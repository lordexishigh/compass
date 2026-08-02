import {
  buildWeeklyDigest,
  mergeTeamReports,
  type MergedReport,
  type StructuredReport,
  type WeeklyDigest,
} from '@compass/analysis';
import { previousCivilDayWindow, type Instant, type TimeWindow } from '@compass/clock';
import type { StoredReportBundle } from '@compass/db';
import {
  renderMergedReport,
  renderWeeklyDigest,
  type RenderedMergedReport,
  type RenderedWeeklyDigest,
} from '@compass/renderers';

import { ensureDailyReport, type EnsureReportRequest, type EnsuredReport } from './ensure-report.js';

/**
 * The merged cross-team report and the weekly digest, both through the real pipeline.
 *
 * ## Why neither of these forks the report path
 *
 * They do not generate anything. Both call `ensureDailyReport` — the one generation entry point the
 * worker and the web edge already share — once per team, and then read the *stored* structured payload
 * back out. So the "not a precomputed mock" and "real pipeline" criteria hold by construction rather
 * than by discipline: there is no second analysis here to drift from the first, and a merged item can
 * never state a number the per-team report it links into disagrees with.
 *
 * ## Why the merged report is not persisted
 *
 * It is a *derived view*, not a record. Every fact in it belongs to a per-team report that is already
 * stored, already permalinked and already archived; the merged report adds only a ranking and a budget,
 * both of which are pure functions of those rows. Persisting it would need a second report shape in the
 * schema, a second archive path, and — the real cost — a second copy of every headline that could fall
 * out of step with the one it was copied from.
 *
 * The archive therefore renders a past merged report by re-merging that date's stored per-team reports,
 * which is why it can never disagree with them. The existing `scopeKind: 'merged'` row is a different
 * object and stays what it was: the six-section analysis over an org-wide snapshot.
 */

export interface EnsureMergedReportRequest extends Omit<EnsureReportRequest, 'scope'> {
  /**
   * The teams to merge, in any order.
   *
   * Order is deliberately not meaningful: `mergeTeamReports` ranks by action impact and breaks ties on
   * the item id, so the same set of teams produces the same page however it was listed. Passing them in
   * a different order is what `tests/merged-report.test.ts` uses to prove it.
   */
  readonly teamKeys: readonly string[];
}

export interface EnsuredMergedReport {
  readonly merged: MergedReport;
  readonly rendered: RenderedMergedReport;
  /** Each team's own report, so the caller can link down without a second read. */
  readonly teamReports: readonly EnsuredTeamReport[];
  /** True when at least one team's report had to be generated for this instant. */
  readonly generated: boolean;
}

export interface EnsuredTeamReport {
  readonly teamKey: string;
  readonly bundle: StoredReportBundle;
  readonly report: StructuredReport;
}

export class MergedReportUnavailableError extends Error {
  constructor(detail: string) {
    super(`Compass could not produce a merged report: ${detail}`);
    this.name = 'MergedReportUnavailableError';
  }
}

/**
 * The structured report a stored row carries, parsed back out.
 *
 * `payload_json` is the canonical serialisation the analysis core emitted, stored verbatim, so this is
 * the *same object* the per-team page renders rather than a reconstruction from the section rows. That
 * matters for the merged report specifically: it reads `severityScore`, `changeTag` and `firstSeenAt`
 * off every item, and those live in the payload rather than in the section rows the page reads.
 */
export function structuredReportFrom(bundle: StoredReportBundle): StructuredReport {
  return JSON.parse(bundle.report.payloadJson) as StructuredReport;
}

/**
 * Ensures each team's daily report for this instant, then merges them.
 *
 * Sequential rather than concurrent, and that is not laziness: each `ensureDailyReport` may *write*, and
 * they share one ingest run id and one connector. Running them in parallel would have several teams
 * ingesting the same window into the same knowledge model at once, which the model tolerates but which
 * makes the ingest journal unreadable — one run row per team per window, interleaved. The seeded org has
 * three teams and the whole loop is well under a second.
 */
export async function ensureMergedReport(request: EnsureMergedReportRequest): Promise<EnsuredMergedReport> {
  if (request.teamKeys.length === 0) {
    throw new MergedReportUnavailableError(
      'no team was named. A merged report is a ranking across teams, and there is nothing to rank across none.',
    );
  }

  const window = request.window ?? previousCivilDayWindow(request.now, request.timezone);
  const teamReports: EnsuredTeamReport[] = [];
  let generated = false;

  for (const teamKey of [...request.teamKeys].sort()) {
    const ensured: EnsuredReport = await ensureDailyReport({
      ...request,
      scope: { kind: 'team', teamKey },
      window,
    });
    if (ensured.generated) generated = true;
    teamReports.push({ teamKey, bundle: ensured.bundle, report: structuredReportFrom(ensured.bundle) });
  }

  const merged = mergeTeamReports({
    organizationId: request.organizationId,
    instant: request.now,
    timezone: request.timezone,
    window,
    teamReports: teamReports.map((entry) => ({
      teamKey: entry.teamKey,
      report: entry.report,
      reportId: entry.bundle.report.id,
    })),
  });

  // The budget is asserted inside the renderer, over the finished prose. A merged report that could not
  // be rendered inside its budget is a generation failure rather than a page somebody reads.
  return { merged, rendered: renderMergedReport(merged), teamReports, generated };
}

export interface EnsureWeeklyDigestRequest extends Omit<EnsureReportRequest, 'scope'> {
  readonly teamKey: string;
}

export interface EnsuredWeeklyDigest {
  readonly digest: WeeklyDigest;
  readonly rendered: RenderedWeeklyDigest;
  readonly bundle: StoredReportBundle;
  readonly generated: boolean;
}

/**
 * The weekly digest for one team at one instant.
 *
 * Built from that instant's daily report, which is what makes it deterministic for
 * `(organization, team, instant)`: the daily is already byte-identical for those three, and the digest is
 * a pure function of it. Nothing here reads a clock, so a digest generated for a past instant covers
 * that instant's week — which is what makes it replayable under the time-travel control rather than
 * always describing the week ending today.
 */
export async function ensureWeeklyDigest(request: EnsureWeeklyDigestRequest): Promise<EnsuredWeeklyDigest> {
  const ensured = await ensureDailyReport({ ...request, scope: { kind: 'team', teamKey: request.teamKey } });
  const digest = buildWeeklyDigest({
    teamKey: request.teamKey,
    report: structuredReportFrom(ensured.bundle),
  });

  return { digest, rendered: renderWeeklyDigest(digest), bundle: ensured.bundle, generated: ensured.generated };
}

/**
 * Merges per-team reports that are already stored, without generating anything.
 *
 * The archive's path. A past merged report is re-derived from that date's per-team rows rather than read
 * from a merged row of its own, so it cannot drift from the reports it points at — and a date with no
 * stored reports returns null rather than quietly generating one, because an archive that wrote to the
 * database when a skip-level opened last Tuesday would not be an archive.
 */
export function mergeStoredReports(input: {
  readonly organizationId: string;
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly teamReports: readonly { readonly teamKey: string; readonly bundle: StoredReportBundle }[];
}): { readonly merged: MergedReport; readonly rendered: RenderedMergedReport } | null {
  if (input.teamReports.length === 0) return null;

  const merged = mergeTeamReports({
    organizationId: input.organizationId,
    instant: input.instant,
    timezone: input.timezone,
    window: input.window,
    teamReports: input.teamReports.map((entry) => ({
      teamKey: entry.teamKey,
      report: structuredReportFrom(entry.bundle),
      reportId: entry.bundle.report.id,
    })),
  });

  return { merged, rendered: renderMergedReport(merged) };
}
