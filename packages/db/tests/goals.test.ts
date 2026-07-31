import { instantFromIso } from '@compass/clock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AppendOnlyTableError,
  GoalNodeExistsError,
  GoalNodeNotFoundError,
  ScopedDb,
  appendGoalRevision,
  appendGoalScopeLink,
  archiveGoalNode,
  findObjectiveLinksForSubject,
  listObjectiveLinks,
  loadGoalNodeHistory,
  loadGoalStore,
  objectiveVersions,
  orgScope,
  organizations,
  recordObjectiveLinks,
  scopeLinkKey,
  syncGoalNodes,
  type GoalNodeInput,
} from '@compass/db';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

/**
 * The goal store, against a real engine.
 *
 * The acceptance criterion is a *storage* claim — "an edit creates a new
 * effective-dated version and does not mutate the prior row" — so it is asserted
 * here rather than only in the pure layer: the append-only trigger, the uniqueness
 * constraint and the derived-not-stored belief window are all properties of the
 * database, and a test that only exercised the repository functions would pass on a
 * schema that permitted an UPDATE.
 *
 * The rule these tests enforce is documented in `docs/ARCHITECTURE.md` under
 * "Effective dating and the freeze rule", and the *reading* half of it —
 * `goalHierarchyAt` — is unit-tested in
 * `packages/analysis/tests/goal-hierarchy.test.ts`.
 */
const ORG = '88888888-8888-4888-8888-888888888888';

const at = (iso: string) => instantFromIso(iso);
const JULY = at('2026-07-01T00:00:00Z');
const AUGUST = at('2026-08-01T00:00:00Z');
const SEPTEMBER = at('2026-09-01T00:00:00Z');

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORG));

const quarter = (overrides: Partial<GoalNodeInput> = {}): GoalNodeInput => ({
  nodeId: 'OBJ-Q3-PLAT',
  objectiveKind: 'quarter',
  parentNodeId: 'OBJ-CO-1',
  title: 'Cut p95 payment gateway latency below 400 ms',
  effectiveFrom: JULY,
  effectiveUntil: at('2026-09-30T00:00:00Z'),
  isCurrent: true,
  origin: 'declared',
  ...overrides,
});

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  await database.db
    .insert(organizations)
    .values({
      id: ORG,
      organizationId: ORG,
      name: 'Goal Store',
      slug: 'goal-store',
      timezone: 'Europe/London',
      createdAt: new Date(Date.parse('2026-07-01T00:00:00Z')),
      updatedAt: new Date(Date.parse('2026-07-01T00:00:00Z')),
    })
    .onConflictDoNothing()
    .execute();
}, 120_000);

afterAll(async () => {
  await database.close();
});

describe('creating and editing an objective', () => {
  it('records revision 1 on create and refuses a second create of the same node', async () => {
    const created = await appendGoalRevision(scoped(), quarter(), JULY, false);

    expect(created.revision).toBe(1);
    expect(created.appended).toBe(true);
    await expect(appendGoalRevision(scoped(), quarter(), AUGUST, false)).rejects.toThrow(GoalNodeExistsError);
  });

  it('refuses an update of a node that does not exist rather than inventing it', async () => {
    await expect(
      appendGoalRevision(scoped(), quarter({ nodeId: 'OBJ-NOPE' }), AUGUST, true),
    ).rejects.toThrow(GoalNodeNotFoundError);
  });

  it('appends a new version on edit and leaves the prior row byte-identical', async () => {
    const before = await loadGoalNodeHistory(scoped(), 'OBJ-Q3-PLAT');
    const beforeJson = JSON.stringify(before);

    const edited = await appendGoalRevision(
      scoped(),
      quarter({ title: 'Cut p95 payment gateway latency below 250 ms', changeNote: 'Tightened after the July review.' }),
      AUGUST,
      true,
    );

    const after = await loadGoalNodeHistory(scoped(), 'OBJ-Q3-PLAT');

    expect(edited.revision).toBe(2);
    expect(after).toHaveLength(2);
    // The acceptance criterion, literally: the prior row is untouched.
    expect(JSON.stringify(after.slice(0, before.length))).toBe(beforeJson);
    expect(after[0]?.title).toBe('Cut p95 payment gateway latency below 400 ms');
    expect(after[1]?.title).toBe('Cut p95 payment gateway latency below 250 ms');
    expect(after[1]?.recordedAt).toBe(AUGUST);
    expect(after[1]?.changeNote).toBe('Tightened after the July review.');
  });

  it('appends nothing when the content has not moved, so a re-sync does not grow the store', async () => {
    const before = await loadGoalNodeHistory(scoped(), 'OBJ-Q3-PLAT');
    const result = await appendGoalRevision(
      scoped(),
      quarter({ title: 'Cut p95 payment gateway latency below 250 ms' }),
      SEPTEMBER,
      true,
    );

    expect(result.appended).toBe(false);
    expect(await loadGoalNodeHistory(scoped(), 'OBJ-Q3-PLAT')).toHaveLength(before.length);
  });

  it('archives by appending, and an archived goal is never still current', async () => {
    const archived = await archiveGoalNode(scoped(), 'OBJ-Q3-PLAT', SEPTEMBER, {
      recordedBy: 'priya@example.com',
      changeNote: 'Superseded by the Q4 plan.',
    });
    const history = await loadGoalNodeHistory(scoped(), 'OBJ-Q3-PLAT');

    expect(archived.revision).toBe(3);
    expect(history).toHaveLength(3);
    expect(history[2]?.archived).toBe(true);
    expect(history[2]?.isCurrent).toBe(false);
    // The wording survives the archive, so a report generated for August still
    // resolves the chain and prints what was in force then.
    expect(history[2]?.title).toBe('Cut p95 payment gateway latency below 250 ms');
    expect(history[0]?.archived).toBe(false);
  });

  it('refuses an UPDATE or a DELETE on the store, in the database itself', async () => {
    // Sealing `effective_until` on a superseded row is the tempting mutation, and
    // it is exactly what this refuses. The belief window's end is derived instead.
    await expect(
      database.client.query(`update "objective_versions" set title = 'rewritten'`),
    ).rejects.toThrow(/append-only/i);
    await expect(database.client.query('delete from "objective_versions"')).rejects.toThrow(/append-only/i);
    expect(() => scoped().updateIn(objectiveVersions, { title: 'rewritten' })).toThrow(AppendOnlyTableError);
  });
});

describe('a sync never overwrites what a manager wrote', () => {
  it('skips a declared node and appends an undeclared one', async () => {
    const declared = quarter({ nodeId: 'OBJ-Q3-CHK', title: 'Ship guest checkout to every merchant' });
    await appendGoalRevision(scoped(), declared, JULY, false);

    const result = await syncGoalNodes(
      scoped(),
      [
        // The tracker's own wording, which the manager has already overridden.
        { ...declared, title: 'Guest checkout, per the tracker', origin: 'observed' },
        {
          ...quarter({ nodeId: 'PLAT/Sprint 46', objectiveKind: 'sprint_goal', parentNodeId: 'OBJ-Q3-PLAT' }),
          origin: 'observed',
          subjectKind: 'sprint',
          subjectKey: 'primary-tracker:sprint-PLAT-6',
        },
      ],
      AUGUST,
    );

    expect(result.skipped).toBe(1);
    expect(result.appended).toBe(1);
    const history = await loadGoalNodeHistory(scoped(), 'OBJ-Q3-CHK');
    expect(history).toHaveLength(1);
    expect(history[0]?.title).toBe('Ship guest checkout to every merchant');
  });

  it('reads back every revision, so the pure layer can pick the one in force', async () => {
    const store = await loadGoalStore(scoped());

    // Ordered by (node, revision) — never by insertion order, which PostgreSQL has
    // never promised.
    const keys = store.nodes.map((node) => `${node.nodeId}@${node.revision}`);
    expect(keys).toEqual([...keys].sort());
    expect(store.nodes.filter((node) => node.nodeId === 'OBJ-Q3-PLAT')).toHaveLength(3);
  });
});

describe('attaching a ticket to a goal', () => {
  it('revisions the attachment, and a detach appends rather than deletes', async () => {
    const input = {
      nodeId: 'OBJ-Q3-PLAT',
      subjectKind: 'ticket',
      subjectKey: 'PLAT-742',
      effectiveFrom: JULY,
    };

    const attached = await appendGoalScopeLink(scoped(), input, JULY);
    const detached = await appendGoalScopeLink(scoped(), { ...input, detached: true }, AUGUST);

    expect(attached.linkKey).toBe(scopeLinkKey('OBJ-Q3-PLAT', 'ticket', 'PLAT-742'));
    expect(attached.revision).toBe(1);
    expect(detached.revision).toBe(2);

    const store = await loadGoalStore(scoped());
    const revisions = store.links.filter((link) => link.linkKey === attached.linkKey);
    expect(revisions.map((link) => link.detached)).toEqual([false, true]);
  });
});

describe('the ObjectiveLink audit trail', () => {
  const INSTANT = at('2026-07-31T09:00:00.000Z');

  it('writes one row per resolved subject and reads them back in subject order', async () => {
    const written = await recordObjectiveLinks(
      scoped(),
      INSTANT,
      [
        {
          subjectKind: 'commit',
          subjectKey: 'platform-api@4f5a6b7',
          subjectLabel: '4f5a6b7',
          source: 'configured',
          nodeId: 'PLAT/Sprint 46',
          nodeRevision: 1,
          chainNodeIds: ['PLAT/Sprint 46', 'OBJ-Q3-PLAT', 'OBJ-CO-1'],
          matchedSubstring: 'PLAT-742',
          matchedOffset: 0,
          matchedIn: 'commit_message',
          score: null,
          threshold: null,
          comparedTextA: null,
          comparedTextB: null,
          servesCurrentObjective: true,
        },
        {
          subjectKind: 'ticket',
          subjectKey: 'PLAT-742',
          subjectLabel: 'PLAT-742',
          source: 'semantic',
          nodeId: 'OBJ-Q2-BILL',
          nodeRevision: 1,
          chainNodeIds: ['OBJ-Q2-BILL', 'OBJ-CO-1'],
          matchedSubstring: null,
          matchedOffset: null,
          matchedIn: null,
          score: 0.6154,
          threshold: 0.3,
          comparedTextA: 'Migrate the legacy billing client onto the new SDK',
          comparedTextB: 'Migrate every merchant off the legacy billing client',
          servesCurrentObjective: false,
        },
      ],
      INSTANT,
    );

    expect(written).toBe(2);
    const links = await listObjectiveLinks(scoped(), INSTANT);
    expect(links.map((link) => link.subjectKey)).toEqual(['platform-api@4f5a6b7', 'PLAT-742']);
    expect(links[0]?.chainNodeIds).toEqual(['PLAT/Sprint 46', 'OBJ-Q3-PLAT', 'OBJ-CO-1']);
    expect(links[0]?.matchedOffset).toBe(0);
    expect(links[1]?.score).toBeCloseTo(0.6154, 6);
    expect(links[1]?.comparedTextB).toBe('Migrate every merchant off the legacy billing client');
  });

  it('replays into the same rows rather than accumulating near-duplicates', async () => {
    await recordObjectiveLinks(
      scoped(),
      INSTANT,
      [
        {
          subjectKind: 'commit',
          subjectKey: 'platform-api@4f5a6b7',
          subjectLabel: '4f5a6b7',
          source: 'configured',
          nodeId: 'PLAT/Sprint 46',
          nodeRevision: 1,
          chainNodeIds: ['PLAT/Sprint 46'],
          matchedSubstring: 'PLAT-742',
          matchedOffset: 0,
          matchedIn: 'commit_message',
          score: null,
          threshold: null,
          comparedTextA: null,
          comparedTextB: null,
          servesCurrentObjective: true,
        },
      ],
      INSTANT,
    );

    expect(await listObjectiveLinks(scoped(), INSTANT)).toHaveLength(2);
  });

  it('finds every link that ever named one subject', async () => {
    const history = await findObjectiveLinksForSubject(scoped(), 'ticket', 'PLAT-742');

    expect(history).toHaveLength(1);
    expect(history[0]?.source).toBe('semantic');
    expect(history[0]?.reportInstant).toBe(INSTANT);
  });
});
