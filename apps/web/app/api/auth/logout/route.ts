import { endSession } from '@compass/auth';
import { NextResponse } from 'next/server';

import { clearSessionCookie } from '../../../../lib/auth/cookies';
import { guard } from '../../../../lib/auth/guard';
import { failure } from '../../../../lib/auth/http';

/**
 * `POST /api/auth/logout` — ends this session, and only this one.
 *
 * Answers 200 whether or not there was a session to end, and clears the cookie either
 * way. Signing out is the one act that must never fail: a 401 to someone who is trying
 * to leave would leave a dead cookie in their browser and no way to be rid of it.
 * Other devices are untouched — that is `DELETE /api/auth/sessions`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/logout', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  try {
    if (admitted.identity !== null) {
      await endSession({
        scoped: admitted.scoped,
        session: admitted.identity.session,
        now: admitted.now,
      });
    }

    const response = NextResponse.json(
      {
        signedOut: true,
        detail:
          admitted.identity === null
            ? 'There was no session to end. The cookie has been cleared.'
            : 'This session has ended. Other devices are still signed in — use “sign out everywhere” for those.',
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    return clearSessionCookie(response, request);
  } catch (error) {
    return failure(error);
  }
}
