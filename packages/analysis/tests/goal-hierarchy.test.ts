import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { instantFromIso, type Instant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  goalChain,
  goalChainIds,
  goalHierarchyAt,
  goalNodeById,
  horizonContains,
  objectiveAbove,
  sprintGoalFor,
  sprintGoalNodeId,
  subjectLinksFor,
  type GoalNodeRevision,
  type GoalSubjectLinkRevision,
} from '@compass/analysis';

/**
 * Effective dating, and the freeze rule the whole product's credibility rests on.
 *
 * The rule is stated in prose in `docs/ARCHITECTURE.md` under "Effective dating and
 * the freeze rule", and the last test in this file reads that document and fails if
 * the section is missing — because a documented guarantee nobody can find is not a
 * guarantee, and the acceptance criterion asks for both the document and the test.
 *
 * Stated once more, because it is the point of the file:
 *
 *   Rewording an objective today can never change what Compass said about
 *   yesterday. A verdict inside a persisted report is frozen; a verdict recomputed
 *   for a past instant resolves against the wording in force at that instant.
 */
const ARCHITECTURE_DOC = new URL('../../../docs/ARCHITECTURE.md', import.meta.url);

const at = (iso: string): Instant => instantFromIso(iso);

/** One millisecond after an instant — "just after the edit was recorded". */
const justAfter = (instant: Instant): Instant => (instant + 1) as Instant;

const JANUARY = at('2026-01-01T00:00:00Z');
const APRIL = at('2026-04-01T00:00:00Z');
const JULY = at('2026-07-01T00:00:00Z');
const AUGUST = at('2026-08-01T00:00:00Z');
const SEPTEMBER = at('2026-09-01T00:00:00Z');

const node = (overrides: Partial<GoalNodeRevision> = {}): GoalNodeRevision => ({
  nodeId: 'OBJ-Q3-PLAT',
  revision: 1,
  kind: 'quarter',
  parentNodeId: 'OBJ-CO-1',
  title: 'Cut p95 payment gateway latency below 400 ms',
  effectiveFrom: JULY,
  effectiveUntil: at('2026-09-30T00:00:00Z'),
  isCurrent: true,
  archived: false,
  origin: 'declared',
  subjectKind: null,
  subjectKey: null,
  recordedAt: JULY,
  ...overrides,
});

const COMPANY = node({
  nodeId: 'OBJ-CO-1',
  kind: 'company',
  parentNodeId: null,
  title: 'Make Northwind the fastest way to take a payment on the web',
  effectiveFrom: JANUARY,
  effectiveUntil: at('2026-12-31T00:00:00Z'),
  recordedAt: JANUARY,
});

describe('an edit appends a revision and never mutates the prior one', () => {
  /**
   * The same node, said twice: the July wording and the August rewording. Both
   * rows exist forever; the store is append-only and the *reader* decides which
   * one is in force.
   */
  const july = node({ revision: 1, title: 'Cut p95 payment gateway latency below 400 ms', recordedAt: JULY });
  const august = node({
    revision: 2,
    title: 'Cut p95 payment gateway latency below 250 ms',
    recordedAt: AUGUST,
  });
  const revisions = [COMPANY, july, august];

  it('resolves a past instant against the wording in force then, not the newest one', () => {
    const asOfJuly = goalHierarchyAt(revisions, [], justAfter(JULY));

    expect(goalNodeById(asOfJuly, 'OBJ-Q3-PLAT')?.revision).toBe(1);
    expect(goalNodeById(asOfJuly, 'OBJ-Q3-PLAT')?.title).toBe('Cut p95 payment gateway latency below 400 ms');
  });

  it('resolves a later instant against the rewording', () => {
    const asOfSeptember = goalHierarchyAt(revisions, [], SEPTEMBER);

    expect(goalNodeById(asOfSeptember, 'OBJ-Q3-PLAT')?.revision).toBe(2);
    expect(goalNodeById(asOfSeptember, 'OBJ-Q3-PLAT')?.title).toBe('Cut p95 payment gateway latency below 250 ms');
  });

  it('leaves the prior revision byte-identical after the edit', () => {
    // The whole freeze guarantee in one assertion: the object a July report
    // resolved against is the same object it resolves against today.
    const before = JSON.stringify(goalHierarchyAt([COMPANY, july], [], justAfter(JULY)).nodes);
    const after = JSON.stringify(goalHierarchyAt(revisions, [], justAfter(JULY)).nodes);

    expect(after).toBe(before);
  });

  it('shows nothing of a goal recorded after the instant being asked about', () => {
    // April predates the quarter objective but not the company one, so the answer
    // is a partial hierarchy rather than an empty one — which is exactly right: the
    // company objective genuinely was the plan in April.
    expect(goalHierarchyAt(revisions, [], APRIL).nodes.map((entry) => entry.nodeId)).toEqual(['OBJ-CO-1']);
    expect(goalHierarchyAt(revisions, [], at('2025-12-31T00:00:00Z')).nodes).toEqual([]);
  });

  it('breaks a tie on the same recorded instant by taking the later revision', () => {
    // Two edits recorded at the same instant is a real case — a batch save — and
    // "whichever row the database returned first" is not an answer.
    const tied = [
      node({ revision: 1, title: 'first', recordedAt: AUGUST }),
      node({ revision: 2, title: 'second', recordedAt: AUGUST }),
    ];

    expect(goalNodeById(goalHierarchyAt(tied, [], AUGUST), 'OBJ-Q3-PLAT')?.title).toBe('second');
  });
});

describe('archiving is an append, so the past still resolves', () => {
  const live = node({ revision: 1, recordedAt: JULY });
  const archived = node({ revision: 2, archived: true, isCurrent: false, recordedAt: AUGUST });

  it('drops the node once the archive is in force', () => {
    expect(goalHierarchyAt([COMPANY, live, archived], [], SEPTEMBER).nodes.map((entry) => entry.nodeId)).toEqual([
      'OBJ-CO-1',
    ]);
  });

  it('still resolves the chain for a report generated before the archive', () => {
    const asOfJuly = goalHierarchyAt([COMPANY, live, archived], [], justAfter(JULY));

    expect(goalChainIds(asOfJuly, 'OBJ-Q3-PLAT')).toEqual(['OBJ-Q3-PLAT', 'OBJ-CO-1']);
  });
});

describe('reading the graph', () => {
  const sprintGoal = node({
    nodeId: sprintGoalNodeId('PLAT', 'Sprint 46'),
    kind: 'sprint_goal',
    parentNodeId: 'OBJ-Q3-PLAT',
    title: 'Cut p95 payment gateway latency below 400 ms',
    origin: 'observed',
    subjectKind: 'sprint',
    subjectKey: 'primary-tracker:sprint-PLAT-6',
    recordedAt: JULY,
  });
  const hierarchy = goalHierarchyAt([COMPANY, node(), sprintGoal], [], AUGUST);

  it('walks a chain leaf first', () => {
    expect(goalChain(hierarchy, 'PLAT/Sprint 46').map((entry) => entry.nodeId)).toEqual([
      'PLAT/Sprint 46',
      'OBJ-Q3-PLAT',
      'OBJ-CO-1',
    ]);
  });

  it('names the nearest objective above a sprint goal, which is what a verdict may cite', () => {
    expect(objectiveAbove(hierarchy, 'PLAT/Sprint 46')?.nodeId).toBe('OBJ-Q3-PLAT');
    expect(objectiveAbove(hierarchy, 'OBJ-CO-1')?.nodeId).toBe('OBJ-CO-1');
    expect(objectiveAbove(hierarchy, null)).toBeNull();
  });

  it('finds a sprint goal by the sprint natural key rather than by its name', () => {
    expect(sprintGoalFor(hierarchy, 'primary-tracker:sprint-PLAT-6')?.nodeId).toBe('PLAT/Sprint 46');
    expect(sprintGoalFor(hierarchy, 'primary-tracker:nope')).toBeNull();
    expect(sprintGoalFor(hierarchy, null)).toBeNull();
  });

  it('terminates on a hierarchy that names itself as its own parent', () => {
    // A hand-edited chain can be cyclic. A hang here would be far harder to
    // diagnose than a short chain, so the walk is bounded.
    const cyclic = goalHierarchyAt(
      [
        node({ nodeId: 'A', parentNodeId: 'B', recordedAt: JULY }),
        node({ nodeId: 'B', parentNodeId: 'A', recordedAt: JULY }),
      ],
      [],
      AUGUST,
    );

    expect(goalChainIds(cyclic, 'A')).toEqual(['A', 'B']);
  });

  it('reads a goal horizon as half-open', () => {
    const quarter = node();

    expect(horizonContains(quarter, JULY)).toBe(true);
    expect(horizonContains(quarter, at('2026-09-29T23:59:59Z'))).toBe(true);
    expect(horizonContains(quarter, at('2026-09-30T00:00:00Z'))).toBe(false);
    expect(horizonContains(node({ effectiveUntil: null }), at('2030-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('declared attachments down to a ticket', () => {
  const link = (overrides: Partial<GoalSubjectLinkRevision> = {}): GoalSubjectLinkRevision => ({
    linkKey: 'OBJ-Q3-PLAT|ticket|PLAT-742',
    revision: 1,
    nodeId: 'OBJ-Q3-PLAT',
    subjectKind: 'ticket',
    subjectKey: 'PLAT-742',
    effectiveFrom: JULY,
    effectiveUntil: null,
    detached: false,
    recordedAt: JULY,
    ...overrides,
  });

  it('resolves an attachment a manager made', () => {
    const hierarchy = goalHierarchyAt([COMPANY, node()], [link()], AUGUST);

    expect(subjectLinksFor(hierarchy, 'ticket', 'PLAT-742').map((entry) => entry.nodeId)).toEqual(['OBJ-Q3-PLAT']);
  });

  it('stops resolving once it is detached, and still resolves for an earlier instant', () => {
    const revisions = [link(), link({ revision: 2, detached: true, recordedAt: AUGUST })];

    expect(subjectLinksFor(goalHierarchyAt([COMPANY, node()], revisions, SEPTEMBER), 'ticket', 'PLAT-742')).toEqual([]);
    expect(
      subjectLinksFor(goalHierarchyAt([COMPANY, node()], revisions, justAfter(JULY)), 'ticket', 'PLAT-742'),
    ).toHaveLength(1);
  });
});

describe('the freeze rule is written down where a reader will find it', () => {
  const document = readFileSync(fileURLToPath(ARCHITECTURE_DOC), 'utf8');

  it('has a section stating the rule by name', () => {
    expect(document).toContain('Effective dating and the freeze rule');
  });

  it('says which half is frozen and which half is re-evaluated', () => {
    // The criterion is that the rule is documented, not merely that a heading
    // exists. These are the four claims the tests above enforce.
    for (const claim of ['never rewritten', 'effective at that instant', 'append', 'Correction']) {
      expect(document, `ARCHITECTURE.md does not say "${claim}"`).toContain(claim);
    }
  });
});
