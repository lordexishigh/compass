import { NextResponse } from 'next/server';

import { InvalidGoalRequestError } from './goal-source';

/**
 * The two things both goal endpoints answer with, in one place.
 *
 * They live here rather than in either `route.ts` because an App Router route
 * module may export only the HTTP verbs and the segment config fields. Any other
 * named export — even one the other route imports deliberately — fails Next.js's
 * generated route type check and breaks `next build`, which is a failure the
 * vitest suites cannot see: they read the route files as text.
 */

/** A goal read is never cached: the hierarchy is what a verdict is checked against. */
export const NO_STORE = { 'cache-control': 'no-store' } as const;

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
