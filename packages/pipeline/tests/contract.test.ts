import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  generateStructuredReport,
  resolveScope,
  type AnalysisCollections,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type AnalysisTicketTransition,
} from '@compass/analysis';
import type {
  KnowledgeCollections,
  KnowledgeSnapshot,
  SnapshotEntity,
  SnapshotTicketTransition,
} from '@compass/knowledge-model';

/**
 * The structural-mirror contract between the knowledge model and the analysis
 * core.
 *
 * `@compass/analysis` declares zero dependencies — it cannot `import type` from
 * `@compass/knowledge-model`, because that package depends on `@compass/db` and
 * would drag a database into the pure core's manifest. So `AnalysisSnapshot` is a
 * *re-declaration* of `KnowledgeSnapshot`'s shape, and TypeScript's structural
 * typing is what makes the two interchangeable at the seam.
 *
 * That arrangement has one failure mode: the two definitions drifting apart with
 * nothing to notice. `@compass/pipeline` is the only package that depends on
 * both, so this is the one place the equivalence can be asserted — and it is
 * asserted at *compile* time, in both directions. If the knowledge model renames
 * a collection or changes a field's type, this file stops type-checking, which is
 * exactly when a human should be looking at it.
 *
 * The runtime assertions below are secondary: they prove the compile-time claim
 * is not vacuous by handing a real snapshot value straight to the analysis entry
 * point.
 */

/**
 * `[A] extends [B]` — tuple-wrapped so a union on the left is tested as a whole
 * rather than distributed, which is what makes a `false` result meaningful.
 */
type Extends<A, B> = [A] extends [B] ? true : false;

/** Assignable in both directions: the two declarations are the same shape. */
type Mutual<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;

// The load-bearing direction: whatever the knowledge model produces must be
// accepted by the pure core, with no cast and no adapter.
const knowledgeIsAnalysisInput: Extends<KnowledgeSnapshot, AnalysisSnapshot> = true;

// Everything except the entity-kind field is identical in both directions, so
// neither side can add, drop or retype a field without this failing to compile.
const envelopesMatch: Mutual<Omit<KnowledgeSnapshot, 'collections'>, Omit<AnalysisSnapshot, 'collections'>> = true;
const entityFieldsMatch: Mutual<Omit<SnapshotEntity, 'kind'>, Omit<AnalysisEntity, 'kind'>> = true;
const transitionsMatch: Mutual<SnapshotTicketTransition, AnalysisTicketTransition> = true;

/**
 * The one deliberate difference, pinned so it stays deliberate.
 *
 * `SnapshotEntity.kind` is the registry's closed `EntityKind` union; the analysis
 * core widens it to `string`. That direction is safe — every real kind is a
 * string — and it is the widening that lets the pure package avoid importing the
 * registry. The reverse must stay false: if it ever became true, the analysis
 * core would have grown a dependency on the entity registry.
 */
const kindIsWidened: Extends<SnapshotEntity['kind'], AnalysisEntity['kind']> = true;
const kindIsNotNarrowed: Extends<AnalysisEntity['kind'], SnapshotEntity['kind']> = false;

const COLLECTION_KEYS = [
  'corrections',
  'entities',
  'entityCounts',
  'entityVersions',
  'ingestRuns',
  'sprintScopeChanges',
  'ticketTransitions',
] as const;

// Both sides must have exactly these keys — a new collection on one side only is
// a compile error here rather than a silently ignored input downstream.
const knowledgeKeys: readonly (keyof KnowledgeCollections)[] = COLLECTION_KEYS;
const analysisKeys: readonly (keyof AnalysisCollections)[] = COLLECTION_KEYS;

const instant = instantFromIso('2026-07-31T09:00:00.000Z');
const window = timeWindow(instantFromIso('2026-07-30T00:00:00.000Z'), instantFromIso('2026-07-31T00:00:00.000Z'));

/**
 * A minimal but real `KnowledgeSnapshot` value, typed as the knowledge model
 * declares it rather than as the analysis core does. Passing *this* to
 * `generateStructuredReport` is the assignment the whole contract is about.
 */
const knowledgeSnapshot: KnowledgeSnapshot = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  scope: { kind: 'team', teamKey: 'platform' },
  instant,
  timezone: 'Europe/London',
  window,
  collections: {
    entities: [
      {
        kind: 'team',
        naturalKey: 'platform',
        firstSeenAt: instantFromIso('2026-05-18T00:00:00.000Z'),
        lastSeenAt: instantFromIso('2026-05-18T00:00:00.000Z'),
        beliefAt: instantFromIso('2026-05-18T00:00:00.000Z'),
        version: 1,
        elapsed: { ageDays: 74, staleDays: 74, seenToday: false, trail: [] },
        fields: { name: 'Platform', methodology: 'scrum', projectKey: 'PLAT' },
      },
      {
        kind: 'project',
        naturalKey: 'PLAT',
        firstSeenAt: instantFromIso('2026-05-18T00:00:00.000Z'),
        lastSeenAt: instantFromIso('2026-05-18T00:00:00.000Z'),
        beliefAt: instantFromIso('2026-05-18T00:00:00.000Z'),
        version: 1,
        elapsed: { ageDays: 74, staleDays: 74, seenToday: false, trail: [] },
        fields: { name: 'Platform', teamKey: 'platform', methodology: 'scrum', defaultBranch: 'main' },
      },
    ],
    entityCounts: [
      { kind: 'team', count: 1 },
      { kind: 'project', count: 1 },
    ],
    entityVersions: [],
    ticketTransitions: [],
    sprintScopeChanges: [],
    corrections: [],
    ingestRuns: [],
  },
};

describe('the knowledge snapshot is the analysis snapshot', () => {
  it('asserts the equivalence at compile time, field by field', () => {
    expect([knowledgeIsAnalysisInput, envelopesMatch, entityFieldsMatch, transitionsMatch]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('widens the entity kind and narrows nothing', () => {
    // These constants are checked by the compiler; the runtime assertion exists
    // so the file reads as a test rather than as a wall of unused declarations.
    expect(kindIsWidened).toBe(true);
    expect(kindIsNotNarrowed).toBe(false);
  });

  it('agrees on exactly which collections a snapshot carries', () => {
    expect([...knowledgeKeys].sort()).toEqual([...analysisKeys].sort());
    expect(Object.keys(knowledgeSnapshot.collections).sort()).toEqual([...COLLECTION_KEYS]);
  });

  it('hands a real knowledge snapshot straight to the analysis core', () => {
    // No cast, no adapter, no mapping function: the value produced by the layer
    // below is the value the pure core reads. That is the whole contract.
    const report = generateStructuredReport(knowledgeSnapshot, instant);

    expect(report.organizationId).toBe(knowledgeSnapshot.organizationId);
    expect(report.instant).toBe(instant);
    expect(report.sections).toHaveLength(6);
  });

  it('resolves scope off the knowledge model own value', () => {
    const scope = resolveScope(knowledgeSnapshot);

    expect(scope.kind).toBe('team');
    expect(scope.teamKey).toBe('platform');
    expect(scope.projectKeys).toEqual(['PLAT']);
  });
});
