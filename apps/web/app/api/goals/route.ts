import { instantFromIso } from '@compass/clock';
import { GoalNodeExistsError } from '@compass/db';
import { NextResponse } from 'next/server';

import { InvalidGoalRequestError, createGoal, listGoals, nowAtEdge } from '../../../lib/goal-source';

/**
 * `/api/goals` — the goal hierarchy, read and created.
 *
 * The write half is an append: a create writes revision 1 and nothing else, and
 * there is no code path here that can rewrite a revision — `objective_versions` is
 * append-only in `ScopedDb` and in the database itself.
 *
 * `GET ?at=<ISO instant>` is the interesting read. It resolves the hierarchy as it
 * stood at that instant, through the same `goalHierarchyAt` the report pipeline
 * uses, which is how a manager answers "what was Tuesday's report measured
 * against". Without the parameter it answers for now.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get('at');

  let at = nowAtEdge();
  if (raw !== null && raw.length > 0) {
    try {
      at = instantFromIso(raw);
    } catch {
      return NextResponse.json(
        {
          error: 'invalid_instant',
          detail: `\`at\` must be an ISO-8601 instant, e.g. 2026-07-31T09:00:00Z. Received \`${raw}\`.`,
        },
        { status: 400, headers: NO_STORE },
      );
    }
  }

  try {
    return NextResponse.json(await listGoals(at), { status: 200, headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
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
      { error: 'invalid_body', detail: 'The request body must be a JSON object describing one goal.' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    return NextResponse.json(await createGoal(body), { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof GoalNodeExistsError) {
      // 409 rather than 400: the request is well-formed and the state is the
      // problem, and the message says what to do instead (edit it, which appends).
      return NextResponse.json({ error: 'goal_exists', detail: error.message }, { status: 409, headers: NO_STORE });
    }
    return failure(error);
  }
}

/**
 * Every failure names the field or the condition.
 *
 * This is the one surface a human types into, and an unexplained 500 would make the
 * whole feature feel broken rather than the request wrong.
 */
export function failure(error: unknown): NextResponse {
  if (error instanceof InvalidGoalRequestError) {
    return NextResponse.json({ error: 'invalid_request', detail: error.detail }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json(
    {
      error: 'goal_store_unavailable',
      detail: error instanceof Error ? error.message : 'The goal store could not be reached.',
    },
    { status: 503, headers: NO_STORE },
  );
}
