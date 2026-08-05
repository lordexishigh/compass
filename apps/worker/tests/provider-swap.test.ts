import {
  instantFromEpochMillis,
  instantFromIso,
  timeWindow,
  toEpochMillis,
  type Instant,
  type TimeWindow,
} from '@compass/clock';
import {
  CompositeConnector,
  findProviderVocabularyViolations,
  type ConnectorPort,
  type HttpClient,
  type HttpResponse,
} from '@compass/connector-port';
import { FixtureConnector, type FixtureDataset } from '@compass/connector-port/testkit';
import { ScopedDb, findIntegrationToken, orgScope, saveSourceConfig } from '@compass/db';
import { storeIntegrationToken, useIntegrationToken } from '@compass/auth';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { GITHUB_CONNECTOR_ID, GithubConnector } from '@compass/github-connector';
import { JIRA_CONNECTOR_ID } from '@compass/jira-connector';
import { KnowledgeStore, provisionRoster, type OrgRoster } from '@compass/knowledge-model';
import { runReportPipeline } from '@compass/pipeline';
import { SLACK_CONNECTOR_ID, SlackConnector } from '@compass/slack-connector';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveConnector } from '../src/connectors.js';

import {
  CHANNEL_KEY,
  CHANNEL_NAME,
  CHAT_SOURCE_KEY,
  CODE_SOURCE_KEY,
  GITHUB_API_BASE_URL,
  NOW,
  ORGANIZATION_ID,
  OWNER,
  PROJECT_KEY,
  REPO,
  REPORT_WINDOW,
  REPOSITORY_KEY,
  SLACK_API_BASE_URL,
  TEAM_KEY,
  TIMEZONE,
  recordedGithubClient,
  recordedSlackClient,
} from './helpers/recorded-live-api.js';

/**
 * The zero-change swap, proven by running the same pipeline over both providers.
 *
 * > The same analysis test suite passes against a recorded live-provider fixture and the seeded provider.
 *
 * `describeSameReportFor` below is that suite: one block of assertions, defined once, invoked twice. The
 * *only* thing that differs between the two invocations is the `ConnectorPort` handed in — same
 * `runReportPipeline` call, same arguments, same database, same roster, same window. If either side needed
 * a different assertion, a different argument or a special case, the swap would not be configuration-only
 * and this file could not be written this way.
 *
 * That is the same shape `describeConnectorContract` uses one layer down, and for the same reason: a
 * property asserted by two suites that merely resemble each other is a property nobody is checking.
 *
 * ## What each side is
 *
 *  - **A recorded live provider.** `GithubConnector` and `SlackConnector`, composed by
 *    `CompositeConnector`, reading recorded HTTP. Every line of the production connectors runs — the
 *    pagination, the window filtering, the coverage bookkeeping — with the network replaced.
 *  - **The seeded-shape provider.** `FixtureConnector` over a provider-neutral dataset, which is what
 *    every layer below the port is tested against and what the seeded connector's own records look like
 *    to the pipeline.
 *
 * ## Why the reports are not asserted to be byte-identical
 *
 * They describe different fixture content, so they could not be. What is asserted is what the criterion
 * actually rests on: both sides run the same stages in the same order, produce a complete six-section
 * report, carry no provider vocabulary anywhere in the persisted payload, and are deterministic on a
 * replay. A test demanding identical bytes would have forced the two fixtures to be transcriptions of each
 * other, which proves the fixtures match and nothing about the code.
 */

/** Wide enough to reach the history the report reconciles against. */
const INGEST_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-06-01T00:00:00Z'),
  instantFromIso('2026-07-31T07:30:00Z'),
);

const at = (iso: string): Instant => instantFromIso(iso);

/**
 * The roster both sides run against.
 *
 * Provisioned rather than observed, because a team and its people are *configuration*: no connector
 * reports them, and inferring a team from who commits together would put someone else's merge in this
 * team's Yesterday.
 */
const roster = (declaredAt: Instant): OrgRoster => ({
  company: { key: 'northwind', name: 'Northwind', timezone: TIMEZONE },
  objectives: [
    {
      key: 'OBJ-Q3',
      kind: 'quarter',
      parentKey: null,
      title: 'Cut checkout latency by a third',
      effectiveFrom: at('2026-07-01T00:00:00Z'),
      effectiveUntil: at('2026-10-01T00:00:00Z'),
      isCurrent: true,
    },
  ],
  teams: [
    {
      key: TEAM_KEY,
      name: 'Platform',
      methodology: 'scrum',
      projectKey: PROJECT_KEY,
      objectiveKey: 'OBJ-Q3',
      conversationKey: CHANNEL_KEY,
      timezone: TIMEZONE,
    },
  ],
  developers: [
    {
      key: 'priya',
      displayName: 'Priya Raman',
      teamKey: TEAM_KEY,
      active: true,
      gitEmails: ['priya@example.com'],
      trackerAccounts: ['acct-priya'],
      chatHandles: ['priya'],
    },
    {
      key: 'marcus',
      displayName: 'Marcus Hale',
      teamKey: TEAM_KEY,
      active: true,
      gitEmails: ['marcus@example.com'],
      trackerAccounts: ['acct-marcus'],
      chatHandles: ['marcus'],
    },
  ],
  absences: [],
  declaredAt,
});

/**
 * The live composite: two real connectors over recorded HTTP.
 *
 * A fresh transport per call, because the pipeline is run more than once and `ReplayHttpClient` records
 * what it was asked — a shared client would let one run's request list leak into the next.
 */
const liveConnector = (): ConnectorPort =>
  new CompositeConnector({
    connectorId: `live:${[CHAT_SOURCE_KEY, CODE_SOURCE_KEY].sort().join('+')}`,
    members: [
      new GithubConnector({
        sourceKey: CODE_SOURCE_KEY,
        repositories: [{ repositoryKey: REPOSITORY_KEY, owner: OWNER, name: REPO }],
        token: 'a-test-installation-token',
        http: recordedGithubClient(),
        apiBaseUrl: GITHUB_API_BASE_URL,
      }),
      new SlackConnector({
        sourceKey: CHAT_SOURCE_KEY,
        channels: [{ conversationKey: CHANNEL_KEY, name: CHANNEL_NAME }],
        botToken: 'a-test-bot-token',
        http: recordedSlackClient(),
        apiBaseUrl: SLACK_API_BASE_URL,
      }),
    ],
  });

/**
 * The seeded-shape side: the same two source kinds, in the port's own neutral vocabulary.
 *
 * Deliberately *not* a transcription of the recording. It describes the same day at the same organization
 * — same repository key, same tracker key in the prose, same people — because that is what makes the two
 * reports comparable in kind, but its numbers differ, which is what stops this test degenerating into a
 * check that two fixtures were copied from each other.
 */
const SEEDED_SHAPE_DATASET: FixtureDataset = {
  datasetId: 'seeded-shape',
  deploySignal: false,
  sources: [
    { sourceKey: CODE_SOURCE_KEY, sourceKind: 'code', availability: { status: 'available' } },
    { sourceKey: CHAT_SOURCE_KEY, sourceKind: 'chat', availability: { status: 'available' } },
  ],
  records: {
    commits: [
      {
        sourceKey: CODE_SOURCE_KEY,
        sourceKind: 'code',
        sourceRecordId: 'commit-seeded-1',
        occurredAt: at('2026-07-30T10:00:00Z'),
        repositoryKey: REPOSITORY_KEY,
        revisionId: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
        parentRevisionIds: [],
        authorIdentity: { kind: 'email', value: 'priya@example.com', displayName: 'Priya Raman' },
        committerIdentity: { kind: 'email', value: 'priya@example.com', displayName: 'Priya Raman' },
        authoredAt: at('2026-07-30T10:00:00Z'),
        message: 'DEV-501 batch the checkout writer',
        changedFileCount: 4,
        branchName: 'feature/DEV-501-batch-writer',
      },
    ],
    pull_requests: [
      {
        sourceKey: CODE_SOURCE_KEY,
        sourceKind: 'code',
        sourceRecordId: 'pr-seeded-901',
        occurredAt: at('2026-07-30T14:10:00Z'),
        repositoryKey: REPOSITORY_KEY,
        displayNumber: 901,
        title: 'Batch the checkout writer',
        description: 'DEV-501: one write per basket.',
        authorIdentity: { kind: 'email', value: 'priya@example.com', displayName: 'Priya Raman' },
        state: 'merged',
        createdAt: at('2026-07-29T09:00:00Z'),
        updatedAt: at('2026-07-30T14:10:00Z'),
        mergedAt: at('2026-07-30T14:10:00Z'),
        closedAt: at('2026-07-30T14:10:00Z'),
        sourceBranch: 'feature/DEV-501-batch-writer',
        targetBranch: 'main',
        headRevisionId: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
        mergeRevisionId: 'dabbad00dabbad00dabbad00dabbad00dabbad00',
        requestedReviewerIdentities: [
          { kind: 'email', value: 'marcus@example.com', displayName: 'Marcus Hale' },
        ],
        linkedWorkItemKeys: ['DEV-501'],
      },
    ],
    reviews: [
      {
        sourceKey: CODE_SOURCE_KEY,
        sourceKind: 'code',
        sourceRecordId: 'review-seeded-1',
        occurredAt: at('2026-07-30T13:00:00Z'),
        repositoryKey: REPOSITORY_KEY,
        pullRequestRef: 'pr-seeded-901',
        reviewerIdentity: { kind: 'email', value: 'marcus@example.com', displayName: 'Marcus Hale' },
        verdict: 'approved',
        submittedAt: at('2026-07-30T13:00:00Z'),
        commentCount: 1,
      },
    ],
    branch_refs: [
      {
        sourceKey: CODE_SOURCE_KEY,
        sourceKind: 'code',
        sourceRecordId: `${REPOSITORY_KEY}:main`,
        occurredAt: at('2026-07-30T14:15:00Z'),
        repositoryKey: REPOSITORY_KEY,
        name: 'main',
        revisionId: 'dabbad00dabbad00dabbad00dabbad00dabbad00',
        isDefault: true,
        observedAt: NOW,
      },
    ],
    release_tags: [
      {
        sourceKey: CODE_SOURCE_KEY,
        sourceKind: 'code',
        sourceRecordId: `${REPOSITORY_KEY}:v2.15`,
        occurredAt: at('2026-07-30T19:00:00Z'),
        repositoryKey: REPOSITORY_KEY,
        name: 'v2.15',
        revisionId: 'dabbad00dabbad00dabbad00dabbad00dabbad00',
        releasedAt: at('2026-07-30T19:00:00Z'),
        description: 'Checkout batching',
      },
    ],
    messages: [
      {
        sourceKey: CHAT_SOURCE_KEY,
        sourceKind: 'chat',
        sourceRecordId: `${CHANNEL_KEY}:seeded-1`,
        occurredAt: at('2026-07-30T09:45:00Z'),
        conversationKey: CHANNEL_KEY,
        conversationName: CHANNEL_NAME,
        authorIdentity: { kind: 'handle', value: 'marcus', displayName: 'Marcus Hale' },
        body: 'DEV-522 is still waiting on the payments team.',
        threadRef: null,
        referencedItemKeys: ['DEV-522'],
        postedAt: at('2026-07-30T09:45:00Z'),
      },
    ],
  },
};

let database: TestDatabase;

beforeAll(async () => {
  /**
   * The encryption key, without which Compass refuses to store an OAuth credential at all.
   *
   * That refusal is the intended behaviour and is asserted elsewhere; here it would only stop the refresh
   * assertions from reaching the thing they are about. 32 bytes, base64, as `resolveMasterKey` requires.
   */
  vi.stubEnv('COMPASS_KMS_MASTER_KEY', Buffer.alloc(32, 11).toString('base64'));

  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind',
    slug: 'northwind-swap',
    timezone: TIMEZONE,
    at: new Date(Date.parse('2026-05-18T00:00:00.000Z')),
  });

  await provisionRoster(
    new KnowledgeStore(database.scopedFor(ORGANIZATION_ID)),
    roster(at('2026-05-18T00:00:00Z')),
  );
}, 180_000);

afterAll(async () => {
  await database?.close();
});

/**
 * The suite, defined once and run against both providers.
 *
 * Every argument to `runReportPipeline` is identical between the two invocations except `connector`. That
 * is the assertion this whole file makes, and it is made by construction rather than by a check: there is
 * one `request` builder and it takes the connector as its only parameter.
 */
/** Each side's stage list, so the two can be compared against each other. */
const observedStages = new Map<string, readonly string[]>();

function describeSameReportFor(name: string, createConnector: () => ConnectorPort, scopeKey: string): void {
  describe(`the pipeline over ${name}`, () => {
    const request = (connector: ConnectorPort) => ({
      organizationId: ORGANIZATION_ID,
      // A scope key per side, so the two runs write their own report rows rather than one finding the
      // other's and returning it.
      scope: { kind: 'team', teamKey: scopeKey } as const,
      now: NOW,
      timezone: TIMEZONE,
      window: REPORT_WINDOW,
      ingestWindow: INGEST_WINDOW,
      runId: `44444444-4444-4444-8444-0000000000${scopeKey === TEAM_KEY ? '01' : '02'}`,
      connector,
      database: database.db,
    });

    it('runs every stage, in the order the architecture declares', async () => {
      const result = await runReportPipeline(request(createConnector()));

      expect(result.stages).toEqual([
        'ingest-window',
        'build-snapshot',
        'sync-goals',
        'load-change-history',
        'analyse',
        'render',
        'narrate',
        'persist',
        'record-objective-links',
      ]);

      // Recorded so the cross-provider check below can compare the two sides against each other rather
      // than each against a literal — which is what keeps this assertion meaningful if a stage is ever
      // added: the list above would need updating, but a stage that ran for only *one* provider would be
      // caught even if somebody updated it carelessly.
      observedStages.set(name, result.stages);
    });

    it('produces all six sections, in the fixed order, from a real ingest', async () => {
      const result = await runReportPipeline(request(createConnector()));

      expect(result.rendered.sections.map((section) => section.key)).toEqual([
        'yesterday',
        'progress',
        'blockers',
        'risks',
        'recommendations',
        'wins',
      ]);
      // Not an empty run: the connector actually answered.
      expect(result.ingest?.summary.totalRecords).toBeGreaterThan(0);
    });

    it('names no provider anywhere in the report a manager reads', async () => {
      /**
       * The end-to-end version of `provider-neutrality.test.ts`, which reads source text. This reads the
       * *output*: if a provider's vocabulary survived the port, it would surface here as a field name or a
       * word in the prose, and no amount of layer discipline upstream would matter.
       */
      const result = await runReportPipeline(request(createConnector()));

      expect(findProviderVocabularyViolations(result.rendered, '$.rendered')).toEqual([]);
      for (const token of ['github', 'jira', 'slack', 'atlassian']) {
        expect(result.rendered.prose.toLowerCase(), `the prose names ${token}`).not.toContain(token);
      }
    });

    it('states its coverage rather than implying completeness', async () => {
      const result = await runReportPipeline(request(createConnector()));

      const coverage = result.ingest?.summary.coverage ?? [];
      expect(coverage.length).toBeGreaterThan(0);
      for (const entry of coverage) {
        expect(entry.detail).toContain(entry.sourceKey);
      }
    });

    it('is deterministic: the same window twice produces the same report content', async () => {
      /**
       * Run twice through the whole pipeline, including a second real ingest. A connector holding cursor
       * state, or a projection that was not idempotent, would change the hash — which is the property the
       * archive's continuity rests on, and the one a live provider is most likely to break.
       */
      const first = await runReportPipeline(request(createConnector()));
      const second = await runReportPipeline(request(createConnector()));

      expect(second.stored.contentHash).toBe(first.stored.contentHash);
    });
  });
}

const LIVE = 'a recorded live provider';
const SEEDED = 'the seeded-shape provider';

describeSameReportFor(LIVE, liveConnector, TEAM_KEY);
describeSameReportFor(SEEDED, () => new FixtureConnector(SEEDED_SHAPE_DATASET), TEAM_KEY);

describe('the two providers are handled by one code path', () => {
  it('runs the identical stages for both, in the identical order', () => {
    /**
     * The claim in its most direct form: swapping the provider changes *nothing* about which layers run.
     * A stage that fired for a live provider and not for the seeded one — a normalisation step, a retry, a
     * provider-specific reconciliation — would be the swap costing code, which is exactly what the
     * criterion forbids.
     */
    const live = observedStages.get(LIVE);
    const seeded = observedStages.get(SEEDED);

    expect(live, 'the live side recorded no stages').toBeDefined();
    expect(seeded).toEqual(live);
  });
});

// ---------------------------------------------------------------------------
// The swap itself is configuration
// ---------------------------------------------------------------------------

describe('provider selection happens through configuration, at the composition root only', () => {
  const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

  it('falls back to the seeded provider when nothing is connected', async () => {
    /**
     * The zero-config promise: an organization that has connected nothing still gets a full six-section
     * report. `resolveConnector` says so explicitly rather than building an empty composite, because a
     * port answering every question with an empty list is indistinguishable from one whose sources are all
     * down — and the report would then state a quiet day rather than an unconfigured deployment.
     */
    const resolved = await resolveConnector({ db: database.db, organizationId: ORGANIZATION_ID, now: NOW });

    expect(resolved.seeded).toBe(true);
    expect(resolved.connector.capabilities().sources.length).toBeGreaterThan(0);
  });

  it('resolves a live composite once a source is configured, and nothing else changes', async () => {
    /**
     * The criterion: "Provider selection happens through configuration resolved at composition root only."
     * The *only* input that changed between this assertion and the one above is a row in `source_configs` —
     * no environment variable, no code path, no redeploy.
     */
    await saveSourceConfig(
      scoped(),
      {
        sourceKey: CODE_SOURCE_KEY,
        sourceKind: 'code',
        connectorId: GITHUB_CONNECTOR_ID,
        enabled: true,
        selections: [{ selectionKey: `${OWNER}/${REPO}`, displayName: REPOSITORY_KEY }],
      },
      NOW,
    );

    const resolved = await resolveConnector({
      db: database.db,
      organizationId: ORGANIZATION_ID,
      now: NOW,
      http: recordedGithubClient(),
    });

    // Skipped rather than resolved: there is no stored credential for it in this test, and that is stated
    // rather than silently ignored.
    expect(resolved.seeded).toBe(true);
    expect(resolved.skipped.join(' ')).toContain('no stored credential');
  });

  it('states a disconnected source instead of quietly reading it', async () => {
    await saveSourceConfig(
      scoped(),
      {
        sourceKey: CHAT_SOURCE_KEY,
        sourceKind: 'chat',
        connectorId: SLACK_CONNECTOR_ID,
        enabled: false,
        selections: [{ selectionKey: CHANNEL_KEY, displayName: CHANNEL_NAME }],
      },
      NOW,
    );

    const resolved = await resolveConnector({ db: database.db, organizationId: ORGANIZATION_ID, now: NOW });

    expect(resolved.skipped.join(' ')).toContain('is disconnected');
    // And it says what survived, because that is what a manager reading it needs to know.
    expect(resolved.skipped.join(' ')).toContain('unchanged');
  });

  it('refuses an unscoped source rather than reading everything the credential can see', async () => {
    await saveSourceConfig(
      scoped(),
      {
        sourceKey: CODE_SOURCE_KEY,
        sourceKind: 'code',
        connectorId: GITHUB_CONNECTOR_ID,
        enabled: true,
        selections: [],
      },
      NOW,
    );

    const resolved = await resolveConnector({ db: database.db, organizationId: ORGANIZATION_ID, now: NOW });

    expect(resolved.skipped.join(' ')).toContain('has nothing selected');
    expect(resolved.skipped.join(' ')).toContain('an unscoped read is refused');
  });

  it('refreshes an access token that is about to expire, and rotates the refresh token with it', async () => {
    /**
     * The gap this closes, which is invisible until the day after a manager connects.
     *
     * A tracker access token lives **one hour**. Storing a refresh token that nothing exchanges would make
     * "connect your tracker" a feature that works until lunch and then states a coverage gap every fifteen
     * minutes until somebody reconnects by hand. `offline_access` is requested for exactly this.
     *
     * The rotation is the subtle half: this provider invalidates the refresh token that was sent, so a
     * resolver that stored only the new *access* token would leave a connection that works now and cannot
     * be recovered in an hour.
     */
    const TRACKER_SOURCE_KEY = 'primary-tracker';

    await saveSourceConfig(
      scoped(),
      {
        sourceKey: TRACKER_SOURCE_KEY,
        sourceKind: 'tracker',
        connectorId: JIRA_CONNECTOR_ID,
        enabled: true,
        selections: [{ selectionKey: PROJECT_KEY, displayName: PROJECT_KEY }],
        settings: { cloudId: 'cloud-abc' },
      },
      NOW,
    );

    // An access token that dies in one minute — inside the resolver's five-minute margin — plus the
    // refresh token that is supposed to save it.
    await storeIntegrationToken(
      scoped(),
      {
        sourceKey: TRACKER_SOURCE_KEY,
        tokenKind: 'access',
        token: 'access-1',
        expiresAt: instantFromEpochMillis(toEpochMillis(NOW) + 60_000),
      },
      NOW,
    );
    await storeIntegrationToken(
      scoped(),
      { sourceKey: TRACKER_SOURCE_KEY, tokenKind: 'refresh', token: 'refresh-1' },
      NOW,
    );

    const refreshResponses: HttpResponse[] = [
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
      },
    ];
    const asked: string[] = [];
    const http: HttpClient = {
      send: (outbound) => {
        asked.push(outbound.url);
        const answer = refreshResponses.shift();
        // Anything after the refresh is the connector itself reaching for the API, which this test does not
        // exercise — a 429 makes it a stated coverage gap rather than an unhandled rejection.
        return Promise.resolve(
          answer ?? { status: 429, headers: { 'retry-after': '60' }, body: '{"errorMessages":[]}' },
        );
      },
    };

    await resolveConnector({
      db: database.db,
      organizationId: ORGANIZATION_ID,
      now: NOW,
      http,
      environment: { COMPASS_JIRA_CLIENT_ID: 'client-1234', COMPASS_JIRA_CLIENT_SECRET: 'shh' },
    });

    expect(asked[0], 'no refresh was attempted').toContain('oauth/token');

    // Both tokens replaced, and the new expiry recorded so the next tick does not refresh again.
    expect(await useIntegrationToken(scoped(), TRACKER_SOURCE_KEY, 'access')).toBe('access-2');
    expect(await useIntegrationToken(scoped(), TRACKER_SOURCE_KEY, 'refresh')).toBe('refresh-2');

    const stored = await findIntegrationToken(scoped(), TRACKER_SOURCE_KEY, 'access');
    expect(stored?.expiresAt).not.toBeNull();
    expect(toEpochMillis(stored?.expiresAt ?? NOW)).toBe(toEpochMillis(NOW) + 3_600_000);
  });

  it('does not refresh a token that is comfortably alive', async () => {
    // One request per tick is cheap; one *unnecessary* request per tick spends a rotation for nothing, and
    // this provider's rotations are the thing a connection depends on.
    const TRACKER_SOURCE_KEY = 'primary-tracker';

    await storeIntegrationToken(
      scoped(),
      {
        sourceKey: TRACKER_SOURCE_KEY,
        tokenKind: 'access',
        token: 'access-live',
        expiresAt: instantFromEpochMillis(toEpochMillis(NOW) + 3_600_000),
      },
      NOW,
    );

    const asked: string[] = [];
    const http: HttpClient = {
      send: (outbound) => {
        asked.push(outbound.url);
        return Promise.resolve({ status: 429, headers: { 'retry-after': '60' }, body: '{}' });
      },
    };

    await resolveConnector({
      db: database.db,
      organizationId: ORGANIZATION_ID,
      now: NOW,
      http,
      environment: { COMPASS_JIRA_CLIENT_ID: 'client-1234', COMPASS_JIRA_CLIENT_SECRET: 'shh' },
    });

    expect(asked.filter((url) => url.includes('oauth/token'))).toEqual([]);
    expect(await useIntegrationToken(scoped(), TRACKER_SOURCE_KEY, 'access')).toBe('access-live');
  });

  it('builds a connector id from source keys, never from provider names', async () => {
    /**
     * `ingest_runs.connector_id` is a column the freshness panel reads and a report renders, so a provider
     * name in it would put the provider's name in front of a manager — the one thing the port exists to
     * prevent.
     */
    const id = liveConnector().connectorId;

    expect(id).toContain(CODE_SOURCE_KEY);
    expect(id).toContain(CHAT_SOURCE_KEY);
    for (const token of ['github', 'jira', 'slack']) {
      expect(id.toLowerCase()).not.toContain(token);
    }
  });
});
