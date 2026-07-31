import { ROLE_CAPABILITIES, sessionDeadline } from '@compass/auth';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonOk } from '../../../../lib/auth/http';

/**
 * `GET /api/auth/session` — who this request is.
 *
 * Answers 200 with `{ signedIn: false }` rather than 401 when there is no session. This
 * is the route a client calls to *find out* whether it is signed in, and answering 401
 * to that question would make "not signed in" indistinguishable from "this endpoint is
 * broken".
 *
 * The role is read from the membership on every request, never from the session, which
 * is why a role changed a moment ago is in force here immediately.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/session', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    if (admitted.identity === null) {
      return jsonOk({ signedIn: false, principal: 'public' as const });
    }

    const { user, membership, session, teamScopes } = admitted.identity;

    return jsonOk({
      signedIn: true,
      principal: membership.role,
      email: user.email,
      displayName: user.displayName,
      role: membership.role,
      roleCapabilities: ROLE_CAPABILITIES[membership.role],
      seatStatus: membership.status,
      hasPassword: user.passwordHash !== null,
      // Owners are unscoped by design; an empty list here means "every team".
      teamKeys: teamScopes,
      unscoped: membership.role === 'owner',
      sessionIssuedAt: new Date(session.issuedAt).toISOString(),
      sessionEndsAt: new Date(sessionDeadline(session)).toISOString(),
    });
  } catch (error) {
    return failure(error);
  }
}
