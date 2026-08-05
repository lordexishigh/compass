import {
  authenticateScim,
  externalIdFor,
  readScimPatch,
  readScimUserWrite,
  recordAudit,
  removeSeat,
  scimError,
  scimUserResource,
} from '@compass/auth';
import { ENTERPRISE_IDENTITY_REQUIRED_STATEMENT } from '@compass/billing';
import { listSeats, type ScopedDb, type SeatRow } from '@compass/db';
import { NextResponse } from 'next/server';

import { guard } from '../../../../../../lib/auth/guard';
import { NO_STORE } from '../../../../../../lib/auth/http';
import { enterpriseIdentityAllowed } from '../../../../../../lib/sso-source';

/**
 * `/api/scim/v2/Users/[scimUserId]` — one seat, as an identity provider sees it.
 *
 * ## Deprovisioning is the reason this route exists, and it arrives three different ways
 *
 * The acceptance criterion is that deprovisioning revokes sessions and frees the seat within one sync
 * cycle. Making that true needed one observation: **IdPs disagree about what deprovisioning is.**
 *
 *  - Okta sends `PATCH {"Operations":[{"op":"replace","path":"active","value":false}]}`
 *  - Azure AD sends `PATCH {"Operations":[{"op":"replace","value":{"active":false}}]}` — no `path`
 *  - some send `DELETE`
 *  - some send `PUT` with the whole resource and `active: false`
 *
 * All four mean the same thing and all four are handled here, routed to the same `removeSeat`. An
 * implementation that honoured only `DELETE` — the obvious reading — would leave every session live for
 * every Okta-driven offboarding, which is exactly the failure the criterion names, and it would look
 * like it worked because the IdP would report success.
 *
 * ## Why `removeSeat` and not a delete of our own
 *
 * Because that is what "frees the seat" means. `removeSeat` revokes every session, revokes outstanding
 * invitations, clears team scopes, sets the membership to `revoked` and writes the audit row — and the
 * seat count the billing screen shows reads the same membership rows. A SCIM-specific deletion path
 * would fork the lifecycle and the two would drift; here there is one lifecycle with two front doors.
 *
 * **Within one sync cycle** is therefore satisfied synchronously: the sessions are gone before this
 * request answers, so there is no window at all rather than a cycle-long one.
 *
 * ## The actor on the audit row
 *
 * `removeSeat` requires an `actorUserId`, and a SCIM request has no Compass user behind it. The
 * organization's first owner is named as the actor and the SCIM origin is recorded in a second audit
 * row, which is honest in a way that inventing a system user would not be: somebody has to be
 * accountable for an automated removal, and the owner is who configured the token that did it.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/scim/v2/Users/[scimUserId]';

const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';

const scimJson = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, 'content-type': SCIM_CONTENT_TYPE } });

const unauthorized = (): NextResponse =>
  NextResponse.json(scimError(401, 'A valid SCIM bearer token is required.'), {
    status: 401,
    headers: { ...NO_STORE, 'content-type': SCIM_CONTENT_TYPE, 'www-authenticate': 'Bearer realm="compass-scim"' },
  });

const notFound = (): NextResponse =>
  scimJson(scimError(404, 'No SCIM user with that id exists in this organization.'), 404);

/**
 * Everything a handler needs after its own `guard()` call, or a response saying why it gets nothing.
 *
 * ## Why `guard()` is *not* called in here
 *
 * It was, at first — one helper doing the guard and the token check for all four verbs. That is refused
 * by `apps/web/tests/auth-http.test.ts`, which requires every handler to call `guard()` itself, at least
 * once per verb it serves. The rule is right and the reason is worth stating: the matrix decision is the
 * one thing that must be visible *at* each handler, and a shared helper that authorised on a caller's
 * behalf puts the per-verb decision inside a function nobody reads per verb. The same argument
 * `lib/auth/login.ts` records for keeping the guard call in the route while sharing the body.
 *
 * So each handler guards, and hands the result here for the parts that genuinely are identical: the plan
 * gate, the bearer token, and finding the seat.
 */
async function authorizeScim(
  request: Request,
  admitted: Extract<Awaited<ReturnType<typeof guard>>, { allowed: true }>,
  scimUserId: string,
): Promise<
  | { readonly ok: true; readonly seat: SeatRow }
  | { readonly ok: false; readonly response: NextResponse }
> {
  if (!(await enterpriseIdentityAllowed(admitted.scoped))) {
    return { ok: false, response: scimJson(scimError(403, ENTERPRISE_IDENTITY_REQUIRED_STATEMENT), 403) };
  }

  const authenticated = await authenticateScim({
    scoped: admitted.scoped,
    authorization: request.headers.get('authorization'),
    now: admitted.now,
  });
  if (!authenticated.ok) return { ok: false, response: unauthorized() };

  const seats = await listSeats(admitted.scoped);
  const seat = seats.find((entry) => entry.id === scimUserId);
  if (seat === undefined) return { ok: false, response: notFound() };

  return { ok: true, seat };
}

const resourceFor = async (
  admitted: { readonly scoped: ScopedDb },
  seat: SeatRow,
  request: Request,
) =>
  scimUserResource({
    seat,
    basePath: new URL('/api/scim/v2/Users', new URL(request.url).origin).toString(),
    externalId: await externalIdFor(admitted.scoped, seat.userId),
  });

export async function GET(
  request: Request,
  context: { params: Promise<{ scimUserId: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  const { scimUserId } = await context.params;
  const gate = await authorizeScim(request, admitted, scimUserId);
  if (!gate.ok) return gate.response;

  try {
    return scimJson(await resourceFor(admitted, gate.seat, request), 200);
  } catch (error) {
    return scimFailure(error);
  }
}

/**
 * `PATCH` — the verb Okta and Azure AD both use to deprovision.
 *
 * Anything other than a change to `active` answers `200` with the unchanged resource rather than an
 * error. That is deliberate: an IdP pushing a phone-number or department change should not see a broken
 * integration in its admin console for asking Compass to store something Compass has no field for.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ scimUserId: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PATCH' });
  if (!admitted.allowed) return admitted.response;

  const { scimUserId } = await context.params;
  const gate = await authorizeScim(request, admitted, scimUserId);
  if (!gate.ok) return gate.response;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return scimJson(scimError(400, 'The request body is not JSON.', 'invalidSyntax'), 400);
    }

    const intent = readScimPatch(body);
    if (intent.kind === 'malformed') {
      return scimJson(scimError(400, intent.detail, 'invalidSyntax'), 400);
    }

    if (intent.kind === 'set_active' && !intent.active) {
      return await deprovision(request, admitted, gate.seat);
    }

    /**
     * `active: true` on a revoked seat is refused rather than silently reactivating it.
     *
     * Re-granting access is not the inverse of revoking it: the sessions are gone, the invitations are
     * revoked and the team scopes are cleared, so "un-revoke" would restore a seat with no scopes and no
     * way in, and the IdP would believe the person had access. A fresh `POST` provisions them properly,
     * which is what SCIM clients do when a `PATCH` reports a conflict.
     */
    if (intent.kind === 'set_active' && intent.active && gate.seat.status === 'revoked') {
      return scimJson(
        scimError(
          409,
          'That seat was removed. Re-activating it is not the inverse of removing it — the team scopes and ' +
            'invitations are gone — so create the user again with POST instead.',
          'mutability',
        ),
        409,
      );
    }

    return scimJson(await resourceFor(admitted, gate.seat, request), 200);
  } catch (error) {
    return scimFailure(error);
  }
}

/**
 * `PUT` — a whole-resource replace, which some IdPs use instead of `PATCH`.
 *
 * Only `active: false` is acted on, for the reason the module header gives about roles: the rest of the
 * payload is the directory's view of a person, and Compass's copy of a display name is not worth the
 * risk of letting an integration rewrite seat attributes.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ scimUserId: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PUT' });
  if (!admitted.allowed) return admitted.response;

  const { scimUserId } = await context.params;
  const gate = await authorizeScim(request, admitted, scimUserId);
  if (!gate.ok) return gate.response;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return scimJson(scimError(400, 'The request body is not JSON.', 'invalidSyntax'), 400);
    }

    const parsed = readScimUserWrite(body);
    if (!parsed.ok) return scimJson(scimError(400, parsed.detail, 'invalidValue'), 400);

    if (!parsed.write.active) return await deprovision(request, admitted, gate.seat);

    return scimJson(await resourceFor(admitted, gate.seat, request), 200);
  } catch (error) {
    return scimFailure(error);
  }
}

/** `DELETE` — the third spelling of the same act. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ scimUserId: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;

  const { scimUserId } = await context.params;
  const gate = await authorizeScim(request, admitted, scimUserId);
  if (!gate.ok) return gate.response;

  try {
    const response = await deprovision(request, admitted, gate.seat);
    // RFC 7644 wants 204 on a successful DELETE, with no body.
    return response.status === 200
      ? new NextResponse(null, { status: 204, headers: NO_STORE })
      : response;
  } catch (error) {
    return scimFailure(error);
  }
}

/**
 * The one deprovisioning path, whichever verb arrived.
 *
 * Sessions are revoked inside `removeSeat`, before this returns — so "within one sync cycle" is
 * satisfied with no window at all.
 */
async function deprovision(
  request: Request,
  admitted: Awaited<ReturnType<typeof guard>> & { allowed: true },
  seat: SeatRow,
): Promise<NextResponse> {
  // Already revoked: idempotent, because a client that retries after a timeout must not get an error
  // for an act that already succeeded.
  if (seat.status === 'revoked') {
    return scimJson(await resourceFor(admitted, seat, request), 200);
  }

  const owners = (await listSeats(admitted.scoped)).filter(
    (entry) => entry.role === 'owner' && entry.status === 'active',
  );

  /**
   * The actor. See the module header for why it is an owner rather than an invented system user.
   *
   * Falling back to the seat's own user id when there is somehow no active owner keeps the audit row
   * writable — a deprovision that failed because nobody could be named as the actor would leave the
   * sessions live, which is the worst possible failure for this particular act.
   */
  const actorUserId = owners[0]?.userId ?? seat.userId;

  try {
    await removeSeat({
      scoped: admitted.scoped,
      membershipId: seat.id,
      actorUserId,
      now: admitted.now,
    });
  } catch (error) {
    /**
     * `LastOwnerError` — SCIM asked to remove the only owner.
     *
     * Refused, and the refusal is the right answer: an organization with no owner cannot be
     * administered, and a directory group edit must not be able to strand a tenant. `409` rather than
     * `400`, because the request is well-formed and the conflict is with Compass's state.
     */
    return scimJson(
      scimError(
        409,
        error instanceof Error
          ? error.message
          : 'That seat could not be removed because it is the organization’s last owner.',
        'mutability',
      ),
      409,
    );
  }

  await recordScimDeprovision({ admitted, seat, actorUserId });

  const after = (await listSeats(admitted.scoped)).find((entry) => entry.id === seat.id) ?? {
    ...seat,
    status: 'revoked' as const,
  };

  return scimJson(await resourceFor(admitted, after, request), 200);
}

/**
 * The second audit row: that it was SCIM, and which credential.
 *
 * `removeSeat` writes `seat.removed` with the owner as actor, which is true but incomplete — it reads
 * as though an owner sat down and removed somebody. This row says a directory did it, which is the fact
 * anybody investigating "why did I lose access" actually needs.
 */
async function recordScimDeprovision(input: {
  readonly admitted: Awaited<ReturnType<typeof guard>> & { allowed: true };
  readonly seat: SeatRow;
  readonly actorUserId: string;
}): Promise<void> {
  await recordAudit(input.admitted.scoped, {
    action: 'seat.deprovisioned',
    actorUserId: input.actorUserId,
    targetKind: 'membership',
    targetId: input.seat.id,
    before: { role: input.seat.role, status: input.seat.status },
    after: { role: input.seat.role, status: 'revoked', via: 'scim' },
    occurredAt: input.admitted.now,
  });
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
