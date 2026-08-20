import { randomUUID } from 'node:crypto';

import { deactivateSubscription, findSubscriptionForChannel } from '@compass/db';
import { InvalidScheduleError, type DeliveryChannel, type DeliveryScope } from '@compass/delivery';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import {
  failure,
  isFormSubmission,
  jsonError,
  jsonOk,
  readFormOrJsonObject,
  requiredString,
  seeOtherPath,
} from '../../../../lib/auth/http';
import { saveSubscription } from '../../../../lib/subscription-source';

/**
 * `POST /api/delivery/subscription` — the manager's own daily: when, where, and stop.
 *
 * ## Why this route had to exist
 *
 * Everything under it was already built. `@compass/delivery` schedules per zone, renders the whole
 * report inline into an email and into Slack blocks, and the worker ticks and sends; `upsertSubscription`
 * in `@compass/db` says in its own comment that it upserts on `(organization, user, channel)` "because
 * the screen offers one row per channel"; `lib/subscription-source.ts` mints the unsubscribe token and
 * defaults the scope from the roster. There was no screen and no endpoint, so the only way into
 * `subscriptions` was a test — and `POST /api/delivery/unsubscribe` told readers they could "turn
 * delivery back on from the report page", which was not true of any page. This is that endpoint.
 *
 * ## One verb, with an intent
 *
 * `save` writes the subscription; `stop` deactivates it. Both are POST rather than POST-and-DELETE
 * because the caller that matters is a `<form method="post">` in a Server Component — the same posture
 * the billing and connect screens take — and a form cannot send DELETE without a client island whose
 * only job would be to change the method. Stopping is a state change either way, and RFC 8058's
 * unsubscribe is a POST for the same reason.
 *
 * ## Your own subscription, never somebody else's
 *
 * The user id comes from the session, not from the body. Every seat may set its own delivery — that is
 * why the matrix admits `member` and `viewer` here and not just owners — and no seat, including an
 * owner's, can address another person's row through this route. A manager who needs to stop somebody
 * else's mail does it from the roster screen, where it is audited.
 *
 * ## What is validated, and where
 *
 * The zone and send time are checked by `assertSchedulable` inside `saveSubscription`, before anything
 * is written: a subscription that looks configured and silently never sends is the worst failure this
 * feature has. The target is checked here, because what makes an address plausible differs by channel
 * and this is the boundary that knows which channel was asked for.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/delivery/subscription';

const isChannel = (value: string): value is DeliveryChannel => value === 'email' || value === 'slack';

/**
 * The scope, or `undefined` for "let my seat decide".
 *
 * `default` is a real choice rather than an absent field: it means "follow the roster", so a manager
 * who is later moved onto a second team starts getting the merged report without editing anything.
 * `saveSubscription` resolves it through `defaultScopeFor`.
 */
function requestedScope(raw: unknown): DeliveryScope | undefined | 'invalid' {
  if (raw === undefined || raw === null || raw === '' || raw === 'default') return undefined;
  if (raw === 'team' || raw === 'merged' || raw === 'both') return raw;
  return 'invalid';
}

/**
 * Whether an address could plausibly receive this channel.
 *
 * Deliberately shallow. A deliverable address cannot be established by inspecting a string — that is
 * what the first send finds out, and `delivery_log` records — so this rejects only what is certainly
 * wrong: an email with no `@`, and a Slack target that is neither a channel (`#name`), a person
 * (`@name`) nor a Slack id (`C…`/`D…`/`U…`). Anything stricter would refuse legitimate addresses and
 * push people back to a config file, which is the thing this screen replaces.
 */
function targetProblem(channel: DeliveryChannel, target: string): string | null {
  if (channel === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)
      ? null
      : 'That does not look like an email address. Compass sends the whole report inline, so it needs a mailbox.';
  }

  return /^[#@][^\s]+$/.test(target) || /^[CDGU][A-Z0-9]{6,}$/.test(target)
    ? null
    : 'A Slack target is a channel (#platform-standup), a direct message (@you), or the id Slack shows in a ' +
        'channel’s details (C… for a channel, D… or U… for a person).';
}

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  if (admitted.identity === null) return jsonError('forbidden', 'This needs a seat.', 403);
  const identity = admitted.identity;

  const browserForm = isFormSubmission(request);
  /** Where a browser lands, with the outcome as a slug rather than as text. `/account` looks it up. */
  const back = (outcome: string): NextResponse => seeOtherPath(request, `/account?delivery=${outcome}`);

  try {
    const parsed = await readFormOrJsonObject(request);
    if ('response' in parsed) return parsed.response;

    const channelField = requiredString(parsed.body, 'channel');
    if ('response' in channelField) return channelField.response;
    if (!isChannel(channelField.value)) {
      return jsonError(
        'invalid_request',
        'Compass delivers the daily by `email` or to `slack`. There is no third channel.',
        400,
      );
    }
    const channel = channelField.value;

    const intent = typeof parsed.body['intent'] === 'string' ? parsed.body['intent'] : 'save';

    if (intent === 'stop') {
      const existing = await findSubscriptionForChannel(admitted.scoped, identity.user.id, channel);
      // Idempotent, and for the same reason the one-click unsubscribe is: the person clicking this
      // wants the mail to stop, and a 404 for "it already had" reads as a broken button.
      if (existing !== null && existing.active) {
        await deactivateSubscription(admitted.scoped, existing.id, admitted.now);
      }

      return browserForm
        ? back(`${channel}-stopped`)
        : jsonOk({
            channel,
            active: false,
            detail:
              `The ${channel === 'email' ? 'email' : 'Slack'} daily is switched off. The report is still readable ` +
              'in Compass, and turning it back on keeps the same schedule.',
          });
    }

    if (intent !== 'save') {
      return jsonError('invalid_request', '`intent` is either `save` or `stop`.', 400);
    }

    const targetField = requiredString(parsed.body, 'target');
    if ('response' in targetField) return targetField.response;
    const problem = targetProblem(channel, targetField.value);
    if (problem !== null) {
      return browserForm ? back(`${channel}-target-rejected`) : jsonError('invalid_target', problem, 422);
    }

    const sendTimeField = requiredString(parsed.body, 'sendTime');
    if ('response' in sendTimeField) return sendTimeField.response;

    const timezoneField = requiredString(parsed.body, 'timezone');
    if ('response' in timezoneField) return timezoneField.response;

    const scope = requestedScope(parsed.body['scope']);
    if (scope === 'invalid') {
      return jsonError(
        'invalid_request',
        '`scope` is `team`, `merged`, `both`, or `default` to follow the teams your seat can read.',
        400,
      );
    }

    const created = await saveSubscription(
      admitted.scoped,
      {
        userId: identity.user.id,
        membershipId: identity.membership.id,
        channel,
        target: targetField.value,
        scope,
        sendTime: sendTimeField.value,
        timezone: timezoneField.value,
      },
      { newId: randomUUID, at: admitted.now },
    );

    return browserForm
      ? back(`${channel}-saved`)
      : jsonOk({
          channel,
          target: created.subscription.target,
          scope: created.subscription.scope,
          sendTime: created.subscription.sendTime,
          timezone: created.subscription.timezone,
          active: created.subscription.active,
          teamKeys: created.teamKeys,
        });
  } catch (error) {
    /**
     * A zone or a send time Compass cannot schedule.
     *
     * Caught here rather than left to `failure()`, which would answer 500 and log it as ours. It is
     * neither: the manager typed something Compass cannot turn into an instant, and telling them so
     * with the offending value quoted is the whole point of validating at the write boundary.
     */
    if (error instanceof InvalidScheduleError) {
      return browserForm ? back('schedule-rejected') : jsonError('invalid_schedule', error.detail, 422);
    }
    return failure(error);
  }
}
