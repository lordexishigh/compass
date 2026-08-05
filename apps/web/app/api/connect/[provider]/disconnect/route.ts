import { appendAuditLogEntry, deleteIntegrationToken, setSourceConfigEnabled } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import { failure, isFormSubmission, jsonError, jsonOk, seeOther } from '../../../../../lib/auth/http';
import { findProviderConfig, isConnectProviderId, providerById } from '../../../../../lib/connect-source';

/**
 * `POST /api/connect/[provider]/disconnect` — stop reading a source, keep everything already read.
 *
 * ## Four effects, and the middle two are the ones worth stating
 *
 * 1. **The credentials are deleted.** Both of them — access and refresh. This is the one table in the
 *    schema where deleting is right: a superseded credential is not history, it is a live key somebody
 *    else could use. A disconnect that left the refresh token behind would leave a way back in.
 * 2. **Every row Compass already wrote stays.** No report, commit, pull request or ingest run is touched.
 *    Disconnecting is "stop reading", not "forget what you read" — a manager who disconnects to rotate a
 *    credential must not lose three months of Yesterday, and the archive has to keep rendering as the
 *    document they actually read. Erasure is a separate, deliberate act with its own screen and its own
 *    confirmation.
 * 3. **The selections stay, and the configuration is marked not-reading.** Which is what lets the
 *    freshness indicator *state* "disconnected" rather than falling silent: a source with a configuration
 *    and no credential is a fact, whereas a source with neither is one that was never set up. It also
 *    means reconnecting does not ask for the repositories again.
 * 4. **It is on the record**, with the acting principal attached — unlike the callback, this one arrives
 *    with a session, so who pressed disconnect is known and worth keeping.
 *
 * Idempotent: disconnecting twice is not an error. The second call deletes nothing and still records the
 * act, because "the owner pressed disconnect" is a fact whether or not a row was there to remove.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/connect/[provider]/disconnect';

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly provider: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const { provider: raw } = await context.params;
  if (!isConnectProviderId(raw)) {
    return jsonError('unknown_provider', `Compass has no connector called "${raw}".`, 404);
  }
  const provider = providerById(raw);

  try {
    const config = await findProviderConfig(admitted.scoped, raw);

    await deleteIntegrationToken(admitted.scoped, provider.sourceKey, 'access');
    // The refresh token too. Leaving it would leave a way back in after the access token was revoked.
    await deleteIntegrationToken(admitted.scoped, provider.sourceKey, 'refresh');

    // Not-reading, rather than deleted: the selections are what a reconnect needs and what the freshness
    // indicator reads to say "disconnected" instead of saying nothing.
    await setSourceConfigEnabled(admitted.scoped, provider.sourceKey, false, admitted.now);

    await appendAuditLogEntry(admitted.scoped, {
      actorUserId: admitted.identity?.user.id ?? null,
      action: 'connector.disconnected',
      targetKind: 'connector',
      targetId: provider.sourceKey,
      before: { connected: true, selectionCount: config?.selections.length ?? 0 },
      // States what survived, because that is what somebody reading the log needs to know.
      after: {
        connected: false,
        rowsRetained: true,
        selectionsRetained: config?.selections.length ?? 0,
        sourceKind: provider.sourceKind,
      },
      occurredAt: admitted.now,
    });

    return isFormSubmission(request)
      ? seeOther(new URL(`/connect?${raw}=disconnected`, request.url).toString())
      : jsonOk({ connected: false, sourceKey: provider.sourceKey });
  } catch (error) {
    return failure(error);
  }
}
