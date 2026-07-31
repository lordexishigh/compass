import { describeLoginFailure, startSession, verifyLogin } from '@compass/auth';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../lib/auth/cookies';
import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, readJsonObject, requiredPassword, requiredString } from '../../../../lib/auth/http';

/**
 * `POST /api/auth/login` — email and password in, session cookie out.
 *
 * On success this answers 200 and sets an `httpOnly; Secure; SameSite=Lax` cookie
 * whose value is a fresh 256-bit secret. Only the SHA-256 of that secret reaches the
 * database, so the row cannot be turned back into a working session.
 *
 * A wrong address and a wrong password produce the same 401 and the same sentence:
 * distinguishing them would publish which addresses have accounts here. The
 * unknown-address branch still performs one Argon2id verification against a decoy
 * hash, so the *timing* does not publish it either.
 */
export const dynamic = 'force-dynamic';
// Argon2id is a native addon. It cannot load on the Edge runtime, and a route that
// hashed a password there would fail at build time rather than at request time.
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/login', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const email = requiredString(parsed.body, 'email');
  if ('response' in email) return email.response;
  const password = requiredPassword(parsed.body);
  if ('response' in password) return password.response;

  try {
    const result = await verifyLogin({ scoped: admitted.scoped, email: email.value, password: password.value });

    if (!result.ok) {
      return jsonError(
        result.failure,
        describeLoginFailure(result.failure),
        // A pending seat is a 403: the credentials were right and the seat is not
        // ready, which is a different thing for the reader to do about it.
        result.failure === 'seat_not_active' ? 403 : 401,
      );
    }

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
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    return setSessionCookie(response, request, started.secret);
  } catch (error) {
    return failure(error);
  }
}
