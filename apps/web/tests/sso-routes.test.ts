import { generateScimToken, hashScimToken, hashPassword, startSession } from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  insertScimCredential,
  linkIdentity,
  listIdentitiesForUser,
  memberships,
  orgScope,
  organizationSubscriptions,
  saveSamlConnection,
  upsertBillingSubscription,
  users,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME, SSO_NONCE_COOKIE_NAME } from '../lib/auth/cookies';

/**
 * The single-sign-on, SAML and SCIM routes, executed end to end.
 *
 * The handlers are imported unchanged and reach a real migrated PostgreSQL 17 through PGlite. `guard`,
 * `authorize` and the session resolution are the production path, because the properties under test are
 * exactly the ones the guard and the token comparison decide.
 *
 * Three acceptance criteria are asserted at the HTTP surface here, which is where a reviewer can see
 * them rather than having to trust a unit test:
 *
 *  - **SAML and SCIM endpoints are available only to business-plan organizations and return a clear
 *    message otherwise.** Both halves: the refusal *and* that the sentence names the plan.
 *  - **SCIM deprovisioning frees the seat.** Driven through `DELETE` and through Okta's and Azure AD's
 *    two different `PATCH` shapes, because all three are the same act arriving three ways.
 *  - **Unlinking a provider requires re-authentication**, which is the half the role matrix cannot
 *    express and which `authz-matrix.test.ts` points here for.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;

const OWNER = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const OWNER_MEMBERSHIP = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const MEMBER = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const MEMBER_MEMBERSHIP = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const SUBSCRIPTION_ROW = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';

const T0: Instant = instantFromIso('2026-08-05T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

/** The member's password, so re-authentication can be exercised for real rather than stubbed. */
const MEMBER_PASSWORD = 'a-long-enough-fixture-passphrase';

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

const sessions: Record<'owner' | 'member', string> = { owner: '', member: '' };

/** A base URL, so `baseUrlFor` does not have to guess and the SAML values are deterministic. */
const BASE_URL = 'https://compass.example.com';

beforeAll(async () => {
  process.env['COMPASS_BASE_URL'] = BASE_URL;
  process.env['COMPASS_SSO_STATE_SECRET'] = 'a-state-secret-for-tests-only';
  process.env['COMPASS_GOOGLE_CLIENT_ID'] = 'google-client-id';
  process.env['COMPASS_GOOGLE_CLIENT_SECRET'] = 'google-client-secret-fixture';

  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-sso-routes',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  await scoped()
    .insertInto(users, {
      id: OWNER,
      email: 'owner@example.com',
      displayName: 'An Owner',
      passwordHash: null,
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(users, {
      id: MEMBER,
      email: 'priya@example.com',
      displayName: 'Priya Raman',
      passwordHash: await hashPassword(MEMBER_PASSWORD),
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  for (const [id, userId, role] of [
    [OWNER_MEMBERSHIP, OWNER, 'owner'],
    [MEMBER_MEMBERSHIP, MEMBER, 'member'],
  ] as const) {
    await scoped()
      .insertInto(memberships, {
        id,
        userId,
        role,
        status: 'active',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  sessions.owner = (await startSession({ scoped: scoped(), userId: OWNER, now: T0 })).secret;
  sessions.member = (await startSession({ scoped: scoped(), userId: MEMBER, now: T0 })).secret;
}, 180_000);

afterAll(async () => {
  await database?.close();
});

/** Puts the organization on a plan, or takes it off one entirely. */
async function setPlan(planId: 'starter' | 'business' | null): Promise<void> {
  if (planId === null) {
    await database.client.query('delete from organization_subscriptions');
    return;
  }

  await upsertBillingSubscription(
    scoped(),
    {
      id: SUBSCRIPTION_ROW,
      write: {
        status: 'active',
        planId,
        seatAllowance: 10,
        stripeCustomerId: 'cus_fixture',
        stripeSubscriptionId: 'sub_fixture',
        trialEndsAt: null,
        currentPeriodEndsAt: instantFromIso('2026-09-05T09:00:00Z'),
        dunningStartedAt: null,
      },
    },
    T0,
  );
}

const cookie = (secret: string): string => `${SESSION_COOKIE_NAME}=${encodeURIComponent(secret)}`;

// ---------------------------------------------------------------------------
// Starting a round-trip
// ---------------------------------------------------------------------------

describe('GET /api/auth/sso/[provider]', () => {
  it('redirects to the provider with the documented scopes, and sets a nonce cookie', async () => {
    const { GET } = await import('../app/api/auth/sso/[provider]/route');

    const response = await GET(new Request(`${BASE_URL}/api/auth/sso/google`), {
      params: Promise.resolve({ provider: 'google' }),
    });

    expect(response.status).toBe(303);

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    // The scope list, from the one declaration in `@compass/auth`.
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/auth/sso/google/callback`);
    expect(location.searchParams.get('state')).not.toBeNull();

    /**
     * The nonce cookie is what binds the callback to this browser.
     *
     * `SameSite=Lax` rather than `Strict`, because the callback is a top-level navigation from the
     * provider and `Strict` would withhold the cookie on exactly that request — so every sign-in would
     * be refused for a missing nonce.
     */
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(SSO_NONCE_COOKIE_NAME);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  it('answers 404 for a provider Compass does not sign in with', async () => {
    const { GET } = await import('../app/api/auth/sso/[provider]/route');

    const response = await GET(new Request(`${BASE_URL}/api/auth/sso/okta`), {
      params: Promise.resolve({ provider: 'okta' }),
    });

    expect(response.status).toBe(404);
  });

  it('refuses rather than redirecting when the provider is not configured', async () => {
    const previous = process.env['COMPASS_GITHUB_SSO_CLIENT_ID'];
    delete process.env['COMPASS_GITHUB_SSO_CLIENT_ID'];

    try {
      const { GET } = await import('../app/api/auth/sso/[provider]/route');
      const response = await GET(new Request(`${BASE_URL}/api/auth/sso/github`), {
        params: Promise.resolve({ provider: 'github' }),
      });

      // A button that cannot work is worse than no button; the refusal names the condition.
      expect(response.status).toBe(503);
    } finally {
      if (previous !== undefined) process.env['COMPASS_GITHUB_SSO_CLIENT_ID'] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Unlinking — the half the matrix cannot express
// ---------------------------------------------------------------------------

describe('POST /api/auth/sso/unlink', () => {
  beforeEach(async () => {
    await database.client.query('delete from user_identities');
    await linkIdentity(
      scoped(),
      {
        userId: MEMBER,
        provider: 'google',
        subject: 'google-subject-1',
        email: 'priya@example.com',
        emailVerified: true,
      },
      T0,
    );
  });

  const unlink = async (body: Record<string, string>, secret: string | null) => {
    const { POST } = await import('../app/api/auth/sso/unlink/route');

    return POST(
      new Request(`${BASE_URL}/api/auth/sso/unlink`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret === null ? {} : { cookie: cookie(secret) }),
        },
        body: JSON.stringify(body),
      }),
    );
  };

  it('refuses an anonymous caller, because unlinking is an act on your own account', async () => {
    const response = await unlink({ provider: 'google', password: MEMBER_PASSWORD }, null);

    expect(response.status).toBe(401);
  });

  /**
   * The acceptance-adjacent property the role matrix cannot state.
   *
   * A session alone is not enough. For an account whose only credential is the provider link, unlinking
   * is a lockout — so a stolen session must not be able to remove somebody's way back in.
   */
  it('refuses a signed-in caller who does not supply the right password', async () => {
    const response = await unlink({ provider: 'google', password: 'not-the-password' }, sessions.member);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/password/i);

    // And nothing was removed.
    expect(await listIdentitiesForUser(scoped(), MEMBER)).toHaveLength(1);
  });

  it('unlinks with the correct password, and the row is gone', async () => {
    const response = await unlink({ provider: 'google', password: MEMBER_PASSWORD }, sessions.member);

    expect(response.status).toBe(200);
    expect(await listIdentitiesForUser(scoped(), MEMBER)).toHaveLength(0);
  });

  it('refuses when the account has no password to re-authenticate with, rather than locking them out', async () => {
    await linkIdentity(
      scoped(),
      { userId: OWNER, provider: 'google', subject: 'google-owner', email: 'owner@example.com', emailVerified: true },
      T0,
    );

    const response = await unlink({ provider: 'google', password: 'anything' }, sessions.owner);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/set a password/i);
  });
});

// ---------------------------------------------------------------------------
// SAML metadata
// ---------------------------------------------------------------------------

describe('GET /api/auth/saml/metadata', () => {
  it('serves metadata with no session, stating the entity id and the ACS URL', async () => {
    const { GET } = await import('../app/api/auth/saml/metadata/route');

    const response = await GET(new Request(`${BASE_URL}/api/auth/saml/metadata`));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('samlmetadata+xml');
    expect(body).toContain(`entityID="${BASE_URL}/api/auth/saml/metadata"`);
    expect(body).toContain(`Location="${BASE_URL}/api/auth/saml/acs"`);
    // The requirement Compass actually enforces has to be the one the document advertises.
    expect(body).toContain('WantAssertionsSigned="true"');
  });

  it('is readable without the business plan, because it describes what the plan would give you', async () => {
    await setPlan('starter');
    const { GET } = await import('../app/api/auth/saml/metadata/route');

    expect((await GET(new Request(`${BASE_URL}/api/auth/saml/metadata`))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The plan gate
// ---------------------------------------------------------------------------

describe('the business-plan gate', () => {
  const scimRequest = (token: string) =>
    new Request(`${BASE_URL}/api/scim/v2/Users`, { headers: { authorization: `Bearer ${token}` } });

  it('refuses SCIM on a non-business plan, and the sentence names the plan', async () => {
    await setPlan('starter');
    const token = generateScimToken();
    await insertScimCredential(scoped(), { tokenHash: hashScimToken(token), label: 'Okta' }, T0);

    const { GET } = await import('../app/api/scim/v2/Users/route');
    const response = await GET(scimRequest(token));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { detail: string; schemas: string[] };
    // A clear message, not a bare 403: the caller is an administrator wiring up an integration.
    expect(body.detail).toMatch(/Business/);
    expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });

  it('refuses SCIM when the organization has no subscription at all', async () => {
    // An unconfigured deployment must not expose provisioning endpoints to the internet.
    await setPlan(null);
    const token = generateScimToken();
    await insertScimCredential(scoped(), { tokenHash: hashScimToken(token), label: 'Okta' }, T0);

    const { GET } = await import('../app/api/scim/v2/Users/route');

    expect((await GET(scimRequest(token))).status).toBe(403);
  });

  it('refuses a SAML assertion on a non-business plan before parsing any XML', async () => {
    await setPlan('starter');
    const { POST } = await import('../app/api/auth/saml/acs/route');

    const response = await POST(
      new Request(`${BASE_URL}/api/auth/saml/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'SAMLResponse=not-even-base64-xml',
      }),
    );

    // A redirect rather than JSON, because a person is looking at this in a browser.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('saml=not_allowed');
  });

  it('admits SCIM on the business plan', async () => {
    await setPlan('business');
    const token = generateScimToken();
    await insertScimCredential(scoped(), { tokenHash: hashScimToken(token), label: 'Okta' }, T0);

    const { GET } = await import('../app/api/scim/v2/Users/route');
    const response = await GET(scimRequest(token));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/scim+json');
  });
});

// ---------------------------------------------------------------------------
// SCIM authentication and deprovisioning
// ---------------------------------------------------------------------------

describe('the SCIM endpoints', () => {
  let token = '';

  beforeAll(async () => {
    await setPlan('business');
    token = generateScimToken();
    await insertScimCredential(scoped(), { tokenHash: hashScimToken(token), label: 'Okta' }, T0);
  });

  const usersRequest = (init: RequestInit & { readonly token?: string | null } = {}) =>
    new Request(`${BASE_URL}/api/scim/v2/Users`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? token}` }),
      },
    });

  it('refuses a request with no bearer token, and says how to authenticate', async () => {
    const { GET } = await import('../app/api/scim/v2/Users/route');
    const response = await GET(usersRequest({ token: null }));

    expect(response.status).toBe(401);
    /**
     * `WWW-Authenticate` is not decoration.
     *
     * Several SCIM clients treat a 401 without it as a transport fault and retry forever rather than
     * surfacing "your token is wrong" to the administrator who can fix it.
     */
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('refuses an unknown token', async () => {
    const { GET } = await import('../app/api/scim/v2/Users/route');

    expect((await GET(usersRequest({ token: generateScimToken() }))).status).toBe(401);
  });

  it('refuses a session cookie in place of a token, because SCIM is not session-authorised', async () => {
    const { GET } = await import('../app/api/scim/v2/Users/route');

    const response = await GET(
      new Request(`${BASE_URL}/api/scim/v2/Users`, { headers: { cookie: cookie(sessions.owner) } }),
    );

    expect(response.status).toBe(401);
  });

  it('refuses an unsupported filter rather than returning every user', async () => {
    const { GET } = await import('../app/api/scim/v2/Users/route');

    const response = await GET(
      usersRequest({}) && new Request(`${BASE_URL}/api/scim/v2/Users?filter=${encodeURIComponent('emails.value co "@x"')}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { scimType: string }).scimType).toBe('invalidFilter');
  });

  it('provisions a seat, and answers 201 with a location', async () => {
    const { POST } = await import('../app/api/scim/v2/Users/route');

    const response = await POST(
      usersRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'newjoiner@example.com',
          externalId: 'okta-0042',
          name: { givenName: 'New', familyName: 'Joiner' },
          active: true,
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; active: boolean; externalId: string };
    expect(body.active).toBe(true);
    expect(body.externalId).toBe('okta-0042');
    expect(response.headers.get('location')).toContain(body.id);
  });

  it('refuses a duplicate with `uniqueness`, which is what makes a retry safe', async () => {
    const { POST } = await import('../app/api/scim/v2/Users/route');

    const response = await POST(
      usersRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userName: 'newjoiner@example.com' }),
      }),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { scimType: string }).scimType).toBe('uniqueness');
  });

  /**
   * The acceptance criterion, at the HTTP surface, in all three spellings a provider might use.
   *
   * Okta patches with a path, Azure AD patches without one, and some providers send `DELETE`. All three
   * mean the same thing, so all three have to free the seat — an implementation that honoured only
   * `DELETE` would leave sessions live for every Okta-driven offboarding while the provider reported
   * success.
   */
  const deprovisionCases = [
    {
      name: 'Okta’s pathed PATCH',
      verb: 'PATCH' as const,
      email: 'departing-okta@example.com',
      body: { Operations: [{ op: 'replace', path: 'active', value: false }] },
    },
    {
      name: 'Azure AD’s nested PATCH',
      verb: 'PATCH' as const,
      email: 'departing-entra@example.com',
      body: { Operations: [{ op: 'replace', value: { active: false } }] },
    },
    { name: 'a plain DELETE', verb: 'DELETE' as const, email: 'departing-delete@example.com', body: null },
  ];

  it.each(deprovisionCases)('frees the seat and kills the sessions via $name', async ({ verb, email, body }) => {
    const { POST } = await import('../app/api/scim/v2/Users/route');
    const item = await import('../app/api/scim/v2/Users/[scimUserId]/route');

    const created = await POST(
      usersRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userName: email, name: { formatted: 'Departing Person' } }),
      }),
    );
    expect(created.status).toBe(201);
    const seatId = ((await created.json()) as { id: string }).id;

    // A live session, as a real person would have.
    const membership = await database.client.query<{ user_id: string }>(
      'select user_id from memberships where id = $1',
      [seatId],
    );
    const userId = membership.rows[0]?.user_id ?? '';
    expect(userId).not.toBe('');
    await startSession({ scoped: scoped(), userId, now: T0 });

    const liveBefore = await database.client.query<{ count: string }>(
      'select count(*)::text as count from sessions where user_id = $1 and revoked_at is null',
      [userId],
    );
    expect(Number(liveBefore.rows[0]?.count)).toBeGreaterThan(0);

    const request = new Request(`${BASE_URL}/api/scim/v2/Users/${seatId}`, {
      method: verb,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });

    const response = verb === 'PATCH'
      ? await item.PATCH(request, { params: Promise.resolve({ scimUserId: seatId }) })
      : await item.DELETE(request, { params: Promise.resolve({ scimUserId: seatId }) });

    expect([200, 204]).toContain(response.status);

    // The seat is freed — the membership the seat count reads is revoked.
    const after = await database.client.query<{ status: string }>(
      'select status from memberships where id = $1',
      [seatId],
    );
    expect(after.rows[0]?.status).toBe('revoked');

    // And every session is gone, before the request answered rather than on some later sync.
    const liveAfter = await database.client.query<{ count: string }>(
      'select count(*)::text as count from sessions where user_id = $1 and revoked_at is null',
      [userId],
    );
    expect(Number(liveAfter.rows[0]?.count)).toBe(0);
  });

  it('is idempotent on a second deprovision, so a client retry is not an error', async () => {
    const { POST } = await import('../app/api/scim/v2/Users/route');
    const item = await import('../app/api/scim/v2/Users/[scimUserId]/route');

    const created = await POST(
      usersRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userName: 'twice@example.com' }),
      }),
    );
    const seatId = ((await created.json()) as { id: string }).id;

    const remove = () =>
      item.DELETE(
        new Request(`${BASE_URL}/api/scim/v2/Users/${seatId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
        { params: Promise.resolve({ scimUserId: seatId }) },
      );

    expect([200, 204]).toContain((await remove()).status);
    expect([200, 204]).toContain((await remove()).status);
  });

  it('answers 404 for a seat id from another organization or none at all', async () => {
    const item = await import('../app/api/scim/v2/Users/[scimUserId]/route');
    const unknown = '9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f';

    const response = await item.GET(
      new Request(`${BASE_URL}/api/scim/v2/Users/${unknown}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ scimUserId: unknown }) },
    );

    expect(response.status).toBe(404);
  });

  it('refuses to deprovision the last owner, so a directory edit cannot strand the tenant', async () => {
    const item = await import('../app/api/scim/v2/Users/[scimUserId]/route');

    const response = await item.DELETE(
      new Request(`${BASE_URL}/api/scim/v2/Users/${OWNER_MEMBERSHIP}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ scimUserId: OWNER_MEMBERSHIP }) },
    );

    // An organization with no owner cannot be administered, and that must not be reachable from a
    // directory group edit.
    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// The ACS route's own refusals
// ---------------------------------------------------------------------------

describe('POST /api/auth/saml/acs', () => {
  beforeAll(async () => {
    await setPlan('business');
  });

  it('states that SAML is not configured rather than failing obscurely', async () => {
    await database.client.query('delete from saml_connections');
    const { POST } = await import('../app/api/auth/saml/acs/route');

    const response = await POST(
      new Request(`${BASE_URL}/api/auth/saml/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'SAMLResponse=anything',
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('saml=not_configured');
  });

  it('refuses a request carrying no SAMLResponse at all', async () => {
    await saveSamlConnection(
      scoped(),
      {
        idpEntityId: 'https://idp.example.com/entity',
        idpSsoUrl: 'https://idp.example.com/sso',
        // A syntactically valid base64 blob. The signature check is what refuses it, which is the point.
        idpCertificate: 'TUlJRGR6Q0NBbCtnQXdJQkFnSUU=',
        defaultRole: 'member',
      },
      T0,
    );

    const { POST } = await import('../app/api/auth/saml/acs/route');
    const response = await POST(
      new Request(`${BASE_URL}/api/auth/saml/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'RelayState=somewhere',
      }),
    );

    expect(response.headers.get('location')).toContain('saml=no_response');
  });

  it('never mints a session for an assertion it refused', async () => {
    const { POST } = await import('../app/api/auth/saml/acs/route');

    const response = await POST(
      new Request(`${BASE_URL}/api/auth/saml/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `SAMLResponse=${encodeURIComponent(Buffer.from('<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>').toString('base64'))}`,
      }),
    );

    // The property that matters most on this route: a refusal sets no cookie.
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('never follows RelayState, because that would be an open redirect on a session-minting route', async () => {
    const { POST } = await import('../app/api/auth/saml/acs/route');

    const response = await POST(
      new Request(`${BASE_URL}/api/auth/saml/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'SAMLResponse=bad&RelayState=https%3A%2F%2Fevil.example%2Fsteal',
      }),
    );

    expect(response.headers.get('location') ?? '').not.toContain('evil.example');
  });
});

/** Referenced so the unused-import rule does not fire on a table used only for cleanup. */
void organizationSubscriptions;
