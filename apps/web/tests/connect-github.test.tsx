// @vitest-environment jsdom
import { startSession, storeIntegrationToken } from '@compass/auth';
import { instantFromEpochMillis, instantFromIso, toEpochMillis, type Instant } from '@compass/clock';
import {
  ScopedDb,
  findIntegrationToken,
  listAuditLogEntries,
  memberships,
  orgScope,
  reports,
  users,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { GITHUB_SCOPES } from '@compass/github-connector';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import {
  CONNECT_STATE_SECRET_ENV_VAR,
  GITHUB_APP_SLUG_ENV_VAR,
  GITHUB_SOURCE_KEY,
  issueConnectState,
  verifyConnectState,
} from '../lib/connect-source';

/**
 * The GitHub connect flow, end to end.
 *
 * `packages/github-connector/tests/contract.test.ts` proves the connector itself — the port contract,
 * per-repository scoping and the rate-limit coverage gap. This file proves the half a manager touches:
 * that the scopes on the screen are the scopes in the request, that a forged install return cannot
 * store a credential, and that disconnecting stops the reading without destroying the reading already
 * done.
 *
 * The handlers and the page are imported unchanged and reach a real migrated PostgreSQL 17 through
 * PGlite. Only `lib/database`'s pool is stubbed, the same way every other route test here does it, so
 * `guard`, `authorize` and the session resolution are the production path.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;
const OWNER = '1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c';
const OWNER_MEMBERSHIP = '2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d';
const MANAGER = '3e3e3e3e-3e3e-4e3e-8e3e-3e3e3e3e3e3e';
const MANAGER_MEMBERSHIP = '4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f';
const REPORT_ROW = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';

const T0: Instant = instantFromIso('2026-08-05T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

/**
 * `next/headers`, because the page reads the request's cookie through it.
 *
 * The page must take the cookie from the request — passing `null` would refuse every caller including
 * the owner, which is a bug this suite caught on its first run. There is no request context in a unit
 * test, so the one Next primitive it uses is stubbed and the cookie is whatever `cookieHeaderFor`
 * currently holds. Everything else on the page — `pageAccess`, `authorize`, the session lookup, the
 * token read — is the production path.
 */
const cookieHeaderFor = vi.hoisted(() => ({ current: '' }));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(cookieHeaderFor.current === '' ? {} : { cookie: cookieHeaderFor.current })),
}));

const sessions: Record<'owner' | 'manager', string> = { owner: '', manager: '' };

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-connect',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  for (const [id, email, name] of [
    [OWNER, 'owner@example.com', 'An Owner'],
    [MANAGER, 'priya@example.com', 'Priya Raman'],
  ] as const) {
    await scoped()
      .insertInto(users, {
        id,
        email,
        displayName: name,
        passwordHash: null,
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  for (const [id, userId, role] of [
    [OWNER_MEMBERSHIP, OWNER, 'owner'],
    [MANAGER_MEMBERSHIP, MANAGER, 'manager'],
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
  sessions.manager = (await startSession({ scoped: scoped(), userId: MANAGER, now: T0 })).secret;
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(() => {
  // The owner's session, for the page renders. Route tests pass their own cookie on the Request.
  cookieHeaderFor.current = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessions.owner)}`;
  vi.stubEnv(GITHUB_APP_SLUG_ENV_VAR, 'compass-daily');
  vi.stubEnv(CONNECT_STATE_SECRET_ENV_VAR, 'a-long-random-connect-state-secret');
  // Required before Compass will store any OAuth credential at all. 32 bytes, base64.
  vi.stubEnv('COMPASS_KMS_MASTER_KEY', Buffer.alloc(32, 7).toString('base64'));
});

afterEach(() => {
  document.body.innerHTML = '';
});

const clearToken = async (): Promise<void> => {
  const { deleteIntegrationToken } = await import('@compass/db');
  await deleteIntegrationToken(scoped(), GITHUB_SOURCE_KEY, 'access');
};

const formPost = (path: string, session = sessions.owner): Request =>
  new Request(`https://compass.example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
    },
    body: '',
  });

// ---------------------------------------------------------------------------
// The scopes on the screen are the scopes in the request
// ---------------------------------------------------------------------------

describe('the connect screen shows the requested permissions verbatim', () => {
  const renderConnect = async (): Promise<string> => {
    const { default: ConnectPage } = await import('../app/connect/page');
    const element = await ConnectPage({ searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(element as React.ReactElement);
  };

  it('renders every permission from GITHUB_SCOPES, and no others', async () => {
    document.body.innerHTML = await renderConnect();

    const rendered = [...document.body.querySelectorAll('[data-testid="connect-scope"]')].map((node) =>
      node.getAttribute('data-permission'),
    );

    /**
     * Asserted against the array, not against literals.
     *
     * This is the same discipline `billing.test.tsx` uses against `PLANS`: if the assertion listed the
     * permissions itself, adding `contents:write` to the connector would leave both the page and this
     * test agreeing with each other and disagreeing with the install request. Comparing to the exported
     * array is what makes the screen and the request one fact.
     */
    expect(rendered).toEqual(GITHUB_SCOPES.map((scope) => scope.permission));
  });

  it('shows each permission with the access level and the reason it is asked for', async () => {
    document.body.innerHTML = await renderConnect();
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');

    for (const scope of GITHUB_SCOPES) {
      expect(text, `${scope.permission} is not shown with its access level`).toContain(
        `${scope.permission}:${scope.access}`,
      );
      // A consent screen listing permissions with no justification is one nobody can refuse
      // intelligently, so the reason has to be on the page too.
      expect(text, `${scope.permission} is shown without its reason`).toContain(scope.because.slice(0, 40));
    }
  });

  it('offers a connect button and no disconnect button while unconnected', async () => {
    await clearToken();
    document.body.innerHTML = await renderConnect();

    expect(document.body.querySelector('[data-testid="install-submit"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="disconnect-submit"]')).toBeNull();
    expect(
      document.body.querySelector('[data-testid="connect-provider"]')?.getAttribute('data-connected'),
    ).toBe('false');
  });

  it('states which variable is missing rather than offering a button that cannot work', async () => {
    vi.stubEnv(GITHUB_APP_SLUG_ENV_VAR, '');
    document.body.innerHTML = await renderConnect();

    const stated = document.body.querySelector('[data-testid="connect-unavailable"]');
    expect(stated?.textContent).toContain(GITHUB_APP_SLUG_ENV_VAR);
    // Honest degradation: it also says what is *not* broken.
    expect(stated?.textContent).toContain('is unaffected');
    expect(document.body.querySelector('[data-testid="install-submit"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe('starting an install', () => {
  it('redirects to GitHub with the permissions built from the same list', async () => {
    const { POST } = await import('../app/api/connect/github/install/route');
    const response = await POST(formPost('/api/connect/github/install'));

    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('github.com/apps/compass-daily/installations/new');

    for (const scope of GITHUB_SCOPES) {
      expect(location, `${scope.permission} is missing from the install request`).toContain(
        `${scope.permission}%3A${scope.access}`,
      );
    }
    // And a state to verify the return with.
    expect(location).toContain('state=');
  });

  it('refuses a manager: connecting decides what Compass reads for the whole organization', async () => {
    const { POST } = await import('../app/api/connect/github/install/route');
    const response = await POST(formPost('/api/connect/github/install', sessions.manager));

    expect(response.status).toBe(403);
  });

  it('answers 503 naming the variables when the deployment cannot verify a return', async () => {
    vi.stubEnv(CONNECT_STATE_SECRET_ENV_VAR, '');
    const { POST } = await import('../app/api/connect/github/install/route');
    const response = await POST(formPost('/api/connect/github/install'));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { detail: string }).detail).toContain(CONNECT_STATE_SECRET_ENV_VAR);
  });
});

// ---------------------------------------------------------------------------
// The signed state
// ---------------------------------------------------------------------------

describe('the install return is authorised by a signed state, never by a query parameter', () => {
  const callbackRequest = (query: string): Request =>
    new Request(`https://compass.example.com/api/connect/github/callback?${query}`);

  it('accepts a state this deployment minted', () => {
    const state = issueConnectState({ organizationId: ORGANIZATION_ID, now: T0 });
    expect(state).not.toBeNull();

    const verdict = verifyConnectState({ state, now: T0 });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.organizationId).toBe(ORGANIZATION_ID);
  });

  it('refuses a state signed with another secret', () => {
    const forged = issueConnectState({
      organizationId: ORGANIZATION_ID,
      now: T0,
      environment: { [CONNECT_STATE_SECRET_ENV_VAR]: 'somebody-elses-secret' },
    });

    const verdict = verifyConnectState({ state: forged, now: T0 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  it('refuses a hand-written state naming another organization', () => {
    // The attack the signature exists to stop: storing your own token against somebody else's tenant.
    const verdict = verifyConnectState({ state: `${ORGANIZATION_ID}.${toEpochMillis(T0)}.deadbeef`, now: T0 });
    expect(verdict.ok).toBe(false);
  });

  it('refuses a state older than its window, however well signed', () => {
    const state = issueConnectState({ organizationId: ORGANIZATION_ID, now: T0 });
    const muchLater = instantFromIso('2026-08-05T09:30:00Z');

    const verdict = verifyConnectState({ state, now: muchLater });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('expired');
  });

  it('fails closed with no state secret configured', () => {
    // A callback accepted without a verifiable state is one anybody can forge.
    const verdict = verifyConnectState({ state: 'anything', now: T0, environment: {} });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('unconfigured');
  });

  it('stores nothing and says so when the state is rejected', async () => {
    await clearToken();
    const { GET } = await import('../app/api/connect/github/callback/route');
    const response = await GET(callbackRequest('state=forged&installation_id=42'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('github=state-rejected');
    // The whole point: no credential reached the database.
    expect(await findIntegrationToken(scoped(), GITHUB_SOURCE_KEY, 'access')).toBeNull();
  });

  it('stores the credential and records the act on a valid return', async () => {
    await clearToken();

    /**
     * Minted at the *route's* clock, not at `T0`.
     *
     * The state carries an issue instant and is refused outside a ten-minute window, and the route
     * verifies against the request edge's real clock — so a state stamped `2026-08-05T09:00Z` is
     * correctly rejected as expired whenever the suite actually runs. That is the TTL working, not a
     * bug, and the fix is to issue the state the way production does: at the instant of the request.
     * The expiry itself is asserted directly in `refuses a state older than its window` above.
     */
    const realNow = instantFromEpochMillis(Date.now());
    const state = issueConnectState({ organizationId: ORGANIZATION_ID, now: realNow }) ?? '';

    const { GET } = await import('../app/api/connect/github/callback/route');
    const response = await GET(
      callbackRequest(`state=${encodeURIComponent(state)}&installation_id=87654321`),
    );

    expect(response.headers.get('location')).toContain('github=connected');

    const stored = await findIntegrationToken(scoped(), GITHUB_SOURCE_KEY, 'access');
    expect(stored, 'the credential was not stored').not.toBeNull();
    // Sealed, never in the clear: the scheme prefix is a CHECK constraint in the schema.
    expect(stored?.sealedValue).not.toContain('87654321');

    const audit = await listAuditLogEntries(scoped());
    expect(audit.some((entry) => entry.action === 'connector.connected')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disconnect — the three effects
// ---------------------------------------------------------------------------

describe('disconnecting stops the reading without destroying what was read', () => {
  beforeEach(async () => {
    await clearToken();
    await storeIntegrationToken(
      scoped(),
      { sourceKey: GITHUB_SOURCE_KEY, tokenKind: 'access', token: 'an-installation-id' },
      T0,
    );
  });

  it('deletes the credential', async () => {
    const { POST } = await import('../app/api/connect/github/disconnect/route');
    const response = await POST(formPost('/api/connect/github/disconnect'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('github=disconnected');
    expect(await findIntegrationToken(scoped(), GITHUB_SOURCE_KEY, 'access')).toBeNull();
  });

  it('keeps every row Compass already wrote', async () => {
    /**
     * The effect worth asserting, because losing it is silent and unrecoverable.
     *
     * Disconnecting is "stop reading", not "forget what you read". A manager who disconnects to rotate
     * an App installation must not lose three months of Yesterday, and the archive has to keep
     * rendering as the document they actually read. Erasure is a separate, deliberate act.
     */
    await scoped()
      .insertInto(reports, {
        id: REPORT_ROW,
        scopeKind: 'team',
        scopeKey: 'platform',
        reportDate: '2026-08-04',
        reportInstant: asDate('2026-08-04T06:00:00Z'),
        timezone: 'Europe/London',
        // NOT NULL with no default: the window a report is *about* is not derivable from its instant.
        windowStart: asDate('2026-08-03T23:00:00Z'),
        windowEnd: asDate('2026-08-04T23:00:00Z'),
        schemaVersion: 1,
        // Also NOT NULL, and a *text* column: the canonical JSON the content hash is taken over, so it
        // is stored as the exact string rather than as jsonb whose key order a driver could reorder.
        payloadJson: '{}',
        // The queryable copy of the same payload. Both are NOT NULL: the text one is what the content
        // hash is taken over, the jsonb one is what a query reads.
        payload: {},
        coverageStatus: 'complete',
        prose: 'The report that must survive a disconnect.',
        rendererId: 'template',
        fallbackRenderer: false,
        fallbackReason: null,
        contentHash: 'a'.repeat(64),
        ingestRunId: null,
        // No `createdAt`/`updatedAt`: a report row is stamped with the instant it is *about*
        // (`generatedAt`, `reportInstant`), not with row-lifecycle timestamps.
        generatedAt: asDate('2026-08-04T06:00:00Z'),
      })
      .onConflictDoNothing()
      .execute();

    const before = await scoped().selectFrom(reports);

    const { POST } = await import('../app/api/connect/github/disconnect/route');
    await POST(formPost('/api/connect/github/disconnect'));

    const after = await scoped().selectFrom(reports);
    expect(after.length).toBe(before.length);
    expect(after.some((row) => row.id === REPORT_ROW)).toBe(true);
  });

  it('writes an audit entry naming the act', async () => {
    const { POST } = await import('../app/api/connect/github/disconnect/route');
    await POST(formPost('/api/connect/github/disconnect'));

    const audit = await listAuditLogEntries(scoped());
    const entry = audit.find((row) => row.action === 'connector.disconnected');
    expect(entry, 'disconnecting wrote no audit entry').toBeDefined();
    expect(entry?.targetKind).toBe('connector');
    expect(entry?.targetId).toBe(GITHUB_SOURCE_KEY);
    // Who did it, and that the rows survived — the two facts somebody reading the log needs.
    expect(entry?.actorUserId).toBe(OWNER);
    expect(entry?.after).toMatchObject({ connected: false, rowsRetained: true });
  });

  it('flips the state the connect screen reads', async () => {
    const { default: ConnectPage } = await import('../app/connect/page');

    const connected = renderToStaticMarkup(
      (await ConnectPage({ searchParams: Promise.resolve({}) })) as React.ReactElement,
    );
    document.body.innerHTML = connected;
    expect(
      document.body.querySelector('[data-testid="connect-provider"]')?.getAttribute('data-connected'),
    ).toBe('true');
    expect(document.body.querySelector('[data-testid="disconnect-submit"]')).not.toBeNull();

    const { POST } = await import('../app/api/connect/github/disconnect/route');
    await POST(formPost('/api/connect/github/disconnect'));

    document.body.innerHTML = renderToStaticMarkup(
      (await ConnectPage({ searchParams: Promise.resolve({}) })) as React.ReactElement,
    );
    expect(
      document.body.querySelector('[data-testid="connect-provider"]')?.getAttribute('data-connected'),
    ).toBe('false');
    expect(document.body.querySelector('[data-testid="install-submit"]')).not.toBeNull();
  });

  it('refuses a manager', async () => {
    const { POST } = await import('../app/api/connect/github/disconnect/route');
    const response = await POST(formPost('/api/connect/github/disconnect', sessions.manager));

    expect(response.status).toBe(403);
    // And the credential is untouched.
    expect(await findIntegrationToken(scoped(), GITHUB_SOURCE_KEY, 'access')).not.toBeNull();
  });
});
