import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Instant } from '@compass/clock';

/**
 * Slack interactivity: the v0 signature, the timestamp window, and the action payload.
 *
 * ## Verify before parsing, always
 *
 * Slack signs the **raw request body**, byte for byte. A route handler that called
 * `request.json()` first and re-serialised would compute the HMAC over different bytes — key
 * order, whitespace, unicode escapes — and every legitimate request would fail while the developer
 * concluded the secret was wrong. So `verifySlackSignature` takes a string it did not produce, and
 * `parseSlackInteraction` is a separate function that a caller reaches only after verification
 * succeeded. The order is enforced by the shape: parsing takes the *verified* body.
 *
 * ## The five-minute window
 *
 * Slack's own guidance, and the reason is replay. The signature never expires on its own — it is a
 * deterministic function of the body and the secret — so a captured request would be valid forever
 * without a timestamp bound. Five minutes is long enough to survive a clock a little out of step
 * and short enough that a captured "dismiss this risk" is worthless by the time anybody finds it in
 * a log.
 *
 * The comparison is on absolute difference, so a timestamp from the *future* is refused too. A
 * request dated an hour ahead is either a badly set clock or somebody extending their own window,
 * and neither is a request Compass should act on.
 *
 * ## What this module deliberately does not do
 *
 * It does not authorize. Verifying that Slack sent something proves the *workspace*, not the
 * person: any member of a Slack workspace can click a button in a channel they can see. Mapping the
 * acting Slack user to a Compass identity with permission on that report is a separate step, done
 * by the route against `subscriptions.slack_user_id` and the role matrix, and an unmapped or
 * unauthorized click gets an ephemeral refusal and mutates nothing.
 */

export const SLACK_SIGNING_SECRET_ENV_VAR = 'SLACK_SIGNING_SECRET';

/** Slack's documented replay window. */
export const SLACK_TIMESTAMP_WINDOW_SECONDS = 300;

export const SLACK_TIMESTAMP_WINDOW_MILLIS = SLACK_TIMESTAMP_WINDOW_SECONDS * 1000;

/** The version prefix Slack's current scheme uses. */
export const SLACK_SIGNATURE_VERSION = 'v0';

export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';

export type SlackSignatureVerdict =
  | 'verified'
  | 'unconfigured'
  | 'missing_headers'
  | 'stale_timestamp'
  | 'bad_signature';

export interface SlackSignatureInput {
  /** The body exactly as it arrived. Never a re-serialisation. */
  readonly rawBody: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  readonly now: Instant;
  readonly secret: string | undefined;
}

/** The sentence each refusal becomes in a log line. Never shown to a Slack user verbatim. */
export const SLACK_SIGNATURE_SENTENCE: Readonly<Record<Exclude<SlackSignatureVerdict, 'verified'>, string>> =
  Object.freeze({
    unconfigured: `${SLACK_SIGNING_SECRET_ENV_VAR} is not set, so Compass cannot verify that a request came from Slack and refuses every interaction.`,
    missing_headers: `A Slack interaction arrived without both ${SLACK_SIGNATURE_HEADER} and ${SLACK_TIMESTAMP_HEADER}.`,
    stale_timestamp: `A Slack interaction's timestamp was more than ${SLACK_TIMESTAMP_WINDOW_SECONDS} seconds from now, so it is refused as a replay.`,
    bad_signature: 'A Slack interaction’s v0 signature did not match the raw body under the signing secret.',
  });

/**
 * The v0 signature of one raw body: `v0=` + HMAC-SHA256 over `v0:<timestamp>:<body>`.
 *
 * Exported so a test can produce a genuine signature rather than asserting against a fixture, which
 * is what makes the negative cases meaningful — a test that only checked a hard-coded string would
 * pass for an implementation that always returned false.
 */
export function slackSignatureFor(rawBody: string, timestamp: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`, 'utf8')
    .digest('hex');
  return `${SLACK_SIGNATURE_VERSION}=${digest}`;
}

export function verifySlackSignature(input: SlackSignatureInput): SlackSignatureVerdict {
  if (input.secret === undefined || input.secret.length === 0) return 'unconfigured';
  if (input.signature === null || input.timestamp === null) return 'missing_headers';
  if (!/^\d+$/.test(input.timestamp)) return 'missing_headers';

  // Absolute difference: a timestamp from the future is a replay attempt or a broken clock, and
  // neither is a request to act on.
  const skew = Math.abs(input.now - Number.parseInt(input.timestamp, 10) * 1000);
  if (skew > SLACK_TIMESTAMP_WINDOW_MILLIS) return 'stale_timestamp';

  const expected = slackSignatureFor(input.rawBody, input.timestamp, input.secret);
  const provided = Buffer.from(input.signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) return 'bad_signature';

  return 'verified';
}

// ---------------------------------------------------------------------------
// The action payload
// ---------------------------------------------------------------------------

/** The prefix every Compass `action_id` carries, so another app's buttons are ignored. */
export const SLACK_ACTION_PREFIX = 'compass_feedback:';

export const slackActionId = (action: string): string => `${SLACK_ACTION_PREFIX}${action}`;

/**
 * What one Slack button carries.
 *
 * The item id travels in `value` and the action in `action_id`, rather than both in one string,
 * because Slack caps `action_id` at 255 characters and *blocks* duplicate ids within a message —
 * which a report with two dismissible risks would immediately trip if the id carried the item.
 */
export interface SlackFeedbackAction {
  readonly action: string;
  readonly itemStableId: string;
}

export interface SlackInteraction {
  readonly slackUserId: string;
  readonly slackTeamId: string | null;
  readonly channelId: string | null;
  /** Where an ephemeral reply is posted. Absent for a payload Slack sent without one. */
  readonly responseUrl: string | null;
  readonly actions: readonly SlackFeedbackAction[];
}

/**
 * Parses a verified interaction body.
 *
 * Slack posts `application/x-www-form-urlencoded` with a single `payload` field holding JSON. Both
 * layers are handled here and neither is trusted: every field is checked for the type it must have,
 * and a payload missing the acting user is refused with `null` rather than defaulted — a Slack
 * interaction with no user is one Compass cannot authorize, and a placeholder would authorize it as
 * somebody.
 */
export function parseSlackInteraction(rawBody: string): SlackInteraction | null {
  const encoded = new URLSearchParams(rawBody).get('payload');
  if (encoded === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const body = parsed as Record<string, unknown>;
  const user = body['user'];
  const slackUserId = typeof user === 'object' && user !== null ? (user as Record<string, unknown>)['id'] : undefined;
  if (typeof slackUserId !== 'string' || slackUserId.length === 0) return null;

  const team = body['team'];
  const channel = body['channel'];
  const responseUrl = body['response_url'];
  const rawActions = Array.isArray(body['actions']) ? (body['actions'] as readonly unknown[]) : [];

  const actions: SlackFeedbackAction[] = [];
  for (const candidate of rawActions) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const entry = candidate as Record<string, unknown>;
    const actionId = entry['action_id'];
    const value = entry['value'];
    if (typeof actionId !== 'string' || !actionId.startsWith(SLACK_ACTION_PREFIX)) continue;
    if (typeof value !== 'string' || value.length === 0) continue;
    actions.push({ action: actionId.slice(SLACK_ACTION_PREFIX.length), itemStableId: value });
  }

  return {
    slackUserId,
    slackTeamId: readNestedId(team),
    channelId: readNestedId(channel),
    responseUrl: typeof responseUrl === 'string' && responseUrl.length > 0 ? responseUrl : null,
    actions,
  };
}

const readNestedId = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
};

/**
 * The ephemeral reply an unmapped or unauthorized click gets.
 *
 * `response_type: 'ephemeral'` and `replace_original: false`, so the refusal is visible only to the
 * person who clicked and the report itself is untouched. Both matter: a manager's daily must not be
 * rewritten because a colleague pressed a button in a shared channel, and telling the channel that
 * somebody lacks access would be a small public humiliation for a permissions problem.
 *
 * The sentence names what to do next. "You don't have access" with no route forward is how an
 * internal tool acquires a reputation for being broken.
 */
export const SLACK_NO_ACCESS_MESSAGE = Object.freeze({
  response_type: 'ephemeral' as const,
  replace_original: false as const,
  text:
    'You don’t have access to give feedback on this report. Compass could not match your Slack account to a ' +
    'Compass seat with permission on it — ask an owner to add your Slack user to your subscription, then try again. ' +
    'Nothing has been changed.',
});

/** The ephemeral acknowledgement a verdict that *was* applied gets. */
export const slackAppliedMessage = (sentence: string) =>
  ({
    response_type: 'ephemeral' as const,
    replace_original: false as const,
    text: sentence,
  }) as const;
