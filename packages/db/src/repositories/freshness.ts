import type { Instant, TimeWindow } from '@compass/clock';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';

import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { ingestRuns, ingestSourceCoverage } from '../schema/tables.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Data freshness, read from the ingest journal and from nothing else.
 *
 * The rule this file exists to keep is negative: **no fabricated freshness
 * value**. If there is no `ingest_runs` row, there is no "last updated" to
 * display, and the honest answer is to say Compass has no record of an ingest —
 * not to fall back to the report's own `generated_at`, which would tell a
 * manager the data is fresh when what is fresh is the page.
 *
 * So every field here is nullable where the journal can be silent, and the
 * caller is given `hasIngestRecord` rather than being left to infer it from an
 * empty array that might equally mean "no sources configured".
 */

export interface SourceFreshness {
  readonly sourceKey: string;
  readonly sourceKind: string;
  /** complete | partial | unavailable, as the connector itself reported it. */
  readonly status: string;
  /** The machine reason — `ok`, `rate_limited`, `auth_failed`, `not_configured`. */
  readonly reason: string;
  /** The connector's own sentence about this source. Never rewritten here. */
  readonly detail: string;
  /** When this source was last observed. Null when it never answered. */
  readonly lastObservedAt: Instant | null;
  /** The window the run asked for. */
  readonly requestedWindow: TimeWindow;
  /** The window the source could actually cover. Null when it covered none. */
  readonly coveredWindow: TimeWindow | null;
  readonly recordCount: number;
  /** The artifact families this source was asked for, sorted. */
  readonly artifacts: readonly string[];
}

export interface FreshnessReport {
  /** False when the journal holds no run at all for this organization. */
  readonly hasIngestRecord: boolean;
  /** The run these figures came from. Null when there is none. */
  readonly ingestRunId: string | null;
  readonly connectorId: string | null;
  readonly startedAt: Instant | null;
  readonly completedAt: Instant | null;
  readonly window: TimeWindow | null;
  readonly totalRecords: number;
  /** complete | partial | unavailable — the worst status across the sources. */
  readonly overallStatus: string;
  readonly sources: readonly SourceFreshness[];
  /** Sources that answered nothing usable, by key. Drives the "missing" note. */
  readonly missingSourceKeys: readonly string[];
}

export const EMPTY_FRESHNESS: FreshnessReport = Object.freeze({
  hasIngestRecord: false,
  ingestRunId: null,
  connectorId: null,
  startedAt: null,
  completedAt: null,
  window: null,
  totalRecords: 0,
  overallStatus: 'unavailable',
  sources: [],
  missingSourceKeys: [],
});

const STATUS_SEVERITY: Readonly<Record<string, number>> = { complete: 0, partial: 1, unavailable: 2 };

const worst = (statuses: readonly string[]): string =>
  statuses.reduce(
    (accumulated, status) =>
      (STATUS_SEVERITY[status] ?? 2) > (STATUS_SEVERITY[accumulated] ?? 0) ? status : accumulated,
    statuses.length === 0 ? 'unavailable' : 'complete',
  );

/**
 * The newest completed run whose window overlaps the one asked about.
 *
 * A report about yesterday should quote yesterday's ingest, not this morning's
 * unrelated backfill of March. When no run covers the window the answer is
 * `null` and the caller says so.
 */
async function latestRunForWindow(scoped: ScopedDb, window: TimeWindow | null) {
  const overlapping =
    window === null
      ? undefined
      : and(
          lte(ingestRuns.windowStart, toDatabaseInstant(window.end)),
          gte(ingestRuns.windowEnd, toDatabaseInstant(window.start)),
        );

  const [row] = await scoped.selectFrom(ingestRuns, overlapping).orderBy(desc(ingestRuns.startedAt)).limit(1);
  if (row !== undefined || window === null) return row;

  // Nothing covers the window. Fall back to the newest run of any window so the
  // page can say "the last ingest was X, and it did not cover this day" — which
  // is a different and more useful fact than "no ingest has ever happened".
  const [fallback] = await scoped.selectFrom(ingestRuns).orderBy(desc(ingestRuns.startedAt)).limit(1);
  return fallback;
}

/**
 * Per-source freshness for a window, from `ingest_runs` and
 * `ingest_source_coverage`.
 *
 * Coverage rows are per (source, artifact); a source is folded to one entry by
 * taking its worst status and its latest observation, because a manager needs to
 * know "can I trust the tracker today", not "did the issue-transitions call
 * succeed while the issues call did not".
 */
export async function loadFreshness(
  scoped: ScopedDb,
  window: TimeWindow | null = null,
): Promise<FreshnessReport> {
  const run = await latestRunForWindow(scoped, window);
  if (run === undefined) return EMPTY_FRESHNESS;

  const coverage = await scoped
    .selectFrom(ingestSourceCoverage, eq(ingestSourceCoverage.ingestRunId, run.id))
    .orderBy(asc(ingestSourceCoverage.sourceKey), asc(ingestSourceCoverage.artifact));

  const bySource = new Map<string, SourceFreshness>();
  for (const row of coverage) {
    const existing = bySource.get(row.sourceKey);
    const observedAt = fromDatabaseInstant(row.observedAt);
    const covered =
      row.coveredWindowStart === null || row.coveredWindowEnd === null
        ? null
        : {
            start: fromDatabaseInstant(row.coveredWindowStart),
            end: fromDatabaseInstant(row.coveredWindowEnd),
          };

    if (existing === undefined) {
      bySource.set(row.sourceKey, {
        sourceKey: row.sourceKey,
        sourceKind: row.sourceKind,
        status: row.status,
        reason: row.reason,
        detail: row.detail,
        lastObservedAt: row.recordCount > 0 ? observedAt : null,
        requestedWindow: {
          start: fromDatabaseInstant(row.requestedWindowStart),
          end: fromDatabaseInstant(row.requestedWindowEnd),
        },
        coveredWindow: covered,
        recordCount: row.recordCount,
        artifacts: [row.artifact],
      });
      continue;
    }

    const status = worst([existing.status, row.status]);
    bySource.set(row.sourceKey, {
      ...existing,
      status,
      // Keep the reason and sentence that belong to the status being reported,
      // so a degraded source is never explained by a healthy call's message.
      reason: status === row.status ? row.reason : existing.reason,
      detail: status === row.status ? row.detail : existing.detail,
      lastObservedAt:
        row.recordCount > 0 && (existing.lastObservedAt === null || observedAt > existing.lastObservedAt)
          ? observedAt
          : existing.lastObservedAt,
      coveredWindow: existing.coveredWindow ?? covered,
      recordCount: existing.recordCount + row.recordCount,
      artifacts: [...existing.artifacts, row.artifact].sort(),
    });
  }

  const sources = [...bySource.values()].sort((left, right) =>
    left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0,
  );

  return {
    hasIngestRecord: true,
    ingestRunId: run.id,
    connectorId: run.connectorId,
    startedAt: fromDatabaseInstant(run.startedAt),
    completedAt: fromNullableDatabaseInstant(run.completedAt),
    window: { start: fromDatabaseInstant(run.windowStart), end: fromDatabaseInstant(run.windowEnd) },
    totalRecords: run.totalRecords,
    overallStatus: sources.length === 0 ? run.status : worst(sources.map((source) => source.status)),
    sources,
    missingSourceKeys: sources
      .filter((source) => source.status !== 'complete' || source.recordCount === 0)
      .map((source) => source.sourceKey),
  };
}
