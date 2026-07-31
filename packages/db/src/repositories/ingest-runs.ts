import type { Instant, TimeWindow } from '@compass/clock';
import type { ArtifactKind, CoverageStatus, SourceCoverage } from '@compass/connector-port';
import { desc, eq, sql } from 'drizzle-orm';

import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { ingestRuns, ingestSourceCoverage } from '../schema/tables.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * IngestRun persistence.
 *
 * Every write goes through a ScopedDb, so an ingest run belonging to another
 * organization is unreachable from here. Ids and instants are passed in by the
 * caller — this layer never invents either.
 */
export interface IngestRunInput {
  readonly id: string;
  readonly connectorId: string;
  readonly window: TimeWindow;
  readonly startedAt: Instant;
  readonly completedAt: Instant | null;
  readonly status: CoverageStatus;
  readonly totalRecords: number;
  readonly artifactCounts: Readonly<Record<ArtifactKind, number>>;
}

export interface IngestRunCoverageInput {
  readonly id: string;
  readonly coverage: SourceCoverage;
}

export interface StoredIngestRun {
  readonly id: string;
  readonly connectorId: string;
  readonly window: TimeWindow;
  readonly startedAt: Instant;
  readonly completedAt: Instant | null;
  readonly status: string;
  readonly totalRecords: number;
}

/**
 * Writes one ingest run and its per-source coverage. **One run, one row, always.**
 *
 * The id is derived by the caller from `(organization, connector, window, attempt)`,
 * so re-ingesting the same window under the same connector produces the same id by
 * design — that is what makes the journal comparable across runs instead of an
 * append-only pile of near-duplicates.
 *
 * Which means this has to be an upsert, and the reason is a real failure rather
 * than a purity argument. The container's entrypoint runs the cold start on every
 * boot, and `ensureDailyReport` re-ingests whenever there is no report for the day
 * yet. With a plain insert the second such run raised a duplicate-key error, so a
 * container restarted on a new day answered `/` with a stack trace instead of a
 * report — the one outcome the zero-config promise cannot survive.
 *
 * A replay therefore *updates*: the newer completion instant, status and counts
 * replace the older ones, because they describe the same run over the same window
 * and the later observation is the truer one. Nothing is appended and nothing is
 * lost — `ingest_runs` is a journal of runs, not a history table, and the
 * append-only tables it feeds keep their own record either way.
 */
export async function insertIngestRun(
  scoped: ScopedDb,
  run: IngestRunInput,
  coverage: readonly IngestRunCoverageInput[] = [],
): Promise<void> {
  const completedAt = run.completedAt === null ? null : toDatabaseInstant(run.completedAt);

  await scoped
    .insertInto(ingestRuns, {
      id: run.id,
      connectorId: run.connectorId,
      windowStart: toDatabaseInstant(run.window.start),
      windowEnd: toDatabaseInstant(run.window.end),
      startedAt: toDatabaseInstant(run.startedAt),
      completedAt,
      status: run.status,
      totalRecords: run.totalRecords,
      artifactCounts: run.artifactCounts,
    })
    .onConflictDoUpdate({
      target: ingestRuns.id,
      set: {
        startedAt: toDatabaseInstant(run.startedAt),
        completedAt,
        status: run.status,
        totalRecords: run.totalRecords,
        artifactCounts: run.artifactCounts,
      },
    });

  if (coverage.length === 0) return;

  await scoped
    .insertInto(
      ingestSourceCoverage,
      coverage.map(({ id, coverage: entry }) => ({
        id,
        ingestRunId: run.id,
        sourceKey: entry.sourceKey,
        sourceKind: entry.sourceKind,
        artifact: entry.artifact,
        status: entry.status,
        reason: entry.reason,
        detail: entry.detail,
        requestedWindowStart: toDatabaseInstant(entry.requestedWindow.start),
        requestedWindowEnd: toDatabaseInstant(entry.requestedWindow.end),
        coveredWindowStart:
          entry.coveredWindow === null ? null : toDatabaseInstant(entry.coveredWindow.start),
        coveredWindowEnd: entry.coveredWindow === null ? null : toDatabaseInstant(entry.coveredWindow.end),
        recordCount: entry.recordCount,
        observedAt: toDatabaseInstant(entry.observedAt),
      })),
    )
    .onConflictDoUpdate({
      target: ingestSourceCoverage.id,
      set: {
        status: sql`excluded.status`,
        reason: sql`excluded.reason`,
        detail: sql`excluded.detail`,
        coveredWindowStart: sql`excluded.covered_window_start`,
        coveredWindowEnd: sql`excluded.covered_window_end`,
        recordCount: sql`excluded.record_count`,
        observedAt: sql`excluded.observed_at`,
      },
    });
}

/** Most recent runs first — what the freshness line reads. */
export async function listRecentIngestRuns(scoped: ScopedDb, limit = 10): Promise<readonly StoredIngestRun[]> {
  const rows = await scoped.selectFrom(ingestRuns).orderBy(desc(ingestRuns.startedAt)).limit(limit);

  return rows.map((row) => ({
    id: row.id,
    connectorId: row.connectorId,
    window: { start: fromDatabaseInstant(row.windowStart), end: fromDatabaseInstant(row.windowEnd) },
    startedAt: fromDatabaseInstant(row.startedAt),
    completedAt: fromNullableDatabaseInstant(row.completedAt),
    status: row.status,
    totalRecords: row.totalRecords,
  }));
}

export async function listCoverageForRun(scoped: ScopedDb, ingestRunId: string) {
  return scoped.selectFrom(ingestSourceCoverage, eq(ingestSourceCoverage.ingestRunId, ingestRunId));
}
