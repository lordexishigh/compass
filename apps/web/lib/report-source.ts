import { SystemClock } from '@compass/clock';
import {
  createDatabase,
  ingestRunRowId,
  resolveDatabaseUrl,
  type CompassDatabase,
  type DatabaseHandle,
} from '@compass/db';
import { ensureDailyReport, loadFreshnessFor, type EnsuredReport } from '@compass/pipeline';
import { SeedConnector, resolveSeededRun, type SeededRun } from '@compass/seed-connector';

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
 * One pool per process, cached across hot reloads.
 *
 * Next.js re-evaluates modules on every edit in development. Without this the
 * dev server opens a new pool per reload and PostgreSQL runs out of connections
 * within a few minutes of ordinary work.
 */
const POOL_KEY = Symbol.for('compass.web.database');
type PoolGlobal = typeof globalThis & { [POOL_KEY]?: DatabaseHandle };

export function database(): CompassDatabase {
  const cache = globalThis as PoolGlobal;
  const existing = cache[POOL_KEY];
  if (existing !== undefined) return existing.db;

  const handle = createDatabase(resolveDatabaseUrl('pooled'));
  cache[POOL_KEY] = handle;
  return handle.db;
}

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

/** Freshness on its own, for a surface that must not generate anything. */
export async function loadFreshnessOnly(): Promise<Awaited<ReturnType<typeof loadFreshnessFor>>> {
  const provider = resolveProvider();
  return loadFreshnessFor(database(), provider.organizationId, provider.datasetWindow);
}
