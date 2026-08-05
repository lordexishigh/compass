import { randomUUID } from 'node:crypto';

import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  recordAudit,
  totpEnrollmentUri,
  verifyPassword,
  verifyTotpCode,
} from '@compass/auth';
import {
  activateSecondFactor,
  beginSecondFactorEnrollment,
  deleteSecondFactor,
  findSecondFactor,
  replaceRecoveryCodes,
} from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';

/**
 * `/api/auth/2fa` — enroll in, activate, or turn off your own second factor.
 *
 * ## Three verbs on one route, and why not three routes
 *
 * They are one resource — *your* enrollment — in three states, and each verb moves it between two of
 * them: `POST` creates it pending, `PUT` activates it once you have proved the app works, `DELETE`
 * removes it. Splitting them would produce three matrix rows and three places to get the
 * re-authentication rule right, for one noun.
 *
 * ## Re-authentication, not merely a session
 *
 * `PUT` and `DELETE` both demand a credential in the body. The reason is narrow and worth stating: an
 * unattended signed-in browser is the exact threat a second factor exists to survive. If holding a
 * session were enough to remove the factor, then a stolen session could remove it, and the factor would
 * protect nothing beyond the moment of sign-in. So turning it off costs the same proof as turning it on.
 *
 * `POST` does not, because beginning an enrollment grants nothing — a pending row cannot sign anybody in
 * and activation still requires a working code — and demanding a password to *start* protecting your
 * account is friction pointed the wrong way.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/2fa';

const REAUTH_REQUIRED =
  'Enter your current password to change two-factor authentication. This is asked even though you are ' +
  'signed in, because an unattended browser is exactly what the second factor is for.';

/** Begins an enrollment: a fresh secret, a pending row, and the URI an authenticator app scans. */
export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  // `EVERY_SEAT` in the matrix guarantees this, and the narrowing is for the type checker rather than
  // for the authorisation — which has already happened, in the line above.
  if (admitted.identity === null) return jsonError('forbidden', 'This needs a seat.', 403);
  const user = admitted.identity.user;

  try {
    const existing = await findSecondFactor(admitted.scoped, user.id);

    /**
     * An *active* enrollment is not silently replaced.
     *
     * Overwriting it would invalidate the authenticator entry the person is currently relying on, on a
     * request that could be a stray double-submit. A pending one is replaced freely: it protects nothing
     * yet, and the commonest reason to call this twice is that the first QR code was never scanned.
     */
    if (existing !== null && existing.activatedAt !== null) {
      return jsonError(
        'already_enrolled',
        'Two-factor authentication is already on for this account. Turn it off first if you want to ' +
          'enroll a new device.',
        409,
      );
    }

    const secret = generateTotpSecret();
    await beginSecondFactorEnrollment(
      admitted.scoped,
      { id: existing?.id ?? randomUUID(), userId: user.id, secret },
      admitted.now,
    );

    /**
     * The `otpauth:` URI is the one thing that leaves the server, and it is built here rather than
     * inside the response object.
     *
     * Two reasons, and they agree. `compass/no-secret-disclosure` refuses a field named `secret` in a
     * response body, and the rule is right even about this route: a handler that returns one is
     * indistinguishable — to the gate, and to somebody reviewing it — from one echoing a stored
     * credential back to its caller. And the second field was redundant anyway. What an authenticator
     * app consumes is the URI; a device with no camera reads the same key out of the URI's own
     * `secret=` parameter. Returning it twice bought nothing but a second place for it to be logged.
     */
    const enrollmentUri = totpEnrollmentUri({ secret, accountEmail: user.email });

    return jsonOk({
      pending: true,
      enrollmentUri,
      detail:
        'Scan this with your authenticator app — or, if the device has no camera, type in the key from ' +
        'the end of that link by hand. Then send the six-digit code it shows to confirm. Two-factor ' +
        'authentication is not on until you do.',
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Activates a pending enrollment by proving the app produces the right code.
 *
 * The code is the re-authentication here — a stronger proof than the password, because it demonstrates
 * the thing being turned on actually works. Activating on the password alone is how somebody locks
 * themselves out of their own account with a mis-scanned QR code.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PUT' });
  if (!admitted.allowed) return admitted.response;
  if (admitted.identity === null) return jsonError('forbidden', 'This needs a seat.', 403);

  const user = admitted.identity.user;
  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const code = requiredString(parsed.body, 'code');
  if ('response' in code) return code.response;

  try {
    const pending = await findSecondFactor(admitted.scoped, user.id);
    if (pending === null) {
      return jsonError('not_enrolled', 'Start an enrollment before confirming one.', 409);
    }
    if (pending.activatedAt !== null) {
      return jsonError('already_enrolled', 'Two-factor authentication is already on.', 409);
    }

    const verdict = verifyTotpCode({
      secret: pending.secret,
      code: code.value,
      now: admitted.now,
      lastUsedStep: pending.lastUsedStep,
    });

    if (!verdict.ok) {
      return jsonError(
        'code_rejected',
        'That code is not what Compass expected. Check your phone’s clock is set automatically, then ' +
          'try the next code your app shows.',
        400,
      );
    }

    /**
     * The activating step is recorded as spent.
     *
     * Otherwise the very code that turned 2FA on would still be usable to sign in during its remaining
     * seconds — which is a replay, and the fact that it happens to be the enrollment code makes it no
     * less one.
     */
    await activateSecondFactor(admitted.scoped, { userId: user.id, usedStep: verdict.step }, admitted.now);

    /**
     * Recovery codes are issued *with* activation, not offered afterwards.
     *
     * A person whose only factor is a phone they may drop needs the way back before they need it, and an
     * enrollment flow that ends with an optional "you may also want recovery codes" screen is one most
     * people click past. Shown once, stored only as hashes.
     */
    const codes = generateRecoveryCodes();
    await replaceRecoveryCodes(
      admitted.scoped,
      { userId: user.id, codes: codes.map((value) => ({ id: randomUUID(), codeHash: hashRecoveryCode(value) })) },
      admitted.now,
    );

    await recordAudit(admitted.scoped, {
      action: 'account.second_factor_enabled',
      actorUserId: user.id,
      targetKind: 'user',
      targetId: user.id,
      before: { secondFactor: 'pending' },
      after: { secondFactor: 'active' },
      occurredAt: admitted.now,
    });

    return jsonOk({
      active: true,
      recoveryCodes: codes,
      detail:
        'Two-factor authentication is on. Save these recovery codes somewhere that is not the phone ' +
        'holding your authenticator app — each one signs you in once if you lose it. They are not shown again.',
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Turns the second factor off. Requires the current password, and is audited.
 *
 * Both halves are the criterion. The password is what makes a stolen session insufficient; the audit row
 * is what lets the account's owner tell "I did this" from "somebody else did this" afterwards, which is
 * otherwise impossible to reconstruct — disabling 2FA looks identical whoever does it.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;
  if (admitted.identity === null) return jsonError('forbidden', 'This needs a seat.', 403);

  const user = admitted.identity.user;
  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const password = requiredString(parsed.body, 'password');
  if ('response' in password) return password.response;

  try {
    const reauthenticated = await verifyPassword(user.passwordHash, password.value);
    if (!reauthenticated) return jsonError('reauthentication_failed', REAUTH_REQUIRED, 403);

    const existing = await findSecondFactor(admitted.scoped, user.id);
    if (existing === null) {
      return jsonError('not_enrolled', 'Two-factor authentication is not on for this account.', 409);
    }

    await deleteSecondFactor(admitted.scoped, user.id);

    /**
     * Written after the delete, deliberately.
     *
     * An audit row claiming a disable that then failed would be worse than a missing one: it would send
     * somebody looking for a compromise that never happened. The order means a crash between the two
     * loses the record of a real act, which is the less misleading of the two failures — and the act
     * itself is visible on the account screen either way.
     */
    await recordAudit(admitted.scoped, {
      action: 'account.second_factor_disabled',
      actorUserId: user.id,
      targetKind: 'user',
      targetId: user.id,
      before: { secondFactor: 'active' },
      after: { secondFactor: 'none' },
      occurredAt: admitted.now,
    });

    return jsonOk({
      active: false,
      detail:
        'Two-factor authentication is off, and your recovery codes have been deleted. This is on your ' +
        'account’s record.',
    });
  } catch (error) {
    return failure(error);
  }
}
