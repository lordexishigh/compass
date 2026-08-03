/**
 * What Compass is allowed to send to an error reporter.
 *
 * ## Why this exists at all, given the SDK has a flag for it
 *
 * `sendDefaultPii: false` stops Sentry *adding* personal data of its own — the user's IP, cookie
 * headers it would otherwise attach. It does nothing about the data that is already inside the
 * exception Compass throws. An error raised while reconciling a commit carries the commit in its
 * message; a failed sign-in carries the address it failed for. The flag is necessary and it is not
 * sufficient, so every event goes through `scrubEvent` before it leaves.
 *
 * ## The three things that must never leave
 *
 *  1. **Email addresses.** Every account in Compass is one, and they are the most identifying field
 *     in the product. `user.email` is dropped outright, and any `@`-bearing token in a free-text
 *     field is masked.
 *  2. **Credentials.** `Authorization` and `Cookie` headers, session secrets, integration tokens,
 *     the feedback-link signing secret. A leaked bearer token in a stack trace is a live
 *     credential in a third party's database.
 *  3. **Raw ingested text.** A commit message, a pull request body, a ticket comment, a chat
 *     message. This is the same rule the narration boundary enforces, for the same reason and with
 *     the same mechanism: the *field names* are enumerated, because scanning for "does this string
 *     look like a commit message" is unfalsifiable while scanning for the field that carries commit
 *     messages is exact.
 *
 * ## The structural argument
 *
 * `RAW_TEXT_FIELD_NAMES` below is held to `@compass/narrator`'s `RAW_INGESTED_TEXT_FIELDS` by
 * `tests/scrub.test.ts`, which fails if the narrator learns about a raw-text field this scrubber
 * does not. So adding a raw-text field to the report payload is a build failure until the error
 * reporter is taught to drop it too — the same shape of gate, one layer over.
 */

/**
 * Field names that only ever hold verbatim text from a source system.
 *
 * Kept in sync with `@compass/narrator`'s list by a test rather than by importing it: this package
 * sits below the narrator and must depend on nothing, so the agreement is asserted rather than
 * enforced by the module graph.
 */
export const RAW_TEXT_FIELD_NAMES: readonly string[] = Object.freeze([
  'searchedText',
  'matchedSubstring',
  'comparedTextA',
  'comparedTextB',
  'message',
  'commitMessage',
  'body',
  'rawText',
  'comment',
  'evidence',
]);

/** Header names whose value is a credential. Compared case-insensitively. */
export const CREDENTIAL_HEADERS: readonly string[] = Object.freeze([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-hub-signature-256',
  'x-slack-signature',
]);

/**
 * Keys whose *value* is a secret whatever it looks like.
 *
 * Matched as a substring of the lower-cased key, so `undoTokenHash`, `sessionSecret` and
 * `resendApiKey` are all covered without enumerating every casing anybody might invent.
 */
const SECRET_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  'token',
  'secret',
  'password',
  'apikey',
  'api_key',
  'credential',
  'authorization',
  'cookie',
]);

export const REDACTED = '[redacted]';

/**
 * An email address anywhere in free text.
 *
 * Deliberately loose on both sides of the `@`. A pattern tuned to valid addresses would miss the
 * malformed one somebody actually typed into the sign-in box, which is the one most likely to be in
 * an error message.
 */
const EMAIL_PATTERN = /[^\s<>()[\]{},;:"']+@[^\s<>()[\]{},;:"']+/gu;

/**
 * Token-shaped strings: bearer tokens, hex digests, base64url secrets, JWTs.
 *
 * The length floor is 32 so it does not eat a SHA prefix (`7a8b9c0`), a tracker key or a branch
 * name — those are the receipts a report is built from and a stack trace naming one is useful.
 */
const TOKEN_PATTERN =
  /\b(?:Bearer\s+[\w.~+/-]+=*|eyJ[\w.-]{16,}|[A-Za-z0-9_-]{32,}|[0-9a-f]{40,})\b/gu;

/**
 * A UUID, which is never a secret and is frequently the most useful field on the line.
 *
 * Needed because a v4 UUID is 36 characters of `[A-Za-z0-9-]` and so matches the generic
 * base64url-ish arm of `TOKEN_PATTERN`. Without this exception the scrubber redacted
 * `organizationId` — the one tag that makes a crash report attributable to a tenant — which is a
 * scrubber defeating the reason the report exists. Session *secrets* are not UUIDs (they are 32
 * random bytes) and the tokens that are stored are stored as digests, so nothing private relies on
 * a UUID being masked.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** True when a `TOKEN_PATTERN` hit is something we deliberately keep. */
const isKeptIdentifier = (candidate: string): boolean => UUID_PATTERN.test(candidate);

const isSecretKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
};

const isRawTextKey = (key: string): boolean => RAW_TEXT_FIELD_NAMES.includes(key);

/** Masks addresses and token-shaped runs inside a string, leaving the rest readable. */
export function scrubText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(TOKEN_PATTERN, (match) => (isKeptIdentifier(match) ? match : REDACTED));
}

/**
 * Walks any value and returns a scrubbed copy.
 *
 * A copy rather than a mutation: the event object Sentry hands `beforeSend` is the same one the SDK
 * may retain for a retry, and scrubbing in place while a queue holds a reference is the kind of bug
 * that shows up as intermittently-clean payloads.
 *
 * Depth-limited, because an event can carry a cyclic object graph — a Drizzle error holds its query
 * builder — and a scrubber that stack-overflowed on the way out would drop the report entirely.
 */
function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isRawTextKey(key) || isSecretKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(nested, depth + 1);
  }
  return out;
}

/** The shape of a Sentry event this scrubber touches. Structural, so the SDK is not a dependency. */
export interface ScrubbableEvent {
  user?: { email?: string; ip_address?: string; username?: string; id?: string } | null;
  request?: { headers?: Record<string, string>; cookies?: unknown; data?: unknown; url?: string } | null;
  extra?: Record<string, unknown> | null;
  contexts?: Record<string, unknown> | null;
  breadcrumbs?: unknown[] | null;
  exception?: unknown;
  message?: unknown;
  tags?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * The `beforeSend` body. Returns a scrubbed copy of the event.
 *
 * Never returns `null` to drop the event: an error Compass cannot report is an error nobody fixes,
 * and the answer to "this event might contain something private" is to remove that thing rather
 * than to lose the crash. The one exception would be an event we could not scrub at all, and there
 * is no such shape — `scrubValue` is total.
 */
export function scrubEvent<TEvent extends object>(event: TEvent): TEvent {
  const scrubbed = scrubValue(event) as ScrubbableEvent;

  if (scrubbed.user != null) {
    // Dropped rather than masked. `user.email` is the one field whose *presence* is the leak: a
    // masked value still tells a reader this event belongs to an identifiable person, and the id
    // below is enough to correlate without naming anybody.
    const { email: _email, ip_address: _ip, username: _username, ...rest } = scrubbed.user;
    scrubbed.user = rest;
  }

  if (scrubbed.request?.headers != null) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(scrubbed.request.headers)) {
      headers[name] = CREDENTIAL_HEADERS.includes(name.toLowerCase()) ? REDACTED : value;
    }
    scrubbed.request = { ...scrubbed.request, headers, cookies: REDACTED };
  } else if (scrubbed.request != null) {
    scrubbed.request = { ...scrubbed.request, cookies: REDACTED };
  }

  /**
   * Generic in the event type so the SDK's own `ErrorEvent` and `TransactionEvent` flow through
   * unchanged.
   *
   * `ScrubbableEvent` is a *structural description* of the fields this function touches, not a claim
   * to be the SDK's type — Sentry's events carry a required `type` discriminant and no index
   * signature, so neither type is assignable to the other. Casting at each call site was the
   * alternative and it was worse: two `as unknown as` per hook, in the one place where a silent type
   * mismatch would mean the scrubber ran on the wrong shape.
   */
  return scrubbed as unknown as TEvent;
}

/**
 * Every address, token or raw-text fixture still present in a serialized event.
 *
 * The assertion form the criterion asks for, exported so the test, the web app and the worker all
 * check the same thing the same way rather than three greps drifting apart.
 */
export function leaksIn(serialized: string, rawTextFixtures: readonly string[] = []): readonly string[] {
  const found: string[] = [];

  for (const match of serialized.matchAll(EMAIL_PATTERN)) {
    if (match[0] !== REDACTED) found.push(match[0]);
  }
  for (const match of serialized.matchAll(TOKEN_PATTERN)) {
    if (match[0] !== REDACTED && !isKeptIdentifier(match[0])) found.push(match[0]);
  }
  for (const fixture of rawTextFixtures) {
    if (serialized.includes(fixture)) found.push(fixture);
  }

  return found;
}
