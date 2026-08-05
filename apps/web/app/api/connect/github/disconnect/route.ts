import { appendAuditLogEntry, deleteIntegrationToken } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import { failure, isFormSubmission, jsonOk, seeOther } from '../../../../../lib/auth/http';
import { GITHUB_SOURCE_KEY } from '../../../../../lib/connect-source';

/**
 * `POST /api/connect/github/disconnect` — stop reading GitHub, keep everything already read.
 *
 * ## Three effects, and the second is the one worth stating
 *
 * 1. **The credential is deleted.** `deleteIntegrationToken` removes the sealed row. This is the one
 *    table in the schema where deleting is right: a superseded credential is not history, it is a live
 *    key somebody else could use.
 * 2. **Every row Compass already wrote stays.** No report, commit, pull request or ingest run is
 *    touched. Disconnecting is "stop reading", not "forget what you read" — a manager who disconnects
 *    to rotate an App installation must not lose three months of Yesterday, and the archive has to keep
 *    rendering as the document they actually read. Erasure is a separate, deliberate act with its own
 *    screen and its own confirmation.
 * 3. **The freshness read reports it.** With no credential the source is disconnected, which the panel
 *    states as a first-class fact rather than showing a healthy-looking source that silently returns
 *    nothing.
 *
 * Idempotent: disconnecting twice is not an error. The second call deletes nothing and still records
 * the act, because "the owner pressed disconnect" is a fact whether or not a row was there to remove.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/connect/github/disconnect';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  try {
    await deleteIntegrationToken(admitted.scoped, GITHUB_SOURCE_KEY, 'access');

    // On the record with the acting principal, unlike the callback — this one arrives with a session,
    // so who pressed disconnect is known and worth keeping.
    await appendAuditLogEntry(admitted.scoped, {
      actorUserId: admitted.identity?.user.id ?? null,
      action: 'connector.disconnected',
      targetKind: 'connector',
      targetId: GITHUB_SOURCE_KEY,
      before: { connected: true },
      // States what survived, because that is what somebody reading the log needs to know.
      after: { connected: false, rowsRetained: true },
      occurredAt: admitted.now,
    });

    return isFormSubmission(request)
      ? seeOther(new URL('/connect?github=disconnected', request.url).toString())
      : jsonOk({ connected: false, sourceKey: GITHUB_SOURCE_KEY });
  } catch (error) {
    return failure(error);
  }
}
