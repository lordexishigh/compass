import { findMembershipByUserId, findSubscriptionBySlackUserId, listTeamScopes } from '@compass/db';
import {
  SLACK_NO_ACCESS_MESSAGE,
  SLACK_SIGNATURE_HEADER,
  SLACK_SIGNATURE_SENTENCE,
  SLACK_SIGNING_SECRET_ENV_VAR,
  SLACK_TIMESTAMP_HEADER,
  parseSlackInteraction,
  slackAppliedMessage,
  verifySlackSignature,
} from '@compass/delivery';
import { NextResponse } from 'next/server';

import { guard, isDemoOrganization } from '../../../../lib/auth/guard';
import { NO_STORE, failure } from '../../../../lib/auth/http';
import {
  applyManagerFeedback,
  parseFeedbackAction,
  resolveItemReportScope,
  seatMayActOnItem,
} from '../../../../lib/feedback-source';

/**
 * `POST /api/slack/actions` — Block Kit feedback buttons.
 *
 * ## The raw body is read before anything else touches it
 *
 * Slack signs the request body byte for byte. `await request.text()` is therefore the first thing
 * this handler does with the body, and the signature is computed over that exact string. Calling
 * `request.json()` first and re-serialising would hash different bytes — key order, whitespace,
 * unicode escapes — and *every* legitimate interaction would fail while the operator concluded the
 * signing secret was wrong. The body is parsed only after verification, from the same string.
 *
 * ## Verifying Slack is not authorizing a person
 *
 * A valid v0 signature proves the *workspace* sent this. It does not prove the clicker may act:
 * anyone in a Slack workspace can press a button in a channel they can see. So there are two gates,
 * and both must pass before a single row is written:
 *
 *  1. the signature, inside a five-minute timestamp window, and
 *  2. a stored `(slack user id → Compass seat)` mapping whose seat the role matrix permits to give
 *     feedback.
 *
 * An unmapped or unauthorized click gets an **ephemeral** reply — visible only to the person who
 * clicked, `replace_original: false` — and mutates nothing. Both properties are deliberate: a
 * manager's daily must not be rewritten because a colleague pressed a button in a shared channel,
 * and announcing to the channel that somebody lacks access would be a small public humiliation for
 * what is only a configuration gap. The sentence therefore names the fix.
 *
 * ## Why an unverified request still answers 200
 *
 * It does not. A bad signature answers 401 with no body worth reading, because that is not a Slack
 * user seeing a message — it is something that failed to be Slack. Only the *authorization* refusal
 * is a 200-with-ephemeral-message, because there the caller genuinely is Slack and the ephemeral
 * reply is the only way to tell the human anything at all.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/slack/actions';

/** An ephemeral Slack message, as this route's response body. Never cached. */
const ephemeral = (body: unknown): NextResponse => NextResponse.json(body, { status: 200, headers: NO_STORE });

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  // First, and from the request exactly once: a Request body can only be read a single time, and
  // this string is what the signature covers.
  const rawBody = await request.text();

  const verdict = verifySlackSignature({
    rawBody,
    signature: request.headers.get(SLACK_SIGNATURE_HEADER),
    timestamp: request.headers.get(SLACK_TIMESTAMP_HEADER),
    now: admitted.now,
    secret: process.env[SLACK_SIGNING_SECRET_ENV_VAR],
  });

  if (verdict !== 'verified') {
    // Logged in full, answered in brief. The detail names the deployment's own configuration or a
    // replay attempt, and neither is the caller's business.
    console.error(`[compass] ${SLACK_SIGNATURE_SENTENCE[verdict]}`);
    return NextResponse.json(
      { error: verdict, detail: 'This request could not be verified as coming from Slack.' },
      { status: verdict === 'unconfigured' ? 503 : 401, headers: NO_STORE },
    );
  }

  const interaction = parseSlackInteraction(rawBody);
  if (interaction === null) {
    return NextResponse.json(
      { error: 'unreadable_payload', detail: 'That interaction payload could not be read.' },
      { status: 400, headers: NO_STORE },
    );
  }

  const action = interaction.actions[0];
  // A verified interaction with no Compass button in it is one of Slack's own lifecycle events
  // (a view closing, another app's block). Acknowledged silently: Slack requires a 200 quickly, and
  // there is nothing to tell the user.
  if (action === undefined) return ephemeral({ ok: true });

  try {
    // The item first, because *which report it belongs to* is what decides whether this seat may act
    // at all — and that decision has to be made before a single row is written. An id that resolves
    // to nothing is folded into the same refusal below rather than answered separately: Slack button
    // values are visible to everybody in the channel, and answering "no such item" for one id and
    // "no access" for another would turn this endpoint into a directory of which items exist.
    const itemScope = await resolveItemReportScope(admitted.scoped, action.itemStableId);

    const seat =
      itemScope === null
        ? null
        : await resolveSlackSeat(admitted.scoped, admitted.organizationId, interaction.slackUserId, itemScope.teamKey);
    if (seat === null) return ephemeral(SLACK_NO_ACCESS_MESSAGE);

    const feedbackAction = parseFeedbackAction(action.action);
    if (feedbackAction === null) {
      return ephemeral(
        slackAppliedMessage(
          `Compass does not act on “${action.action}”, so nothing was changed. Open the report to give feedback.`,
        ),
      );
    }

    const result = await applyManagerFeedback(admitted.scoped, {
      stableId: action.itemStableId,
      action: feedbackAction,
      reason: 'Recorded from a button in Slack.',
      channel: 'slack',
      authorUserId: seat.userId,
      now: admitted.now,
    });

    if (!result.ok) return ephemeral(slackAppliedMessage(result.detail));
    return ephemeral(slackAppliedMessage(result.sentence));
  } catch (error) {
    return failure(error);
  }
}

/**
 * The Compass seat behind a Slack user id, or null when there is not one that may act on this item.
 *
 * Four things have to hold, and every failure is the same answer to the user because telling them
 * apart would be an oracle: no mapping, no usable seat, a role the matrix does not let give feedback,
 * and — the one this signature exists for — an item belonging to a team this seat is not scoped to.
 *
 * The matrix is consulted with the *same route and action* the web POST uses, so a role that cannot
 * give feedback on the page cannot give it from Slack either. That is the point of having a matrix
 * at all — a second channel with its own opinion about who may act is how a viewer ends up
 * dismissing a manager's risks.
 *
 * ## Why `itemTeamKey` is a parameter rather than something derived here
 *
 * It has to be the team of the report *containing the item*. This function used to pass
 * `teamScopes[0]` — the clicker's own first team — which made `teamScopeAllows` compare a scope
 * against itself: the check could never fail, and since the item lookup underneath is scoped to the
 * organization and nothing narrower, a mapped manager could record a verdict on another team's
 * report. Taking the item's team as an argument is what makes the comparison mean something, and
 * putting it in the signature is what stops the next caller forgetting it.
 */
async function resolveSlackSeat(
  scoped: Parameters<typeof findMembershipByUserId>[0],
  organizationId: string,
  slackUserId: string,
  itemTeamKey: string | null,
): Promise<{ readonly userId: string } | null> {
  const subscription = await findSubscriptionBySlackUserId(scoped, slackUserId);
  if (subscription === null) return null;

  const membership = await findMembershipByUserId(scoped, subscription.userId);
  if (membership === null || membership.status !== 'active') return null;

  const teamScopes = await listTeamScopes(scoped, membership.id);
  const allowed = seatMayActOnItem({
    principal: membership.role,
    teamScopes,
    itemTeamKey,
    demoOrganization: isDemoOrganization(organizationId),
  });

  return allowed ? { userId: subscription.userId } : null;
}
