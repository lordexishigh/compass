import { endAllSessions, sessionDeadline, sessionRejection } from '@compass/auth';
import { listSessionsForUser } from '@compass/db';
import { NextResponse } from 'next/server';

import { clearSessionCookie } from '../../../../lib/auth/cookies';
import { guard } from '../../../../lib/auth/guard';
import { failure, jsonOk } from '../../../../lib/auth/http';

/**
 * `/api/auth/sessions` — every device this account is signed in on.
 *
 * `GET` lists them, live ones first, so "sign out everywhere" is a decision a person
 * can make with the facts rather than a button they press hopefully.
 *
 * `DELETE` ends all of them, including this one, and writes an `AuditLogEntry`. The
 * cookie is cleared on the way out: the whole point is that nothing keeps working, and
 * that has to include the browser that asked.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/sessions', action: 'GET' });
  if (!admitted.allowed) return admitted.response;
  // The matrix admits only seated principals to this route, so an identity is present.
  const identity = admitted.identity;
  if (identity === null) return failure(new Error('A seated principal reached this route without an identity.'));

  try {
    const sessions = await listSessionsForUser(admitted.scoped, identity.user.id);

    return jsonOk({
      sessions: sessions.map((session) => ({
        // The digest is a credential-shaped value; the row id is not, and it is what a
        // future "sign this one device out" would name.
        id: session.id,
        current: session.id === identity.session.id,
        issuedAt: new Date(session.issuedAt).toISOString(),
        lastUsedAt: new Date(session.lastUsedAt).toISOString(),
        endsAt: new Date(sessionDeadline(session)).toISOString(),
        revokedAt: session.revokedAt === null ? null : new Date(session.revokedAt).toISOString(),
        revokedReason: session.revokedReason,
        rotatedFromSessionId: session.rotatedFromSessionId,
        // Whether it would still be honoured, which is not the same as "nothing revoked
        // it": a session past either deadline is finished and was never revoked by anyone.
        live: sessionRejection(session, admitted.now) === null,
      })),
      live: sessions.filter((session) => sessionRejection(session, admitted.now) === null).length,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/sessions', action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;
  const identity = admitted.identity;
  if (identity === null) return failure(new Error('A seated principal reached this route without an identity.'));

  try {
    const revoked = await endAllSessions({
      scoped: admitted.scoped,
      userId: identity.user.id,
      actorUserId: identity.user.id,
      now: admitted.now,
    });

    const response = NextResponse.json(
      {
        signedOutEverywhere: true,
        sessionsEnded: revoked,
        detail: `${revoked} session${revoked === 1 ? '' : 's'} ended, including this one. Sign in again to continue.`,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    return clearSessionCookie(response, request);
  } catch (error) {
    return failure(error);
  }
}
