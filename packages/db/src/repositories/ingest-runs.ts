import type { Instant, TimeWindow } from '@compass/clock';
import type { ArtifactKind, CoverageStatus, SourceCoverage } from '@compass/connector-port';
import { desc, eq } from 'drizzle-orm';

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

export async function insertIngestRun(
  scoped: ScopedDb,
  run: IngestRunInput,
  coverage: readonly IngestRunCoverageInput[] = [],
): Promise<void> {
  await scoped.insertInto(ingestRuns, {
    id: run.id,
    connectorId: run.connectorId,
    windowStart: toDatabaseInstant(run.window.start),
    windowEnd: toDatabaseInstant(run.window.end),
    startedAt: toDatabaseInstant(run.startedAt),
    completedAt: run.completedAt === null ? null : toDatabaseInstant(run.completedAt),
    status: run.status,
    totalRecords: run.totalRecords,
    artifactCounts: run.artifactCounts,
  });

  if (coverage.length === 0) return;

  await scoped.insertInto(
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
  );
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
