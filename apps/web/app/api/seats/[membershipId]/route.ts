import { changeSeat, isSeatRole, readSeats, removeSeat, revokeInvite } from '@compass/auth';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../lib/auth/cookies';
import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, optionalTeamKeys, readJsonObject } from '../../../../lib/auth/http';

/**
 * `/api/seats/<membershipId>` — one seat.
 *
 * `PATCH` changes the role, the team scopes, or both, and **rotates that person's
 * sessions**. That rotation is what makes "the new role applies on the next request"
 * true rather than aspirational: the role is read from the membership on every request,
 * and every cookie that was issued under the old one has been revoked. When an owner
 * edits their *own* seat, a replacement cookie is issued for the browser they are
 * working in, so they are not signed out of the screen they just used.
 *
 * `DELETE` removes the seat. For a *pending* one it is a revoke — the invitation token
 * becomes unusable, and the person clicking the mailed link is told it was withdrawn
 * rather than shown a generic error. For an active one it ends every session and revokes
 * every outstanding link. Neither deletes a row: the audit log references the
 * membership, and a trail whose targets have been deleted is not a trail.
 *
 * In Next.js 15 route handlers, `params` is a Promise and has to be awaited.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { readonly params: Promise<{ readonly membershipId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { membershipId } = await context.params;
  const admitted = await guard({ request, route: '/api/seats/[membershipId]', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    const seat = (await readSeats(admitted.scoped)).find((candidate) => candidate.id === membershipId);
    if (seat === undefined) {
      return jsonError('seat_not_found', `No seat \`${membershipId}\` exists in this organization.`, 404);
    }

    return jsonOk({
      membershipId: seat.id,
      email: seat.email,
      displayName: seat.displayName,
      role: seat.role,
      status: seat.status,
      hasPassword: seat.hasPassword,
      teamKeys: seat.teamKeys,
      invitedAt: new Date(seat.createdAt).toISOString(),
      updatedAt: new Date(seat.updatedAt).toISOString(),
      canManage: admitted.principal === 'owner',
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const { membershipId } = await context.params;
  const admitted = await guard({ request, route: '/api/seats/[membershipId]', action: 'PATCH' });
  if (!admitted.allowed) return admitted.response;
  const identity = admitted.identity;
  if (identity === null) return failure(new Error('An owner reached this route without an identity.'));

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const rawRole = parsed.body['role'];
  if (rawRole !== undefined && !isSeatRole(rawRole)) {
    return jsonError('invalid_request', '`role` must be one of owner, manager, member or viewer.', 400);
  }
  const teamKeys = optionalTeamKeys(parsed.body);
  if ('response' in teamKeys) return teamKeys.response;

  if (rawRole === undefined && teamKeys.value === undefined) {
    return jsonError(
      'invalid_request',
      'Send `role`, `teamKeys`, or both. An empty patch would revoke sessions for no change.',
      400,
    );
  }

  try {
    const result = await changeSeat({
      scoped: admitted.scoped,
      membershipId,
      ...(rawRole === undefined ? {} : { role: rawRole }),
      ...(teamKeys.value === undefined ? {} : { teamKeys: teamKeys.value }),
      actorUserId: identity.user.id,
      now: admitted.now,
      actorSession: identity.session,
    });

    const response = NextResponse.json(
      {
        membershipId: result.membership.id,
        role: result.membership.role,
        teamKeys: result.teamKeys,
        changed: result.changed,
        sessionsRevoked: result.sessionsRevoked,
        detail:
          result.changed.length === 0
            ? 'Nothing changed, so no sessions were ended.'
            : `Applied. ${result.sessionsRevoked} session${result.sessionsRevoked === 1 ? '' : 's'} ended, so the new access is in force on the next request.`,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );

    // The owner edited their own seat: the rotation revoked the cookie they are holding,
    // so the replacement it issued goes back on this response.
    return result.replacementSession === null
      ? response
      : setSessionCookie(response, request, result.replacementSession.secret);
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const { membershipId } = await context.params;
  const admitted = await guard({ request, route: '/api/seats/[membershipId]', action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;
  const identity = admitted.identity;
  if (identity === null) return failure(new Error('An owner reached this route without an identity.'));

  try {
    const seat = (await readSeats(admitted.scoped)).find((candidate) => candidate.id === membershipId);
    if (seat === undefined) {
      return jsonError('seat_not_found', `No seat \`${membershipId}\` exists in this organization.`, 404);
    }

    if (seat.status === 'pending') {
      await revokeInvite({
        scoped: admitted.scoped,
        membershipId,
        actorUserId: identity.user.id,
        now: admitted.now,
      });

      return jsonOk({
        membershipId,
        status: 'revoked',
        invitationUsable: false,
        detail:
          'Invitation revoked. The link that was mailed no longer works, and whoever opens it is told it was withdrawn.',
      });
    }

    const removed = await removeSeat({
      scoped: admitted.scoped,
      membershipId,
      actorUserId: identity.user.id,
      now: admitted.now,
    });

    return jsonOk({
      membershipId,
      status: 'revoked',
      sessionsRevoked: removed.sessionsRevoked,
      detail:
        `Seat removed and ${removed.sessionsRevoked} session${removed.sessionsRevoked === 1 ? '' : 's'} ended. ` +
        'The account row stays so the audit log still names who did what; nothing it could sign in with remains.',
    });
  } catch (error) {
    return failure(error);
  }
}
