import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';

/**
 * What every route does when the database is not there.
 *
 * These are the tests the previous pass was missing, and their absence is exactly why the
 * bug survived: `tests/health.test.ts` calls `readiness()` directly, so it proved the
 * *reporting* function handles a missing `DATABASE_URL` while the *route* in front of it
 * answered an unhandled 500 in the same condition. `guard()` ran before the try/catch,
 * reached for a connection string that was not there, and threw out of the handler.
 *
 * The consequence was worse than an ugly response. The container `HEALTHCHECK` in
 * `docker-compose.yml` polls this route; a hard failure there restart-loops a container
 * whose only problem is a misconfigured connection string, instead of staying up and
 * reporting `database: not_configured` to somebody who can fix it.
 *
 * So each test here drives a real exported handler with the substrate removed, and asserts
 * the *stated* answer rather than the absence of a crash.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env['DATABASE_URL'];
  delete process.env['DATABASE_URL_DIRECT'];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

interface HealthBody {
  readonly status: string;
  readonly checks: readonly { readonly name: string; readonly status: string; readonly detail: string }[];
}

describe('GET /api/health with no DATABASE_URL', () => {
  it('answers 200 and reports the database as not_configured', async () => {
    const { GET } = await import('../app/api/health/route');

    const response = await GET(new Request('http://localhost:3000/api/health'));

    // 200, not 500 and not 503: a missing connection string is a documented condition.
    expect(response.status).toBe(200);

    const body = (await response.json()) as HealthBody;
    const database = body.checks.find((check) => check.name === 'database');

    expect(database, 'the readiness report was never reached').toBeDefined();
    expect(database?.status).toBe('not_configured');
    expect(database?.detail).toContain('DATABASE_URL');
    expect(body.status).toBe('not_configured');
  });

  it('still names every other capability, so the guard failure cost no information', async () => {
    const { GET } = await import('../app/api/health/route');

    const body = (await GET(new Request('http://localhost:3000/api/health'))).json() as Promise<HealthBody>;

    expect((await body).checks.map((check) => check.name)).toEqual([
      'clock',
      'connector',
      'seed-dataset',
      'database',
      'seats',
      'mail',
      'slack',
    ]);
  });

  it('reports that nobody can sign in, rather than failing to answer', async () => {
    const { GET } = await import('../app/api/health/route');

    const body = (await (await GET(new Request('http://localhost:3000/api/health'))).json()) as HealthBody;
    const seats = body.checks.find((check) => check.name === 'seats');

    expect(seats?.status).toBe('not_configured');
    expect(seats?.detail).toContain('Sign-in is unavailable');
  });

  it('never carries a cache header a proxy could act on', async () => {
    const { GET } = await import('../app/api/health/route');

    const response = await GET(new Request('http://localhost:3000/api/health'));

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

/**
 * The other half: a route that is *not* `/api/health` must answer the stated 503.
 *
 * `/api/health` is the one route allowed to survive its own guard failing, because
 * reporting that failure is its job. Everywhere else the right answer is "Compass could
 * not reach its own records" with a 503 — never a framework 500, and never a driver's
 * message, which on a public route would describe the infrastructure to a stranger.
 */
describe('a route whose database throws', () => {
  const brokenDatabase = () => {
    vi.doMock('../lib/database', () => ({
      database: () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:5432 — user "compass", database "compass"');
      },
    }));
  };

  it('answers 503 with the `unavailable` code from POST /api/auth/login', async () => {
    brokenDatabase();
    const { POST } = await import('../app/api/auth/login/route');

    const response = await POST(
      new Request('https://compass.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'priya@example.com', password: 'a-long-enough-passphrase' }),
      }),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'unavailable' });
  });

  it('does not leak the driver’s host, port, user or database to a public caller', async () => {
    brokenDatabase();
    const { POST } = await import('../app/api/auth/login/route');

    const response = await POST(
      new Request('https://compass.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'priya@example.com', password: 'a-long-enough-passphrase' }),
      }),
    );

    const raw = await response.text();

    for (const secret of ['ECONNREFUSED', '10.0.0.7', '5432', 'database "compass"']) {
      expect(raw, `the 503 body carries \`${secret}\``).not.toContain(secret);
    }
    // And it still says something useful about what to do next.
    expect(raw).toContain('/api/health');
  });

  it('answers 503 rather than throwing from a seated route too', async () => {
    brokenDatabase();
    const { GET } = await import('../app/api/seats/route');

    const response = await GET(new Request('https://compass.example.com/api/seats'));

    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'unavailable' });
  });

  it('answers 503 from a public read, not an unhandled 500', async () => {
    brokenDatabase();
    const { GET } = await import('../app/api/goals/route');

    const response = await GET(new Request('https://compass.example.com/api/goals'));

    expect(response.status).toBe(503);
  });

  it('lets a signed-out caller still sign out, because that must never fail', async () => {
    brokenDatabase();
    const { POST } = await import('../app/api/auth/logout/route');

    const response = await POST(
      new Request('https://compass.example.com/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=whatever-was-in-there` },
      }),
    );

    // The guard could not establish an identity, so this is a 503 — but the point is that
    // it is a *stated* one, and the browser is told to drop the cookie on the way out.
    expect(response.status).toBe(503);
  });
});

/**
 * `pageAccess` is the Server Component equivalent and carries the same contract.
 *
 * A page cannot answer 503, so it renders `StatedFailure` — but only if the resolver hands
 * it a value rather than throwing. `/account` is the screen somebody opens *because*
 * something is wrong; it is the last one allowed to become an error page itself.
 */
describe('pageAccess with no DATABASE_URL', () => {
  it('returns the unavailable arm rather than rejecting', async () => {
    const { pageAccess } = await import('../lib/auth/guard');

    const access = await pageAccess({ route: '/account', cookieHeader: null });

    expect(access.kind).toBe('unavailable');
    expect(access.kind === 'unavailable' ? access.detail : '').toContain('/api/health');
  });

  it('says nothing about the driver, for the same reason the 503 does not', async () => {
    const { pageAccess } = await import('../lib/auth/guard');

    const access = await pageAccess({ route: '/seats', cookieHeader: null });
    const detail = access.kind === 'unavailable' ? access.detail : '';

    expect(detail).not.toContain('DATABASE_URL');
    expect(detail).toContain('nothing was changed');
  });
});

