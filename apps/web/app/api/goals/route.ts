import { instantFromIso } from '@compass/clock';
import { GoalNodeExistsError } from '@compass/db';
import { NextResponse } from 'next/server';

import { NO_STORE, failure } from '../../../lib/goal-http';
import { createGoal, listGoals, nowAtEdge } from '../../../lib/goal-source';

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
 *
 * `failure` and `NO_STORE` are imported from `lib/goal-http` rather than defined
 * here: a route module may export only the HTTP verbs and the segment config, so
 * the shared error shape cannot live in one route and be imported by the other.
 */
export const dynamic = 'force-dynamic';

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
