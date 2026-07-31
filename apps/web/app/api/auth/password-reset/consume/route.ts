import { consumePasswordReset, describeTokenRejection } from '@compass/auth';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../../lib/auth/cookies';
import { guard } from '../../../../../lib/auth/guard';
import { failure, jsonError, readJsonObject, requiredPassword, requiredString } from '../../../../../lib/auth/http';

/**
 * `POST /api/auth/password-reset/consume` — spends a reset link and sets the password.
 *
 * The token is spent by an UPDATE whose predicate is "not yet consumed", so **a second
 * use is refused** — which is the acceptance criterion, and the reason it is a single
 * statement rather than a read followed by a write: two submissions arriving together
 * would both pass a read-then-write check.
 *
 * Setting a password ends every session the account holds. Someone resetting a password
 * usually believes somebody else has it, and leaving the intruder's session alive would
 * be the one moment the product could help and did not. A fresh session is issued for
 * the browser that did the reset, so the person is not signed out of the form they just
 * submitted.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/password-reset/consume', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const token = requiredString(parsed.body, 'token');
  if ('response' in token) return token.response;
  const password = requiredPassword(parsed.body);
  if ('response' in password) return password.response;

  try {
    const result = await consumePasswordReset({
      scoped: admitted.scoped,
      secret: token.value,
      password: password.value,
      now: admitted.now,
    });

    if (!result.ok) {
      return jsonError(
        `token_${result.rejection}`,
        describeTokenRejection(result.rejection, 'password_reset'),
        // 410 for a link that was valid and is now spent or lapsed: the request was
        // right and the resource is gone, which is what 410 means and what the reader
        // needs to know. 400 would send them looking at their own typing.
        result.rejection === 'already_used' || result.rejection === 'expired' || result.rejection === 'revoked'
          ? 410
          : 400,
      );
    }

    const response = NextResponse.json(
      {
        passwordChanged: true,
        email: result.payload.user.email,
        detail:
          'Password set, and every other session on this account has been ended. You are signed in on this device.',
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    return setSessionCookie(response, request, result.payload.started.secret);
  } catch (error) {
    return failure(error);
  }
}
