import { createHmac } from 'node:crypto';

import { MILLIS_PER_MINUTE, type Instant } from '@compass/clock';

import { digestsMatch } from './secrets.js';

/**
 * Inbound webhook authentication: GitHub, Jira and Slack.
 *
 * ## Why this is in `@compass/auth` and not in a connector
 *
 * A webhook is a request that arrives with no session and asks Compass to believe
 * something. Deciding whether to believe it is an access decision, so it lives in the
 * package that owns access decisions — beside `digestsMatch`, which is the one
 * constant-time comparator in the repository. Every provider below routes its
 * comparison through it, so "all comparisons are constant-time" is a property of one
 * function rather than a habit repeated three times.
 *
 * Slack's verifier already existed in `@compass/delivery` when this module was written
 * (it is used by `/api/slack/actions`, which is interactivity rather than ingest), so it
 * is not reimplemented here. `slackWebhookVerdict` adapts its verdict into the shape the
 * shared route logs, and `tests/webhooks.test.ts` asserts both helpers compare with
 * `timingSafeEqual` and never with `===`.
 *
 * ## Verify against the raw bytes, before parsing
 *
 * All three providers sign the body exactly as it was sent. A handler that parsed JSON
 * first and re-serialised would hash different bytes — key order, whitespace, unicode
 * escapes — and every legitimate delivery would fail while whoever was debugging it
 * concluded the secret was wrong. So every function here takes a `rawBody: string` it did
 * not produce.
 *
 * ## Refusing when unconfigured is the safe direction
 *
 * A missing secret is `unconfigured`, which the route answers 401 to. The alternative —
 * accepting an unverifiable delivery because no secret is set — would mean the ingest
 * path could be fed by anyone who found the URL, and it would fail *open* on a
 * misconfiguration, which is the one direction a security control must never fail.
 */

export const WEBHOOK_PROVIDERS = ['github', 'slack', 'jira'] as const;

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export const isWebhookProvider = (value: string): value is WebhookProvider =>
  (WEBHOOK_PROVIDERS as readonly string[]).includes(value);

/** The environment variable each provider's secret is read from. */
export const WEBHOOK_SECRET_ENV_VAR: Readonly<Record<WebhookProvider, string>> = Object.freeze({
  github: 'GITHUB_WEBHOOK_SECRET',
  slack: 'SLACK_SIGNING_SECRET',
  jira: 'JIRA_WEBHOOK_SECRET',
});

export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
export const GITHUB_EVENT_HEADER = 'x-github-event';
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery';

/** Jira Cloud's shared-secret form, and Atlassian Connect's JWT form. */
export const JIRA_SIGNATURE_HEADER = 'x-atlassian-webhook-signature';
export const JIRA_AUTHORIZATION_HEADER = 'authorization';

/**
 * The replay window every provider is held to.
 *
 * Slack documents five minutes and enforces it on its own timestamp header. Jira's JWT
 * carries `iat`/`exp` instead, and those are checked against the same five minutes rather
 * than against whatever expiry the token asked for: a token minted with a one-year `exp`
 * is a token somebody can replay for a year, and the receiver is the only party in a
 * position to refuse that.
 *
 * GitHub sends no timestamp at all, so there is nothing to window. Its protection is the
 * delivery id, which the route logs; deduplicating on it belongs to whatever consumes the
 * payload, and is stated as such rather than pretended here.
 */
export const WEBHOOK_TIMESTAMP_WINDOW_MILLIS = 5 * MILLIS_PER_MINUTE;

export const WEBHOOK_TIMESTAMP_WINDOW_SECONDS = WEBHOOK_TIMESTAMP_WINDOW_MILLIS / 1000;

/**
 * Why a delivery was refused. `verified` is the only accepting value.
 *
 *  - `unconfigured` — no secret for this provider, so nothing could be checked.
 *  - `missing_signature` — the provider's signature header was absent.
 *  - `malformed_signature` — present but not the shape the scheme defines.
 *  - `bad_signature` — a real signature that does not match these bytes under this secret.
 *  - `stale_timestamp` — outside the replay window, whatever the signature says.
 */
export type WebhookVerdict =
  | 'verified'
  | 'unconfigured'
  | 'missing_signature'
  | 'malformed_signature'
  | 'bad_signature'
  | 'stale_timestamp';

export const isWebhookAccepted = (verdict: WebhookVerdict): boolean => verdict === 'verified';

/**
 * The log sentence a refusal becomes.
 *
 * Every one names the provider, because the acceptance criterion for this is a log an
 * operator can read: "a webhook was rejected" is not actionable, and "github rejected a
 * delivery whose HMAC did not match the raw body" says which secret to go and look at.
 * Never returned to the caller — the response says only that the signature did not verify.
 */
export function describeWebhookVerdict(provider: WebhookProvider, verdict: WebhookVerdict): string {
  const variable = WEBHOOK_SECRET_ENV_VAR[provider];
  switch (verdict) {
    case 'verified':
      return `${provider} delivery verified against ${variable}.`;
    case 'unconfigured':
      return `${provider} webhook refused: ${variable} is not set, so Compass cannot verify that the delivery came from ${provider} and refuses every one.`;
    case 'missing_signature':
      return `${provider} webhook refused: the delivery arrived without a signature header.`;
    case 'malformed_signature':
      return `${provider} webhook refused: the signature was present but not in the shape ${provider}'s scheme defines.`;
    case 'bad_signature':
      return `${provider} webhook refused: the signature did not match the raw body under ${variable}.`;
    case 'stale_timestamp':
      return `${provider} webhook refused: the delivery was timestamped more than ${WEBHOOK_TIMESTAMP_WINDOW_SECONDS} seconds from now, so it is treated as a replay regardless of whether the signature is valid.`;
  }
}

/**
 * The single constant-time comparison in the repository, re-exported under the name the
 * webhook code reads best.
 *
 * Not a second implementation: `digestsMatch` wraps `timingSafeEqual` and handles the
 * length mismatch that would otherwise throw (and, in throwing, leak the length). Signature
 * comparison is exactly the case where `===` is wrong — it returns on the first differing
 * byte, so an attacker with a timing oracle can recover a valid signature one byte at a time.
 */
export const constantTimeEqual = digestsMatch;

// ---------------------------------------------------------------------------
// GitHub — X-Hub-Signature-256
// ---------------------------------------------------------------------------

export const GITHUB_SIGNATURE_PREFIX = 'sha256=';

/**
 * The signature GitHub would send for these bytes.
 *
 * Exported so tests can produce a genuine signature rather than assert against a fixture:
 * a test that only checked a hard-coded string would also pass for a verifier that always
 * returned false.
 */
export function githubSignatureFor(rawBody: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `${GITHUB_SIGNATURE_PREFIX}${digest}`;
}

export interface GithubSignatureInput {
  /** The body exactly as it arrived. Never a re-serialisation. */
  readonly rawBody: string;
  readonly signature: string | null;
  readonly secret: string | undefined;
}

export function verifyGithubSignature(input: GithubSignatureInput): WebhookVerdict {
  if (input.secret === undefined || input.secret.length === 0) return 'unconfigured';
  if (input.signature === null || input.signature.length === 0) return 'missing_signature';
  if (!input.signature.startsWith(GITHUB_SIGNATURE_PREFIX)) return 'malformed_signature';

  const hex = input.signature.slice(GITHUB_SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return 'malformed_signature';

  const expected = githubSignatureFor(input.rawBody, input.secret);
  return constantTimeEqual(input.signature.toLowerCase(), expected) ? 'verified' : 'bad_signature';
}

// ---------------------------------------------------------------------------
// Jira — a shared-secret HMAC, or an Atlassian Connect HS256 JWT
// ---------------------------------------------------------------------------

/**
 * Jira sends one of two things, so both are accepted and neither is guessed at.
 *
 *  - A **Jira Cloud webhook with a secret** signs the raw body with HMAC-SHA256 and puts
 *    the hex digest in `X-Atlassian-Webhook-Signature`.
 *  - An **Atlassian Connect app** sends `Authorization: JWT <token>`, an HS256 JWT signed
 *    with the shared secret established at installation.
 *
 * The JWT path deliberately does **not** treat the token's own `exp` as the deadline. A
 * token minted with a distant expiry is replayable until then, and the receiver is the only
 * party who can refuse that — so `iat` is held to Compass's own five-minute window, and a
 * token whose `exp` has passed is refused as well. `qsh` (the query-string hash) is not
 * checked here: it binds a token to one HTTP request line, which the route does not
 * reconstruct, and a check that silently passed because the value was absent would be worse
 * than a documented omission.
 */
export interface JiraSignatureInput {
  readonly rawBody: string;
  /** `X-Atlassian-Webhook-Signature`, when Jira was configured with a secret. */
  readonly signature: string | null;
  /** The raw `Authorization` header, when an Atlassian Connect app sent a JWT. */
  readonly authorization: string | null;
  readonly now: Instant;
  readonly secret: string | undefined;
}

export function jiraSignatureFor(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Signs a JWT the way Atlassian Connect does, for the tests. */
export function jiraJwtFor(claims: Record<string, unknown>, secret: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyJiraSignature(input: JiraSignatureInput): WebhookVerdict {
  if (input.secret === undefined || input.secret.length === 0) return 'unconfigured';

  const jwt = readJwt(input.authorization);
  if (jwt !== null) return verifyJiraJwt(jwt, input.secret, input.now);

  if (input.signature === null || input.signature.length === 0) return 'missing_signature';
  if (!/^[0-9a-f]{64}$/i.test(input.signature)) return 'malformed_signature';

  const expected = jiraSignatureFor(input.rawBody, input.secret);
  return constantTimeEqual(input.signature.toLowerCase(), expected) ? 'verified' : 'bad_signature';
}

/** `Authorization: JWT <token>`, case-insensitively. Null when the header is something else. */
function readJwt(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^JWT\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function verifyJiraJwt(token: string, secret: string, now: Instant): WebhookVerdict {
  const parts = token.split('.');
  if (parts.length !== 3) return 'malformed_signature';

  const [encodedHeader, encodedClaims, provided] = parts as [string, string, string];
  const header = decodeJwtSegment(encodedHeader);
  const claims = decodeJwtSegment(encodedClaims);
  if (header === null || claims === null) return 'malformed_signature';
  // `alg: none` is the classic forgery, and an unexpected algorithm is refused rather
  // than trusted: the token gets to say what it is, not what Compass will accept.
  if (header['alg'] !== 'HS256') return 'malformed_signature';

  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedClaims}`, 'utf8')
    .digest('base64url');
  if (!constantTimeEqual(provided, expected)) return 'bad_signature';

  // Signature first, then freshness: a valid signature on a stale token is still stale,
  // and an invalid signature's claims are not worth reading.
  const issuedAt = numericClaim(claims['iat']);
  const expiresAt = numericClaim(claims['exp']);
  if (issuedAt === null) return 'malformed_signature';
  if (Math.abs(now - issuedAt * 1000) > WEBHOOK_TIMESTAMP_WINDOW_MILLIS) return 'stale_timestamp';
  if (expiresAt !== null && now >= expiresAt * 1000) return 'stale_timestamp';

  return 'verified';
}

function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const numericClaim = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// ---------------------------------------------------------------------------
// Slack — adapting the verifier that already exists
// ---------------------------------------------------------------------------

/**
 * Slack's own five verdicts, mapped onto this module's vocabulary.
 *
 * `@compass/delivery` owns the Slack v0 implementation because `/api/slack/actions` needed
 * it first, and it is correct: raw body, HMAC over `v0:<timestamp>:<body>`, five-minute
 * absolute window, `timingSafeEqual`. Duplicating it here so that all three providers lived
 * in one file would mean two implementations of one scheme, and the second one would be the
 * one that fell behind. So the mapping is the seam instead, and it is total — a new Slack
 * verdict would fail to typecheck here rather than fall through to "verified".
 */
export function slackWebhookVerdict(
  verdict: 'verified' | 'unconfigured' | 'missing_headers' | 'stale_timestamp' | 'bad_signature',
): WebhookVerdict {
  switch (verdict) {
    case 'verified':
      return 'verified';
    case 'unconfigured':
      return 'unconfigured';
    case 'missing_headers':
      return 'missing_signature';
    case 'stale_timestamp':
      return 'stale_timestamp';
    case 'bad_signature':
      return 'bad_signature';
  }
}
