import { ENTITY_KINDS } from '@compass/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  KnowledgeStore,
  SNAPSHOT_ORDERING,
  buildKnowledgeSnapshot,
  entitiesOfKind,
  entityByKey,
  isSealed,
  isSortedByStableKey,
  provisionRoster,
  snapshotJson,
  type KnowledgeSnapshot,
} from '@compass/knowledge-model';

import {
  TEST_ORGANIZATION_ID,
  TEST_TIMEZONE,
  at,
  blockerFields,
  createStoreHarness,
  sprintFields,
  ticketFields,
  windowOf,
  type StoreHarness,
} from './helpers/store.js';

/**
 * The materialized snapshot: the only thing the analysis core is ever shown.
 *
 * Three properties, all of them load-bearing. It is plain serializable data with
 * no handle, promise or Date inside. It is byte-identical when built twice for the
 * same (organization, team, instant). Every collection is sorted by a documented
 * key, so nothing depends on the order PostgreSQL felt like returning rows in.
 */
let harness: StoreHarness;
let snapshot: KnowledgeSnapshot;

const INSTANT = at('2026-07-31T08:00:00Z');
const WINDOW = windowOf('2026-07-30T00:00:00Z', '2026-07-31T00:00:00Z');

const buildInput = {
  scope: { kind: 'team', teamKey: 'checkout' },
  instant: INSTANT,
  timezone: TEST_TIMEZONE,
  window: WINDOW,
} as const;

beforeAll(async () => {
  harness = await createStoreHarness();

  await provisionRoster(harness.store, {
    company: { key: 'northwind', name: 'Northwind Retail', timezone: TEST_TIMEZONE },
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
        timezone: TEST_TIMEZONE,
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
    ],
    absences: [
      {
        developerKey: 'naomi-chen',
        kind: 'leave',
        startAt: at('2026-08-03T00:00:00Z'),
        endAt: at('2026-08-10T00:00:00Z'),
        note: null,
      },
    ],
    declaredAt: at('2026-07-01T09:00:00Z'),
  });

  // Deliberately inserted out of key order, so a snapshot that leaked row order
  // would come back in insertion order and fail the sort assertions.
  for (const itemKey of ['CHK-712', 'CHK-703', 'CHK-701']) {
    await harness.store.observe({
      kind: 'ticket',
      naturalKey: itemKey,
      fields: ticketFields({ itemKey, status: itemKey === 'CHK-701' ? 'Blocked' : 'In Progress' }),
      observedAt: at('2026-07-30T09:00:00Z'),
      evidence: null,
    });
    await harness.store.recordTicketTransition({
      ticketKey: itemKey,
      sourceKey: 'primary-tracker',
      sourceRecordId: `transition-${itemKey}-1`,
      fromStatus: 'To Do',
      toStatus: 'In Progress',
      fromStatusCategory: 'todo',
      toStatusCategory: 'in_progress',
      actorDeveloperKey: 'naomi-chen',
      transitionedAt: at('2026-07-29T09:00:00Z'),
    });
  }

  await harness.store.observe({
    kind: 'blocker',
    naturalKey: 'ticket:CHK-701:tracker_blocked',
    fields: blockerFields(),
    observedAt: at('2026-07-25T08:00:00Z'),
    evidence: null,
  });
  await harness.store.observe({
    kind: 'blocker',
    naturalKey: 'ticket:CHK-701:tracker_blocked',
    fields: blockerFields(),
    observedAt: at('2026-07-30T08:00:00Z'),
    evidence: null,
  });

  await harness.store.recordCorrection({
    subjectKind: 'ticket',
    subjectKey: 'CHK-701',
    priorVersion: 1,
    priorBelief: 'CHK-701 was flagged blocked by the tracker.',
    newBelief: 'CHK-701 merged in #9201.',
    contradiction: 'blocked_but_merged',
    evidence: { kind: 'pull_request', label: '#9201', sourceKey: 'primary-code', sourceRecordId: 'pull-request-9201' },
    observedAt: at('2026-07-30T18:40:00Z'),
    detectedAt: at('2026-07-31T06:00:00Z'),
  });

  snapshot = await buildKnowledgeSnapshot(harness.store, buildInput);
});

afterAll(async () => {
  await harness.close();
});

describe('the snapshot envelope', () => {
  it('carries the organization, the scope and the instant it represents', () => {
    expect(snapshot.organizationId).toBe(TEST_ORGANIZATION_ID);
    expect(snapshot.scope).toEqual({ kind: 'team', teamKey: 'checkout' });
    expect(snapshot.instant).toBe(INSTANT);
    expect(snapshot.window).toEqual(WINDOW);
  });

  it('is sealed: plain, frozen, serializable data', () => {
    expect(isSealed(snapshot)).toBe(true);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('holds no database handle, promise, Date, Map or class instance anywhere', () => {
    const offenders: string[] = [];

    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') {
        if (typeof value === 'function') offenders.push(`${path} is a function`);
        return;
      }
      if (value instanceof Date) offenders.push(`${path} is a Date`);
      if (value instanceof Promise) offenders.push(`${path} is a Promise`);
      if (value instanceof Map || value instanceof Set) offenders.push(`${path} is a Map or Set`);
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) offenders.push(`${path} is a class instance`);
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) walk(nested, `${path}.${key}`);
    };

    walk(snapshot, '$');
    expect(offenders).toEqual([]);
  });

  it('reaches every entity kind in the registry, so a new one cannot be silently omitted', () => {
    expect(snapshot.collections.entityCounts.map((entry) => entry.kind)).toEqual([...ENTITY_KINDS]);
  });
});

describe('building it twice', () => {
  it('produces byte-identical JSON for the same (organization, team, instant)', async () => {
    const again = await buildKnowledgeSnapshot(harness.store, buildInput);

    expect(snapshotJson(again)).toBe(snapshotJson(snapshot));
    expect(JSON.stringify(again)).toBe(JSON.stringify(snapshot));
  });

  it('produces identical JSON from a second store instance with a cold cache', async () => {
    // Proves the result comes from the database rather than from the read-through
    // cache the first store warmed up while writing the fixtures.
    const cold = await buildKnowledgeSnapshot(new KnowledgeStore(harness.store.scoped), buildInput);

    expect(snapshotJson(cold)).toBe(snapshotJson(snapshot));
  });

  it('differs for a different instant, because the elapsed facts genuinely differ', async () => {
    const tomorrow = await buildKnowledgeSnapshot(harness.store, {
      ...buildInput,
      instant: at('2026-08-01T08:00:00Z'),
    });

    expect(snapshotJson(tomorrow)).not.toBe(snapshotJson(snapshot));
    expect(entityByKey(tomorrow, 'blocker', 'ticket:CHK-701:tracker_blocked')?.elapsed.ageDays).toBe(
      (entityByKey(snapshot, 'blocker', 'ticket:CHK-701:tracker_blocked')?.elapsed.ageDays ?? 0) + 1,
    );
  });
});

describe('ordering', () => {
  it('documents a stable key for every collection it carries', () => {
    const documented = Object.keys(SNAPSHOT_ORDERING);

    for (const collection of Object.keys(snapshot.collections)) {
      if (collection === 'entityCounts') continue; // registry order, stated below
      expect(documented, `${collection} has no documented sort key`).toContain(collection);
    }
  });

  it('sorts entities by kind then natural key', () => {
    expect(
      isSortedByStableKey(snapshot.collections.entities, (entity) => `${entity.kind} ${entity.naturalKey}`),
    ).toBe(true);
    expect(entitiesOfKind(snapshot, 'ticket').map((ticket) => ticket.naturalKey)).toEqual([
      'CHK-701',
      'CHK-703',
      'CHK-712',
    ]);
  });

  it('sorts versions by entity then version, and transitions by ticket then instant', () => {
    expect(
      isSortedByStableKey(
        snapshot.collections.entityVersions,
        (version) =>
          `${version.entityKind} ${version.entityNaturalKey} ${String(version.version).padStart(6, '0')}`,
      ),
    ).toBe(true);
    expect(
      isSortedByStableKey(
        snapshot.collections.ticketTransitions,
        (transition) => `${transition.ticketKey} ${String(transition.transitionedAt).padStart(16, '0')}`,
      ),
    ).toBe(true);
  });

  it('keeps entity counts in the registry order, not alphabetically by count', () => {
    expect(snapshot.collections.entityCounts.map((entry) => entry.kind)).toEqual([...ENTITY_KINDS]);
    const tickets = snapshot.collections.entityCounts.find((entry) => entry.kind === 'ticket');
    expect(tickets?.count).toBe(3);
  });
});

/**
 * `afterSprintStart` is derived at snapshot time rather than stored, because
 * `sprint_scope_changes` is append-only and a derivation frozen into an
 * append-only row could never be corrected. These are the three cases that
 * justify the choice.
 */
describe('sprint scope changes, and the flag that is computed rather than stored', () => {
  let scoped: KnowledgeSnapshot;

  beforeAll(async () => {
    await harness.store.observe({
      kind: 'sprint',
      naturalKey: 'primary-tracker:sprint-CHK-3',
      fields: sprintFields({ startAt: at('2026-07-27T09:00:00Z') }),
      observedAt: at('2026-07-27T09:00:00Z'),
      evidence: null,
    });

    // Planned in before the sprint opened.
    await harness.store.recordSprintScopeChange({
      sprintKey: 'primary-tracker:sprint-CHK-3',
      ticketKey: 'CHK-701',
      sourceKey: 'primary-tracker',
      sourceRecordId: 'scope-planned-1',
      change: 'added',
      actorDeveloperKey: null,
      changedAt: at('2026-07-26T10:00:00Z'),
    });
    // Pulled in eight days after it opened: scope creep.
    await harness.store.recordSprintScopeChange({
      sprintKey: 'primary-tracker:sprint-CHK-3',
      ticketKey: 'CHK-712',
      sourceKey: 'primary-tracker',
      sourceRecordId: 'scope-late-1',
      change: 'added',
      actorDeveloperKey: null,
      changedAt: at('2026-07-29T10:00:00Z'),
    });
    // A backfill that reached the scope change before it reached the sprint. This
    // is the case a stored column would have frozen wrongly and forever.
    await harness.store.recordSprintScopeChange({
      sprintKey: 'primary-tracker:sprint-NOT-YET-SEEN',
      ticketKey: 'CHK-900',
      sourceKey: 'primary-tracker',
      sourceRecordId: 'scope-orphan-1',
      change: 'added',
      actorDeveloperKey: null,
      changedAt: at('2026-07-29T11:00:00Z'),
    });

    harness.store.forget();
    scoped = await buildKnowledgeSnapshot(harness.store, buildInput);
  });

  const changeFor = (sourceRecordId: string) =>
    scoped.collections.sprintScopeChanges.find((change) => change.sourceRecordId === sourceRecordId);

  it('marks a change that landed after the sprint opened', () => {
    expect(changeFor('scope-late-1')?.afterSprintStart).toBe(true);
  });

  it('does not mark a change that was planned in before the sprint opened', () => {
    expect(changeFor('scope-planned-1')?.afterSprintStart).toBe(false);
  });

  it('claims nothing when the sprint itself has not been observed yet', () => {
    // No evidence the change was late, so Compass does not assert that it was.
    expect(changeFor('scope-orphan-1')?.afterSprintStart).toBe(false);
  });

  it('stores no such column, so the derivation can never be frozen wrong', async () => {
    const columns = await harness.database.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'sprint_scope_changes'`,
    );

    expect(columns.rows.map((row) => row.column_name)).not.toContain('after_sprint_start');
  });

  it('still sorts by sprint, then instant, then source record id', () => {
    expect(
      isSortedByStableKey(
        scoped.collections.sprintScopeChanges,
        (change) => `${change.sprintKey} ${String(change.changedAt).padStart(16, '0')} ${change.sourceRecordId}`,
      ),
    ).toBe(true);
  });
});

describe('what the analysis layer needs', () => {
  it('carries the declared roster: company, objectives, teams, developers, absences', () => {
    expect(entitiesOfKind(snapshot, 'company')).toHaveLength(1);
    expect(entitiesOfKind(snapshot, 'objective')[0]?.fields['isCurrent']).toBe(true);
    expect(entitiesOfKind(snapshot, 'team')[0]?.fields['name']).toBe('Checkout');
    expect(entitiesOfKind(snapshot, 'developer')[0]?.fields['displayName']).toBe('Naomi Chen');
    expect(entitiesOfKind(snapshot, 'absence')).toHaveLength(1);
  });

  it('carries the memo and feedback collections, empty and read from their real tables', () => {
    expect(entitiesOfKind(snapshot, 'manager_memo')).toEqual([]);
    expect(entitiesOfKind(snapshot, 'feedback')).toEqual([]);
    expect(snapshot.collections.entityCounts.find((entry) => entry.kind === 'manager_memo')?.count).toBe(0);
  });

  it('carries history and corrections, not just current state', () => {
    expect(snapshot.collections.entityVersions.length).toBeGreaterThan(0);
    expect(snapshot.collections.ticketTransitions).toHaveLength(3);
    expect(snapshot.collections.corrections).toHaveLength(1);
    expect(snapshot.collections.corrections[0]?.newBelief).toContain('#9201');
  });

  it('precomputes the elapsed facts every recurring item is rendered from', () => {
    const blocker = entityByKey(snapshot, 'blocker', 'ticket:CHK-701:tracker_blocked');

    expect(blocker?.elapsed.ageDays).toBe(6);
    expect(blocker?.elapsed.trail).toHaveLength(14);
    expect(blocker?.elapsed.staleDays).toBe(1);
  });
});
