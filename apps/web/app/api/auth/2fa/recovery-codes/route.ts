import { randomUUID } from 'node:crypto';

import { generateRecoveryCodes, hashRecoveryCode, recordAudit, verifyPassword } from '@compass/auth';
import { findSecondFactor, replaceRecoveryCodes } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../../lib/auth/http';

/**
 * `POST /api/auth/2fa/recovery-codes` — replace your recovery codes with a fresh batch.
 *
 * ## Why replace rather than top up
 *
 * Because the codes live on paper, and somebody who regenerates has almost always concluded that the old
 * paper is compromised or lost. Appending would leave those old codes live while the screen implied a
 * clean slate, which is the failure mode that makes the feature actively harmful. `replaceRecoveryCodes`
 * deletes and re-inserts for exactly this reason.
 *
 * ## Why re-authentication
 *
 * The output of this endpoint is ten credentials that each bypass the authenticator app. Reaching it with
 * a session alone would mean a stolen session yields a permanent set of 2FA bypasses — quieter and more
 * durable than disabling the factor outright, because the account's owner sees nothing different.
 *
 * ## Shown once
 *
 * Only hashes are stored, so there is no second chance to display them and no query an operator could run
 * to recover one. That is the property that makes a database dump not a set of working bypasses.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/2fa/recovery-codes';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;
  if (admitted.identity === null) return jsonError('forbidden', 'This needs a seat.', 403);

  const user = admitted.identity.user;
  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const password = requiredString(parsed.body, 'password');
  if ('response' in password) return password.response;

  try {
    const reauthenticated = await verifyPassword(user.passwordHash, password.value);
    if (!reauthenticated) {
      return jsonError(
        'reauthentication_failed',
        'Enter your current password to generate new recovery codes.',
        403,
      );
    }

    // Recovery codes are the way back *past* an authenticator app. Issuing them to an account with no
    // active enrollment would be issuing bypasses for a factor that is not there.
    const enrollment = await findSecondFactor(admitted.scoped, user.id);
    if (enrollment === null || enrollment.activatedAt === null) {
      return jsonError(
        'not_enrolled',
        'Turn on two-factor authentication first — recovery codes are the way back into an account that ' +
          'has it.',
        409,
      );
    }

    const codes = generateRecoveryCodes();
    await replaceRecoveryCodes(
      admitted.scoped,
      {
        userId: user.id,
        codes: codes.map((value) => ({ id: randomUUID(), codeHash: hashRecoveryCode(value) })),
      },
      admitted.now,
    );

    await recordAudit(admitted.scoped, {
      action: 'account.recovery_codes_regenerated',
      actorUserId: user.id,
      targetKind: 'user',
      targetId: user.id,
      before: null,
      after: { issued: codes.length },
      occurredAt: admitted.now,
    });

    return jsonOk({
      recoveryCodes: codes,
      detail:
        'These replace every code you had — the old ones no longer work. Save them somewhere that is not ' +
        'the phone holding your authenticator app. They are not shown again.',
    });
  } catch (error) {
    return failure(error);
  }
}
