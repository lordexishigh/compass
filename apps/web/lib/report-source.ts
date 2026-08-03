import { SystemClock } from '@compass/clock';
import { ScopedDb, ingestRunRowId, orgScope, type CompassDatabase } from '@compass/db';
import { narratorFromEnvironment } from '@compass/narrator';
import { ensureDailyReport, loadFreshnessFor, type EnsuredReport } from '@compass/pipeline';
import { SeedConnector, resolveSeededRun, type SeededRun } from '@compass/seed-connector';

import {
  organizationIsUnprovisioned,
  readFirstRunReadiness,
  type FirstRunStep,
} from './first-run-source';
import { resolveProvider } from './foundation-report';
import { buildReportView, type ReportView } from './view-model';

/**
 * The request edge.
 *
 * This is one of the two places in Compass allowed to construct a Clock (the
 * other is the worker). It resolves `now` once, picks the connector, opens the
 * pool, and hands all three down as parameters. Nothing below this file reads the
 * time or decides which provider answered — which is why the pipeline this page
 * calls is the same one the worker calls, running against the same code path a
 * live GitHub connector would.
 *
 * The read path is allowed to write, once, and only here: `ensureDailyReport`
 * generates today's report if the boot script has not. That is the whole of the
 * zero-config promise — a manager opens `/` on a cold container and reads a
 * report, with no login wall, no connector wizard and no empty state.
 */

/**
 * The pool moved to `lib/database.ts` and is re-exported here.
 *
 * Every existing caller imports `database` from this module, so the name stays; what
 * changed is that `lib/health.ts` can now reach the same pool without importing the report
 * path — `/api/health` has to be the lightest route in the app, not the one that loads the
 * analysis core and the narrator before it can say whether Postgres answered.
 */
import { database } from './database';

export { database };

/**
 * Which report this request is about.
 *
 * Resolved through the shared `resolveSeededRun`, never decided here: the boot
 * script calls the same function with its own instant, so the report it warmed
 * and the report this request looks for are the same row rather than two rows for
 * one day. The Clock is constructed here because this is a process edge; the
 * instant it produces is the only thing handed downward.
 */
export function requestedRun(): SeededRun {
  return resolveSeededRun({ hostNow: new SystemClock().now() });
}

/**
 * Today's report, generated on demand if nobody has generated it yet.
 *
 * The boot script normally gets there first, so this is usually a read. When it
 * is not — a container restarted past midnight, a day nobody scheduled — the
 * read path generates, which is what makes the page unable to show an empty
 * state. `ensureDailyReport` is keyed by `(organization, scope, report date)`, so
 * two requests racing on a cold start land on the same row rather than on two.
 */
export async function ensureTodaysReport(database_: CompassDatabase): Promise<{
  readonly ensured: EnsuredReport;
  readonly run: SeededRun;
}> {
  const run = requestedRun();
  const connector = new SeedConnector(run.dataset);

  const ensured = await ensureDailyReport({
    organizationId: run.organizationId,
    scope: { kind: 'team', teamKey: run.teamKey },
    now: run.now,
    timezone: run.timezone,
    window: run.window,
    ingestWindow: run.ingestWindow,
    runId: ingestRunRowId(
      run.organizationId,
      connector.connectorId,
      run.ingestWindow.start,
      run.ingestWindow.end,
      1,
    ),
    connector,
    database: database_,
    // Resolved at the edge, exactly like the connector and the clock. Null when
    // `ANTHROPIC_API_KEY` is absent, which is the zero-config default: the report
    // is then the deterministic render, complete and correct, with no fallback
    // flag — nothing was attempted, so nothing degraded.
    narrator: narratorFromEnvironment(process.env),
  });

  return { ensured, run };
}

/**
 * Everything the page needs, already formatted in the team's timezone, so the
 * component tree does no date arithmetic and needs no clock of its own.
 *
 * A degraded substrate is stated in the same place the day shift is: both are
 * reasons the page in front of the reader is not the page they would get on a
 * healthy deployment, and neither may be silent.
 */
export async function loadReportView(): Promise<ReportView> {
  const { ensured, run } = await ensureTodaysReport(database());

  const notes = [run.degradation, run.timeShiftNote].filter(
    (note): note is string => note !== null && note.length > 0,
  );

  return buildReportView({
    bundle: ensured.bundle,
    freshness: ensured.freshness,
    timeShiftNote: notes.length === 0 ? null : notes.join(' '),
  });
}

/**
 * What `/` has to render: a report, or the reason there is not one.
 *
 * ## Why the check happens before `ensureDailyReport` and not after
 *
 * Generating first and inspecting the result afterwards would be the obvious order and it is
 * the wrong one. `ensureDailyReport` *persists* — an unprovisioned organization would end up
 * with a stored report asserting six empty sections about a team that does not exist, and
 * that row would then be served by the archive, the merged view and every subscription,
 * forever. So the question is asked first, and the write does not happen at all.
 *
 * ## Why this does not weaken the zero-config promise
 *
 * The seeded tenant has teams and people from boot, so it takes the report branch on the very
 * first request exactly as before — the extra cost is one roster read. The guide branch is
 * reachable only by an organization that has genuinely never been configured, which the
 * demonstration deployment never is. And a *quiet* day still renders six sections: this asks
 * whether there is a subject, not whether the subject did anything.
 */
export type HomeView =
  | { readonly kind: 'report'; readonly view: ReportView }
  | {
      readonly kind: 'unprovisioned';
      readonly steps: readonly FirstRunStep[];
      readonly reportExists: boolean;
    };

export async function loadHomeView(): Promise<HomeView> {
  const run = requestedRun();
  const scoped = new ScopedDb(database(), orgScope(run.organizationId));

  const readiness = await readFirstRunReadiness({
    scoped,
    organizationId: run.organizationId,
    now: run.now,
  });

  if (organizationIsUnprovisioned(readiness)) {
    return { kind: 'unprovisioned', steps: readiness.steps, reportExists: readiness.reportExists };
  }

  return { kind: 'report', view: await loadReportView() };
}

/** Freshness on its own, for a surface that must not generate anything. */
export async function loadFreshnessOnly(): Promise<Awaited<ReturnType<typeof loadFreshnessFor>>> {
  const provider = resolveProvider();
  return loadFreshnessFor(database(), provider.organizationId, provider.datasetWindow);
}
