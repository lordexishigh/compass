import { resendInvite } from '@compass/auth';
import type { NextResponse } from 'next/server';

import { baseUrlFor, guard, mailer, organizationName } from '../../../../../lib/auth/guard';
import { failure, jsonOk } from '../../../../../lib/auth/http';

/**
 * `POST /api/seats/<membershipId>/invite` — resends a pending invitation.
 *
 * Resending revokes the previous token and issues a new seven-day one, so there is never
 * more than one live invitation for a seat. That matters for revoke: an owner who takes
 * an invitation back should not have to wonder which of three forwarded emails still
 * works.
 *
 * A seat that is not `pending` is refused by name rather than quietly re-invited — an
 * active seat signs in, and a revoked one has to be invited afresh, and the two need
 * different sentences.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { readonly params: Promise<{ readonly membershipId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { membershipId } = await context.params;
  const admitted = await guard({ request, route: '/api/seats/[membershipId]/invite', action: 'POST' });
  if (!admitted.allowed) return admitted.response;
  const identity = admitted.identity;
  if (identity === null) return failure(new Error('An owner reached this route without an identity.'));

  try {
    const issued = await resendInvite({
      scoped: admitted.scoped,
      membershipId,
      actor: { userId: identity.user.id, displayName: identity.user.displayName },
      now: admitted.now,
      mailer: mailer(),
      organizationName: await organizationName(admitted.scoped),
      baseUrl: baseUrlFor(request),
    });

    return jsonOk({
      membershipId,
      invitationExpiresAt: new Date(issued.expiresAt).toISOString(),
      invitationLink: issued.link,
      detail: 'A new invitation is on its way. The previous link has been revoked and no longer works.',
    });
  } catch (error) {
    return failure(error);
  }
}
