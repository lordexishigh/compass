import { TOKEN_TTL_LABEL, inviteSeat, isSeatRole, readSeats, seatReadiness } from '@compass/auth';
import type { NextResponse } from 'next/server';

import { baseUrlFor, guard, mailer, organizationName } from '../../../lib/auth/guard';
import {
  failure,
  jsonError,
  jsonOk,
  optionalTeamKeys,
  readJsonObject,
  requiredString,
} from '../../../lib/auth/http';

/**
 * `/api/seats` — the seat list, and inviting a new one.
 *
 * `GET` is owner and manager: a manager needs to know who is on the team and with what
 * role, and a read that showed only owners the roster would make "who can see this
 * report" a question only an owner could answer. Members and viewers are refused —
 * reading a report does not make someone an administrator of it.
 *
 * `POST` is owner only, creates a `pending` Membership, and mails a single-use
 * invitation whose lifetime is `TOKEN_TTL_LABEL.invite` — never a number written here,
 * because this sentence and the token would then be free to disagree, and once did.
 *
 * The link is also returned in the response, because a deployment whose mail transport is
 * the process log would otherwise have no way to hand the invitation over — and a silently
 * undeliverable invite is worse than a visible one.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/seats', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    const seats = await readSeats(admitted.scoped);

    return jsonOk({
      seats: seats.map((seat) => ({
        membershipId: seat.id,
        email: seat.email,
        displayName: seat.displayName,
        role: seat.role,
        status: seat.status,
        hasPassword: seat.hasPassword,
        teamKeys: seat.teamKeys,
        invitedAt: new Date(seat.createdAt).toISOString(),
        updatedAt: new Date(seat.updatedAt).toISOString(),
        // Null for somebody who has never signed in, which the caller states rather than
        // renders as a missing field.
        lastActiveAt: seat.lastActiveAt === null ? null : new Date(seat.lastActiveAt).toISOString(),
      })),
      readiness: await seatReadiness(admitted.scoped),
      // A manager reads this list; only an owner may act on it. Stated so the UI does
      // not have to re-derive the matrix.
      canManage: admitted.principal === 'owner',
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/seats', action: 'POST' });
  if (!admitted.allowed) return admitted.response;
  const identity = admitted.identity;
  if (identity === null) return failure(new Error('An owner reached this route without an identity.'));

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const email = requiredString(parsed.body, 'email');
  if ('response' in email) return email.response;
  const role = requiredString(parsed.body, 'role');
  if ('response' in role) return role.response;
  if (!isSeatRole(role.value)) {
    return jsonError('invalid_request', '`role` must be one of owner, manager, member or viewer.', 400);
  }
  const teamKeys = optionalTeamKeys(parsed.body);
  if ('response' in teamKeys) return teamKeys.response;

  try {
    const invited = await inviteSeat({
      scoped: admitted.scoped,
      email: email.value,
      role: role.value,
      teamKeys: teamKeys.value ?? [],
      actor: { userId: identity.user.id, displayName: identity.user.displayName },
      now: admitted.now,
      mailer: mailer(),
      organizationName: await organizationName(admitted.scoped),
      baseUrl: baseUrlFor(request),
    });

    return jsonOk(
      {
        membershipId: invited.membership.id,
        email: invited.seat.email,
        role: invited.membership.role,
        status: invited.membership.status,
        teamKeys: invited.seat.teamKeys,
        invitationExpiresAt: new Date(invited.expiresAt).toISOString(),
        invitationLink: invited.link,
        detail:
          `Invitation sent. The link works once and expires in ${TOKEN_TTL_LABEL.invite}; resending it revokes the ` +
          'previous one.',
      },
      201,
    );
  } catch (error) {
    return failure(error);
  }
}
