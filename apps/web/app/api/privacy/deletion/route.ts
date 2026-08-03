import { composeDeletionUndoMail } from '@compass/auth';
import { formatCivilDate } from '@compass/clock';
import type { NextResponse } from 'next/server';

import { baseUrlFor, guard, mailer, organizationName } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject } from '../../../../lib/auth/http';
import { categoriesForSubject, requestDeletion, undoDeletion } from '../../../../lib/privacy-source';

/**
 * `/api/privacy/deletion` — ask Compass to delete an account or a whole organization.
 *
 * ## The order of operations, which is the whole feature
 *
 *  1. Record the request, freezing both deadlines onto the row.
 *  2. Mail the undo link and the export link to the address on file.
 *  3. Answer with what will be deleted and by when.
 *
 * Nothing is deleted here. The worker's `privacy.deletion-sweep` does that once the grace
 * period has ended, which is what makes the seven days real rather than a message.
 *
 * ## Why the mail failing does not fail the request
 *
 * It does — deliberately, and this is the one place in Compass where a send failure aborts
 * the act it belongs to. Everywhere else (a report delivery, a lockout notice) the mail is a
 * copy of something the reader can also see in the product. Here the mail *is* the undo
 * capability: the token exists in that message and nowhere else, so a request recorded
 * without a deliverable undo link is a deletion nobody can stop. So the row is written, the
 * mail is attempted, and a failure rolls the request back to `undone` before answering 503.
 *
 * ## Who may ask for what
 *
 * `organization` is owner-only: it ends the product for everybody on it. `account` is any
 * seat, for their own account only — the `subjectId` is not read from the body, it is the
 * caller's own user id, because a route that accepted one would let a manager delete a
 * colleague's account with a curl.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/privacy/deletion';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const rawKind = parsed.body['subjectKind'];
  if (rawKind !== 'account' && rawKind !== 'organization') {
    return jsonError(
      'invalid_request',
      '`subjectKind` must be `account` (yours) or `organization` (all of it).',
      400,
    );
  }

  const identity = admitted.identity;
  if (identity === null) {
    // Unreachable through the matrix, which requires a seat on both verbs. Kept because the
    // alternative is a non-null assertion on the one route where being wrong about who is
    // asking would delete the wrong person's account.
    return jsonError('authentication_required', 'Sign in to request a deletion.', 401);
  }

  if (rawKind === 'organization' && identity.principal !== 'owner') {
    return jsonError(
      'role_not_permitted',
      'Only an owner can delete the whole organization. You can delete your own account from this screen.',
      403,
    );
  }

  try {
    const { request: recorded, undoSecret } = await requestDeletion(
      admitted.scoped,
      {
        subjectKind: rawKind,
        // Never from the body. A route that accepted a subject id would let one seat delete
        // another person's account by naming them.
        subjectId: rawKind === 'organization' ? admitted.organizationId : identity.user.id,
        notifyEmail: identity.user.email,
      },
      identity,
      admitted.now,
    );

    const origin = baseUrlFor(request);
    const undoLink = `${origin}/account/deletion?undo=${encodeURIComponent(undoSecret)}`;
    const exportLink = `${origin}/api/privacy/export`;

    try {
      await mailer().send(
        composeDeletionUndoMail({
          to: identity.user.email,
          organizationName: await organizationName(admitted.scoped),
          subjectKind: rawKind,
          undoLink,
          exportLink,
          graceEndsOn: formatCivilDate(recorded.graceEndsAt, 'UTC'),
          hardDeleteBy: formatCivilDate(recorded.hardDeleteBy, 'UTC'),
        }),
      );
    } catch (cause) {
      // The undo token lives only in that message. A request nobody can cancel is worse than
      // no request, so this one is rolled back rather than left standing.
      await undoDeletion(admitted.scoped, undoSecret, admitted.now);
      console.error(
        `[compass] deletion request ${recorded.id} was rolled back because its undo link could not be sent: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return jsonError(
        'undo_link_unsendable',
        'Compass could not send the undo link, so it has not started the deletion — a deletion you cannot cancel ' +
          'is not one it is willing to schedule. Nothing was changed. Check the mail configuration and try again.',
        503,
      );
    }

    return jsonOk(
      {
        deletionRequestId: recorded.id,
        subjectKind: rawKind,
        graceEndsAt: recorded.graceEndsAt,
        hardDeleteBy: recorded.hardDeleteBy,
        categories: categoriesForSubject(rawKind),
        exportLink,
        detail:
          `Scheduled. Nothing has been deleted. An email is on its way to ${identity.user.email} with a link that ` +
          `cancels this until ${formatCivilDate(recorded.graceEndsAt, 'UTC')}, and a link that downloads everything ` +
          `Compass holds. The deletion will have completed by ${formatCivilDate(recorded.hardDeleteBy, 'UTC')}, and ` +
          'Compass will send one more message listing exactly what was removed.',
      },
      202,
    );
  } catch (error) {
    return failure(error);
  }
}
