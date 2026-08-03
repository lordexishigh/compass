import { SystemClock, type Clock } from '@compass/clock';
import { resolveDatabaseUrl, withFirstRunLock } from '@compass/db';
import { resolveSeededRun } from '@compass/seed-connector';

import { coldStart, describeColdStart, type ColdStartResult } from './cold-start.js';
import { describeDemoAccountFile, writeDemoAccountFile, type WrittenDemoAccount } from './demo-account.js';

/**
 * First run, without a user action.
 *
 * ## The promise this keeps
 *
 * A clean checkout and one command has to end with a manager reading a report. `pnpm run
 * seed` does that explicitly, and the container entrypoint calls the same cold start —
 * but neither covers the case that actually bites: somebody who starts the worker
 * directly, or a deployment whose database was reset underneath a container that was
 * already running. So the worker checks, on every boot, whether this database has a
 * report in it, and seeds itself if it does not.
 *
 * ## Why the worker and not the web app
 *
 * The worker is the one process with an ordered startup: it boots, subscribes and then
 * waits. The web app is N request handlers with no start-up phase to hook, so the same
 * check there would have to run at module top level or on the first request — the first
 * races itself across workers, and the second puts a two-minute ingest in front of a
 * reader who asked for a page. `/` still generates a *report* on demand, which is a
 * different and much cheaper thing: the substrate is already there by then.
 *
 * ## What "already seeded" means
 *
 * One stored report for the seeded organization. Not a row count, and not the tenant row:
 * an interrupted first run can leave an organization and a roster behind with nothing to
 * read, and the question being asked is "could a manager open `/` right now and get what
 * they came for", whose answer is a report or nothing.
 *
 * Every step below it is idempotent anyway — drizzle records applied migrations,
 * `ensureOrganization` finds the row it would have created, an unchanged roster produces
 * no new entity versions, `bootstrapOwner` never overwrites a password, and
 * `ensureDailyReport` is keyed by `(organization, scope, report date)`. The check is
 * therefore about *cost*, not correctness: it keeps a restart from re-ingesting the whole
 * seeded substrate to arrive back where it started.
 */

/** Set to `1` to boot the worker without seeding, whatever state the database is in. */
export const DISABLE_FIRST_RUN_ENV_VAR = 'COMPASS_DISABLE_FIRST_RUN_SEED';

export type FirstRunOutcome =
  /** This process seeded the database and generated the first report. */
  | 'seeded'
  /** A report was already stored, so nothing was ingested or generated. */
  | 'already_seeded'
  /** Another process holds the first-run lock and is seeding right now. */
  | 'deferred'
  /** `COMPASS_DISABLE_FIRST_RUN_SEED` is set. */
  | 'disabled';

export interface FirstRunResult {
  readonly outcome: FirstRunOutcome;
  /** Present only when this process performed the seed. */
  readonly coldStart: ColdStartResult | null;
  /**
   * Present on every outcome that reached the database, including `already_seeded`.
   *
   * Rewritten on a restart on purpose: the file is how a harness signs in, and a boot that
   * found the database seeded but the file deleted would otherwise leave it deleted.
   */
  readonly demoAccount: WrittenDemoAccount | null;
}

export interface FirstRunOptions {
  /** The process edge's clock. The worker is one of the two places allowed to hold one. */
  readonly clock?: Clock;
  /** Seed even when a report is already stored. What `pnpm run seed --force` means. */
  readonly force?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export async function ensureFirstRun(options: FirstRunOptions = {}): Promise<FirstRunResult> {
  const env = options.env ?? process.env;

  if (env[DISABLE_FIRST_RUN_ENV_VAR] === '1') {
    return { outcome: 'disabled', coldStart: null, demoAccount: null };
  }

  const clock = options.clock ?? new SystemClock();
  // The same tenant resolution the report edge and the boot script use, so the report this
  // seeds is the row the first request looks for rather than a second one for the same day.
  const organizationId = resolveSeededRun({ hostNow: clock.now() }).organizationId;

  const result = await withFirstRunLock(resolveDatabaseUrl('direct'), async (session) => {
    if (options.force !== true && (await session.hasStoredReport(organizationId))) {
      return {
        outcome: 'already_seeded' as const,
        coldStart: null,
        demoAccount: writeDemoAccountFile({ env }),
      };
    }

    const seeded = await coldStart({
      clock,
      ...(options.force === true ? { force: true } : {}),
    });

    // After the seed, not before: the file says an owner seat exists, and until
    // `bootstrapOwner` has run inside the cold start, it does not.
    return {
      outcome: 'seeded' as const,
      coldStart: seeded,
      demoAccount: writeDemoAccountFile({ env }),
    };
  });

  // `null` means another process holds the lock. That is a success — the work is being
  // done, just not here — so this boot carries on and subscribes to its queues.
  return result ?? { outcome: 'deferred', coldStart: null, demoAccount: null };
}

/** The lines an operator reads at boot to know what happened and whether they can sign in. */
export function describeFirstRun(result: FirstRunResult): readonly string[] {
  const lines: string[] = [];

  switch (result.outcome) {
    case 'seeded':
      lines.push('[compass] first run: this database held no report, so the seeded organization was loaded.');
      if (result.coldStart !== null) lines.push(describeColdStart(result.coldStart));
      break;
    case 'already_seeded':
      lines.push('[compass] first run: a report is already stored, so nothing was ingested or generated.');
      break;
    case 'deferred':
      lines.push(
        '[compass] first run: another process holds the first-run lock and is seeding now — this one carries on.',
      );
      break;
    case 'disabled':
      lines.push(`[compass] first run: skipped, ${DISABLE_FIRST_RUN_ENV_VAR} is set.`);
      break;
  }

  if (result.demoAccount !== null) lines.push(describeDemoAccountFile(result.demoAccount));

  return lines;
}
