import { GoalNodeNotFoundError } from '@compass/db';
import { NextResponse } from 'next/server';

import { NO_STORE, failure } from '../../../../lib/goal-http';
import { archiveGoal, readGoal, updateGoal } from '../../../../lib/goal-source';

/**
 * `/api/goals/<nodeId>` — read one goal's whole history, edit it, archive it.
 *
 * Three verbs, one storage primitive: every one of them appends an effective-dated
 * revision and none of them can rewrite one.
 *
 *  - `GET` returns *every* revision, oldest first, with the chain each one resolved
 *    against at the instant it was recorded. That list is the answer to "what did
 *    this goal say in August", which is what makes a frozen verdict checkable.
 *  - `PATCH` appends the next revision. A body may carry one field; the rest are
 *    inherited from the open revision rather than blanked.
 *  - `DELETE` archives, which is also an append. Nothing is ever removed, because a
 *    report from before the archive still has to resolve its chain.
 *
 * In Next.js 15 route handlers, `params` is a Promise and has to be awaited. It
 * arrives percent-decoded, so `nodeId` is used as delivered and never decoded a
 * second time — the same rule `app/artifact/[kind]/[artifactId]/page.tsx` states,
 * and the reason a node id containing a literal `%` reaches the store intact
 * instead of throwing a `URIError` that would be reported as an unreachable
 * database.
 */
export const dynamic = 'force-dynamic';

type Context = { readonly params: Promise<{ readonly nodeId: string }> };

const notFound = (nodeId: string): NextResponse =>
  NextResponse.json(
    {
      error: 'goal_not_found',
      detail: `No goal node \`${nodeId}\` exists in this organization. Node ids are the identifiers a report cites, so they are never invented on write.`,
    },
    { status: 404, headers: NO_STORE },
  );

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const { nodeId } = await context.params;

  try {
    const history = await readGoal(nodeId);
    return history === null ? notFound(nodeId) : NextResponse.json(history, { status: 200, headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const { nodeId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', detail: 'The request body must be JSON.' },
      { status: 400, headers: NO_STORE },
    );
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'invalid_body', detail: 'The request body must be a JSON object carrying the fields to change.' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    return NextResponse.json(await updateGoal(nodeId, body), { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof GoalNodeNotFoundError) return notFound(nodeId);
    return failure(error);
  }
}

/**
 * Archives rather than deletes, and says so in the response.
 *
 * `DELETE` is the verb a manager's client will reach for, so it is the verb served —
 * but the response names what actually happened, because "deleted" and "archived by
 * appending a revision" have very different consequences for last month's reports.
 */
export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const { nodeId } = await context.params;
  const changeNote = new URL(request.url).searchParams.get('note');

  try {
    const archived = await archiveGoal(nodeId, changeNote);
    return NextResponse.json(
      {
        ...archived,
        archived: true,
        detail:
          'Archived by appending a revision. Every earlier revision is still on disk, so a report generated before ' +
          'this instant still resolves the chain it was measured against.',
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof GoalNodeNotFoundError) return notFound(nodeId);
    return failure(error);
  }
}
