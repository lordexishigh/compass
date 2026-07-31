import { AUDIT_ACTION_LABEL, changedKeys, isAuditAction } from '@compass/auth';
import { findUserById, listAuditLogEntries } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../lib/auth/guard';
import { failure, jsonOk } from '../../../lib/auth/http';

/**
 * `GET /api/audit` — every privileged and destructive act, newest first.
 *
 * Owner only, and read-only in the strongest sense available: `audit_log_entries` is in
 * `APPEND_ONLY_TABLE_NAMES`, so `ScopedDb` refuses an UPDATE or a DELETE on it, a
 * database trigger refuses the same thing underneath, and there is no repository
 * function anywhere in `@compass/db` that would attempt either. There is deliberately no
 * `DELETE` verb on this route — a log an owner can prune is not evidence.
 *
 * Each row carries the whole before and after state rather than a diff, because a diff
 * cannot be read back into "what did this seat look like on Tuesday". `changedKeys`
 * derives the summary a person reads from the two states, so the sentence and the
 * evidence cannot disagree.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_ROWS = 200;

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/audit', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  const url = new URL(request.url);
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_ROWS)
    : 50;
  const targetId = url.searchParams.get('targetId');

  try {
    const entries = await listAuditLogEntries(admitted.scoped, {
      limit,
      ...(targetId === null || targetId.length === 0 ? {} : { targetId }),
    });

    // Actor names are resolved for display. The cache means one read per distinct
    // actor rather than one per row, which matters on a 200-row page.
    const actorNames = new Map<string, string>();
    for (const entry of entries) {
      if (entry.actorUserId === null || actorNames.has(entry.actorUserId)) continue;
      const actor = await findUserById(admitted.scoped, entry.actorUserId);
      actorNames.set(entry.actorUserId, actor?.displayName ?? actor?.email ?? entry.actorUserId);
    }

    return jsonOk({
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        // An action outside the closed vocabulary is shown verbatim rather than
        // dropped: an unrecognised entry is exactly the one an owner needs to see.
        label: isAuditAction(entry.action) ? AUDIT_ACTION_LABEL[entry.action] : entry.action,
        actorUserId: entry.actorUserId,
        actorName:
          entry.actorUserId === null
            ? 'Compass itself, at boot'
            : (actorNames.get(entry.actorUserId) ?? entry.actorUserId),
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        before: entry.before,
        after: entry.after,
        changed: changedKeys(entry.before, entry.after),
        occurredAt: new Date(entry.occurredAt).toISOString(),
      })),
      limit,
      appendOnly: true,
      detail:
        'Append-only. No route, repository function, or application code path updates or deletes a row here, and a ' +
        'database trigger refuses one from a psql session too.',
    });
  } catch (error) {
    return failure(error);
  }
}
