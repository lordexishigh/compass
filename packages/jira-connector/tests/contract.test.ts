import { describeConnectorContract, ThrottledHttpClient } from '@compass/connector-port/testkit';
import {
  FORBIDDEN_JIRA_SCOPES,
  JIRA_OFFLINE_SCOPE,
  JIRA_SCOPES,
  JiraConnector,
  jiraAuthorizeUrl,
  jiraScopeQuery,
} from '@compass/jira-connector';
import { describe, expect, it } from 'vitest';

import {
  API_BASE_URL,
  CLOUD_ID,
  CONTRACT_WINDOW,
  NOW,
  ORGANIZATION_ID,
  PROJECT_KEY,
  SOURCE_KEY,
  recordedClient,
} from './recorded-api.js';

/**
 * The acceptance criterion, as the only test that can prove it:
 *
 * > The Jira connector passes the ConnectorPort contract test suite unchanged.
 *
 * `describeConnectorContract` is imported and called. It is not copied, not parameterised beyond the
 * factory hook it already offers, and not weakened — the seeded provider and the code host run the
 * identical function. That is what makes "a live provider drops in unchanged" a checked property rather
 * than a claim in an architecture document.
 */

const connectorConfig = (overrides: Record<string, unknown> = {}) => ({
  sourceKey: SOURCE_KEY,
  projects: [{ projectKey: PROJECT_KEY }],
  accessToken: 'a-test-access-token',
  cloudId: CLOUD_ID,
  http: recordedClient(),
  apiBaseUrl: API_BASE_URL,
  ...overrides,
});

describeConnectorContract({
  name: 'JiraConnector',
  // A fresh connector *and* a fresh transport per call, which is what the "holds no cursor state"
  // property actually demands: a shared client would let one call's pagination leak into the next.
  createConnector: () => new JiraConnector(connectorConfig()),
  organizationId: ORGANIZATION_ID,
  window: CONTRACT_WINDOW,
  now: NOW,
});

const request = { organizationId: ORGANIZATION_ID, window: CONTRACT_WINDOW, now: NOW };
const connector = () => new JiraConnector(connectorConfig());

// ---------------------------------------------------------------------------
// Scopes, displayed verbatim before consent
// ---------------------------------------------------------------------------

describe('the requested scopes are exactly the documented read-only set', () => {
  it('requests read access and nothing else', () => {
    for (const scope of JIRA_SCOPES) {
      expect(scope.access, `${scope.scope} must be read-only`).toBe('read');
      expect(scope.scope.startsWith('read:'), `${scope.scope} is not a read scope`).toBe(true);
    }
  });

  it('requests none of the scopes Compass promises never to ask for', () => {
    const requested = jiraScopeQuery().split(' ');

    for (const forbidden of FORBIDDEN_JIRA_SCOPES) {
      expect(requested, `${forbidden} is a write or admin scope and must never be requested`).not.toContain(forbidden);
    }
  });

  it('builds the consent URL from the same list the connect screen renders', () => {
    /**
     * The drift this pins: two copies of the scope list — one in the URL, one in the JSX — is the shape
     * where the screen keeps promising read-only after somebody adds a write scope to the request. The URL
     * is *derived*, so the promise and the request cannot disagree.
     */
    const url = jiraAuthorizeUrl({
      clientId: 'a-client-id',
      redirectUri: 'https://compass.example.com/api/connect/jira/callback',
      state: 'a-csrf-token',
    });

    for (const scope of JIRA_SCOPES) {
      expect(url).toContain(encodeURIComponent(scope.scope));
    }
    expect(url).toContain('state=a-csrf-token');
    expect(url).toContain('prompt=consent');
    expect(url.startsWith('https://auth.atlassian.com/authorize?')).toBe(true);
  });

  it('keeps the refresh scope out of the read-only list but still requests it', () => {
    // `offline_access` grants no access to anybody's data, so folding it into `JIRA_SCOPES` would force an
    // exception into the "every scope is read" assertion above — the assertion that has to stay absolute.
    expect(JIRA_SCOPES.map((scope) => scope.scope)).not.toContain(JIRA_OFFLINE_SCOPE);
    expect(jiraScopeQuery().split(' ')).toContain(JIRA_OFFLINE_SCOPE);
  });

  it('gives every scope a reason a manager can evaluate', () => {
    // A consent screen listing scopes with no justification is a screen nobody can refuse intelligently.
    for (const scope of JIRA_SCOPES) {
      expect(scope.because.length, `${scope.scope} has no stated reason`).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// The rate-limit criterion
// ---------------------------------------------------------------------------

describe('a rate limit becomes a stated coverage gap, not a quiet empty day', () => {
  const throttled = (pattern: RegExp) =>
    new JiraConnector(connectorConfig({ http: new ThrottledHttpClient(recordedClient(), pattern) }));

  it('reports unavailable coverage naming the source and the reason', async () => {
    const result = await throttled(/search\/jql/).fetchIssues(request);

    expect(result.status).toBe('unavailable');
    const coverage = result.coverage.find((entry) => entry.sourceKey === SOURCE_KEY);
    expect(coverage?.reason).toBe('rate_limited');
    // The contract requires the sentence to name its own source, because it is shown to a manager as-is
    // in the freshness panel.
    expect(coverage?.detail).toContain(SOURCE_KEY);
    expect(coverage?.coveredWindow, 'nothing was covered, so the covered window must be null').toBeNull();
  });

  it('returns no records rather than the half it managed to read', async () => {
    /**
     * The criterion is "rather than reporting on partial data as complete". A changelog read that dies
     * half way through the issue list is the realistic shape of this: returning the transitions found
     * before the 429 with a `complete` count would state a number that is arithmetically wrong and
     * typographically confident.
     */
    const result = await throttled(/changelog/).fetchIssueTransitions(request);

    expect(result.records).toEqual([]);
    expect(result.coverage.every((entry) => entry.recordCount === 0)).toBe(true);
    expect(result.coverage[0]?.reason).toBe('rate_limited');
  });

  it('says so in the health report the freshness indicator reads', async () => {
    const health = await throttled(/rest\/api\/3\/project/).reportSourceHealth(request);

    expect(health.overall).not.toBe('complete');
    const entry = health.sources.find((source) => source.sourceKey === SOURCE_KEY);
    expect(entry?.status).toBe('unavailable');
    expect(entry?.reason).toBe('rate_limited');
  });

  it('treats a refused credential as a reconnect instruction, not a rate limit', async () => {
    const refusing = {
      send: () => Promise.resolve({ status: 401, headers: {}, body: '{"message":"Unauthorized"}' }),
    };
    const result = await new JiraConnector(connectorConfig({ http: refusing })).fetchIssues(request);

    expect(result.coverage[0]?.reason).toBe('authentication_failed');
    expect(result.coverage[0]?.detail).toContain('Reconnect');
  });

  it('does not fabricate a freshness timestamp when it has no journal', async () => {
    // The panel's rule: no invented "last updated". This connector holds no journal, so it reports null
    // and lets the ingest journal be the single source of that fact.
    const health = await connector().reportSourceHealth(request);

    expect(health.sources[0]?.lastObservedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tracker's own contribution to the report
// ---------------------------------------------------------------------------

describe('issues carry what Progress and Blockers are computed from', () => {
  it('maps the tracker status category onto the port\'s three', async () => {
    const result = await connector().fetchIssues(request);

    const inProgress = result.records.find((record) => record.itemKey === 'DEV-501');
    const done = result.records.find((record) => record.itemKey === 'DEV-502');
    expect(inProgress?.statusCategory).toBe('in_progress');
    expect(done?.statusCategory).toBe('done');
    // The provider's own word is kept alongside the category, because "Done" and "Released" are both
    // `done` and a manager reading the report needs to know which one their team said.
    expect(done?.status).toBe('Done');
  });

  it('reads the tracker\'s blocked flag rather than guessing from a status name', async () => {
    /**
     * A status called "Blocked" is a convention some teams have and others do not. The flag is the one
     * signal the tracker itself calls an impediment, so it is the one Blockers can rely on.
     */
    const result = await connector().fetchIssues(request);

    expect(result.records.find((record) => record.itemKey === 'DEV-502')?.flaggedBlocked).toBe(true);
    expect(result.records.find((record) => record.itemKey === 'DEV-501')?.flaggedBlocked).toBe(false);
  });

  it('flattens a document-format description to the prose the narrator is given', async () => {
    // The v3 API returns a tree, not a string. Handing the narration model a JSON tree would be handing
    // it something to hallucinate structure from.
    const result = await connector().fetchIssues(request);

    expect(result.records[0]?.description).toBe('DEV-501: one write per basket instead of one per line.');
  });

  it('resolves an identity to an address when the site publishes one, and to an account when it does not', async () => {
    const result = await connector().fetchIssues(request);
    const record = result.records.find((entry) => entry.itemKey === 'DEV-501');

    expect(record?.assigneeIdentity).toEqual({
      kind: 'email',
      value: 'priya@example.com',
      displayName: 'Priya Raman',
    });
    // Profile privacy hides the address; the opaque account id is then the only stable identifier, and
    // inventing an address from the display name is exactly the guess the roster exists to prevent.
    expect(record?.reporterIdentity?.kind).toBe('account');
    expect(record?.reporterIdentity?.displayName).toBe('Marcus Hale');
  });

  it('carries the estimate as a number and the parent as a key', async () => {
    const result = await connector().fetchIssues(request);
    const record = result.records.find((entry) => entry.itemKey === 'DEV-501');

    expect(record?.estimatePoints).toBe(5);
    expect(record?.parentItemKey).toBe('DEV-400');
    expect(record?.labels).toEqual(['checkout', 'performance']);
  });
});

describe('transitions and sprint movement come out of the change history', () => {
  it('gives both sides of a transition a category, from the project\'s own status catalogue', async () => {
    /**
     * The changelog carries two status *names* and nothing else, so the category — which is what the
     * report reasons about — has to be resolved from the project configuration. Without this the
     * connector would either omit the field or guess it.
     */
    const result = await connector().fetchIssueTransitions(request);
    const finished = result.records.find((record) => record.itemKey === 'DEV-502');

    expect(finished?.fromStatus).toBe('In Progress');
    expect(finished?.toStatus).toBe('Done');
    expect(finished?.fromStatusCategory).toBe('in_progress');
    expect(finished?.toStatusCategory).toBe('done');
  });

  it('excludes a transition that happened before the window opened', async () => {
    // The recording has a `To Do` transition a day before the window. It is the local window filter that
    // must drop it, because the JQL bound is deliberately wider than the window.
    const result = await connector().fetchIssueTransitions(request);

    expect(result.records).toHaveLength(2);
    expect(result.records.map((record) => record.toStatus)).toEqual(['In Progress', 'Done']);
  });

  it('reads scope added to and removed from a sprint as two different facts', async () => {
    const result = await connector().fetchSprintScopeChanges(request);

    expect(result.records.map((record) => ({ item: record.itemKey, change: record.change }))).toEqual([
      { item: 'DEV-501', change: 'added' },
      { item: 'DEV-502', change: 'removed' },
    ]);
    // Referenced by the sprint's id rather than its name: a renamed sprint would otherwise silently
    // become a different sprint, and mid-sprint renames are common.
    expect(result.records.every((record) => record.sprintRef === '42')).toBe(true);
  });

  it('dates a sprint by its own movement and skips one that was never scheduled', async () => {
    const result = await connector().fetchSprints(request);

    expect(result.records).toHaveLength(1);
    const sprint = result.records[0];
    expect(sprint?.name).toBe('Checkout hardening');
    expect(sprint?.state).toBe('active');
    expect(sprint?.completedAt).toBeNull();
    // Both dates are required by the port, so the unscheduled "Sprint 4" is skipped rather than dated
    // with an invented range.
    expect(result.records.map((record) => record.name)).not.toContain('Sprint 4');
  });

  it('lists the sprint\'s commitment including items that did not move today', async () => {
    /**
     * The commitment is not "what moved" — that is the whole point of reconciling against it. A membership
     * query filtered by the report window would compare the day's movement with itself.
     */
    const result = await connector().fetchSprints(request);

    expect(result.records[0]?.committedItemKeys).toEqual(['DEV-501', 'DEV-502']);
  });
});
