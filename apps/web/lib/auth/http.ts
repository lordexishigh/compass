import { AuthRequestError, WeakPasswordError } from '@compass/auth';
import { LastOwnerError, SeatNotFoundError } from '@compass/auth';
import { PrivateConversationError } from '@compass/db';
import {
  IdentityClaimedError,
  InvalidAbsenceError,
  InvalidCalendarError,
  UnknownDeveloperError,
  UnmatchedIdentityNotFoundError,
} from '@compass/knowledge-model';
import { NextResponse } from 'next/server';

/**
 * The shapes every auth and seat endpoint answers with.
 *
 * Two rules, and they are the reason this is a module rather than a habit:
 *
 *  - **Nothing here is cached, ever.** A `cache-control` header on a response that
 *    depends on a session is a way to serve one person's seat list to the next
 *    request through a shared proxy.
 *  - **Every failure names the field or the condition.** These are the forms a human
 *    types into, and an unexplained 500 makes the whole feature feel broken rather
 *    than the request wrong. `failure` maps the domain errors onto statuses so no
 *    handler has to remember which is which.
 */

export const NO_STORE = { 'cache-control': 'no-store' } as const;

export const jsonOk = <T>(body: T, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: NO_STORE });

export const jsonError = (error: string, detail: string, status: number): NextResponse =>
  NextResponse.json({ error, detail }, { status, headers: NO_STORE });

/**
 * Reads a JSON object body, or returns the response that says why it could not.
 *
 * A form posted with the wrong content type, an empty body and an array body are all
 * real mistakes with different fixes, so they get different sentences.
 */
export async function readJsonObject(
  request: Request,
): Promise<{ readonly body: Record<string, unknown> } | { readonly response: NextResponse }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { response: jsonError('invalid_body', 'The request body must be JSON.', 400) };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      response: jsonError('invalid_body', 'The request body must be a JSON object of fields.', 400),
    };
  }

  return { body: parsed as Record<string, unknown> };
}

/**
 * True when the body is an HTML form submission rather than a JSON API call.
 *
 * The distinction decides two things at once — how the body is read *and* how the reply is shaped —
 * so it is one predicate rather than two guesses. A browser that submitted a `<form>` needs a 303 it
 * can follow; a JSON caller needs a JSON body and would be broken by a redirect.
 */
export const isFormSubmission = (request: Request): boolean =>
  (request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');

/**
 * Reads a body posted either as JSON or as an HTML form.
 *
 * ## Why this exists
 *
 * Compass's billing screens are Server Components with no client JavaScript — the same posture the
 * report surfaces take — so the plan buttons are real `<form method="post">` elements. A native form
 * submission sends `application/x-www-form-urlencoded`, which `readJsonObject` rejects with a 400: the
 * checkout flow could not be started from the UI at all, because the only caller the route accepted
 * was one nothing in the product was making.
 *
 * Every value from a form arrives as a string, which is exactly what the callers of this helper want —
 * they validate against closed vocabularies (`isPlanId`) rather than coercing types. A `File` entry is
 * dropped rather than stringified into `"[object File]"`: no billing form uploads anything, and a
 * silent coercion would turn a mistake into a plausible-looking value.
 */
export async function readFormOrJsonObject(
  request: Request,
): Promise<{ readonly body: Record<string, unknown> } | { readonly response: NextResponse }> {
  if (!isFormSubmission(request)) return readJsonObject(request);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { response: jsonError('invalid_body', 'The form body could not be read.', 400) };
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') body[key] = value;
  }
  return { body };
}

/**
 * The reply a form submission needs: a 303 to where the browser should land next.
 *
 * 303 rather than 302 specifically. A 303 tells the browser to follow with **GET**, which is what
 * turns a POST of a plan choice into a navigation to Stripe Checkout; a 302 leaves the method
 * implementation-defined and browsers have historically re-POSTed it.
 */
export const seeOther = (location: string): NextResponse =>
  NextResponse.redirect(location, { status: 303, headers: NO_STORE });

/**
 * A 303 to a path on this deployment, resolved against the request.
 *
 * `NextResponse.redirect` requires an absolute URL, and the origin is taken from `request.url` rather
 * than from a header: this is only ever used to send the owner back to a Compass page they are already
 * on, so the request's own origin is the correct and the only safe answer. `COMPASS_BASE_URL` is what
 * mailed links use, and deliberately not this — a redirect that left the deployment the owner was
 * looking at would be the surprise, not the fix.
 */
export const seeOtherPath = (request: Request, path: string): NextResponse =>
  seeOther(new URL(path, request.url).toString());

/** A required string field, trimmed, or the sentence naming it. */
export function requiredString(
  body: Record<string, unknown>,
  field: string,
): { readonly value: string } | { readonly response: NextResponse } {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { response: jsonError('invalid_request', `\`${field}\` is required.`, 400) };
  }
  return { value: raw.trim() };
}

/**
 * A password field, taken verbatim.
 *
 * Not trimmed: leading and trailing spaces are legitimate characters in a password,
 * and silently stripping them means the password that was set is not the password
 * that will be accepted. Length is checked in `@compass/auth`, which owns the floor.
 */
export function requiredPassword(
  body: Record<string, unknown>,
  field = 'password',
): { readonly value: string } | { readonly response: NextResponse } {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.length === 0) {
    return { response: jsonError('invalid_request', `\`${field}\` is required.`, 400) };
  }
  return { value: raw };
}

/** An optional list of team keys. Absent means "leave the scopes alone". */
export function optionalTeamKeys(
  body: Record<string, unknown>,
  field = 'teamKeys',
): { readonly value: readonly string[] | undefined } | { readonly response: NextResponse } {
  const raw = body[field];
  if (raw === undefined) return { value: undefined };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    return {
      response: jsonError(
        'invalid_request',
        `\`${field}\` must be an array of team keys, e.g. ["platform"]. Send an empty array to remove every scope.`,
        400,
      ),
    };
  }
  return { value: (raw as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0) };
}

/**
 * The deployment cannot say where a mailed link should point.
 *
 * Its own class because it is neither the caller's fault nor a transient fault: it is a
 * missing configuration value, and the sentence that names the variable is safe to return
 * — it describes this deployment's setup, not a driver's internals. Lives here rather
 * than in `guard.ts` so `failure()` can recognise it without `http.ts` importing
 * `guard.ts`, which would be a cycle.
 */
export class LinkOriginUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'LinkOriginUnavailableError';
    this.detail = detail;
  }
}

/**
 * An un-merge named a merge that is not in the audit log.
 *
 * Lives here rather than in `lib/roster-source.ts` so `failure()` can recognise it. The
 * dependency only runs one way: `roster-source.ts` imports `@compass/auth`, and this module
 * is imported by `guard.ts`, so an import in the other direction would be a cycle. The class
 * is re-exported from `roster-source.ts`, which is where callers expect to find it.
 *
 * A 404 rather than a 503, which is the whole reason it is registered: the request was
 * well-formed and the *id* is the problem, and the sentence says why a guess is not an
 * option. Falling through to the generic branch told the caller Compass could not reach its
 * own records — sending them to look at the database when the fix is the identifier they sent.
 */
export class MergeRecordNotFoundError extends Error {
  readonly detail: string;

  constructor(auditId: string) {
    const detail =
      `No merge record \`${auditId}\` is in the audit log for this organization, so there is nothing to undo. ` +
      'An un-merge restores the attribution the merge itself recorded; without that record it could only guess, ' +
      'and a guessed restoration is not one.';
    super(detail);
    this.name = 'MergeRecordNotFoundError';
    this.detail = detail;
  }
}

/**
 * A retention or anonymization request Compass will not carry out.
 *
 * Declared here rather than in `lib/privacy-source.ts` for the same reason
 * `MergeRecordNotFoundError` is: `failure()` has to recognise it, and this module is
 * imported by `guard.ts` — so an import in the other direction would be a cycle. Both
 * classes are re-exported from `privacy-source.ts`, which is where a caller expects them.
 */
export class InvalidRetentionError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidRetentionError';
    this.detail = detail;
  }
}

/**
 * A second deletion was requested while one was already in its grace period.
 *
 * A 409 naming the existing deadline, because two overlapping requests would mean two undo
 * links of which only one worked — and the person holding the dead one would believe they
 * had cancelled.
 */
export class DeletionAlreadyPendingError extends Error {
  readonly detail: string;

  constructor(graceEndsOn: string) {
    const detail =
      `A deletion is already pending and its grace period ends on ${graceEndsOn}. Cancel that one first if you ` +
      'want to start over — two overlapping requests would mean two undo links, only one of which worked.';
    super(detail);
    this.name = 'DeletionAlreadyPendingError';
    this.detail = detail;
  }
}

/**
 * The one sentence an unexpected failure is allowed to say.
 *
 * A driver or connection error's `message` carries host, port, user and sometimes the
 * database name. `/api/auth/login`, `/api/auth/magic-link` and
 * `/api/auth/password-reset` are public, so returning it would hand an unauthenticated
 * caller a description of the infrastructure. The detail is logged instead, where an
 * operator can read it and a stranger cannot.
 */
export const UNAVAILABLE_SENTENCE =
  'Compass could not reach its own records, so nothing was changed. This is a fault on our side, not a problem ' +
  'with your request. `/api/health` names which capability is unavailable.';

/**
 * Maps a thrown domain error onto a response.
 *
 * `LastOwnerError` is a 409 and not a 400: the request was well formed and the *state*
 * is the problem, and the message says what to do instead. A 400 would read as "you
 * sent something wrong", which sends the reader looking at their JSON.
 *
 * The typed branches all state the caller's *own* request back to them, which is exactly
 * what they need. The final branch does not: an unrecognised error came from underneath
 * this layer, and its message is not the caller's business.
 */
export function failure(error: unknown): NextResponse {
  if (error instanceof LastOwnerError) {
    return jsonError('last_owner', error.detail, 409);
  }
  if (error instanceof SeatNotFoundError) {
    return jsonError('seat_not_found', error.detail, 404);
  }
  if (error instanceof WeakPasswordError) {
    return jsonError('weak_password', error.detail, 400);
  }
  if (error instanceof AuthRequestError) {
    return jsonError('invalid_request', error.detail, 400);
  }
  if (error instanceof LinkOriginUnavailableError) {
    return jsonError('link_origin_unconfigured', error.detail, 503);
  }
  if (error instanceof MergeRecordNotFoundError) {
    return jsonError('merge_record_not_found', error.detail, 404);
  }

  /**
   * The roster service's own refusals.
   *
   * Unregistered, each of these fell through to the 503 below, so a caller-fixable request —
   * an absence ending before it starts, a calendar with no working days, an identifier already
   * held by somebody else — was reported as Compass being unable to reach its own records.
   * That is worse than an unhelpful message: it points the reader at the infrastructure and at
   * `/api/health`, where they would find nothing wrong, while the sentence that names the
   * actual fix was logged and thrown away. Each class already carries a `detail` written to be
   * read by the person who sent the request; these branches are what let it reach them.
   *
   * The statuses follow the same rule as `LastOwnerError` above. The two validation errors are
   * 400 — the body is wrong. `IdentityClaimedError` is 409, because the request was well
   * formed and the *state* is the problem: the identifier is held, and the detail says to
   * remove the existing link first. `UnmatchedIdentityNotFoundError` is 404 — the queue entry
   * named does not exist, which is a fact about the id, not about the request's shape.
   */
  if (error instanceof InvalidAbsenceError) {
    return jsonError('invalid_absence', error.detail, 400);
  }
  if (error instanceof InvalidCalendarError) {
    return jsonError('invalid_calendar', error.detail, 400);
  }
  if (error instanceof IdentityClaimedError) {
    return jsonError('identity_claimed', error.detail, 409);
  }
  if (error instanceof UnmatchedIdentityNotFoundError) {
    return jsonError('unmatched_identity_not_found', error.detail, 404);
  }

  /**
   * The privacy refusals.
   *
   * Statuses on the same rule as the ones above. `PrivateConversationError` is a **409**
   * rather than a 400: the body is well formed and the state of the world is the problem —
   * the conversation is private, and no correction to the JSON changes that. A 400 would
   * send a manager looking at their request when what they need to read is that direct
   * messages are outside what Compass reads at all.
   *
   * `DeletionAlreadyPendingError` is a 409 for the same reason, and it names the date the
   * existing grace period ends, which is the one fact that makes the refusal actionable.
   *
   * `UnknownDeveloperError` is a 404 — the key names nobody — and it says that anonymization
   * is keyed on the person rather than on a name precisely so two people called Marcus
   * cannot be confused.
   */
  if (error instanceof PrivateConversationError) {
    return jsonError('private_conversation', error.message, 409);
  }
  if (error instanceof DeletionAlreadyPendingError) {
    return jsonError('deletion_already_pending', error.detail, 409);
  }
  if (error instanceof InvalidRetentionError) {
    return jsonError('invalid_retention', error.detail, 400);
  }
  if (error instanceof UnknownDeveloperError) {
    return jsonError('developer_not_found', error.detail, 404);
  }

  // Logged, never returned. `no-console` allows `error` for exactly this.
  console.error(
    `[compass] unhandled request failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );

  return jsonError('unavailable', UNAVAILABLE_SENTENCE, 503);
}
