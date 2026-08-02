import type { ReportScope } from '@compass/analysis';
import { formatCivilDate, previousCivilDayWindow, type Instant, type TimeWindow } from '@compass/clock';
import {
  ScopedDb,
  findLatestReport,
  findLatestReportForDate,
  loadFreshness,
  loadReportBundle,
  orgScope,
  type CompassDatabase,
  type FreshnessReport,
  type StoredReportBundle,
} from '@compass/db';

import { SCOPE_KEY_FOR_MERGED, scopeColumnsFor, type ScopeColumns } from './persist.js';
import { runReportPipeline, type ReportPipelineRequest, type ReportPipelineResult } from './report-pipeline.js';

/**
 * Reading today's report, and generating it if nobody has yet.
 *
 * The zero-config promise is that a manager opens `/` and reads a report — no
 * login wall, no connector wizard, no empty state. The worker generates reports
 * on a schedule, but on a cold start there has not been a schedule yet, so the
 * read path has to be able to produce one. That is what `ensureDailyReport` does,
 * and it is the *only* place a read turns into a write.
 *
 * It is idempotent by construction: the report row id is derived from
 * `(organization, scope, instant)`, so a second concurrent request for the same
 * day either finds the row the first one wrote or writes the identical rows over
 * it. There is no "generating…" state to get stuck in.
 */

// Re-exported from `persist.ts`, where the mapping now lives: the pipeline needs it before a
// report exists, and `ensure-report.ts` sits above `report-pipeline.ts` in the import order.
export { SCOPE_KEY_FOR_MERGED, scopeColumnsFor, type ScopeColumns };

export interface EnsureReportRequest extends Omit<ReportPipelineRequest, 'window'> {
  /** The report window. Defaults to the team's previous civil day from `now`. */
  readonly window?: TimeWindow;
  /** Regenerate even when a report for the day already exists. */
  readonly force?: boolean;
}

export interface EnsuredReport {
  readonly bundle: StoredReportBundle;
  readonly freshness: FreshnessReport;
  /** Whether this request generated the report, or found one already written. */
  readonly generated: boolean;
  /** Present only when this request ran the pipeline. */
  readonly result: ReportPipelineResult | null;
}

export class ReportUnavailableError extends Error {
  constructor(reportDate: string, cause: string) {
    super(`Compass could not produce a report for ${reportDate}: ${cause}`);
    this.name = 'ReportUnavailableError';
  }
}

/**
 * Today's report, generated on demand if it does not exist yet.
 *
 * `now` is a required parameter. The one clock in the web app lives at the
 * request edge and the one in the worker lives in its job loop; everything from
 * here down is told the instant.
 */
export async function ensureDailyReport(request: EnsureReportRequest): Promise<EnsuredReport> {
  const scoped = new ScopedDb(request.database, orgScope(request.organizationId));
  const scope = scopeColumnsFor(request.scope);
  const window = request.window ?? previousCivilDayWindow(request.now, request.timezone);
  const reportDate = formatCivilDate(request.now, request.timezone);

  const existing = request.force === true ? null : await findLatestReportForDate(scoped, scope, reportDate);

  if (existing !== null) {
    const bundle = await loadReportBundle(scoped, existing.id);
    if (bundle !== null) {
      return {
        bundle,
        freshness: await loadFreshness(scoped, bundle.report.window),
        generated: false,
        result: null,
      };
    }
    // A report row with no sections is a half-written report, which is worse than
    // no report: it would render as a page missing four of its six sections.
    // Regenerating is the only honest recovery.
  }

  const result = await runReportPipeline({ ...request, window });
  const bundle = await loadReportBundle(scoped, result.stored.id);
  if (bundle === null) {
    throw new ReportUnavailableError(reportDate, 'the pipeline wrote a report that could not be read back');
  }

  return {
    bundle,
    freshness: await loadFreshness(scoped, bundle.report.window),
    generated: true,
    result,
  };
}

/**
 * The newest report of any date, without generating one.
 *
 * The read-only path: what a web request uses when it must not write, and what
 * an operator uses to ask "what does Compass currently hold". Returns null rather
 * than an empty shell, so the caller has to decide what to say about the absence
 * instead of rendering a blank page by accident.
 */
export async function loadLatestReport(
  database: CompassDatabase,
  organizationId: string,
  scope: ReportScope,
): Promise<{ readonly bundle: StoredReportBundle; readonly freshness: FreshnessReport } | null> {
  const scoped = new ScopedDb(database, orgScope(organizationId));
  const latest = await findLatestReport(scoped, scopeColumnsFor(scope));
  if (latest === null) return null;

  const bundle = await loadReportBundle(scoped, latest.id);
  if (bundle === null) return null;

  return { bundle, freshness: await loadFreshness(scoped, bundle.report.window) };
}

/** Freshness on its own, for a health endpoint that must not generate anything. */
export async function loadFreshnessFor(
  database: CompassDatabase,
  organizationId: string,
  window: TimeWindow | null = null,
): Promise<FreshnessReport> {
  return loadFreshness(new ScopedDb(database, orgScope(organizationId)), window);
}

/** Re-exported so an edge does not have to import the clock to get the default. */
export const defaultReportWindow = (now: Instant, timezone: string): TimeWindow =>
  previousCivilDayWindow(now, timezone);
