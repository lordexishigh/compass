import { acceptInvite, describeTokenRejection } from '@compass/auth';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../lib/auth/cookies';
import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, readJsonObject, requiredPassword, requiredString } from '../../../../lib/auth/http';

/**
 * `POST /api/seats/accept` — accepts an invitation.
 *
 * Public by necessity: the person accepting has no session yet, and the invitation token
 * is the credential. It is spent by the same not-yet-consumed UPDATE the other flows use,
 * so a double-submitted form activates the seat exactly once.
 *
 * A revoked invitation fails here — which is the acceptance criterion that revoking makes
 * the token unusable — and it fails with its own sentence, because "an owner withdrew
 * this" and "this expired" call for different next steps.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/seats/accept', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const token = requiredString(parsed.body, 'token');
  if ('response' in token) return token.response;
  const displayName = requiredString(parsed.body, 'displayName');
  if ('response' in displayName) return displayName.response;
  const password = requiredPassword(parsed.body);
  if ('response' in password) return password.response;

  try {
    const result = await acceptInvite({
      scoped: admitted.scoped,
      secret: token.value,
      displayName: displayName.value,
      password: password.value,
      now: admitted.now,
    });

    if (!result.ok) {
      return jsonError(
        `token_${result.rejection}`,
        describeTokenRejection(result.rejection, 'invite'),
        result.rejection === 'already_used' || result.rejection === 'expired' || result.rejection === 'revoked'
          ? 410
          : 400,
      );
    }

    const response = NextResponse.json(
      {
        accepted: true,
        email: result.user.email,
        displayName: result.user.displayName,
        role: result.membership.role,
        detail: 'Your seat is active and you are signed in.',
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    return setSessionCookie(response, request, result.started.secret);
  } catch (error) {
    return failure(error);
  }
}
