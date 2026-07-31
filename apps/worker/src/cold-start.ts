import { pathToFileURL } from 'node:url';

import { SystemClock, formatCivilDate, type Clock } from '@compass/clock';
import { createDatabase, ingestRunRowId, resolveDatabaseUrl, type CompassDatabase } from '@compass/db';
import { ensureDailyReport } from '@compass/pipeline';
import { SeedConnector, resolveSeededRun, type SeededRun } from '@compass/seed-connector';

import { bootstrap, type BootstrapResult } from './bootstrap.js';

/**
 * Cold start, all the way to a readable report.
 *
 * `bootstrap.ts` gets the schema, the tenant and the roster in place. That is
 * enough for the web app to *generate* a report on the first request, but not
 * enough for it to be a fast one: a fresh knowledge model means the first request
 * would ingest the whole seeded substrate before writing a byte of HTML, and the
 * zero-config promise is measured in the time to that first page.
 *
 * So this runs the pipeline at boot and leaves the report in the database. The
 * first request then finds the row and reads it. Nothing about the request path
 * changes — it still generates when it has to, which is what makes a container
 * restarted past midnight correct rather than stale — this only means it usually
 * does not have to.
 *
 * The instant, the organization, the team and both windows come from
 * `resolveSeededRun`, which the web edge also calls. That shared call is the whole
 * reason the row this writes is the row that request looks for; two independent
 * derivations would produce two reports for one day and overwrite each other.
 */

export interface ColdStartResult {
  readonly bootstrap: BootstrapResult;
  readonly run: SeededRun;
  readonly reportId: string;
  readonly reportDate: string;
  /** False when a report for the day already existed — a restart, normally. */
  readonly generated: boolean;
  readonly sectionCount: number;
  /** True when every configured source answered for the window. */
  readonly coverageComplete: boolean;
  readonly elapsedMillis: number;
}

export interface ColdStartOptions {
  /** The process edge's clock. The worker is one of the two allowed to hold one. */
  readonly clock?: Clock;
  /** Regenerate even when a report for the day already exists. */
  readonly force?: boolean;
}

/**
 * Generates the seeded organization's report for the day it can honestly cover.
 *
 * Separated from `coldStart` so a test can drive it against a migrated test
 * database without running migrations or provisioning a roster twice.
 */
export async function warmDailyReport(
  database: CompassDatabase,
  run: SeededRun,
  options: { readonly force?: boolean } = {},
): Promise<Omit<ColdStartResult, 'bootstrap' | 'elapsedMillis' | 'run'>> {
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
    database,
    ...(options.force === true ? { force: true } : {}),
  });

  return {
    reportId: ensured.bundle.report.id,
    reportDate: ensured.bundle.report.reportDate,
    generated: ensured.generated,
    sectionCount: ensured.bundle.sections.length,
    coverageComplete: ensured.bundle.report.coverageStatus === 'complete',
  };
}

export async function coldStart(options: ColdStartOptions = {}): Promise<ColdStartResult> {
  const clock = options.clock ?? new SystemClock();
  const startedAt = clock.now();

  const bootstrapped = await bootstrap();
  const run = resolveSeededRun({ hostNow: clock.now() });
  const handle = createDatabase(resolveDatabaseUrl('direct'));

  try {
    const warmed = await warmDailyReport(handle.db, run, {
      ...(options.force === true ? { force: true } : {}),
    });

    return {
      bootstrap: bootstrapped,
      run,
      ...warmed,
      elapsedMillis: clock.now() - startedAt,
    };
  } finally {
    await handle.close();
  }
}

/** One line an operator can read to know whether the container is ready. */
export function describeColdStart(result: ColdStartResult): string {
  const day = formatCivilDate(result.run.now, result.run.timezone);
  return (
    `[compass] cold start complete in ${(result.elapsedMillis / 1000).toFixed(1)}s: ` +
    `report ${result.reportId} for ${result.run.teamKey} on ${result.reportDate} ` +
    `(${result.generated ? 'generated' : 'already present'}), ${result.sectionCount} sections, ` +
    `coverage ${result.coverageComplete ? 'complete' : 'incomplete — the report says which source is missing'}, ` +
    `reporting on ${day}.`
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(entryPoint).href === import.meta.url) {
  coldStart({ force: process.argv.includes('--force') })
    .then((result) => {
      if (result.run.degradation !== null) console.warn(`[compass] ${result.run.degradation}`);
      if (result.run.timeShiftNote !== null) console.info(`[compass] ${result.run.timeShiftNote}`);
      console.info(describeColdStart(result));

      // Six sections or the container is not ready. A report missing a section
      // would render as a page missing a heading, and a boot that reported
      // success on that would make the smoke test the only thing that noticed.
      if (result.sectionCount !== 6) {
        console.error(`[compass] cold start wrote ${result.sectionCount} sections, not six.`);
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      console.error(`[compass] cold start failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
