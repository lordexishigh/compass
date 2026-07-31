import { registerAccount, resolveIdentity, startSession } from '@compass/auth';
import { instantFromIso } from '@compass/clock';
import { ScopedDb, orgScope, type CompassDatabase } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';

/**
 * The login endpoint, executed.
 *
 * `auth-http.test.ts` proves the cookie helper produces the right header and that every
 * route calls the guard. This proves the claim the acceptance criterion actually makes:
 * *POST valid credentials to `/api/auth/login` and you get 200 and an httpOnly, Secure,
 * SameSite=Lax session cookie.* Nothing but running the handler can show that — the
 * helper could be perfect and the route could forget to call it.
 *
 * The handler is imported unchanged and reaches a real migrated PostgreSQL 17 through
 * PGlite. The only thing stubbed is `lib/report-source`'s connection pool, because that is
 * the seam between "this process" and "a database somewhere"; every layer above it —
 * `guard`, `resolveIdentity`, `verifyLogin`, Argon2id, `startSession`, `setSessionCookie` —
 * is the production code path.
 */

let database: TestDatabase;

/**
 * The organization the request edge resolves to.
 *
 * `guard` asks `resolveSeededRun`, which answers with the seeded tenant, so the test
 * database has to hold that same id or every query would be scoped to a row that is not
 * there. Taken from the package rather than hard-coded, so the two cannot drift.
 */
const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;

const T0 = instantFromIso('2026-07-31T09:00:00Z');

const PASSWORD = 'a-long-enough-passphrase';
const EMAIL = 'priya@example.com';

// Hoisted, because `vi.mock` is hoisted above the imports and the factory closes over it.
const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/report-source', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-systems',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  await registerAccount({
    scoped: new ScopedDb(database.db, orgScope(ORGANIZATION_ID)),
    email: EMAIL,
    displayName: 'Priya Raman',
    password: PASSWORD,
    role: 'manager',
    status: 'active',
    now: T0,
  });
}, 120_000);

afterAll(async () => {
  await database?.close();
});

const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

const loginRequest = (body: unknown, origin = 'https://compass.example.com') =>
  new Request(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The `Set-Cookie` line for the session, or null. */
function sessionCookie(response: Response): string | null {
  return response.headers.getSetCookie().find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? null;
}

const secretFrom = (header: string): string =>
  decodeURIComponent(header.slice(`${SESSION_COOKIE_NAME}=`.length, header.indexOf(';')));

describe('POST /api/auth/login', () => {
  it('answers 200 and sets an httpOnly, Secure, SameSite=Lax session cookie', async () => {
    const { POST } = await import('../app/api/auth/login/route');

    const response = await POST(loginRequest({ email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(200);

    const cookie = sessionCookie(response);
    expect(cookie, 'no session cookie was set').not.toBeNull();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain('Path=/');

    // The body names the seat, and carries no credential.
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ signedIn: true, email: EMAIL, role: 'manager' });
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(JSON.stringify(body)).not.toContain(secretFrom(cookie ?? ''));

    // Never cached: a shared proxy would otherwise be able to serve this to the next request.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sets a cookie the session layer then resolves to that seat', async () => {
    const { POST } = await import('../app/api/auth/login/route');

    const response = await POST(loginRequest({ email: EMAIL, password: PASSWORD }));
    const secret = secretFrom(sessionCookie(response) ?? '');

    const resolved = await resolveIdentity({ scoped: scoped(), secret, now: T0 });

    expect(resolved.kind).toBe('identified');
    expect(resolved.kind === 'identified' ? resolved.identity.user.email : null).toBe(EMAIL);
    expect(resolved.kind === 'identified' ? resolved.identity.principal : null).toBe('manager');
  });

  it('stores only the digest of what it put in the cookie', async () => {
    const { POST } = await import('../app/api/auth/login/route');

    const response = await POST(loginRequest({ email: EMAIL, password: PASSWORD }));
    const secret = secretFrom(sessionCookie(response) ?? '');

    const rows = await database.client.query<{ token_hash: string }>('select token_hash from sessions');

    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.token_hash).not.toBe(secret);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('issues a distinct session per sign-in, so two browsers are two sessions', async () => {
    const { POST } = await import('../app/api/auth/login/route');

    const first = secretFrom(sessionCookie(await POST(loginRequest({ email: EMAIL, password: PASSWORD }))) ?? '');
    const second = secretFrom(sessionCookie(await POST(loginRequest({ email: EMAIL, password: PASSWORD }))) ?? '');

    expect(first).not.toBe(second);
    for (const secret of [first, second]) {
      expect((await resolveIdentity({ scoped: scoped(), secret, now: T0 })).kind).toBe('identified');
    }
  });

  it('answers 401 with no cookie for a wrong password', async () => {
    const { POST } = await import('../app/api/auth/login/route');

    const response = await POST(loginRequest({ email: EMAIL, password: 'not-the-right-passphrase' }));

    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toBeNull();
  });

  it('gives an unknown address the same status and the same sentence as a wrong password', async () => {
    // Distinguishing them would publish which addresses have accounts here.
    const { POST } = await import('../app/api/auth/login/route');

    const unknown = await POST(loginRequest({ email: 'nobody@example.com', password: PASSWORD }));
    const wrong = await POST(loginRequest({ email: EMAIL, password: 'not-the-right-passphrase' }));

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it('names the missing field rather than answering an unexplained 400', async () => {
    const { POST } = await import('../app/api/auth/login/route');

    const noPassword = await POST(loginRequest({ email: EMAIL }));
    expect(noPassword.status).toBe(400);
    expect(((await noPassword.json()) as { detail: string }).detail).toContain('password');

    const notJson = await POST(
      new Request('https://compass.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    );
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { detail: string }).detail).toContain('must be JSON');
  });

  it('does not trim a password, because a space is a character somebody chose', async () => {
    const { POST } = await import('../app/api/auth/login/route');

    const padded = await POST(loginRequest({ email: EMAIL, password: ` ${PASSWORD} ` }));

    expect(padded.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie and ends only this session', async () => {
    const { POST: login } = await import('../app/api/auth/login/route');
    const { POST: logout } = await import('../app/api/auth/logout/route');

    const laptop = secretFrom(sessionCookie(await login(loginRequest({ email: EMAIL, password: PASSWORD }))) ?? '');
    const phone = secretFrom(sessionCookie(await login(loginRequest({ email: EMAIL, password: PASSWORD }))) ?? '');

    const response = await logout(
      new Request('https://compass.example.com/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${laptop}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(sessionCookie(response)).toContain('Max-Age=0');

    expect((await resolveIdentity({ scoped: scoped(), secret: laptop, now: T0 })).kind).toBe('anonymous');
    expect((await resolveIdentity({ scoped: scoped(), secret: phone, now: T0 })).kind).toBe('identified');
  });

  it('answers 200 with a cleared cookie even when there was no session', async () => {
    // Signing out must never fail: a 401 here would leave a dead cookie in the browser
    // and no way to be rid of it.
    const { POST: logout } = await import('../app/api/auth/logout/route');

    const response = await logout(
      new Request('https://compass.example.com/api/auth/logout', { method: 'POST' }),
    );

    expect(response.status).toBe(200);
    expect(sessionCookie(response)).toContain('Max-Age=0');
  });
});

describe('GET /api/auth/session', () => {
  it('answers 200 and `signedIn: false` with no cookie, rather than 401', async () => {
    // This is the route a client calls to *find out* whether it is signed in. Answering
    // 401 would make "not signed in" indistinguishable from "this endpoint is broken".
    const { GET } = await import('../app/api/auth/session/route');

    const response = await GET(new Request('https://compass.example.com/api/auth/session'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signedIn: false, principal: 'public' });
  });

  it('reports the role from the membership, so a role change lands on the next request', async () => {
    const { GET } = await import('../app/api/auth/session/route');
    const { setMembershipRole, findMembershipByUserId, findUserByEmail } = await import('@compass/db');

    const started = await startSession({
      scoped: scoped(),
      userId: (await findUserByEmail(scoped(), EMAIL))?.id ?? '',
      now: T0,
    });
    const ask = () =>
      GET(
        new Request('https://compass.example.com/api/auth/session', {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${started.secret}` },
        }),
      );

    expect(await (await ask()).json()).toMatchObject({ role: 'manager' });

    // Changed underneath the live cookie. The role is read from the membership on every
    // request, never from the session, so the very next call reports the new one.
    const user = await findUserByEmail(scoped(), EMAIL);
    const membership = await findMembershipByUserId(scoped(), user?.id ?? '');
    await setMembershipRole(scoped(), membership?.id ?? '', 'viewer', T0);

    expect(await (await ask()).json()).toMatchObject({ role: 'viewer' });

    // Put back, so the ordering of the suites above does not matter.
    await setMembershipRole(scoped(), membership?.id ?? '', 'manager', T0);
  });
});
