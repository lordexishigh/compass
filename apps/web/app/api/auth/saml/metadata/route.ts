import { NextResponse } from 'next/server';

import { baseUrlFor, guard } from '../../../../../lib/auth/guard';
import { NO_STORE, UNAVAILABLE_SENTENCE } from '../../../../../lib/auth/http';
import { samlMetadataFor } from '../../../../../lib/sso-source';

/**
 * `GET /api/auth/saml/metadata` — this deployment's SAML service-provider metadata.
 *
 * ## Why it is public, and why that costs nothing
 *
 * An IdP administrator configuring Compass pastes this URL into their console, and many IdPs fetch it
 * themselves — from their own infrastructure, with no cookie they could send. Requiring a session would
 * mean the integration could only be set up by copying a file around by hand.
 *
 * It discloses nothing: an entity id, an ACS URL and the two flags Compass enforces. All three are
 * already visible to anybody who can reach the deployment, and none of them is a credential. The
 * *organization's* IdP certificate is deliberately not in here — that is per-tenant configuration and
 * lives on the owner-only enterprise screen.
 *
 * ## Generated, never hand-written
 *
 * From the same helpers the ACS route enforces, so the document cannot promise an ACS URL the handler
 * would reject. A metadata file that disagreed with the code sends every operator down a debugging
 * path that ends at a check they cannot see.
 *
 * It carries no plan gate on purpose: reading what Compass *would* need is part of evaluating whether
 * to buy the plan that enables it, and gating the description behind the thing it describes is the
 * shape of a sales dead end.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/saml/metadata';

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  // The document is computed from configuration alone, so it is still answerable when the database
  // cannot be reached — and an operator setting the integration up is exactly who needs it then.
  if (!admitted.allowed && !admitted.unavailable) return admitted.response;

  try {
    // Resolved once, and never from a request header: `baseUrlFor` explains why at length. Here it is
    // load-bearing twice over, because an entity id taken from `x-forwarded-host` would let a caller
    // publish metadata naming an ACS URL they control.
    const baseUrl = baseUrlFor(request);

    return new NextResponse(samlMetadataFor(baseUrl), {
      status: 200,
      headers: {
        ...NO_STORE,
        'content-type': 'application/samlmetadata+xml; charset=utf-8',
        'content-disposition': 'inline; filename="compass-saml-metadata.xml"',
      },
    });
  } catch {
    /**
     * `COMPASS_BASE_URL` is unset on a non-loopback host, so Compass cannot say where it lives.
     *
     * Refusing is the right failure: metadata naming a guessed origin would be pasted into an IdP
     * console and every assertion would then be addressed somewhere Compass does not answer. Plain
     * text rather than JSON, because the caller asked for a document.
     */
    return new NextResponse(
      'Compass cannot generate SAML metadata because COMPASS_BASE_URL is not set on this deployment, so ' +
        'it does not know its own address. Set it to this deployment’s origin and reload.\n\n' +
        UNAVAILABLE_SENTENCE,
      { status: 503, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
}
