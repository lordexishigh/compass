import { SystemClock, formatCivilDate, type Instant } from '@compass/clock';
import {
  findReportById,
  findReportForInstant,
  findReportsForDate,
  listReportArchive,
  loadReportBundle,
  teams as teamsTable,
  listEntityRows,
  type ReportArchiveEntry,
  type ScopedDb,
  type StoredReportBundle,
} from '@compass/db';
import { ingestRunRowId } from '@compass/db';
import { narratorFromEnvironment } from '@compass/narrator';
import {
  SCOPE_KEY_FOR_MERGED,
  ensureMergedReport,
  ensureWeeklyDigest,
  mergeStoredReports,
  reportInstantForDate,
  resolveGenerationLocalTime,
  type EnsuredMergedReport,
  type EnsuredWeeklyDigest,
} from '@compass/pipeline';
import { SeedConnector, resolveSeededRun } from '@compass/seed-connector';

import { database } from './database';

/**
 * The archive, the merged view, the weekly digest and the time-travel regeneration — all reads of the
 * *stored* record, except the two that deliberately are not.
 *
 * ## The rule this module exists to keep
 *
 * A permalink renders **the row**, never a regeneration. That is the whole point of an archive: a
 * manager pointing a skip-level at last Tuesday's report is pointing at what they read last Tuesday,
 * including its numbers, its prose and its fallback flag. Re-running analysis for a past instant would
 * produce today's thresholds over that day's data and quietly answer a different question — and the
 * reader would have no way to tell.
 *
 * So `loadArchivedReport` only ever loads. The one path that generates is `regenerateForInstant`, which
 * is the time-travel control, and it says so in its name.
 */

/** The report scopes the archive groups by. `merged` is a derived view, not a stored scope. */
export type ArchiveScopeKind = 'team' | 'merged';

export interface ArchiveEntryView {
  readonly reportId: string;
  readonly scopeLabel: string;
  readonly scopeKind: string;
  readonly scopeKey: string;
  readonly reportDate: string;
  readonly href: string;
  readonly itemCount: number;
  /** Surfaced in the list, so a degraded report is marked before it is opened. */
  readonly fallbackRenderer: boolean;
  readonly coverageStatus: string;
  readonly generatedAtLabel: string;
}

export interface ArchiveDayView {
  readonly reportDate: string;
  readonly entries: readonly ArchiveEntryView[];
}

/**
 * The archive index, grouped by civil date.
 *
 * By date first and team second, because "last Tuesday" is how a manager navigates and "the platform
 * team" is how they narrow once they are there. The dates are already in descending instant order from
 * the query; this only groups them, so nothing here can reorder what the database decided.
 */
export function groupArchiveByDate(entries: readonly ReportArchiveEntry[]): readonly ArchiveDayView[] {
  const days = new Map<string, ArchiveEntryView[]>();

  for (const entry of entries) {
    const view: ArchiveEntryView = {
      reportId: entry.id,
      scopeKind: entry.scopeKind,
      scopeKey: entry.scopeKey,
      scopeLabel: entry.scopeKind === 'merged' ? 'all teams' : entry.scopeKey,
      reportDate: entry.reportDate,
      href: archiveHref(entry.id),
      itemCount: entry.itemCount,
      fallbackRenderer: entry.fallbackRenderer,
      coverageStatus: entry.coverageStatus,
      generatedAtLabel: formatCivilDate(entry.generatedAt, entry.timezone),
    };

    const bucket = days.get(entry.reportDate);
    if (bucket === undefined) days.set(entry.reportDate, [view]);
    else bucket.push(view);
  }

  return [...days.entries()].map(([reportDate, dayEntries]) => ({ reportDate, entries: dayEntries }));
}

/** The permalink of one stored report. One report, one URL, forever. */
export const archiveHref = (reportId: string): string => `/archive/${encodeURIComponent(reportId)}`;

/** The merged view of one archived date, re-derived from that date's per-team rows. */
export const mergedArchiveHref = (reportDate: string): string => `/archive/merged/${encodeURIComponent(reportDate)}`;

export async function loadArchiveIndex(scoped: ScopedDb, limit = 120): Promise<readonly ArchiveDayView[]> {
  return groupArchiveByDate(await listReportArchive(scoped, { limit }));
}

/**
 * One archived report, exactly as stored.
 *
 * Returns the bundle and nothing derived from a fresh analysis run. `buildReportView` then shapes it for
 * the page from those rows alone, which is what makes the permalink criterion checkable: the page can
 * only show what the row holds.
 */
export async function loadArchivedReport(
  scoped: ScopedDb,
  reportId: string,
): Promise<StoredReportBundle | null> {
  const report = await findReportById(scoped, reportId);
  if (report === null) return null;
  return loadReportBundle(scoped, report.id);
}

/**
 * The merged cross-team view of one archived date.
 *
 * Re-merged from the stored per-team reports rather than read from a merged row of its own, so it can
 * never disagree with the reports it points at. Generates nothing: a date with no stored per-team
 * reports returns null, because an archive that wrote to the database when somebody opened last Tuesday
 * would not be an archive.
 */
export async function loadMergedArchive(
  scoped: ScopedDb,
  reportDate: string,
): Promise<ReturnType<typeof mergeStoredReports>> {
  const stored = await findReportsForDate(scoped, reportDate);
  const teamRows = stored.filter((report) => report.scopeKind === 'team');
  if (teamRows.length === 0) return null;

  const bundles: { teamKey: string; bundle: StoredReportBundle }[] = [];
  for (const report of teamRows) {
    const bundle = await loadReportBundle(scoped, report.id);
    if (bundle !== null) bundles.push({ teamKey: report.scopeKey, bundle });
  }
  if (bundles.length === 0) return null;

  const first = bundles[0]!.bundle.report;
  return mergeStoredReports({
    organizationId: first.organizationId,
    instant: first.reportInstant,
    timezone: first.timezone,
    window: first.window,
    teamReports: bundles,
  });
}

// ---------------------------------------------------------------------------
// The simulated clock, and what it is allowed to move
// ---------------------------------------------------------------------------

/**
 * Whether this deployment runs on the simulated clock.
 *
 * True exactly when the substrate is the seeded dataset — which is the only situation in which stepping
 * `now` is meaningful *and* harmless. A seeded organization's history is a fixture with a known start and
 * end, so "what did Tuesday look like" has an answer; a live organization's `now` is the actual present,
 * and regenerating its report for an arbitrary instant would overwrite today's row with a report about a
 * day that has not happened.
 *
 * Resolved from the substrate rather than from a request, and checked **server-side** in the route. A
 * client-only guard would let a crafted POST move `now` for a live org, which is precisely the failure the
 * criterion names.
 */
export function simulatedClockAvailable(organizationId: string): boolean {
  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  return run.organizationId === organizationId && run.datasetWindow !== null;
}

/** The span the scrubber may move within: the seeded history, and never outside it. */
export interface TimeTravelBounds {
  readonly available: boolean;
  readonly earliestDate: string;
  readonly latestDate: string;
  readonly timezone: string;
  /** The date the page is currently showing. */
  readonly currentDate: string;
}

export function timeTravelBounds(organizationId: string, currentDate: string): TimeTravelBounds {
  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  const available = simulatedClockAvailable(organizationId);
  const window = run.datasetWindow;

  return {
    available,
    // Outside simulated-clock mode the bounds collapse onto the current date, so a UI that ignored
    // `available` still could not offer a step.
    earliestDate: available && window !== null ? formatCivilDate(window.start, run.timezone) : currentDate,
    latestDate: available && window !== null ? formatCivilDate(window.end, run.timezone) : currentDate,
    timezone: run.timezone,
    currentDate,
  };
}

export class TimeTravelUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'TimeTravelUnavailableError';
    this.detail = detail;
  }
}

/**
 * `2026-07-24` → the instant that civil date's report is generated for.
 *
 * ## Why this is the scheduler's own derivation and not an approximation of it
 *
 * `reportInstantForDate` is the function `generate.tick` uses:
 * `instantAtLocalTime(reportDate, DEFAULT_GENERATION_LOCAL_TIME, timezone)` — 06:00 in the team's own
 * zone, as `docs/DEVELOPMENT.md` documents. Because the report row id is derived from
 * `(organization, scope, instant)`, calling anything *else* here would put the time-travel control on a
 * different row from the scheduled run for the same morning, and stepping to a day the scheduler had
 * already generated would write a second report instead of reading the first.
 *
 * This previously copied the UTC hour and minute off `run.now`. That was wrong twice over: it did not
 * match the scheduler's 06:00-local rule, and `run.now` follows the host clock inside the dataset window,
 * so two requests a minute apart produced two different instants — and therefore two rows for one civil
 * date. It is now a **pure function of the civil date**, which is what makes "step to Tuesday twice, read
 * the same report" true rather than hoped for.
 *
 * The zone is the seeded run's own rather than a parameter: which morning `2026-07-24` names is a property
 * of the deployment, not of the caller, and a caller-supplied zone would let two paths disagree about it.
 */
export function instantForDate(date: string): Instant {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TimeTravelUnavailableError(
      `\`${date}\` is not a civil date. The time-travel control steps whole days, in the form 2026-07-24.`,
    );
  }

  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  return reportInstantForDate(date, run.timezone, resolveGenerationLocalTime(process.env));
}

export interface RegeneratedReport {
  readonly reportId: string;
  readonly reportDate: string;
  readonly href: string;
  /** True when this request ran the pipeline rather than finding the row already written. */
  readonly generated: boolean;
}

/**
 * Regenerates one team's report for a stepped instant, through the real pipeline.
 *
 * `force: false` on purpose. The report id is derived from `(organization, scope, instant)`, so stepping
 * back to a day already generated finds that row — which is both faster and *more* correct than
 * regenerating, because the archived report is the record. Stepping to a day never generated runs the
 * whole pipeline for that instant: ingest window, snapshot, analysis, render, persist. There is no
 * precomputed mock anywhere on this path, and no branch that could introduce one.
 */
/**
 * The instant a steppable civil date resolves to, or a stated refusal.
 *
 * Split out of `regenerateForInstant` so the route can validate the *request* — is this a civil date, and
 * is it inside the history Compass holds — before it reads the database to check the team. Order matters
 * for the reader: `2019-01-01` should be answered as a date outside the seeded history whatever team was
 * named, not as a complaint about the team.
 */
export function stepableInstantFor(date: string): Instant {
  const instant = instantForDate(date);
  assertInsideSeededHistory(instant, date);
  return instant;
}

export async function regenerateForInstant(input: {
  readonly organizationId: string;
  readonly teamKey: string;
  readonly date: string;
}): Promise<RegeneratedReport> {
  if (!simulatedClockAvailable(input.organizationId)) {
    throw new TimeTravelUnavailableError(
      'Time travel is only available on the simulated clock, which this organization does not run on. A live ' +
        'organization’s `now` is the actual present, and Compass will not regenerate its daily for a day that has ' +
        'not happened.',
    );
  }

  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  const instant = stepableInstantFor(input.date);

  const connector = new SeedConnector(run.dataset);
  const { ensureDailyReport } = await import('@compass/pipeline');

  const ensured = await ensureDailyReport({
    organizationId: input.organizationId,
    scope: { kind: 'team', teamKey: input.teamKey },
    now: instant,
    timezone: run.timezone,
    ingestWindow: run.ingestWindow,
    runId: ingestRunRowId(input.organizationId, connector.connectorId, run.ingestWindow.start, run.ingestWindow.end, 1),
    connector,
    database: database(),
    narrator: narratorFromEnvironment(process.env),
  });

  return {
    reportId: ensured.bundle.report.id,
    reportDate: ensured.bundle.report.reportDate,
    href: archiveHref(ensured.bundle.report.id),
    generated: ensured.generated,
  };
}

/**
 * Whether stepping to this day would *generate* a report or merely read one.
 *
 * Exists for the rate limiter and for nothing else. "Manual report regeneration, 5 per hour per
 * organization" has to bound the expensive act — a full pipeline run — and must not bound the cheap
 * one, because the time-travel scrubber steps day by day and a manager reviewing last week would hit
 * a 429 on their fifth step. So the route asks this first and only spends the allowance when the
 * answer is yes.
 *
 * It is the same question `ensureDailyReport` answers internally, asked with the same derived id, so
 * the two cannot disagree about what "already generated" means. There is a benign race: two
 * simultaneous requests for the same ungenerated day both see `false`, so the limit can be exceeded
 * by one. That is the correct direction for this particular race to fall — the alternative is a lock
 * around a pipeline run — and the second request finds the row written and returns it.
 */
export async function reportAlreadyGenerated(
  scoped: ScopedDb,
  teamKey: string,
  date: string,
): Promise<boolean> {
  const existing = await findReportForInstant(
    scoped,
    { scopeKind: 'team', scopeKey: teamKey },
    stepableInstantFor(date),
  );
  return existing !== null;
}

/**
 * Refuses an instant outside the seeded history.
 *
 * Not a convenience. The fixture has a first day and a last day, and a report generated for a date
 * outside them would be a page of honest "no signal" statements that looks like a broken deployment. The
 * bound is the substrate's, so it moves when the fixture does.
 */
function assertInsideSeededHistory(instant: Instant, date: string): void {
  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  const window = run.datasetWindow;
  if (window === null) return;

  if (instant < window.start || instant > window.end) {
    throw new TimeTravelUnavailableError(
      `${date} is outside the seeded history, which runs from ${formatCivilDate(window.start, run.timezone)} to ` +
        `${formatCivilDate(window.end, run.timezone)}. Compass will not generate a report for a day it has no data ` +
        'for — the page would be six honest refusals and would read as a broken deployment.',
    );
  }
}

// ---------------------------------------------------------------------------
// The merged report and the weekly digest, for today
// ---------------------------------------------------------------------------

/** Every team the knowledge model holds, in key order. The merged report ranks across these. */
export async function knownTeamKeys(scoped: ScopedDb): Promise<readonly string[]> {
  const rows = await listEntityRows(scoped, teamsTable);
  return rows.map((row) => row.naturalKey).sort();
}

/** Today's merged cross-team report, generating each team's daily through the real pipeline if needed. */
export async function loadMergedReport(
  organizationId: string,
  teamKeys: readonly string[],
): Promise<EnsuredMergedReport> {
  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  const connector = new SeedConnector(run.dataset);

  return ensureMergedReport({
    organizationId,
    teamKeys,
    now: run.now,
    timezone: run.timezone,
    window: run.window,
    ingestWindow: run.ingestWindow,
    runId: ingestRunRowId(organizationId, connector.connectorId, run.ingestWindow.start, run.ingestWindow.end, 1),
    connector,
    database: database(),
    narrator: narratorFromEnvironment(process.env),
  });
}

/** This week's digest for one team. */
export async function loadWeeklyDigest(
  organizationId: string,
  teamKey: string,
): Promise<EnsuredWeeklyDigest> {
  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  const connector = new SeedConnector(run.dataset);

  return ensureWeeklyDigest({
    organizationId,
    teamKey,
    now: run.now,
    timezone: run.timezone,
    window: run.window,
    ingestWindow: run.ingestWindow,
    runId: ingestRunRowId(organizationId, connector.connectorId, run.ingestWindow.start, run.ingestWindow.end, 1),
    connector,
    database: database(),
    narrator: narratorFromEnvironment(process.env),
  });
}

/** Re-exported so a page does not have to know the merged scope's storage key. */
export { SCOPE_KEY_FOR_MERGED };
