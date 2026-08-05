import {
  authenticateScim,
  externalIdFor,
  parseScimFilter,
  readScimUserWrite,
  resolveFederatedSignIn,
  scimError,
  scimListUsers,
  scimUserResource,
} from '@compass/auth';
import { ENTERPRISE_IDENTITY_REQUIRED_STATEMENT } from '@compass/billing';
import { findMembershipByUserId, findUserByEmail, listSeats, normalizeEmail } from '@compass/db';
import { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import { NO_STORE } from '../../../../../lib/auth/http';
import { enterpriseIdentityAllowed } from '../../../../../lib/sso-source';

/**
 * `/api/scim/v2/Users` — the SCIM 2.0 collection an identity provider pushes membership into.
 *
 * ## Why this route is `public` in the matrix, and what actually authorises it
 *
 * A SCIM client is an identity provider's own backend service. It holds no cookie and cannot obtain
 * one — there is no browser and no person in the loop — so a session requirement would mean the feature
 * cannot exist. It gets the same explicit `public` treatment the three provider webhooks and the Stripe
 * webhook have, and for the same reason: what admits it is *narrower* than a session — a 256-bit bearer
 * token compared by SHA-256 digest in constant time against a row that an owner created and can revoke.
 *
 * ## The plan gate answers 403 with a sentence, not 404
 *
 * An organization not on the Business plan is told what the plan is, because the caller is an
 * administrator wiring up an integration and a 404 would send them hunting for a typo in a URL that is
 * correct. The gate is read from `@compass/billing`'s plan table rather than by comparing a plan name.
 *
 * ## `content-type: application/scim+json`
 *
 * Required by RFC 7644 and some IdPs check it. Written on every response including the errors, which is
 * where implementations most often forget it.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/scim/v2/Users';

const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';

const scimJson = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, 'content-type': SCIM_CONTENT_TYPE } });

/**
 * `WWW-Authenticate` on a 401, which is not decoration.
 *
 * Several SCIM clients treat a 401 without it as a transport fault and retry forever rather than
 * surfacing "your token is wrong" to the administrator who can fix it.
 */
const unauthorized = (): NextResponse =>
  NextResponse.json(scimError(401, 'A valid SCIM bearer token is required.'), {
    status: 401,
    headers: { ...NO_STORE, 'content-type': SCIM_CONTENT_TYPE, 'www-authenticate': 'Bearer realm="compass-scim"' },
  });

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    if (!(await enterpriseIdentityAllowed(admitted.scoped))) {
      return scimJson(scimError(403, ENTERPRISE_IDENTITY_REQUIRED_STATEMENT), 403);
    }

    const authenticated = await authenticateScim({
      scoped: admitted.scoped,
      authorization: request.headers.get('authorization'),
      now: admitted.now,
    });
    if (!authenticated.ok) return unauthorized();

    const url = new URL(request.url);
    const filter = parseScimFilter(url.searchParams.get('filter'));

    /**
     * An unsupported filter is a 400, never a silent full list.
     *
     * This is the one place where being permissive would be actively dangerous: an ignored filter
     * returns *every* user to a client that asked about one, and the IdP reads the first row as a match
     * and starts updating the wrong person's seat.
     */
    if (filter.kind === 'unsupported') {
      return scimJson(
        scimError(
          400,
          'Compass supports the filter `userName eq "someone@example.com"` and no other. A filter it ' +
            'cannot parse is refused rather than ignored, because ignoring it would return every user to ' +
            'a client that asked about one.',
          'invalidFilter',
        ),
        400,
      );
    }

    const listed = await scimListUsers({
      scoped: admitted.scoped,
      filter,
      basePath: new URL(ROUTE, url.origin).toString(),
    });

    return scimJson(listed, 200);
  } catch (error) {
    return scimFailure(error);
  }
}

/**
 * `POST` — provision a seat.
 *
 * Idempotent by address, which the specification does not require and every IdP relies on: a client
 * that retries after a timeout must not create a second seat. An existing address answers `409` with
 * `uniqueness`, which is what a SCIM client expects and what makes it fall back to a `PATCH`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  try {
    if (!(await enterpriseIdentityAllowed(admitted.scoped))) {
      return scimJson(scimError(403, ENTERPRISE_IDENTITY_REQUIRED_STATEMENT), 403);
    }

    const authenticated = await authenticateScim({
      scoped: admitted.scoped,
      authorization: request.headers.get('authorization'),
      now: admitted.now,
    });
    if (!authenticated.ok) return unauthorized();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return scimJson(scimError(400, 'The request body is not JSON.', 'invalidSyntax'), 400);
    }

    const parsed = readScimUserWrite(body);
    if (!parsed.ok) return scimJson(scimError(400, parsed.detail, 'invalidValue'), 400);

    const write = parsed.write;
    const existing = await findUserByEmail(admitted.scoped, normalizeEmail(write.userName));

    if (existing !== null) {
      const membership = await findMembershipByUserId(admitted.scoped, existing.id);
      if (membership !== null && membership.status !== 'revoked') {
        return scimJson(
          scimError(409, `A seat for ${write.userName} already exists.`, 'uniqueness'),
          409,
        );
      }
    }

    /**
     * Provisioning goes through the *same* linking core a SAML sign-in uses.
     *
     * Not a bespoke insert. `resolveFederatedSignIn` is what knows to reuse an existing user row, to
     * activate a pending seat rather than duplicate it, and to write the audit record — and a second
     * implementation here would be a second set of rules for the same decision. The `scim` provider and
     * the IdP's `externalId` as the subject are what make the seat traceable to the directory that
     * created it, which is the row a deprovision later reads.
     */
    const resolution = await resolveFederatedSignIn({
      scoped: admitted.scoped,
      assertion: {
        provider: 'scim',
        // The IdP's own id when it sent one; the address otherwise, so the subject is always stable.
        subject: write.externalId ?? normalizeEmail(write.userName),
        email: write.userName,
        // A directory push is the organization's own system asserting its own namespace, exactly as a
        // SAML assertion is. See `federated-sign-in.ts` for why that is what "verified" means here.
        emailVerified: true,
        displayName: write.displayName,
      },
      now: admitted.now,
      allowProvisioning: true,
      // Never from the payload. The database also refuses `owner`; see the schema.
      provisionRole: 'member',
    });

    if (resolution.kind === 'refused') {
      return scimJson(scimError(400, `That user could not be provisioned: ${resolution.reason}.`), 400);
    }

    const seats = await listSeats(admitted.scoped);
    const seat = seats.find((entry) => entry.id === resolution.membership.id);

    if (seat === undefined) {
      return scimJson(scimError(500, 'The seat was created but could not be read back.'), 500);
    }

    const resource = scimUserResource({
      seat,
      basePath: new URL(ROUTE, new URL(request.url).origin).toString(),
      externalId: await externalIdFor(admitted.scoped, seat.userId),
    });

    return NextResponse.json(resource, {
      status: 201,
      headers: {
        ...NO_STORE,
        'content-type': SCIM_CONTENT_TYPE,
        // RFC 7644: a created resource names its own location.
        location: resource.meta.location,
      },
    });
  } catch (error) {
    return scimFailure(error);
  }
}

const scimFailure = (error: unknown): NextResponse => {
  console.error(
    `[compass] SCIM request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  return scimJson(
    scimError(500, 'Compass could not complete that request. The deployment’s logs have the detail.'),
    500,
  );
};
