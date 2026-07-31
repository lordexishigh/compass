import { toIso, type Instant, type TimeWindow } from '@compass/clock';
import { ENTITY_KINDS, fromDatabaseInstant, listRecentIngestRuns, type EntityKind } from '@compass/db';

import { elapsedFactsFor, PRESENCE_TRAIL_DAYS, type ElapsedFact } from './elapsed.js';
import { compareStable, sortByCompositeKey, sortByStableKey } from './ordering.js';
import { sealSnapshot, type SnapshotEnvelope } from './snapshot.js';
import type { KnowledgeStore } from './store.js';
import type { FieldValue } from './values.js';

/**
 * The materialized snapshot.
 *
 * This is the only thing the analysis core is ever shown, and the contract is
 * absolute: plain serializable data, fully materialized, deterministically
 * ordered, with no database handle, promise, Date or clock anywhere inside it.
 * `sealSnapshot` validates that and freezes the result, so a violation fails with
 * the path of the offending value rather than producing a report nobody can
 * reproduce.
 *
 * Ordering is the part that quietly breaks. PostgreSQL is free to return rows in
 * any order it likes, so every collection here is sorted by a documented stable
 * key with code-unit comparison, never `localeCompare`. The keys are listed in
 * `SNAPSHOT_ORDERING`, which is exported so a test can read it rather than
 * restating it.
 */

/** The documented sort key of every collection in the snapshot. */
export const SNAPSHOT_ORDERING = {
  entities: 'kind, then naturalKey',
  entityVersions: 'entityKind, then entityNaturalKey, then version',
  ticketTransitions: 'ticketKey, then transitionedAt, then sourceRecordId',
  sprintScopeChanges: 'sprintKey, then changedAt, then sourceRecordId',
  corrections: 'detectedAt, then subjectKind, then subjectKey',
  ingestRuns: 'windowStart, then windowEnd, then startedAt, then connectorId',
  coverage: 'sourceKey, then artifact',
} as const;

export interface SnapshotEntity {
  readonly kind: EntityKind;
  readonly naturalKey: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly beliefAt: number;
  readonly version: number;
  /** The elapsed facts the report's sigils and pills are rendered from. */
  readonly elapsed: ElapsedFact;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

export interface SnapshotEntityVersion {
  readonly entityKind: string;
  readonly entityNaturalKey: string;
  readonly version: number;
  readonly changedFields: readonly string[];
  readonly trackedFields: Readonly<Record<string, unknown>>;
  readonly observedAt: number;
  readonly evidenceSourceKey: string | null;
  readonly evidenceSourceRecordId: string | null;
}

export interface SnapshotTicketTransition {
  readonly ticketKey: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly fromStatusCategory: string | null;
  readonly toStatusCategory: string;
  readonly actorDeveloperKey: string | null;
  readonly transitionedAt: number;
}

export interface SnapshotSprintScopeChange {
  readonly sprintKey: string;
  readonly ticketKey: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly change: string;
  readonly actorDeveloperKey: string | null;
  readonly changedAt: number;
  /**
   * Whether the change landed after its sprint had already started — mid-sprint
   * scope creep rather than planning.
   *
   * Derived here rather than stored, because `sprint_scope_changes` is append-only
   * and a derivation frozen into an append-only row can never be corrected: a
   * backfill that reached the scope change before it reached the sprint would have
   * written the wrong answer permanently. Computed against the sprint's current
   * `startAt`, which is free to arrive later or move.
   *
   * `false` when the sprint itself has not been observed yet — Compass has no
   * evidence the change was late, and inventing some would be a guess.
   */
  readonly afterSprintStart: boolean;
}

export interface SnapshotCorrection {
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly priorVersion: number;
  readonly priorBelief: string;
  readonly newBelief: string;
  readonly contradiction: string;
  readonly evidenceKind: string;
  readonly evidenceLabel: string;
  readonly evidenceSourceKey: string;
  readonly evidenceSourceRecordId: string;
  readonly observedAt: number;
  readonly detectedAt: number;
}

export interface SnapshotIngestRun {
  readonly connectorId: string;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: string;
  readonly totalRecords: number;
}

export interface KnowledgeCollections {
  /** Every entity, of every kind, in one flat sorted list. */
  readonly entities: readonly SnapshotEntity[];
  /** Entity counts per kind, in the registry's declared order. */
  readonly entityCounts: readonly { readonly kind: EntityKind; readonly count: number }[];
  readonly entityVersions: readonly SnapshotEntityVersion[];
  readonly ticketTransitions: readonly SnapshotTicketTransition[];
  readonly sprintScopeChanges: readonly SnapshotSprintScopeChange[];
  readonly corrections: readonly SnapshotCorrection[];
  readonly ingestRuns: readonly SnapshotIngestRun[];
}

export type KnowledgeSnapshot = SnapshotEnvelope<KnowledgeCollections>;

export interface BuildSnapshotInput {
  readonly scope: { readonly kind: 'team'; readonly teamKey: string } | { readonly kind: 'merged' };
  /** The instant the snapshot represents. Supplied, never read from a clock. */
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  /** How many ingest runs to carry, most recent first. */
  readonly ingestRunLimit?: number;
  readonly trailDays?: number;
}

/**
 * Builds the snapshot for one (organization, team, instant).
 *
 * The result is a value, not a view: everything is read and converted before the
 * function returns, so the analysis core cannot accidentally trigger a query. Two
 * calls for the same (organization, team, instant) produce byte-identical JSON —
 * asserted in `tests/snapshot-builder.test.ts`, and the reason nothing in here
 * generates an id, reads a clock or relies on database row order.
 */
export async function buildKnowledgeSnapshot(
  store: KnowledgeStore,
  input: BuildSnapshotInput,
): Promise<KnowledgeSnapshot> {
  const trailDays = input.trailDays ?? PRESENCE_TRAIL_DAYS;

  const entities: SnapshotEntity[] = [];
  const entityCounts: { kind: EntityKind; count: number }[] = [];

  for (const kind of ENTITY_KINDS) {
    const stored = await store.list(kind);
    entityCounts.push({ kind, count: stored.length });
    for (const entity of stored) {
      entities.push({
        kind: entity.kind,
        naturalKey: entity.naturalKey,
        firstSeenAt: entity.firstSeenAt,
        lastSeenAt: entity.lastSeenAt,
        beliefAt: entity.beliefAt,
        version: entity.version,
        elapsed: elapsedFactsFor(entity, input.instant, input.timezone, trailDays),
        fields: entity.fields,
      });
    }
  }

  // Sprint start instants, for the `afterSprintStart` derivation below. Built from
  // the entities just read rather than re-queried, so the flag and the sprint rows
  // in the same snapshot can never disagree.
  const sprintStarts = new Map<string, number>();
  for (const entity of entities) {
    if (entity.kind !== 'sprint') continue;
    const startAt = entity.fields['startAt'];
    if (typeof startAt === 'number') sprintStarts.set(entity.naturalKey, startAt);
  }

  const versionRows = await store.versions();
  const transitionRows = await store.ticketTransitions();
  const scopeChangeRows = await store.sprintScopeChanges();
  const correctionRows = await store.corrections();
  const runRows = await listRecentIngestRuns(store.scoped, input.ingestRunLimit ?? 14);

  const collections: KnowledgeCollections = {
    entities: sortByCompositeKey(entities, (entity) => [entity.kind, entity.naturalKey]),
    // Registry order, not alphabetical: the registry is the declaration and a
    // reader comparing two snapshots should see the same rows in the same slots.
    entityCounts,
    entityVersions: sortByCompositeKey(
      versionRows.map((row) => ({
        entityKind: row.entityKind,
        entityNaturalKey: row.entityNaturalKey,
        version: row.version,
        changedFields: [...row.changedFields],
        trackedFields: row.trackedFields,
        observedAt: fromDatabaseInstant(row.observedAt),
        evidenceSourceKey: row.evidenceSourceKey,
        evidenceSourceRecordId: row.evidenceSourceRecordId,
      })),
      (version) => [version.entityKind, version.entityNaturalKey, version.version],
    ),
    ticketTransitions: sortByCompositeKey(
      transitionRows.map((row) => ({
        ticketKey: row.ticketKey,
        sourceKey: row.sourceKey,
        sourceRecordId: row.sourceRecordId,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        fromStatusCategory: row.fromStatusCategory,
        toStatusCategory: row.toStatusCategory,
        actorDeveloperKey: row.actorDeveloperKey,
        transitionedAt: fromDatabaseInstant(row.transitionedAt),
      })),
      (transition) => [transition.ticketKey, transition.transitionedAt, transition.sourceRecordId],
    ),
    sprintScopeChanges: sortByCompositeKey(
      scopeChangeRows.map((row) => {
        const changedAt = fromDatabaseInstant(row.changedAt);
        const startAt = sprintStarts.get(row.sprintKey);
        return {
          sprintKey: row.sprintKey,
          ticketKey: row.ticketKey,
          sourceKey: row.sourceKey,
          sourceRecordId: row.sourceRecordId,
          change: row.change,
          actorDeveloperKey: row.actorDeveloperKey,
          changedAt,
          afterSprintStart: startAt !== undefined && changedAt > startAt,
        };
      }),
      (change) => [change.sprintKey, change.changedAt, change.sourceRecordId],
    ),
    corrections: sortByCompositeKey(
      correctionRows.map((row) => ({
        subjectKind: row.subjectKind,
        subjectKey: row.subjectKey,
        priorVersion: row.priorVersion,
        priorBelief: row.priorBelief,
        newBelief: row.newBelief,
        contradiction: row.contradiction,
        evidenceKind: row.evidenceKind,
        evidenceLabel: row.evidenceLabel,
        evidenceSourceKey: row.evidenceSourceKey,
        evidenceSourceRecordId: row.evidenceSourceRecordId,
        observedAt: fromDatabaseInstant(row.observedAt),
        detectedAt: fromDatabaseInstant(row.detectedAt),
      })),
      (correction) => [correction.detectedAt, correction.subjectKind, correction.subjectKey],
    ),
    ingestRuns: sortByCompositeKey(
      runRows.map((run) => ({
        connectorId: run.connectorId,
        windowStart: run.window.start,
        windowEnd: run.window.end,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        status: run.status,
        totalRecords: run.totalRecords,
      })),
      (run) => [run.windowStart, run.windowEnd, run.startedAt, run.connectorId],
    ),
  };

  return sealSnapshot({
    organizationId: store.organizationId,
    scope: input.scope,
    instant: input.instant,
    timezone: input.timezone,
    window: input.window,
    collections,
  });
}

/**
 * The canonical JSON text of a snapshot. Two snapshots built for the same
 * (organization, team, instant) produce the same string, byte for byte.
 *
 * Written with an explicit replacer rather than relying on `JSON.stringify`'s
 * property order, because insertion order is a property of how the object was
 * built and this function has to be independent of that.
 */
export function snapshotJson(snapshot: KnowledgeSnapshot): string {
  return JSON.stringify(canonicalise(snapshot));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, canonicalise(nested)] as const)
      .sort(([left], [right]) => compareStable(left, right));
    return Object.fromEntries(entries);
  }
  return value;
}

/** Entities of one kind, in the snapshot's order. */
export function entitiesOfKind(snapshot: KnowledgeSnapshot, kind: EntityKind): readonly SnapshotEntity[] {
  return snapshot.collections.entities.filter((entity) => entity.kind === kind);
}

export function entityByKey(
  snapshot: KnowledgeSnapshot,
  kind: EntityKind,
  naturalKey: string,
): SnapshotEntity | null {
  return snapshot.collections.entities.find((entity) => entity.kind === kind && entity.naturalKey === naturalKey) ?? null;
}

/** The tickets belonging to one Feature, sorted by item key. */
export function ticketsOfFeature(snapshot: KnowledgeSnapshot, featureKey: string): readonly SnapshotEntity[] {
  return sortByStableKey(
    entitiesOfKind(snapshot, 'ticket').filter((ticket) => ticket.fields['featureKey'] === featureKey),
    (ticket) => String(ticket.fields['itemKey']),
  );
}

/** A human-readable window label, for a page header or a log line. */
export function describeSnapshotWindow(snapshot: KnowledgeSnapshot): string {
  return `[${toIso(snapshot.window.start)}, ${toIso(snapshot.window.end)})`;
}
