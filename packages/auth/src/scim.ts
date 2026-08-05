import { toIso, type Instant } from '@compass/clock';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  findLiveScimCredential,
  listIdentitiesForUser,
  listSeats,
  normalizeEmail,
  touchScimCredential,
  type MembershipRole,
  type ScopedDb,
  type SeatRow,
} from '@compass/db';

/**
 * SCIM 2.0 user provisioning, the service-provider half.
 *
 * ## What SCIM is being asked to do here, and what it is not
 *
 * SCIM is a directory pushing its own membership into Compass. So the mapping is deliberately narrow:
 * a SCIM User *is* a Compass seat, and `id` is the membership id. There is no parallel "SCIM user"
 * concept, and that is the load-bearing decision in this module — a separate table would fork the seat
 * lifecycle, and the acceptance criterion is precisely that deprovisioning **frees a seat**, which is
 * only true if the thing SCIM removes is the same thing the seat count reads.
 *
 * So `deprovision` does not delete rows of its own. It calls the same `removeSeat` the owner-facing
 * seat screen calls, which revokes every session, revokes outstanding invitations, clears team scopes
 * and writes an audit row. One lifecycle, two front doors.
 *
 * ## `active: false` is a deprovision, not a field update
 *
 * IdPs deprovision in two different ways and Compass has to treat them as one act: Okta sends
 * `PATCH {active: false}`, Azure AD sends `DELETE`, and some send `PUT` with the whole resource. All
 * three arrive here as "this person should no longer have access", so all three route to the same
 * `removeSeat`. An implementation that honoured only `DELETE` would leave sessions live for every
 * Okta-driven offboarding — which is the exact failure the criterion names.
 *
 * ## Roles are not taken from the assertion
 *
 * A SCIM payload can say anything; it arrives from an integration that an IdP administrator
 * configured, and Compass's roles decide who can read whose reports and who can move money. So a
 * provisioned seat gets the connection's configured `defaultRole` — which the database forbids from
 * being `owner` — and a role *change* stays an owner's act in Compass. This is stated in
 * `docs/ENGINEERING.md` because it is a deliberate reduction of what SCIM usually controls.
 *
 * ## No clock read, and one bearer-token rule
 *
 * `now` is a parameter. The token is compared by digest in constant time and only its digest is
 * stored — the same rule sessions and mailed tokens follow, with more force rather than less, because
 * this credential can remove seats.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** 256 bits, base64url. Long enough that guessing is not a strategy; shown once. */
export const SCIM_TOKEN_BYTES = 32;

export const generateScimToken = (): string => randomBytes(SCIM_TOKEN_BYTES).toString('base64url');

/** SHA-256 hex. The only form that reaches the database. */
export const hashScimToken = (token: string): string =>
  createHash('sha256').update(token.trim(), 'utf8').digest('hex');

/**
 * Pulls the bearer token out of an `Authorization` header.
 *
 * Returns null rather than throwing for anything that is not exactly `Bearer <token>`, so a malformed
 * header and an unknown token produce the same 401 — telling them apart would confirm to a prober
 * that the *format* was right, which is the first thing they need to know.
 */
export function bearerTokenFrom(authorization: string | null): string | null {
  if (authorization === null) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export type ScimAuthentication =
  | { readonly ok: true; readonly credentialId: string }
  | { readonly ok: false };

/**
 * Authenticates a SCIM request and records that the credential was used.
 *
 * The digest lookup is the comparison — `findLiveScimCredential` filters on `revoked_at IS NULL` in
 * the predicate, so a revoked token is indistinguishable from an unknown one. The extra
 * `timingSafeEqual` is belt to that braces: it makes the comparison of the *digest* constant-time even
 * if a future index change made the query's timing depend on the value.
 */
export async function authenticateScim(input: {
  readonly scoped: ScopedDb;
  readonly authorization: string | null;
  readonly now: Instant;
}): Promise<ScimAuthentication> {
  const token = bearerTokenFrom(input.authorization);
  if (token === null) return { ok: false };

  const digest = hashScimToken(token);
  const credential = await findLiveScimCredential(input.scoped, digest);
  if (credential === null) return { ok: false };

  const expected = Buffer.from(digest, 'utf8');
  const actual = Buffer.from(hashScimToken(token), 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false };

  await touchScimCredential(input.scoped, credential.id, input.now);

  return { ok: true, credentialId: credential.id };
}

// ---------------------------------------------------------------------------
// The resource representation
// ---------------------------------------------------------------------------

export interface ScimUserResource {
  readonly schemas: readonly string[];
  /** The membership id. See the header: a SCIM User *is* a Compass seat. */
  readonly id: string;
  /** The IdP's own id for this person, when one was supplied at provisioning time. */
  readonly externalId?: string;
  readonly userName: string;
  readonly name: { readonly formatted: string };
  readonly emails: readonly { readonly value: string; readonly primary: boolean; readonly type: string }[];
  /** False once the seat is revoked, which is how an IdP reads a deprovision back. */
  readonly active: boolean;
  readonly meta: {
    readonly resourceType: 'User';
    readonly created: string;
    readonly lastModified: string;
    readonly location: string;
  };
  /**
   * The Compass role, under the enterprise extension namespace.
   *
   * Exposed read-only and deliberately not writable: see the header. An IdP that could set it could
   * grant itself whatever Compass access it liked.
   */
  readonly 'urn:compass:params:scim:schemas:extension:2.0:User'?: {
    readonly role: MembershipRole;
  };
}

/** One seat as a SCIM resource. `basePath` is the collection URL, for `meta.location`. */
export function scimUserResource(input: {
  readonly seat: SeatRow;
  readonly basePath: string;
  readonly externalId?: string | null;
}): ScimUserResource {
  const { seat } = input;

  return {
    schemas: [SCIM_USER_SCHEMA],
    id: seat.id,
    ...(input.externalId === null || input.externalId === undefined ? {} : { externalId: input.externalId }),
    userName: seat.email,
    name: { formatted: seat.displayName },
    emails: [{ value: seat.email, primary: true, type: 'work' }],
    // `pending` counts as active: the seat exists and is assigned, the person simply has not signed in
    // yet. Reporting it inactive would make an IdP think its own provisioning had failed and retry.
    active: seat.status !== 'revoked',
    meta: {
      resourceType: 'User',
      // `toIso` rather than `new Date(...)`: an `Instant` is a branded epoch-millis number, and the
      // clock package owns the conversion so a formatting change lands in one place.
      created: toIso(seat.createdAt),
      lastModified: toIso(seat.updatedAt),
      location: `${input.basePath}/${seat.id}`,
    },
    'urn:compass:params:scim:schemas:extension:2.0:User': { role: seat.role },
  };
}

export interface ScimListResponse {
  readonly schemas: readonly string[];
  readonly totalResults: number;
  readonly itemsPerPage: number;
  readonly startIndex: number;
  readonly Resources: readonly ScimUserResource[];
}

/**
 * The `Users` collection, with the one filter IdPs actually send.
 *
 * SCIM defines a whole filter grammar; every IdP uses it to ask exactly one question —
 * `userName eq "someone@example.com"` — as the "does this person already exist" probe before creating
 * them. So that one form is parsed and anything else is refused with `400` rather than silently
 * ignored, because an ignored filter returns *every* user to a client that asked for one, and the IdP
 * would read the first row as a match and start updating the wrong person.
 */
export type ScimFilter =
  | { readonly kind: 'none' }
  | { readonly kind: 'user_name'; readonly value: string }
  | { readonly kind: 'unsupported'; readonly raw: string };

export function parseScimFilter(filter: string | null): ScimFilter {
  if (filter === null || filter.trim().length === 0) return { kind: 'none' };

  const match = /^\s*userName\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
  if (match === null) return { kind: 'unsupported', raw: filter };

  return { kind: 'user_name', value: normalizeEmail(match[1] ?? '') };
}

export const scimError = (status: number, detail: string, scimType?: string) => ({
  schemas: [SCIM_ERROR_SCHEMA],
  status: String(status),
  ...(scimType === undefined ? {} : { scimType }),
  detail,
});

/**
 * Lists seats as SCIM users, applying the filter.
 *
 * Revoked seats are included rather than hidden, because SCIM's model is that a deprovisioned user
 * still *exists* with `active: false`. Hiding them would make an IdP re-create somebody it had just
 * removed, in a loop.
 */
export async function scimListUsers(input: {
  readonly scoped: ScopedDb;
  readonly filter: ScimFilter;
  readonly basePath: string;
}): Promise<ScimListResponse> {
  const seats = await listSeats(input.scoped);

  // Destructured before the closure: narrowing `input.filter` does not survive into a callback,
  // because TypeScript cannot know the property was not reassigned in between.
  const filter = input.filter;
  const matched =
    filter.kind === 'user_name'
      ? seats.filter((seat) => normalizeEmail(seat.email) === filter.value)
      : seats;

  const resources = await Promise.all(
    matched.map(async (seat) => scimUserResource({ seat, basePath: input.basePath, externalId: await externalIdFor(input.scoped, seat.userId) })),
  );

  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources,
  };
}

/** The IdP's own id for this person, from the `scim` identity row, or null. */
export async function externalIdFor(scoped: ScopedDb, userId: string): Promise<string | null> {
  const identities = await listIdentitiesForUser(scoped, userId);
  return identities.find((identity) => identity.provider === 'scim')?.subject ?? null;
}

// ---------------------------------------------------------------------------
// Reading a write payload
// ---------------------------------------------------------------------------

export interface ScimUserWrite {
  readonly userName: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly active: boolean;
}

export type ScimWriteResult =
  | { readonly ok: true; readonly write: ScimUserWrite }
  | { readonly ok: false; readonly detail: string };

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Reads a `POST`/`PUT` user payload.
 *
 * `userName` is required and is treated as the email address, which is what every IdP puts there for
 * a work directory. The display name is assembled from whichever of the three shapes the IdP used —
 * `displayName`, `name.formatted`, or `name.givenName` + `name.familyName` — because they all appear
 * in practice and a seat with an empty name is worse than a slightly wrong one.
 */
export function readScimUserWrite(body: unknown): ScimWriteResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, detail: 'The request body must be a SCIM User object.' };
  }

  const record = body as Record<string, unknown>;
  const userName = normalizeEmail(asString(record['userName']));

  if (userName.length === 0 || !userName.includes('@')) {
    return { ok: false, detail: 'userName is required and must be the user’s email address.' };
  }

  const name = (typeof record['name'] === 'object' && record['name'] !== null
    ? (record['name'] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const assembled = [asString(name['givenName']), asString(name['familyName'])].filter((part) => part.length > 0);

  const displayName =
    [asString(record['displayName']), asString(name['formatted']), assembled.join(' ')].find(
      (candidate) => candidate.length > 0,
    ) ?? userName;

  const externalId = asString(record['externalId']);

  return {
    ok: true,
    write: {
      userName,
      displayName,
      externalId: externalId.length === 0 ? null : externalId,
      // Absent means active: a `POST` that omits the field is creating somebody who should have access.
      active: record['active'] === undefined ? true : record['active'] !== false,
    },
  };
}

/**
 * What a `PATCH` asks for, reduced to the one question Compass answers.
 *
 * SCIM PatchOp is a general path-and-value language. Compass reads exactly one thing out of it —
 * whether this person should still have access — because that is the only mutable field it honours
 * (see the header on roles). Anything else is reported as `no_op` rather than as an error: an IdP that
 * pushes a phone-number change should get a `200` and a resource back, not a `400` that its admin
 * console will surface as a broken integration.
 */
export type ScimPatchIntent =
  | { readonly kind: 'set_active'; readonly active: boolean }
  | { readonly kind: 'no_op' }
  | { readonly kind: 'malformed'; readonly detail: string };

export function readScimPatch(body: unknown): ScimPatchIntent {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'malformed', detail: 'The request body must be a SCIM PatchOp.' };
  }

  const operations = (body as Record<string, unknown>)['Operations'];
  if (!Array.isArray(operations)) {
    return { kind: 'malformed', detail: 'A PatchOp must carry an Operations array.' };
  }

  let intent: ScimPatchIntent = { kind: 'no_op' };

  for (const raw of operations) {
    if (typeof raw !== 'object' || raw === null) continue;
    const operation = raw as Record<string, unknown>;

    const op = asString(operation['op']).toLowerCase();
    if (op !== 'replace' && op !== 'add') continue;

    const path = asString(operation['path']).toLowerCase();
    const value = operation['value'];

    /**
     * Two shapes, and both are sent in the wild.
     *
     * Okta sends `{op: "replace", path: "active", value: false}`; Azure AD sends
     * `{op: "replace", value: {active: false}}` with no path at all. Handling only the first is how a
     * deprovision silently becomes a no-op for half the market.
     */
    if (path === 'active') {
      intent = { kind: 'set_active', active: value !== false && value !== 'false' };
      continue;
    }

    if (path === '' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>)['active'];
      if (nested !== undefined) {
        intent = { kind: 'set_active', active: nested !== false && nested !== 'false' };
      }
    }
  }

  return intent;
}
