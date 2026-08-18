// @vitest-environment jsdom
import { startSession, storeIntegrationToken } from '@compass/auth';
import { instantFromEpochMillis, instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  findIntegrationToken,
  findSourceConfig,
  listAuditLogEntries,
  memberships,
  orgScope,
  users,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { GITHUB_SCOPES } from '@compass/github-connector';
import { FORBIDDEN_JIRA_SCOPES, JIRA_OFFLINE_SCOPE, JIRA_SCOPES } from '@compass/jira-connector';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { FORBIDDEN_SLACK_SCOPES, SLACK_SCOPES } from '@compass/slack-connector';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import { edgeNow } from './helpers/edge-now';
import {
  CONNECT_STATE_SECRET_ENV_VAR,
  GITHUB_APP_SLUG_ENV_VAR,
  GITHUB_SOURCE_KEY,
  JIRA_CLIENT_ID_ENV_VAR,
  JIRA_CLIENT_SECRET_ENV_VAR,
  JIRA_SOURCE_KEY,
  SLACK_CLIENT_ID_ENV_VAR,
  SLACK_CLIENT_SECRET_ENV_VAR,
  SLACK_SOURCE_KEY,
  issueConnectState,
  listDisconnectedSources,
  verifyConnectState,
} from '../lib/connect-source';

/**
 * The self-serve connect flow, across all three providers.
 *
 * `connect-github.test.tsx` proves the code host's round trip in detail. This file proves the things that
 * only exist because there are *three* of them, and the things subtask 004's criteria name directly:
 *
 *  - every provider's scope list reaches the screen from its own connector package, verbatim;
 *  - per-repository, per-project and per-channel scoping is settable by a manager with no admin step, no
 *    upload and no config file, and a bad line is refused whole rather than saved in part;
 *  - a state minted for one provider cannot be replayed against another's callback;
 *  - disconnecting keeps the prior data *and the selections*, states the source as disconnected, and
 *    writes an audit record.
 *
 * The handlers and the page are imported unchanged and reach a real migrated PostgreSQL 17 through PGlite.
 * Only `lib/database`'s pool is stubbed, the same way every other route test here does, so `guard`,
 * `authorize` and the session resolution are the production path.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;
const OWNER = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const OWNER_MEMBERSHIP = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b';
const MANAGER = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c';
const MANAGER_MEMBERSHIP = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';

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

const cookieHeaderFor = vi.hoisted(() => ({ current: '' }));

vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve(new Headers(cookieHeaderFor.current === '' ? {} : { cookie: cookieHeaderFor.current })),
}));

const sessions: Record<'owner' | 'manager', string> = { owner: '', manager: '' };

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-three-providers',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  for (const [id, email, name] of [
    [OWNER, 'owner3@example.com', 'An Owner'],
    [MANAGER, 'priya3@example.com', 'Priya Raman'],
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

  sessions.owner = (await startSession({ scoped: scoped(), userId: OWNER, now: edgeNow() })).secret;
  sessions.manager = (await startSession({ scoped: scoped(), userId: MANAGER, now: edgeNow() })).secret;
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(() => {
  cookieHeaderFor.current = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessions.owner)}`;
  vi.stubEnv(GITHUB_APP_SLUG_ENV_VAR, 'compass-daily');
  vi.stubEnv(JIRA_CLIENT_ID_ENV_VAR, 'jira-client-id');
  vi.stubEnv(JIRA_CLIENT_SECRET_ENV_VAR, 'jira-client-secret');
  vi.stubEnv(SLACK_CLIENT_ID_ENV_VAR, 'slack-client-id');
  vi.stubEnv(SLACK_CLIENT_SECRET_ENV_VAR, 'slack-client-secret');
  vi.stubEnv(CONNECT_STATE_SECRET_ENV_VAR, 'a-long-random-connect-state-secret');
  vi.stubEnv('COMPASS_KMS_MASTER_KEY', Buffer.alloc(32, 9).toString('base64'));
});

afterEach(() => {
  document.body.innerHTML = '';
});

const routeParams = (provider: string) => ({ params: Promise.resolve({ provider }) });

const formPost = (path: string, body = '', session = sessions.owner): Request =>
  new Request(`https://compass.example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
    },
    body,
  });

const jsonPost = (path: string, body: unknown, session = sessions.owner): Request =>
  new Request(`https://compass.example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
    },
    body: JSON.stringify(body),
  });

const setScope = async (provider: string, selections: string) => {
  const { POST } = await import('../app/api/connect/[provider]/scope/route');
  return await POST(jsonPost(`/api/connect/${provider}/scope`, { selections }), routeParams(provider));
};

const renderConnect = async (searchParams: Record<string, string> = {}): Promise<string> => {
  const { default: ConnectPage } = await import('../app/connect/page');
  const element = await ConnectPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element as React.ReactElement);
};

const sectionFor = (provider: string): Element | null =>
  document.body.querySelector(`[data-provider="${provider}"]`);

// ---------------------------------------------------------------------------
// Every provider's scopes reach the screen from its own package
// ---------------------------------------------------------------------------

describe('all three providers state their permissions verbatim before consent', () => {
  /**
   * Asserted against the connector packages' own arrays, never against literals.
   *
   * Same discipline as `/pricing` importing `PLANS`: if this test listed the scopes itself, adding a write
   * scope to a connector would leave the page and this test agreeing with each other and disagreeing with
   * the request that actually goes out.
   */
  const expected: readonly (readonly [string, readonly string[]])[] = [
    ['github', GITHUB_SCOPES.map((scope) => `${scope.permission}:${scope.access}`)],
    ['jira', JIRA_SCOPES.map((scope) => scope.scope)],
    ['slack', SLACK_SCOPES.map((scope) => scope.scope)],
  ];

  it.each(expected)('renders exactly the scopes %s requests', async (provider, labels) => {
    document.body.innerHTML = await renderConnect();

    const rendered = [...(sectionFor(provider)?.querySelectorAll('[data-testid="connect-scope"]') ?? [])].map(
      (node) => node.getAttribute('data-permission'),
    );

    expect(rendered).toEqual(labels);
  });

  it.each(expected)('gives every %s scope a reason on the page', async (provider) => {
    document.body.innerHTML = await renderConnect();
    const text = (sectionFor(provider)?.textContent ?? '').replace(/\s+/g, ' ');

    const scopes =
      provider === 'github'
        ? GITHUB_SCOPES.map((scope) => scope.because)
        : provider === 'jira'
          ? JIRA_SCOPES.map((scope) => scope.because)
          : SLACK_SCOPES.map((scope) => scope.because);

    for (const because of scopes) {
      expect(text, 'a permission is listed with no reason a manager can evaluate').toContain(
        because.slice(0, 40),
      );
    }
  });

  it('states the tracker’s refresh scope apart from its permissions', async () => {
    /**
     * `offline_access` is not a permission over anybody's data — it grants a refresh token. A consent
     * screen that lumped "stay connected" in with "read your issues" would have blurred the only
     * distinction a reader cares about, so it is rendered as its own entry.
     */
    document.body.innerHTML = await renderConnect();
    const refresh = sectionFor('jira')?.querySelector('[data-testid="connect-refresh-scope"]');

    expect(refresh?.getAttribute('data-permission')).toBe(JIRA_OFFLINE_SCOPE);
    // And it is not in the permission list, so `access: 'read'` holds over that whole array with no
    // exception carved into it.
    const permissions = [...(sectionFor('jira')?.querySelectorAll('[data-testid="connect-scope"]') ?? [])].map(
      (node) => node.getAttribute('data-permission'),
    );
    expect(permissions).not.toContain(JIRA_OFFLINE_SCOPE);
  });

  it('never renders a scope either provider promises not to request', async () => {
    /**
     * Asserted against the rendered *permission* attributes rather than against the page's prose, and the
     * distinction is not pedantry: `admin` is on the forbidden list, and this page legitimately contains
     * the word "administrator" in the sentence promising there is no administrator step. A substring check
     * over the text would fail on the very claim the page exists to make. What must hold is that no
     * forbidden scope is *requested*, and the permission list is where a request is displayed.
     */
    document.body.innerHTML = await renderConnect();

    const requested = new Set(
      [
        ...document.body.querySelectorAll('[data-testid="connect-scope"]'),
        ...document.body.querySelectorAll('[data-testid="connect-refresh-scope"]'),
      ].map((node) => node.getAttribute('data-permission')),
    );

    for (const forbidden of [...FORBIDDEN_JIRA_SCOPES, ...FORBIDDEN_SLACK_SCOPES]) {
      expect(requested, `${forbidden} is a scope Compass promises never to request`).not.toContain(forbidden);
    }
  });

  it('requires no administrator, no upload and no config file', async () => {
    /**
     * The criterion, asserted against the page a manager actually reads: "No step requires an org admin, a
     * CSV upload or a hand-edited config file." A file input is the mechanical version of the same claim —
     * if one appeared, this fails.
     */
    document.body.innerHTML = await renderConnect();

    expect(document.body.querySelector('input[type="file"]'), 'the connect screen offers an upload').toBeNull();
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('no file to upload and no configuration to hand-edit');
    expect(text).toContain('There is no administrator step');
  });
});

// ---------------------------------------------------------------------------
// Per-repository, per-project and per-channel scoping
// ---------------------------------------------------------------------------

describe('a manager scopes each source to exactly what Compass may read', () => {
  it('accepts repositories as owner/name and shows the repository name in the report', async () => {
    const response = await setScope('github', 'northwind/checkout-web\nnorthwind/pricing-api');
    expect(response.status).toBe(200);

    const config = await findSourceConfig(scoped(), GITHUB_SOURCE_KEY);
    expect(config?.selections).toEqual([
      { selectionKey: 'northwind/checkout-web', displayName: 'checkout-web' },
      { selectionKey: 'northwind/pricing-api', displayName: 'pricing-api' },
    ]);
  });

  it('accepts project keys and upper-cases what a person typed', async () => {
    // The key is case-insensitive to a person and case-sensitive to the query, so correcting it silently
    // is the behaviour that matches what they meant.
    await setScope('jira', 'dev\nOPS');

    const config = await findSourceConfig(scoped(), JIRA_SOURCE_KEY);
    expect(config?.selections.map((entry) => entry.selectionKey)).toEqual(['DEV', 'OPS']);
  });

  it('accepts a channel link and keeps the name the manager gave it', async () => {
    /**
     * A link and not a name, because resolving a name would need `channels:read` — the scope that turns a
     * channel-scoped connector into one that can enumerate the workspace, and the one Compass refuses. One
     * click in Slack ("Copy link"), one paste here.
     */
    await setScope('slack', '#checkout-eng https://northwind.slack.com/archives/C04AB12CD34');

    const config = await findSourceConfig(scoped(), SLACK_SOURCE_KEY);
    expect(config?.selections).toEqual([{ selectionKey: 'C04AB12CD34', displayName: '#checkout-eng' }]);
  });

  it('refuses a bad line whole rather than saving the good ones', async () => {
    /**
     * The failure this forbids is the quiet one: saving four of five repositories would leave a manager
     * believing Compass reads five, and the difference would only ever surface as a report that was
     * inexplicably thin.
     */
    await setScope('github', 'northwind/checkout-web');
    const before = await findSourceConfig(scoped(), GITHUB_SOURCE_KEY);

    const response = await setScope('github', 'northwind/pricing-api\nnot-a-repository');

    expect(response.status).toBe(422);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toContain('Nothing was saved');
    // The offending line is quoted back, so the correction is possible without guessing.
    expect(body.detail).toContain('not-a-repository');

    const after = await findSourceConfig(scoped(), GITHUB_SOURCE_KEY);
    expect(after?.selections).toEqual(before?.selections);
  });

  it('de-duplicates a repository typed twice and keeps the manager’s order', async () => {
    await setScope('github', 'northwind/pricing-api\nnorthwind/checkout-web\nnorthwind/pricing-api');

    const config = await findSourceConfig(scoped(), GITHUB_SOURCE_KEY);
    expect(config?.selections.map((entry) => entry.selectionKey)).toEqual([
      'northwind/pricing-api',
      'northwind/checkout-web',
    ]);
  });

  it('treats an empty selection as “read nothing”, stated, and never as “read everything”', async () => {
    const response = await setScope('github', '');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { stated: string };
    expect(body.stated).toContain('reads nothing from this source');
    expect(body.stated).toContain('read everything');

    const config = await findSourceConfig(scoped(), GITHUB_SOURCE_KEY);
    expect(config?.selections).toEqual([]);
  });

  it('records which selection changed, not merely that one did', async () => {
    // The log has to answer "which repository stopped being read on the 4th", which a count cannot.
    await setScope('github', 'northwind/checkout-web\nnorthwind/pricing-api');
    await setScope('github', 'northwind/checkout-web');

    const audit = await listAuditLogEntries(scoped());

    /**
     * Matched as a pair rather than by position. Several entries in this suite share an `occurredAt`, so
     * the journal's order between them is not insertion order and `.at(-1)` would be asserting about
     * whichever row the index happened to return. The claim that matters is that the narrowing *was*
     * recorded with both sides of it, which is what this finds.
     */
    const narrowing = audit
      .filter((row) => row.action === 'connector.scope_changed')
      .find(
        (row) =>
          JSON.stringify((row.before as { selectionKeys?: unknown })?.selectionKeys) ===
            JSON.stringify(['northwind/checkout-web', 'northwind/pricing-api']) &&
          JSON.stringify((row.after as { selectionKeys?: unknown })?.selectionKeys) ===
            JSON.stringify(['northwind/checkout-web']),
      );

    expect(narrowing, 'no audit entry records which repository stopped being read').toBeDefined();
  });

  it('refuses a manager: widening what Compass reads is as consequential as connecting', async () => {
    const { POST } = await import('../app/api/connect/[provider]/scope/route');
    const response = await POST(
      formPost('/api/connect/github/scope', 'selections=northwind/anything', sessions.manager),
      routeParams('github'),
    );

    expect(response.status).toBe(403);
  });

  it('renders the stored selection back into the form, so it is editable', async () => {
    await setScope('slack', '#checkout-eng https://northwind.slack.com/archives/C04AB12CD34');
    document.body.innerHTML = await renderConnect();

    const field = sectionFor('slack')?.querySelector('[data-testid="scope-field"]');
    // `#name <id>`: the id is what Compass holds, and hiding it would mean a manager could not tell two
    // identically-named channels apart.
    expect(field?.textContent).toBe('#checkout-eng C04AB12CD34');
  });

  it('answers 404 for a provider Compass does not have', async () => {
    const { POST } = await import('../app/api/connect/[provider]/scope/route');
    const response = await POST(jsonPost('/api/connect/gitlab/scope', { selections: 'a/b' }), routeParams('gitlab'));

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The signed state binds the provider as well as the organization
// ---------------------------------------------------------------------------

describe('a state minted for one provider cannot be replayed against another', () => {
  it('accepts a state in the flow it was issued for', () => {
    const state = issueConnectState({ organizationId: ORGANIZATION_ID, now: T0, providerId: 'slack' });
    const verdict = verifyConnectState({ state, now: T0, providerId: 'slack' });

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.providerId).toBe('slack');
  });

  it('refuses it in another provider’s flow, as if it were forged', () => {
    /**
     * The attack this closes: without the provider bound into the signature, a state minted for the chat
     * flow could be replayed against the tracker's callback, storing a chat credential under the tracker's
     * source key — where the tracker connector would then try to use it. The caller must also not learn
     * *which* check failed, so the reason is `bad_signature` and not something more specific.
     */
    const state = issueConnectState({ organizationId: ORGANIZATION_ID, now: T0, providerId: 'slack' });
    const verdict = verifyConnectState({ state, now: T0, providerId: 'jira' });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  it('stores nothing when a tracker callback arrives with a chat state', async () => {
    const state =
      issueConnectState({ organizationId: ORGANIZATION_ID, now: instantFromEpochMillis(Date.now()), providerId: 'slack' }) ??
      '';

    const { GET } = await import('../app/api/connect/[provider]/callback/route');
    const response = await GET(
      new Request(`https://compass.example.com/api/connect/jira/callback?state=${encodeURIComponent(state)}&code=abc`),
      routeParams('jira'),
    );

    expect(response.headers.get('location')).toContain('jira=state-rejected');
    expect(await findIntegrationToken(scoped(), JIRA_SOURCE_KEY, 'access')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Disconnect: keeps the data, keeps the selections, states it, records it
// ---------------------------------------------------------------------------

describe('disconnecting a source keeps prior data and states the source as disconnected', () => {
  beforeEach(async () => {
    await setScope('slack', '#checkout-eng https://northwind.slack.com/archives/C04AB12CD34');
    await storeIntegrationToken(
      scoped(),
      { sourceKey: SLACK_SOURCE_KEY, tokenKind: 'access', token: 'a-bot-token' },
      T0,
    );
    await storeIntegrationToken(
      scoped(),
      { sourceKey: SLACK_SOURCE_KEY, tokenKind: 'refresh', token: 'a-refresh-token' },
      T0,
    );
  });

  const disconnect = async () => {
    const { POST } = await import('../app/api/connect/[provider]/disconnect/route');
    return await POST(formPost('/api/connect/slack/disconnect'), routeParams('slack'));
  };

  it('deletes the access token and the refresh token', async () => {
    // Leaving the refresh token would leave a way back in after the access token was revoked.
    await disconnect();

    expect(await findIntegrationToken(scoped(), SLACK_SOURCE_KEY, 'access')).toBeNull();
    expect(await findIntegrationToken(scoped(), SLACK_SOURCE_KEY, 'refresh')).toBeNull();
  });

  it('keeps the selections, so reconnecting does not ask for them again', async () => {
    await disconnect();

    const config = await findSourceConfig(scoped(), SLACK_SOURCE_KEY);
    expect(config?.selections).toEqual([{ selectionKey: 'C04AB12CD34', displayName: '#checkout-eng' }]);
    // And the source is marked not-reading rather than deleted, which is what makes "disconnected" a
    // state the freshness indicator can state at all.
    expect(config?.enabled).toBe(false);
  });

  it('writes an audit record naming the act, the actor and what survived', async () => {
    await disconnect();

    const audit = await listAuditLogEntries(scoped());
    const entry = audit.find(
      (row) => row.action === 'connector.disconnected' && row.targetId === SLACK_SOURCE_KEY,
    );

    expect(entry, 'disconnecting wrote no audit entry').toBeDefined();
    expect(entry?.actorUserId).toBe(OWNER);
    expect(entry?.after).toMatchObject({ connected: false, rowsRetained: true, selectionsRetained: 1 });
  });

  it('is what the freshness indicator reads to state the source as disconnected', async () => {
    /**
     * The criterion's exact words: disconnecting "states the source is disconnected in the freshness
     * indicator". The journal cannot say this — a source nobody reads contributes no coverage row, which
     * renders identically to a source that was never configured — so the fact comes from the
     * configuration, and this is the function the report page reads it through.
     */
    const chatEntry = async () =>
      (await listDisconnectedSources(scoped())).find((entry) => entry.sourceKey === SLACK_SOURCE_KEY) ?? null;

    /**
     * Scoped to the chat source, because the other two are *also* legitimately in this list: earlier tests
     * here scoped them without ever granting a credential, and "configured, no credential" is exactly the
     * state this function reports. Asserting an empty list would be asserting that the function under test
     * misses two real cases.
     */
    expect(await chatEntry()).toBeNull();

    await disconnect();

    expect(await chatEntry()).toEqual({
      sourceKey: SLACK_SOURCE_KEY,
      sourceKind: 'chat',
      name: 'Slack',
      retainedSelectionCount: 1,
    });
  });

  it('renders as disconnected on the connect screen, and offers a reconnect', async () => {
    await disconnect();
    document.body.innerHTML = await renderConnect();

    const section = sectionFor('slack');
    expect(section?.getAttribute('data-disconnected')).toBe('true');
    expect(section?.querySelector('[data-testid="connect-status"]')?.textContent).toBe('disconnected');
    expect(section?.querySelector('[data-testid="install-submit"]')?.textContent).toContain('Reconnect');
  });

  it('is idempotent: disconnecting twice is not an error', async () => {
    await disconnect();
    const second = await disconnect();

    expect(second.status).toBe(303);
    // The act is still recorded, because "the owner pressed disconnect" is a fact whether or not a row
    // was there to remove.
    const audit = await listAuditLogEntries(scoped());
    expect(
      audit.filter((row) => row.action === 'connector.disconnected' && row.targetId === SLACK_SOURCE_KEY).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('refuses a manager, and leaves the credential untouched', async () => {
    const { POST } = await import('../app/api/connect/[provider]/disconnect/route');
    const response = await POST(
      formPost('/api/connect/slack/disconnect', '', sessions.manager),
      routeParams('slack'),
    );

    expect(response.status).toBe(403);
    expect(await findIntegrationToken(scoped(), SLACK_SOURCE_KEY, 'access')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Install, per provider
// ---------------------------------------------------------------------------

describe('starting an install sends the owner to the right provider', () => {
  it.each([
    ['github', 'github.com/apps/compass-daily/installations/new'],
    ['jira', 'auth.atlassian.com/authorize'],
    ['slack', 'slack.com/oauth/v2/authorize'],
  ])('redirects %s to its own consent screen with a state', async (provider, expectedHost) => {
    const { POST } = await import('../app/api/connect/[provider]/install/route');
    const response = await POST(formPost(`/api/connect/${provider}/install`), routeParams(provider));

    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain(expectedHost);
    expect(location).toContain('state=');
  });

  it('asks the chat provider for bot scopes and no user scopes', async () => {
    /**
     * A user token would read everything the installing person can see — the whole workspace, their direct
     * messages included. That distinction *is* the difference between a channel-scoped connector and a
     * workspace-wide one, so it is asserted on the URL that actually goes out.
     */
    const { POST } = await import('../app/api/connect/[provider]/install/route');
    const response = await POST(formPost('/api/connect/slack/install'), routeParams('slack'));

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('scope')).toBe(SLACK_SCOPES.map((scope) => scope.scope).join(','));
    expect(location.searchParams.get('user_scope')).toBe('');
  });

  it('answers 503 naming the variables when a provider is not configured here', async () => {
    vi.stubEnv(JIRA_CLIENT_ID_ENV_VAR, '');
    const { POST } = await import('../app/api/connect/[provider]/install/route');
    const response = await POST(formPost('/api/connect/jira/install'), routeParams('jira'));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toContain(JIRA_CLIENT_ID_ENV_VAR);
  });

  it('refuses a manager for every provider', async () => {
    const { POST } = await import('../app/api/connect/[provider]/install/route');

    for (const provider of ['github', 'jira', 'slack']) {
      const response = await POST(
        formPost(`/api/connect/${provider}/install`, '', sessions.manager),
        routeParams(provider),
      );
      expect(response.status, `${provider} admitted a manager`).toBe(403);
    }
  });

  it('answers 404 for a provider Compass does not have', async () => {
    const { POST } = await import('../app/api/connect/[provider]/install/route');
    const response = await POST(formPost('/api/connect/gitlab/install'), routeParams('gitlab'));

    expect(response.status).toBe(404);
  });
});
