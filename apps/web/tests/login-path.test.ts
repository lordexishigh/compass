import {
  DEMO_ACCOUNT_LOGIN_PATH,
  DEMO_OWNER_EMAIL,
  DEMO_OWNER_PASSWORD,
  bootstrapOwner,
  resolveIdentity,
  resolveOwnerCredentials,
} from '@compass/auth';
import { instantFromIso } from '@compass/clock';
import { ScopedDb, orgScope, type CompassDatabase } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import { WRONG_PASSPHRASE } from './helpers/fixture-credentials';

/**
 * `POST /login` with the credentials the seed publishes.
 *
 * ## The criterion, executed
 *
 * *`.nous/demo_account.json` exists after seeding, and WHEN those credentials are POSTed to the
 * login path THE SYSTEM SHALL authenticate successfully and land on the seeded org's report.*
 *
 * `apps/worker/tests/demo-account.test.ts` proves the file holds `{email, password, login_path}`
 * and that its values come from the same resolver the bootstrap provisions the seat with. This
 * proves the other half, which is the half nothing else covers: that the address in that file is
 * a route that exists, that the credentials in it open the owner seat, and that what comes back is
 * a real session cookie plus the report to go to. Between them the loop is closed — a harness that
 * reads the file and follows it gets in.
 *
 * The seat is created by `bootstrapOwner`, not by a fixture, so the password being verified is the
 * one the seed actually hashes. A test that registered its own account would prove the route works
 * and say nothing about whether the published credentials do.
 *
 * Only `lib/database`'s pool is stubbed. `guard`, `resolveIdentity`, `verifyLogin`, Argon2id,
 * `startSession` and `setSessionCookie` are all the production path.
 */

let database: TestDatabase;

const T0 = instantFromIso('2026-07-31T09:00:00Z');

const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: SEEDED_ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-systems',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  // The seed's own owner, provisioned exactly as `bootstrap()` does it.
  await bootstrapOwner({
    scoped: new ScopedDb(database.db, orgScope(SEEDED_ORGANIZATION_ID)),
    now: T0,
    teamKeys: ['platform'],
    env: {},
  });
}, 180_000);

afterAll(async () => {
  await database?.close();
});

const scoped = () => new ScopedDb(database.db, orgScope(SEEDED_ORGANIZATION_ID));

const loginRequest = (body: unknown) =>
  new Request(`https://compass.example.com${DEMO_ACCOUNT_LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sessionCookie = (response: Response): string | null =>
  response.headers.getSetCookie().find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? null;

const secretFrom = (header: string): string =>
  decodeURIComponent(header.slice(`${SESSION_COOKIE_NAME}=`.length, header.indexOf(';')));

describe('the published demo credentials sign in at the published path', () => {
  it('is served at exactly the path the credentials file names', async () => {
    // The file says `/login`; this asserts the route module is at `app/login` and that the
    // constant both sides read is that same string. A drift here is a harness POSTing at a 404.
    expect(DEMO_ACCOUNT_LOGIN_PATH).toBe('/login');
    const route = await import('../app/login/route');
    expect(typeof route.POST).toBe('function');
  });

  it('authenticates and sets a session cookie', async () => {
    const { POST } = await import('../app/login/route');
    const credentials = resolveOwnerCredentials({});

    const response = await POST(loginRequest({ email: credentials.email, password: credentials.password }));

    expect(response.status).toBe(200);

    const cookie = sessionCookie(response);
    expect(cookie, 'no session cookie was set').not.toBeNull();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('answers with the owner seat and where to go next', async () => {
    const { POST } = await import('../app/login/route');

    const response = await POST(loginRequest({ email: DEMO_OWNER_EMAIL, password: DEMO_OWNER_PASSWORD }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ signedIn: true, email: DEMO_OWNER_EMAIL, role: 'owner' });
    // "and land on the seeded org's report" — stated rather than left for the caller to guess.
    expect(body['redirect']).toBe('/');
    // And no credential comes back in the body.
    expect(JSON.stringify(body)).not.toContain(DEMO_OWNER_PASSWORD);
  });

  it('mints a cookie the session layer resolves back to that owner', async () => {
    // The only proof the session is real rather than a 200 with a cookie-shaped string in it.
    const { POST } = await import('../app/login/route');

    const response = await POST(loginRequest({ email: DEMO_OWNER_EMAIL, password: DEMO_OWNER_PASSWORD }));
    const resolved = await resolveIdentity({ scoped: scoped(), secret: secretFrom(sessionCookie(response) ?? ''), now: T0 });

    expect(resolved.kind).toBe('identified');
    expect(resolved.kind === 'identified' ? resolved.identity.principal : null).toBe('owner');
    expect(resolved.kind === 'identified' ? resolved.identity.user.email : null).toBe(DEMO_OWNER_EMAIL);
  });

  it('refuses a wrong password at this address exactly as at the other one', async () => {
    const { POST } = await import('../app/login/route');

    const response = await POST(loginRequest({ email: DEMO_OWNER_EMAIL, password: WRONG_PASSPHRASE }));

    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toBeNull();
  });

  it('is the same implementation as /api/auth/login, not a second one', async () => {
    /**
     * Both routes are asserted to produce the same answer for the same input, which is the
     * property that matters: two sign-in paths that drift is how one address ends up slightly
     * wrong about who you are, and that failure does not look like a bug from outside.
     */
    const short = await import('../app/login/route');
    const api = await import('../app/api/auth/login/route');

    const viaShort = await short.POST(loginRequest({ email: DEMO_OWNER_EMAIL, password: DEMO_OWNER_PASSWORD }));
    const viaApi = await api.POST(loginRequest({ email: DEMO_OWNER_EMAIL, password: DEMO_OWNER_PASSWORD }));

    expect(viaShort.status).toBe(viaApi.status);

    // Same body but for the session deadline, which differs by the milliseconds between the calls.
    const stripDeadline = async (response: Response): Promise<Record<string, unknown>> => {
      const { sessionExpiresAt: _ignored, ...rest } = (await response.json()) as Record<string, unknown>;
      return rest;
    };
    expect(await stripDeadline(viaShort)).toEqual(await stripDeadline(viaApi));
  });

  it('sends a browser that merely visits the address to the screen with the form on it', async () => {
    // `/login` is an endpoint, not a page. A GET is a 303 to `/account`, which is where the
    // credentials are printed — rather than a 405 in front of somebody who typed a reasonable URL.
    const { GET } = await import('../app/login/route');

    const response = await GET(new Request(`https://compass.example.com${DEMO_ACCOUNT_LOGIN_PATH}`));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://compass.example.com/account');
  });
});
