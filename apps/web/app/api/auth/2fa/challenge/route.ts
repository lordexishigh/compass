import {
  describeChallengeRejection,
  hashRecoveryCode,
  matchRecoveryCode,
  startSession,
  verifySecondFactorChallenge,
  verifyTotpCode,
} from '@compass/auth';
import {
  advanceTotpStep,
  findSecondFactor,
  listUnspentRecoveryCodeHashes,
  spendRecoveryCode,
} from '@compass/db';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../../lib/auth/cookies';
import { guard } from '../../../../../lib/auth/guard';
import { failure, jsonError, readJsonObject, requiredString } from '../../../../../lib/auth/http';
import { SIGNED_IN_LANDING_PATH } from '../../../../../lib/auth/login';
import { checkRateLimit, clearRateLimit, clientAddress } from '../../../../../lib/rate-limit';

/**
 * `POST /api/auth/2fa/challenge` — the second step of a two-factor sign-in.
 *
 * ## Why this route is `public`
 *
 * The caller has no session — that is the entire point. `/api/auth/login` verified their password and
 * deliberately minted nothing, handing back a signed challenge instead. Authorisation here is that
 * challenge plus a code, which together are strictly stronger than the cookie this route refuses to
 * require. `public` in the matrix means "no session needed", not "no proof needed".
 *
 * ## Where the replay rejection actually lives
 *
 * `verifyTotpCode` refuses a code whose step is not ahead of `lastUsedStep`, but that is only durable if
 * the accepted step is written back — otherwise the same six digits work again thirty seconds later, and
 * the guarantee exists only in a unit test that feeds the step in by hand.
 *
 * So the write comes **before** the session is minted, and it is `advanceTotpStep`'s conditional `UPDATE`
 * rather than a read-then-write: the `WHERE last_used_step IS NULL OR last_used_step < $step` predicate is
 * what makes two simultaneous submissions of one code resolve to one winner. A `false` return means some
 * other request already spent this step, which is a replay however it arrived, so it is refused here.
 *
 * Ordering the write first is deliberate. If minting the session failed afterwards, the step is spent and
 * the person signs in again — mildly annoying. The reverse order risks a session minted with the step
 * unrecorded, which is the failure that makes the code replayable. Fail-closed is the right side to err on.
 *
 * ## Why a recovery code is accepted at the same address
 *
 * It is the same question — "prove you are still you" — and the answer differs only in which credential
 * satisfies it. A separate route would double the surface for the identical decision and give an attacker
 * two places to look for an inconsistency.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/2fa/challenge';

/**
 * One sentence for every wrong code, whatever was wrong with it.
 *
 * A malformed code, a code for the wrong step, a replayed code and an unrecognised recovery code all get
 * this. Telling them apart would say which of ten recovery codes was real, or confirm that a shoulder-
 * surfed code had already been spent — both of which are facts about the credential that only somebody
 * who does not hold it needs.
 */
const REFUSED = 'That code is not right, or it has already been used. Codes work once each.';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const challenge = requiredString(parsed.body, 'challenge');
  if ('response' in challenge) return challenge.response;
  const code = requiredString(parsed.body, 'code');
  if ('response' in code) return code.response;

  const verdict = verifySecondFactorChallenge({ challenge: challenge.value, now: admitted.now });
  if (!verdict.ok) {
    return jsonError(
      verdict.reason === 'unconfigured' ? 'second_factor_unconfigured' : 'challenge_rejected',
      describeChallengeRejection(verdict.reason),
      verdict.reason === 'unconfigured' ? 503 : 401,
    );
  }

  /**
   * Rate limited on the code, separately from the password.
   *
   * Six digits is a million possibilities, which is a number a script reaches in an afternoon if nothing
   * counts the attempts. The password limiter upstream cannot help: this request carries no password, and
   * an attacker who holds one valid challenge can hammer this address without touching `/login` again.
   * Counted against the user the challenge names, so one account's attack cannot be spread across
   * addresses.
   */
  const subjects = { ip: clientAddress(request), account: verdict.userId };
  const limited = checkRateLimit({ action: 'auth_attempt', subjects, now: admitted.now });
  if (!limited.allowed) {
    return limited.response ?? jsonError('rate_limited', 'Too many code attempts.', 429);
  }

  try {
    const secondFactor = await findSecondFactor(admitted.scoped, verdict.userId);

    // A challenge for a user with no active enrollment cannot be satisfied. It also cannot legitimately
    // exist — the login route only issues one when `activatedAt` is set — so this is the 2FA having been
    // disabled in between, and the honest answer is to start over rather than to sign them in.
    if (secondFactor === null || secondFactor.activatedAt === null) {
      return jsonError('challenge_rejected', describeChallengeRejection('expired'), 401);
    }

    const totp = verifyTotpCode({
      secret: secondFactor.secret,
      code: code.value,
      now: admitted.now,
      lastUsedStep: secondFactor.lastUsedStep,
    });

    let usedRecoveryCode = false;

    if (totp.ok) {
      // The durable half of the replay guarantee. See the note above on why it precedes the session.
      const advanced = await advanceTotpStep(admitted.scoped, { userId: verdict.userId, step: totp.step }, admitted.now);
      if (!advanced) return jsonError('code_rejected', REFUSED, 401);
    } else {
      /**
       * Only unspent hashes are offered to `matchRecoveryCode`.
       *
       * That is what makes a recovery code single-use at all: a spent code that stayed in the candidate
       * list would keep matching for ever, and `spendRecoveryCode`'s `WHERE used_at IS NULL` would be the
       * only thing standing between a leaked printout and an account.
       */
      const unspent = await listUnspentRecoveryCodeHashes(admitted.scoped, verdict.userId);
      const matched = matchRecoveryCode({ code: code.value, hashes: unspent });

      if (matched === null) return jsonError('code_rejected', REFUSED, 401);

      // The conditional `UPDATE` is the single-use guarantee under concurrency; `false` means somebody
      // else spent it first, which is a refusal rather than a race we resolve in the caller's favour.
      const spent = await spendRecoveryCode(
        admitted.scoped,
        { userId: verdict.userId, codeHash: hashRecoveryCode(code.value) },
        admitted.now,
      );
      if (!spent) return jsonError('code_rejected', REFUSED, 401);

      usedRecoveryCode = true;
    }

    clearRateLimit('auth_attempt', subjects);

    /**
     * The session, minted here and nowhere else in this flow.
     *
     * `startSession` is the same function `/api/auth/login` calls, so rotation and both TTLs are inherited
     * by construction rather than by two call sites agreeing — a two-factor session is a session, and one
     * that expired on a different schedule would be a quiet second policy nobody had decided on.
     */
    const started = await startSession({
      scoped: admitted.scoped,
      userId: verdict.userId,
      now: admitted.now,
    });

    const response = NextResponse.json(
      {
        signedIn: true,
        sessionExpiresAt: new Date(started.session.expiresAt).toISOString(),
        redirect: SIGNED_IN_LANDING_PATH,
        /**
         * Stated, because a person who has just spent a recovery code has one fewer than they think and
         * the only moment they will read about it is now.
         */
        usedRecoveryCode,
        ...(usedRecoveryCode
          ? {
              detail:
                'You signed in with a recovery code, so that code is now spent. Generate a new set from ' +
                'your account screen if you are running low.',
            }
          : {}),
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    return setSessionCookie(response, request, started.secret);
  } catch (error) {
    return failure(error);
  }
}
