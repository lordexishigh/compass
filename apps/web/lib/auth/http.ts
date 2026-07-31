import { AuthRequestError, WeakPasswordError } from '@compass/auth';
import { LastOwnerError, SeatNotFoundError } from '@compass/auth';
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
 * Maps a thrown domain error onto a response.
 *
 * `LastOwnerError` is a 409 and not a 400: the request was well formed and the *state*
 * is the problem, and the message says what to do instead. A 400 would read as "you
 * sent something wrong", which sends the reader looking at their JSON.
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
  return jsonError(
    'unavailable',
    error instanceof Error ? error.message : 'The request could not be completed.',
    503,
  );
}
