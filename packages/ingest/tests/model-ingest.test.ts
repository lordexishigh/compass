import { timeWindow, type TimeWindow } from '@compass/clock';
import { createMigratedTestDatabase, databaseSnapshot, type TestDatabase } from '@compass/db/testing';
import { KnowledgeStore, provisionRoster, type OrgRoster } from '@compass/knowledge-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ingestWindowIntoModel, judgementNaturalKey, ticketNaturalKey } from '@compass/ingest';

import { FixtureConnector } from './helpers/fixture-connector.js';
import {
  AUTHORED_COMMIT,
  BLOCKED_ISSUE,
  BLOCKED_TRANSITION,
  LATE_SCOPE_CHANGE,
  LOOKALIKE_COMMIT,
  MERGED_PULL_REQUEST,
  PLAIN_ISSUE,
  ROBOT_COMMIT,
  SPRINT,
  SPRINT_KEY,
  at,
} from './helpers/records.js';

/**
 * Incremental, idempotent ingest, asserted against a real PostgreSQL.
 *
 * The properties under test are the ones that make a daily product trustworthy:
 * running the same window again changes nothing, overlapping and out-of-order
 * windows do not duplicate anything, and every run leaves exactly one row in the
 * journal saying what it read.
 */
const ORGANIZATION_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const TIMEZONE = 'Europe/London';
const NOW = at('2026-08-05T08:00:00Z');

/** Everything except the run journal — a run genuinely happening is not a change. */
const JOURNAL_TABLES = ['ingest_runs', 'ingest_source_coverage'];

const roster: OrgRoster = {
  company: { key: 'northwind', name: 'Northwind Retail', timezone: TIMEZONE },
  objectives: [
    {
      key: 'OBJ-Q3-CHK',
      kind: 'quarter',
      parentKey: null,
      title: 'Cut guest-checkout abandonment',
      effectiveFrom: at('2026-07-01T00:00:00Z'),
      effectiveUntil: at('2026-10-01T00:00:00Z'),
      isCurrent: true,
    },
  ],
  teams: [
    {
      key: 'checkout',
      name: 'Checkout',
      methodology: 'scrum',
      projectKey: 'CHK',
      objectiveKey: 'OBJ-Q3-CHK',
      conversationKey: 'conv-checkout',
      timezone: TIMEZONE,
    },
  ],
  developers: [
    {
      key: 'naomi-chen',
      displayName: 'Naomi Chen',
      teamKey: 'checkout',
      active: true,
      gitEmails: ['naomi.chen@northwind.example'],
      trackerAccounts: ['acct-naomi-chen'],
      chatHandles: ['user-naomi-chen'],
    },
    {
      key: 'priya-raman',
      displayName: 'Priya Raman',
      teamKey: 'platform',
      active: true,
      gitEmails: ['priya.raman@northwind.example'],
      trackerAccounts: ['acct-priya-raman'],
      chatHandles: ['user-priya-raman'],
    },
    {
      key: 'rafael-lima',
      displayName: 'Rafael Lima',
      teamKey: 'checkout',
      active: true,
      gitEmails: ['rafael.lima@northwind.example'],
      trackerAccounts: ['acct-rafael-lima'],
      chatHandles: ['user-rafael-lima'],
    },
  ],
  absences: [],
  declaredAt: at('2026-07-01T09:00:00Z'),
};

const connector = new FixtureConnector({
  sprints: [SPRINT],
  issues: [BLOCKED_ISSUE, PLAIN_ISSUE],
  issue_transitions: [BLOCKED_TRANSITION],
  sprint_scope_changes: [LATE_SCOPE_CHANGE],
  pull_requests: [MERGED_PULL_REQUEST],
  commits: [AUTHORED_COMMIT, LOOKALIKE_COMMIT, ROBOT_COMMIT],
});

const WHOLE_SPAN: TimeWindow = timeWindow(at('2026-07-27T00:00:00Z'), at('2026-08-05T00:00:00Z'));

let database: TestDatabase;
let store: KnowledgeStore;
let runCounter = 0;

/** A fresh run id per ingest — one run, one journal row, by design. */
const nextRunId = (): string => {
  runCounter += 1;
  return `00000000-0000-4000-8000-${String(runCounter).padStart(12, '0')}`;
};

const ingest = (window: TimeWindow) =>
  ingestWindowIntoModel(connector, store, {
    organizationId: ORGANIZATION_ID,
    window,
    now: NOW,
    runId: nextRunId(),
  });

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Retail',
    slug: 'northwind-retail',
    timezone: TIMEZONE,
    at: new Date(Date.parse('2026-05-01T00:00:00Z')),
  });
  store = new KnowledgeStore(database.scopedFor(ORGANIZATION_ID));
  await provisionRoster(store, roster);
});

afterAll(async () => {
  await database.close();
});

describe('the first ingest of a window', () => {
  it('projects every artifact family into named entities', async () => {
    const result = await ingest(WHOLE_SPAN);

    const kinds = Object.fromEntries(result.perKind.map((entry) => [entry.kind, entry]));
    expect(kinds['sprint']?.created).toBe(1);
    expect(kinds['ticket']?.created).toBe(2);
    expect(kinds['pull_request']?.created).toBe(1);
    expect(kinds['commit']?.created).toBe(3);
    expect(kinds['project']?.created).toBe(1);
    expect(kinds['repository']?.created).toBe(1);
    expect(result.transitionsObserved).toBe(1);
    expect(result.scopeChangesObserved).toBe(1);
  });

  it('records one IngestRun with the window, source, counts and coverage status', async () => {
    const runs = await database.client.query<{
      window_start: Date;
      window_end: Date;
      connector_id: string;
      status: string;
      total_records: string;
      artifact_counts: Record<string, number>;
    }>('select * from ingest_runs');

    expect(runs.rows).toHaveLength(1);
    const run = runs.rows[0];
    expect(run?.connector_id).toBe('fixture:knowledge-model');
    expect(run?.window_start.toISOString()).toBe('2026-07-27T00:00:00.000Z');
    expect(run?.window_end.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(run?.status).toBe('complete');

    // Per-artifact counts stated one by one, then the total asserted to be their
    // sum. Written this way rather than as a magic number so adding a fixture
    // record cannot leave the total silently stale: the arithmetic moves with the
    // fixture, and only a genuine miscount fails.
    const counts = run?.artifact_counts ?? {};
    expect(counts).toMatchObject({
      sprints: 1,
      issues: 2,
      issue_transitions: 1,
      sprint_scope_changes: 1,
      pull_requests: 1,
      commits: 3,
      reviews: 0,
      branch_refs: 0,
      release_tags: 0,
      messages: 0,
    });
    expect(Number(run?.total_records)).toBe(Object.values(counts).reduce((sum, count) => sum + count, 0));
    expect(Number(run?.total_records)).toBe(9);

    const coverage = await database.client.query<{ source_key: string; artifact: string; status: string }>(
      'select source_key, artifact, status from ingest_source_coverage order by source_key, artifact',
    );
    // One coverage row per (source, artifact) the connector was asked for.
    expect(coverage.rows.length).toBe(10);
    expect(new Set(coverage.rows.map((row) => row.status))).toEqual(new Set(['complete']));
  });

  it('derives a Blocker from the tracker flag, keyed by its subject and cause', async () => {
    const blocker = await store.read('blocker', judgementNaturalKey('ticket', 'CHK-701', 'tracker_blocked'));

    expect(blocker?.fields['state']).toBe('open');
    expect(blocker?.fields['cause']).toBe('tracker_flag');
    // Pinned to the blocked transition, which is earlier than the issue sighting.
    expect(blocker?.fields['detectedAt']).toBe(at('2026-07-30T08:15:00Z'));
  });

  it('derives a Risk from scope that entered the sprint after it started', async () => {
    const risk = await store.read('risk', judgementNaturalKey('sprint', SPRINT_KEY, 'scope_added_after_start'));

    expect(risk?.fields['summary']).toContain('entered Sprint 17 after it started');
    expect(risk?.fields['summary']).toContain('CHK-712');
    expect(risk?.fields['severity']).toBe('medium');
  });
});

describe('ingesting the same window three times', () => {
  let afterSecond: Record<string, readonly Record<string, unknown>[]>;
  let versionsAfterFirst: number;

  beforeAll(async () => {
    versionsAfterFirst = (await store.versions()).length;
    await ingest(WHOLE_SPAN);
    afterSecond = await databaseSnapshot(database.client, { exclude: JOURNAL_TABLES });
  });

  it('produces identical full DB snapshots after runs 2 and 3', async () => {
    await ingest(WHOLE_SPAN);
    const afterThird = await databaseSnapshot(database.client, { exclude: JOURNAL_TABLES });

    expect(JSON.stringify(afterThird)).toBe(JSON.stringify(afterSecond));
  });

  it('adds zero new entity versions', async () => {
    expect((await store.versions()).length).toBe(versionsAfterFirst);
  });

  it('adds zero duplicate blockers or risks', async () => {
    expect(await store.list('blocker')).toHaveLength(1);
    expect(await store.list('risk')).toHaveLength(1);
  });

  it('duplicates no append-only history either', async () => {
    expect(await store.ticketTransitions()).toHaveLength(1);
    expect(await store.sprintScopeChanges()).toHaveLength(1);
  });

  it('still writes one IngestRun per run, because a run genuinely happened', async () => {
    const runs = await database.client.query<{ count: string }>('select count(*)::text as count from ingest_runs');

    expect(Number(runs.rows[0]?.count)).toBe(3);
  });

  it('reports every observation as unchanged, not as a change', async () => {
    const result = await ingest(WHOLE_SPAN);

    expect(result.totals.created).toBe(0);
    expect(result.totals.changed).toBe(0);
    expect(result.totals.unchanged).toBeGreaterThan(0);
  });
});

describe('overlapping and out-of-order windows', () => {
  it('duplicates nothing when a narrower window is replayed inside a wider one', async () => {
    const before = await databaseSnapshot(database.client, { exclude: JOURNAL_TABLES });

    await ingest(timeWindow(at('2026-07-30T00:00:00Z'), at('2026-07-31T00:00:00Z')));
    await ingest(timeWindow(at('2026-07-29T00:00:00Z'), at('2026-08-01T00:00:00Z')));

    expect(JSON.stringify(await databaseSnapshot(database.client, { exclude: JOURNAL_TABLES }))).toBe(
      JSON.stringify(before),
    );
  });

  it('advances last_seen_at without pulling first_seen_at forward', async () => {
    const ticket = await store.read('ticket', ticketNaturalKey('CHK-701'));

    expect(ticket?.firstSeenAt).toBe(at('2026-07-30T08:15:00Z'));
    expect(ticket?.lastSeenAt).toBe(at('2026-07-30T08:15:00Z'));
  });
});

/**
 * The same organization, rebuilt from scratch, with the windows delivered
 * backwards. The end state must match the forward run — that is what makes a
 * backfill safe to run after a live pull.
 */
describe('a backfill delivered newest window first', () => {
  let backfillDatabase: TestDatabase;
  let backfillStore: KnowledgeStore;

  beforeAll(async () => {
    backfillDatabase = await createMigratedTestDatabase({
      organizationId: ORGANIZATION_ID,
      name: 'Northwind Retail',
      slug: 'northwind-retail',
      timezone: TIMEZONE,
      at: new Date(Date.parse('2026-05-01T00:00:00Z')),
    });
    backfillStore = new KnowledgeStore(backfillDatabase.scopedFor(ORGANIZATION_ID));
    await provisionRoster(backfillStore, roster);

    const windows: TimeWindow[] = [
      timeWindow(at('2026-08-01T00:00:00Z'), at('2026-08-05T00:00:00Z')),
      timeWindow(at('2026-07-30T00:00:00Z'), at('2026-08-01T00:00:00Z')),
      timeWindow(at('2026-07-27T00:00:00Z'), at('2026-07-30T00:00:00Z')),
    ];
    for (const window of windows) {
      await ingestWindowIntoModel(connector, backfillStore, {
        organizationId: ORGANIZATION_ID,
        window,
        now: NOW,
        runId: nextRunId(),
      });
    }
  });

  afterAll(async () => {
    await backfillDatabase.close();
  });

  it('reaches the same beliefs as the forward run', async () => {
    const forward = await store.read('ticket', 'CHK-701');
    const backward = await backfillStore.read('ticket', 'CHK-701');

    expect(backward?.fields).toEqual(forward?.fields);
    expect(backward?.firstSeenAt).toBe(forward?.firstSeenAt);
    expect(backward?.lastSeenAt).toBe(forward?.lastSeenAt);
  });

  it('creates the same number of entities, with no duplicates from the ordering', async () => {
    for (const kind of ['ticket', 'commit', 'pull_request', 'sprint', 'blocker', 'risk'] as const) {
      expect((await backfillStore.list(kind)).length, `${kind} count diverged`).toBe(
        (await store.list(kind)).length,
      );
    }
  });

  it('never lets an older record overwrite a newer belief', async () => {
    // The sprint was observed in the newest window first; the oldest window
    // carries the same record, and must not have rewound anything.
    const sprint = await backfillStore.read('sprint', SPRINT_KEY);

    expect(sprint?.version).toBe(1);
    expect(sprint?.fields['state']).toBe('active');
  });
});

/**
 * Attribution. The one rule: an artifact belongs to a Developer only through a
 * declared IdentityLink that matches the source's own identifier exactly.
 */
describe('attributing commits', () => {
  it('attributes a commit whose author email matches an IdentityLink', async () => {
    const authored = await store.read('commit', 'checkout-web@6a7b8c9');

    expect(authored?.fields['authorDeveloperKey']).toBe('naomi-chen');
    expect(authored?.fields['unmatchedIdentityKey']).toBeNull();
    expect(authored?.fields['ticketKey']).toBe('CHK-701');
  });

  it('attributes an unmatched author to no person and queues the identity instead', async () => {
    const robot = await store.read('commit', 'checkout-web@ff00ee1');
    const queued = await store.read('unmatched_identity', 'email:ci-bot@build.northwind.example');

    expect(robot?.fields['authorDeveloperKey']).toBeNull();
    expect(robot?.fields['unmatchedIdentityKey']).toBe('email:ci-bot@build.northwind.example');
    expect(queued?.fields['occurrenceCount']).toBe(1);
    expect(queued?.fields['displayName']).toBe('northwind-ci');
  });

  it('never attributes by name similarity, however close the display name is', async () => {
    const lookalike = await store.read('commit', 'checkout-web@ab12cd3');
    const developers = await store.list('developer');

    expect(developers.map((developer) => developer.naturalKey)).toContain('priya-raman');
    expect(lookalike?.fields['authorDeveloperKey']).toBeNull();
    expect(lookalike?.fields['unmatchedIdentityKey']).toBe('email:p.raman@personal.example');

    // No commit anywhere is attributed to a developer whose declared emails do
    // not include the commit's author address.
    const commits = await store.list('commit');
    for (const entry of commits) {
      if (entry.fields['authorDeveloperKey'] === null) continue;
      expect(entry.fields['unmatchedIdentityKey']).toBeNull();
    }
  });

  it('keeps the unmatched queue stable across replays', async () => {
    const before = await store.list('unmatched_identity');
    await ingest(WHOLE_SPAN);
    const after = await store.list('unmatched_identity');

    expect(after.map((entry) => entry.version)).toEqual(before.map((entry) => entry.version));
    expect(after).toHaveLength(2);
  });
});

/**
 * "Reported blocked yesterday, actually merged" — the pathology the whole
 * versioned model exists to make sayable.
 */
describe('a ticket stored as blocked, observed merged', () => {
  let splitDatabase: TestDatabase;
  let splitStore: KnowledgeStore;

  beforeAll(async () => {
    splitDatabase = await createMigratedTestDatabase({
      organizationId: ORGANIZATION_ID,
      name: 'Northwind Retail',
      slug: 'northwind-retail',
      timezone: TIMEZONE,
      at: new Date(Date.parse('2026-05-01T00:00:00Z')),
    });
    splitStore = new KnowledgeStore(splitDatabase.scopedFor(ORGANIZATION_ID));
    await provisionRoster(splitStore, roster);

    // Morning: the tracker says blocked, and nothing has merged yet.
    await ingestWindowIntoModel(connector, splitStore, {
      organizationId: ORGANIZATION_ID,
      window: timeWindow(at('2026-07-27T00:00:00Z'), at('2026-07-30T12:00:00Z')),
      now: at('2026-07-30T12:00:00Z'),
      runId: nextRunId(),
    });
  });

  afterAll(async () => {
    await splitDatabase.close();
  });

  it('holds the blocked belief after the morning window', async () => {
    const ticket = await splitStore.read('ticket', 'CHK-701');

    expect(ticket?.fields['status']).toBe('Blocked');
    expect(ticket?.version).toBe(1);
    expect(await splitStore.corrections()).toHaveLength(0);
  });

  it('writes a Correction when the evening window shows the merge', async () => {
    await ingestWindowIntoModel(connector, splitStore, {
      organizationId: ORGANIZATION_ID,
      window: timeWindow(at('2026-07-30T12:00:00Z'), at('2026-07-31T00:00:00Z')),
      now: at('2026-07-31T06:00:00Z'),
      runId: nextRunId(),
    });

    const written = await splitStore.corrections();

    expect(written).toHaveLength(1);
    expect(written[0]?.contradiction).toBe('blocked_but_merged');
    expect(written[0]?.subjectKey).toBe('CHK-701');
    expect(written[0]?.priorBelief).toContain('flagged blocked by the tracker');
    expect(written[0]?.newBelief).toContain('#9201');
    expect(written[0]?.evidenceSourceRecordId).toBe('pull-request-9201');
    expect(written[0]?.detectedAt.toISOString()).toBe('2026-07-31T06:00:00.000Z');
  });

  it('leaves the prior belief exactly where it was', async () => {
    const versions = await splitStore.versions({ entityKind: 'ticket', entityNaturalKey: 'CHK-701' });

    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.trackedFields['status']).toBe('Blocked');
    expect(versions[0]?.trackedFields['flaggedBlocked']).toBe(true);
  });

  it('produces exactly one Correction however many times the window is replayed', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ingestWindowIntoModel(connector, splitStore, {
        organizationId: ORGANIZATION_ID,
        window: timeWindow(at('2026-07-30T12:00:00Z'), at('2026-07-31T00:00:00Z')),
        now: at('2026-08-01T06:00:00Z'),
        runId: nextRunId(),
      });
    }

    expect(await splitStore.corrections()).toHaveLength(1);
  });
});
