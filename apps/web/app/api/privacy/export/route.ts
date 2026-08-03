import { formatCivilDate } from '@compass/clock';
import { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { NO_STORE, failure } from '../../../../lib/auth/http';
import { buildOrganizationExport } from '../../../../lib/privacy-source';

/**
 * `/api/privacy/export` — everything Compass holds, as one JSON document.
 *
 * ## Why it is not only part of the deletion flow
 *
 * Because a data export that exists only as a step on the way out makes leaving the product
 * the price of seeing your own data. An owner can download this at any time; the deletion
 * mail links to the same endpoint, which is what satisfies "offer a full data export before
 * the purge" without building a second, parallel exporter that could disagree with this one.
 *
 * ## What is in it
 *
 * The stored report bundles, not re-derived reports. What a person is owed is what Compass
 * *holds* — including a report that was written by the fallback renderer, with its fallback
 * flag — rather than what Compass would compute if asked today. Alongside them: the roster,
 * the privacy settings, every retention purge with its counts, every anonymization, every
 * ingested channel with the date it was enabled, and every deletion request.
 *
 * The download is audited (`data.exported`) with the actor, because a complete copy of an
 * organization's data leaving the building is exactly the kind of act the audit log exists
 * for.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/privacy/export';

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    const document = await buildOrganizationExport(admitted.scoped, admitted.identity, admitted.now);
    const filename = `compass-export-${formatCivilDate(admitted.now, 'UTC')}.json`;

    // Two spaces, so a person who opens the file in an editor can read it. The document is
    // measured in low megabytes for a year of reports, and a human-readable export is the
    // point of the feature.
    return new NextResponse(`${JSON.stringify(document, null, 2)}\n`, {
      status: 200,
      headers: {
        ...NO_STORE,
        'content-type': 'application/json; charset=utf-8',
        // `attachment` rather than inline: this is a file somebody is keeping, and a browser
        // rendering ten megabytes of JSON in a tab is not that.
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return failure(error);
  }
}
