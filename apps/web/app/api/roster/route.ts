import type { NextResponse } from 'next/server';

import { guard } from '../../../lib/auth/guard';
import { failure, jsonOk } from '../../../lib/auth/http';
import { readRoster } from '../../../lib/roster-source';

/**
 * `GET /api/roster` — the whole configuration in one read.
 *
 * One endpoint rather than one per table, because the questions a manager asks span the
 * tables: "what does this identifier currently attribute" needs identity links *and*
 * commits *and* pull requests, and "who is on this team" needs memberships *and* the
 * Developer rows that imply them. Six endpoints would mean the browser assembled those
 * joins, and every assembly would be a chance to disagree with what the report does.
 *
 * The roster is not enormous — a few dozen people, a few dozen repositories — so a single
 * read is cheaper than the round trips it replaces.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/roster', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    const roster = await readRoster(admitted.scoped, admitted.now);

    return jsonOk({
      ...roster,
      // The screen needs to know whether the reader may act, and asking the matrix twice —
      // once here, once in the browser — would be two answers that could differ.
      canManage: admitted.principal === 'owner' || admitted.principal === 'manager',
    });
  } catch (error) {
    return failure(error);
  }
}
