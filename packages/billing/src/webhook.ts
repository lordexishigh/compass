import { createHmac, timingSafeEqual } from 'node:crypto';

import { toEpochMillis, type Instant } from '@compass/clock';

/**
 * Stripe webhook verification, over the raw bytes.
 *
 * ## Why this is hand-written rather than `stripe.webhooks.constructEvent`
 *
 * Stated plainly because it is a judgement call. Compass verifies GitHub, Slack and Jira webhooks
 * itself already — `packages/auth/src/webhooks.ts` — against the same constant-time comparison, and
 * the scheme here is a documented four-line HMAC. Adding the Stripe SDK to gain
 * `constructEvent` would pull a large dependency into a package whose only other need is one HTTP
 * call, and it would put a second signature-verification style in a repository that has settled on
 * one. The scheme is asserted directly in `tests/webhook.test.ts`, including the replay window and
 * a tampered body.
 *
 * ## The scheme
 *
 * `Stripe-Signature: t=<unix seconds>,v1=<hex hmac>,v1=<another>`
 *
 * The signed payload is the literal string `<t>.<raw body>`, HMAC-SHA256 under the endpoint's
 * signing secret. Two details are load-bearing:
 *
 *  - **The raw body, byte for byte.** `JSON.parse` then `JSON.stringify` reorders nothing on most
 *    inputs and reorders *something* eventually — a float, a unicode escape — and then the hash is
 *    of a document Stripe never sent. The route reads `await request.text()` and passes it here
 *    untouched.
 *  - **Every `v1` is tried.** Stripe sends more than one during a signing-secret rotation, and a
 *    verifier that read only the first would fail every delivery for the duration of the roll.
 *
 * A timestamp outside the tolerance is refused whatever the signature says: the signature never
 * expires on its own, so a captured request would otherwise be replayable forever.
 */

/** Five minutes, matching Stripe's own recommendation and the Slack verifier in `@compass/auth`. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export type WebhookVerdict =
  | 'verified'
  | 'unconfigured'
  | 'malformed_signature'
  | 'bad_signature'
  | 'stale_timestamp';

/** Constant-time hex compare. Length is compared first, since `timingSafeEqual` throws on a mismatch. */
function digestsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

interface ParsedSignature {
  readonly timestampSeconds: number;
  readonly signatures: readonly string[];
}

/** Exported for the test that proves a rotation-era header with two `v1` values is accepted. */
export function parseStripeSignature(header: string): ParsedSignature | null {
  let timestampSeconds: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestampSeconds = parsed;
    } else if (key === 'v1' && value.length > 0) {
      signatures.push(value.toLowerCase());
    }
  }

  if (timestampSeconds === null || signatures.length === 0) return null;
  return { timestampSeconds, signatures };
}

/** The signed payload Stripe hashes. Exported so a test can build a valid header. */
export const signedPayload = (timestampSeconds: number, rawBody: string): string =>
  `${timestampSeconds}.${rawBody}`;

/** The hex HMAC of a signed payload. Exported for the same reason. */
export const signPayload = (secret: string, timestampSeconds: number, rawBody: string): string =>
  createHmac('sha256', secret).update(signedPayload(timestampSeconds, rawBody), 'utf8').digest('hex');

/**
 * Verify a delivery.
 *
 * `now` is a parameter, like every instant in Compass, so the tolerance test is deterministic
 * rather than dependent on how long the suite took to reach this line.
 */
export function verifyStripeWebhook(input: {
  /** The exact bytes of the request body, as text. Never a re-serialised object. */
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  /** The endpoint signing secret, or null on a deployment that has not set one. */
  readonly webhookSecret: string | null;
  readonly now: Instant;
  readonly toleranceSeconds?: number;
}): WebhookVerdict {
  // Fails closed. A security control that fails open on a misconfiguration looks exactly like one
  // that is working, which is the argument `.env.example` makes for the other three webhooks.
  if (input.webhookSecret === null || input.webhookSecret.length === 0) return 'unconfigured';
  if (input.signatureHeader === null || input.signatureHeader.length === 0) {
    return 'malformed_signature';
  }

  const parsed = parseStripeSignature(input.signatureHeader);
  if (parsed === null) return 'malformed_signature';

  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor(toEpochMillis(input.now) / 1000);
  // Absolute, so a timestamp from the future is refused too — clock skew on the sender is not a
  // reason to accept an unbounded replay window in one direction.
  if (Math.abs(nowSeconds - parsed.timestampSeconds) > tolerance) return 'stale_timestamp';

  const expected = signPayload(input.webhookSecret, parsed.timestampSeconds, input.rawBody);
  return parsed.signatures.some((candidate) => digestsMatch(candidate, expected))
    ? 'verified'
    : 'bad_signature';
}

// ---------------------------------------------------------------------------
// The events Compass acts on
// ---------------------------------------------------------------------------

/**
 * The closed set of Stripe event types Compass changes state for.
 *
 * A closed list rather than a switch with a default that guesses: Stripe sends dozens of types, an
 * endpoint receives every type the dashboard subscribes it to, and acting on one nobody designed
 * for is how a subscription ends up in a state no code path produced. Anything not listed is
 * acknowledged with 200 and ignored — 200 rather than an error, because Stripe retries a non-2xx
 * and an unhandled type would otherwise retry forever.
 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export const isHandledEventType = (value: string): value is HandledEventType =>
  (HANDLED_EVENT_TYPES as readonly string[]).includes(value);

/** The envelope fields Compass reads off any event. */
export interface StripeEventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly createdSeconds: number | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export class MalformedEventError extends Error {
  constructor(detail: string) {
    super(`The Stripe event could not be read: ${detail}`);
    this.name = 'MalformedEventError';
  }
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Parse a verified body into the envelope.
 *
 * Deliberately called only *after* `verifyStripeWebhook` has accepted the raw bytes — parsing first
 * and verifying the parsed object is the mistake this whole module is arranged to prevent.
 */
export function parseEventEnvelope(rawBody: string): StripeEventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new MalformedEventError('the body is not JSON');
  }

  const event = asRecord(parsed);
  const id = event['id'];
  const type = event['type'];

  if (typeof id !== 'string' || id.length === 0) throw new MalformedEventError('no event id');
  if (typeof type !== 'string' || type.length === 0) throw new MalformedEventError('no event type');

  const created = event['created'];

  return {
    id,
    type,
    livemode: event['livemode'] === true,
    createdSeconds: typeof created === 'number' && Number.isFinite(created) ? created : null,
    // `data.object` is the Stripe object the event is about. Kept as an opaque record: every field
    // Compass reads off it is read explicitly in `apply.ts`, never spread into a row.
    data: asRecord(asRecord(event['data'])['object']),
  };
}
