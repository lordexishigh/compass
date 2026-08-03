import { describeLoginFailure, startSession, verifyLogin } from '@compass/auth';
import { normalizeEmail } from '@compass/db';
import { NextResponse } from 'next/server';

import { checkRateLimit, clearRateLimit, clientAddress, notifyLockout } from '../rate-limit';

import { setSessionCookie } from './cookies';
import { baseUrlFor, type GuardAllowed } from './guard';
import { failure, jsonError, readJsonObject, requiredPassword, requiredString } from './http';

/**
 * Signing in, once, for both addresses that offer it.
 *
 * ## Why this is a module and not a handler
 *
 * Two routes accept these credentials — `/api/auth/login`, which is where the sign-in
 * form posts, and `/login`, which is the short address published in
 * `.nous/demo_account.json` for a verification harness. They must be the *same*
 * sign-in: two copies of this logic would eventually differ in the one way that matters
 * and nothing would notice, because a difference in how a session is minted does not look
 * like a bug from outside — it looks like one of the two addresses being slightly wrong
 * about who you are.
 *
 * So the body lives here and each route is a guard call plus a call to this. The guard
 * call deliberately stays *in* the route: `tests/auth-http.test.ts` requires `guard()` to
 * be the first statement of every handler, and it is right to — a shared helper that took
 * the raw request and did its own authorisation would put the one decision that must be
 * visible per-route inside a function nobody reads per-route.
 */

/**
 * Where a signed-in reader is sent.
 *
 * The report, not an account screen or a dashboard: somebody who has just proved who they
 * are wants the thing they came for. Named here rather than written into two responses so
 * the harness's `redirect` and the form's own navigation cannot disagree.
 */
export const SIGNED_IN_LANDING_PATH = '/';

/**
 * Where the lockout notice points an owner.
 *
 * The account screen, and deliberately not an unlock link: a "restore access" link mailed to an
 * inbox is a bypass of the lockout worth exactly as much as that inbox.
 *
 * `baseUrlFor` refuses to guess an origin from a request header — `guard.ts` explains why at
 * length — and it throws when `COMPASS_BASE_URL` is unset on a non-loopback host. A notice that
 * could not be addressed must not take the 429 down with it, so the fallback is a bare path: the
 * mail is then slightly less useful and the lockout still holds, which is the correct order of
 * priorities.
 */
function lockoutNoticeUrl(request: Request): string {
  try {
    return `${baseUrlFor(request)}/account`;
  } catch {
    return '/account';
  }
}

/**
 * Verifies the credentials in the body and mints a session.
 *
 * `admitted` is the *result* of the route's own guard call, which is what makes the
 * matrix decision visible at the route and the session logic shared. Everything that can
 * go wrong is answered with the sentence that says what to do about it:
 *
 *  - a body that is not JSON, or is missing a field, is a 400 naming the field;
 *  - a wrong address and a wrong password are the same 401 with the same sentence, because
 *    telling them apart would publish which addresses have seats here — `verifyLogin`
 *    performs a decoy Argon2id verification on the unknown-address branch so the *timing*
 *    does not publish it either;
 *  - a pending or revoked seat is a 403, because the credentials were right and what the
 *    reader has to do about it is different.
 */
export async function completeLogin(request: Request, admitted: GuardAllowed): Promise<NextResponse> {
  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const email = requiredString(parsed.body, 'email');
  if ('response' in email) return email.response;
  const password = requiredPassword(parsed.body);
  if ('response' in password) return password.response;

  /**
   * The rate limit, counted before a single Argon2id verification is performed.
   *
   * Position matters twice over. Before `verifyLogin`, because the criterion says a refused
   * request SHALL NOT perform the action — and here the action is the expensive one: Argon2id is
   * tuned to take tens of milliseconds, so an unlimited sign-in endpoint is a CPU exhaustion
   * vector quite apart from being a password oracle. After the body is parsed, because the
   * per-account counter needs the address, and a malformed body has not attempted anything.
   *
   * Counted against the address *normalised*, so `Priya@Example.com` and `priya@example.com` are
   * one account rather than two allowances — `verifyLogin` normalises before it looks the user
   * up, and a counter that did not would be trivially bypassed by changing the capitalisation.
   */
  const subjects = { ip: clientAddress(request), account: normalizeEmail(email.value) };
  const limited = checkRateLimit({ action: 'auth_attempt', subjects, now: admitted.now });

  if (!limited.allowed) {
    if (limited.lockoutBegan) {
      // The transition only, so a caller who keeps hammering cannot use this as an outbound
      // mail amplifier aimed at the owners' inboxes.
      await notifyLockout({
        scoped: admitted.scoped,
        subjectEmail: normalizeEmail(email.value),
        strikes: limited.strikes,
        retryAfterSeconds: limited.retryAfterSeconds,
        accountUrl: lockoutNoticeUrl(request),
      });
    }
    return limited.response ?? jsonError('rate_limited', 'Too many sign-in attempts.', 429);
  }

  try {
    const result = await verifyLogin({ scoped: admitted.scoped, email: email.value, password: password.value });

    if (!result.ok) {
      return jsonError(
        result.failure,
        describeLoginFailure(result.failure),
        result.failure === 'seat_not_active' ? 403 : 401,
      );
    }

    // A correct credential proves the caller was never guessing, so the pressure counters go.
    // `lib/rate-limit.ts` argues the case for this in full.
    clearRateLimit('auth_attempt', subjects);

    const started = await startSession({
      scoped: admitted.scoped,
      userId: result.user.id,
      now: admitted.now,
    });

    const response = NextResponse.json(
      {
        signedIn: true,
        email: result.user.email,
        displayName: result.user.displayName,
        role: result.membership.role,
        sessionExpiresAt: new Date(started.session.expiresAt).toISOString(),
        /**
         * Where to go next, stated rather than assumed.
         *
         * A harness that has just signed in needs to know which page is the report, and
         * inferring it from a convention is how a verification script ends up asserting
         * against the wrong screen. Same value for both routes.
         */
        redirect: SIGNED_IN_LANDING_PATH,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    return setSessionCookie(response, request, started.secret);
  } catch (error) {
    return failure(error);
  }
}
