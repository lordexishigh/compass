import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';

import { KnowledgeStore, type FieldSet } from '@compass/knowledge-model';

/**
 * A migrated PostgreSQL 17 with one organization and a store over it.
 *
 * Every knowledge-model test runs against the real engine. The invariants under
 * test are database-shaped — a natural-key uniqueness constraint, an append-only
 * trigger, a `timestamptz` round trip — and a mocked query builder would accept
 * all three violations without complaint.
 *
 * These tests deliberately name no connector: the knowledge model must be designed
 * against its own vocabulary of observations, not against the shape of whatever
 * provider happens to be feeding it. `tools/quality-gates` enforces that.
 */
export const TEST_ORGANIZATION_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
export const OTHER_ORGANIZATION_ID = '1b2c3d4e-5f6a-4b7c-8d9e-1f2a3b4c5d6e';
export const TEST_TIMEZONE = 'Europe/London';

export const at = (iso: string): Instant => instantFromIso(iso);

export const windowOf = (startIso: string, endIso: string): TimeWindow => timeWindow(at(startIso), at(endIso));

export interface StoreHarness {
  readonly database: TestDatabase;
  readonly store: KnowledgeStore;
  /** A second tenant, for proving isolation. */
  readonly otherStore: KnowledgeStore;
  close(): Promise<void>;
}

export async function createStoreHarness(): Promise<StoreHarness> {
  const database = await createMigratedTestDatabase({
    organizationId: TEST_ORGANIZATION_ID,
    name: 'Northwind Retail',
    slug: 'northwind-retail',
    timezone: TEST_TIMEZONE,
    at: new Date(Date.parse('2026-05-01T00:00:00Z')),
  });

  await database.seedOrganization({
    organizationId: OTHER_ORGANIZATION_ID,
    name: 'Beta Robotics',
    slug: 'beta-robotics',
    timezone: 'UTC',
    at: new Date(Date.parse('2026-05-01T00:00:00Z')),
  });

  return {
    database,
    store: new KnowledgeStore(database.scopedFor(TEST_ORGANIZATION_ID)),
    otherStore: new KnowledgeStore(database.scopedFor(OTHER_ORGANIZATION_ID)),
    close: () => database.close(),
  };
}

/**
 * The tracked fields of a ticket, so a test states only what it is varying.
 *
 * Returns the store's own `FieldSet`, not a looser `Record<string, unknown>`: a
 * helper that returns `unknown` values would make an override of the wrong type a
 * runtime surprise inside `observe()` rather than a compile error here.
 */
export function ticketFields(overrides: FieldSet = {}): FieldSet {
  return {
    projectKey: 'CHK',
    featureKey: null,
    itemKey: 'CHK-701',
    title: 'Guest checkout retries a declined card twice on slow networks',
    status: 'In Progress',
    statusCategory: 'in_progress',
    itemType: 'Bug',
    priority: 'High',
    estimatePoints: 5,
    labels: ['checkout', 'payments'],
    assigneeDeveloperKey: 'naomi-chen',
    reporterDeveloperKey: 'naomi-chen',
    sprintKey: 'primary-tracker:sprint-CHK-3',
    flaggedBlocked: false,
    createdAt: at('2026-07-28T09:00:00Z'),
    resolvedAt: null,
    ...overrides,
  };
}

/** The tracked fields of a sprint, so a scope-change test can vary only `startAt`. */
export function sprintFields(overrides: FieldSet = {}): FieldSet {
  return {
    projectKey: 'CHK',
    name: 'Sprint 17',
    goal: 'Cut guest-checkout abandonment',
    state: 'active',
    startAt: at('2026-07-27T09:00:00Z'),
    endAt: at('2026-08-10T09:00:00Z'),
    completedAt: null,
    committedItemKeys: ['CHK-701', 'CHK-703'],
    ...overrides,
  };
}

/** The tracked fields of a blocker — the entity every elapsed-fact test counts from. */
export function blockerFields(overrides: FieldSet = {}): FieldSet {
  return {
    subjectKind: 'ticket',
    subjectKey: 'CHK-701',
    teamKey: 'checkout',
    summary: 'CHK-701 is blocked: waiting on the payments sandbox',
    state: 'open',
    cause: 'tracker_flag',
    detectedAt: at('2026-07-24T08:15:00Z'),
    resolvedAt: null,
    evidence: [
      { kind: 'issue', label: 'CHK-701', sourceKey: 'primary-tracker', sourceRecordId: 'issue-CHK-701' },
    ],
    ...overrides,
  };
}
