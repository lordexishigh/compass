import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isAtOrAfter, type Instant } from '@compass/clock';

/**
 * Signed, single-purpose feedback links — the email channel's one click.
 *
 * ## What a link is allowed to be
 *
 * A capability, scoped to **one item and one action**, valid for **30 days**, and — the property
 * that matters most — **not a session**. A manager reading their daily on a phone at 08:45 must be
 * able to dismiss a risk without signing in, and the link that lets them do that must not let
 * anything else happen. So the signed payload names exactly one `(organization, item, action)`
 * triple, the route that consumes it establishes no session and sets no cookie, and there is no
 * path from a valid link to reading a report or changing a setting.
 *
 * That is a deliberate departure from how `share-token.ts` works, and the reason is the direction
 * of trust. A share token is an *unguessable random* value because it grants read access to a
 * whole report and must not be derivable from anything an outsider can guess. A feedback link is
 * an *HMAC over its own contents* because the contents have to survive the round trip: the server
 * must be able to tell which item and which action a click refers to without keeping a row for
 * every link it has ever put in an email. One is a lookup key; the other is a sealed statement.
 *
 * ## Why the nonce is in the payload
 *
 * Without it, "dismiss item X" would sign to the same token in every email forever, so the
 * single-use record would burn the *first* email's link and every later one with it — a manager
 * who ignored Monday's mail and clicked Thursday's would be told the link was already used. With
 * 12 random bytes per minted link, each email carries its own capability, spent independently.
 *
 * ## Fail-closed on configuration
 *
 * With no `COMPASS_FEEDBACK_LINK_SECRET` set, `mintFeedbackToken` refuses rather than signing with
 * a default. An HMAC under a known key is not a signature, and a deployment that silently signed
 * with one would be mailing anybody-can-forge dismissal links. The email renderer omits the
 * actions entirely in that case and says so, which is the honest degradation.
 */

export const FEEDBACK_LINK_SECRET_ENV_VAR = 'COMPASS_FEEDBACK_LINK_SECRET';

/** 30 days, as the criterion requires. */
export const FEEDBACK_LINK_TTL_DAYS = 30;

export const FEEDBACK_LINK_TTL_MILLIS = FEEDBACK_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The version tag inside the signed payload. Bumping it invalidates every live link. */
export const FEEDBACK_TOKEN_VERSION = 'f1';

/** 12 bytes: enough that two links for the same item never collide. */
export const FEEDBACK_NONCE_BYTES = 12;

export const feedbackLinkExpiry = (now: Instant): Instant => (now + FEEDBACK_LINK_TTL_MILLIS) as Instant;

export class FeedbackLinkSecretMissingError extends Error {
  readonly detail: string;

  constructor() {
    const detail =
      `${FEEDBACK_LINK_SECRET_ENV_VAR} is not set, so Compass cannot sign a feedback link. It will not fall back ` +
      'to a default key: an HMAC under a known secret is not a signature, and the link would let anybody dismiss ' +
      'anybody’s risk. Set it to a long random string, or leave it unset and the email will carry no action links.';
    super(detail);
    this.name = 'FeedbackLinkSecretMissingError';
    this.detail = detail;
  }
}

export interface FeedbackTokenClaims {
  readonly organizationId: string;
  /** The one item this link may act on. */
  readonly itemStableId: string;
  /** The one action it may take. */
  readonly action: string;
  readonly expiresAt: Instant;
}

export interface MintedFeedbackToken extends FeedbackTokenClaims {
  /** The whole token: payload and signature, URL-safe. */
  readonly token: string;
  readonly nonce: string;
}

/**
 * The canonical bytes the signature covers.
 *
 * Length-prefixed, exactly as `canonicalIdentityString` is, and for the same reason: an item id
 * or an action could contain the separator, and `a|b` + `c` must not sign identically to `a` +
 * `b|c` — otherwise a link scoped to one action could be re-read as a link scoped to another.
 * Exported so a test can assert what is and is not covered.
 */
export function feedbackTokenPayload(claims: FeedbackTokenClaims, nonce: string): string {
  return [
    FEEDBACK_TOKEN_VERSION,
    claims.organizationId,
    claims.itemStableId,
    claims.action,
    String(claims.expiresAt),
    nonce,
  ]
    .map((field) => `${field.length}:${field}`)
    .join('|');
}

const sign = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');

/** The digest the single-use record is keyed on. The token itself is never stored. */
export const hashFeedbackToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Mints a token for one item and one action.
 *
 * The wire form is `f1.<organizationId>.<itemStableId>.<action>.<expiresAt>.<nonce>.<signature>`
 * — every field the signature covers, in the order it covers them, so verification re-derives the
 * payload from the token rather than trusting a parallel encoding. Dots because they are safe in a
 * URL path and query without escaping, and because neither a uuid, a `v1:`-prefixed item id, an
 * action name nor a base64url nonce can contain one.
 */
export function mintFeedbackToken(
  claims: Omit<FeedbackTokenClaims, 'expiresAt'>,
  now: Instant,
  secret: string | undefined,
): MintedFeedbackToken {
  if (secret === undefined || secret.length === 0) throw new FeedbackLinkSecretMissingError();

  const expiresAt = feedbackLinkExpiry(now);
  const nonce = randomBytes(FEEDBACK_NONCE_BYTES).toString('base64url');
  const full: FeedbackTokenClaims = { ...claims, expiresAt };
  const signature = sign(feedbackTokenPayload(full, nonce), secret);

  const token = [
    FEEDBACK_TOKEN_VERSION,
    claims.organizationId,
    claims.itemStableId,
    claims.action,
    String(expiresAt),
    nonce,
    signature,
  ].join('.');

  return { ...full, nonce, token };
}

/**
 * Why a token was refused, or that it was accepted.
 *
 * `expired` and `bad_signature` are distinct because they are different facts and the reader is
 * owed the right one: an expired link is a manager who took five weeks to click, and a bad
 * signature is either a mangled URL or somebody having a go. Neither is told which item the token
 * named — a refused token authorizes nothing, including the confirmation that an id exists.
 */
export type FeedbackTokenVerdict = 'accepted' | 'malformed' | 'bad_signature' | 'expired' | 'unconfigured';

export type FeedbackTokenVerification =
  | { readonly verdict: 'accepted'; readonly claims: FeedbackTokenClaims; readonly tokenDigest: string }
  | { readonly verdict: Exclude<FeedbackTokenVerdict, 'accepted'>; readonly detail: string };

/** The sentence a reader gets for each refusal. Compass's own voice, never a code. */
export const FEEDBACK_TOKEN_SENTENCE: Readonly<Record<Exclude<FeedbackTokenVerdict, 'accepted'>, string>> =
  Object.freeze({
    malformed: 'That link is not a Compass feedback link. It may have been broken across two lines by a mail client.',
    bad_signature:
      'That link’s signature does not match, so Compass will not act on it. Open the report and use the button there.',
    expired: `That link has expired — feedback links last ${FEEDBACK_LINK_TTL_DAYS} days. Open the report and use the button there.`,
    unconfigured:
      'This deployment has no feedback-link secret configured, so Compass cannot verify the link. Sign in and use the report’s own buttons.',
  });

/**
 * Verifies a token: shape, signature, then expiry.
 *
 * Signature before expiry, deliberately. The expiry is *inside* the signed payload, so checking it
 * first would mean trusting a number an unauthenticated caller supplied — a forged token claiming
 * an expiry in 2099 would be rejected as "expired" only by luck, and one claiming a past expiry
 * would be reported as expired when it was in fact a forgery. Establish authenticity, then read the
 * claims.
 */
export function verifyFeedbackToken(
  token: string,
  now: Instant,
  secret: string | undefined,
): FeedbackTokenVerification {
  if (secret === undefined || secret.length === 0) {
    return { verdict: 'unconfigured', detail: FEEDBACK_TOKEN_SENTENCE.unconfigured };
  }

  const parts = token.split('.');
  if (parts.length !== 7 || parts[0] !== FEEDBACK_TOKEN_VERSION) {
    return { verdict: 'malformed', detail: FEEDBACK_TOKEN_SENTENCE.malformed };
  }

  const [, organizationId, itemStableId, action, expiresAtText, nonce, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (!/^\d+$/.test(expiresAtText) || itemStableId.length === 0 || action.length === 0) {
    return { verdict: 'malformed', detail: FEEDBACK_TOKEN_SENTENCE.malformed };
  }

  const expiresAt = Number.parseInt(expiresAtText, 10) as Instant;
  const claims: FeedbackTokenClaims = { organizationId, itemStableId, action, expiresAt };
  const expected = sign(feedbackTokenPayload(claims, nonce), secret);

  if (!constantTimeEquals(signature, expected)) {
    return { verdict: 'bad_signature', detail: FEEDBACK_TOKEN_SENTENCE.bad_signature };
  }

  // Half-open through the clock package's own comparison, exactly as share links are.
  if (isAtOrAfter(now, expiresAt)) {
    return { verdict: 'expired', detail: FEEDBACK_TOKEN_SENTENCE.expired };
  }

  return { verdict: 'accepted', claims, tokenDigest: hashFeedbackToken(token) };
}

/** Comparison that does not leak the signature one byte at a time. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The actions an email link may carry, and which of them spend the link.
 *
 * `readOnly` actions are the ones that change nothing — today only `view`, which opens the item in
 * the report. They are deliberately *not* single-use: a link that merely shows something has
 * nothing to spend, and burning it on a mail scanner's prefetch would mean the manager's own click
 * landed on an error page. Everything else mutates state and is spent on first use.
 */
export const FEEDBACK_LINK_ACTIONS = [
  'dismiss_risk',
  'off_goal_flag_wrong',
  'accept_recommendation',
  'reject_recommendation',
  'blocker_already_resolved',
  'snooze',
  'view',
] as const;

export type FeedbackLinkAction = (typeof FEEDBACK_LINK_ACTIONS)[number];

export const isFeedbackLinkAction = (value: string): value is FeedbackLinkAction =>
  (FEEDBACK_LINK_ACTIONS as readonly string[]).includes(value);

export const feedbackLinkIsStateChanging = (action: string): boolean => action !== 'view';

/** The absolute URL an email button points at. One item, one action, one token. */
export const feedbackLinkUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/api/feedback/link/${encodeURIComponent(token)}`;
