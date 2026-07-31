import { previousCivilDayWindow, type Instant, type TimeWindow } from '@compass/clock';

import type { SeedDataset } from './dataset.js';
import { FOUNDATION_WINDOW, foundationDataset } from './foundation-dataset.js';
import { resolveSeededInstant } from './report-instant.js';
import { seedBundle } from './seed-dataset.js';

/**
 * The whole of "which report the seeded deployment is about", in one function.
 *
 * Two processes generate reports for the demo organization: the boot script, so
 * that the first request is a read rather than a two-second generate, and the web
 * request edge, so that a container restarted past midnight still answers. If
 * those two disagreed about the organization, the team, the timezone or the
 * instant, they would write *two* reports for what a manager thinks is one day
 * and race to overwrite each other — and the page would flicker between them.
 *
 * So neither edge decides any of it. Both call this, both pass in nothing but
 * their own `hostNow` from their own Clock, and both get the same answer. The one
 * thing this cannot own is the database-derived `runId`, because `@compass/db`
 * sits above the port and this package sits beside it; that id is derived
 * deterministically from the window below, so both edges compute it identically
 * anyway and it never enters the report's identity.
 *
 * `report-instant.ts` explains the day-shifting rule this composes with: a seeded
 * substrate ends on a fixed day, and Compass would rather report a real day and
 * say which one than report today and be honestly empty.
 */

/** The tenant the zero-config demo opens on. */
export const SEEDED_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

/** The team the report is scoped to when the deployment names none. */
export const DEFAULT_TEAM_KEY = 'platform';

/** The zone a report is dated in when the deployment names none. */
export const DEFAULT_TIMEZONE = 'Europe/London';

export const TEAM_KEY_ENV_VAR = 'COMPASS_DEFAULT_TEAM';
export const TIMEZONE_ENV_VAR = 'COMPASS_DEFAULT_TIMEZONE';

export function resolveTeamKey(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[TEAM_KEY_ENV_VAR];
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_TEAM_KEY;
}

export function resolveTimezone(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[TIMEZONE_ENV_VAR];
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_TIMEZONE;
}

/** Which substrate answered, and what to say when it is not the intended one. */
export interface ResolvedSubstrate {
  readonly dataset: SeedDataset;
  readonly organizationId: string;
  /** The span the substrate actually holds data for. */
  readonly datasetWindow: TimeWindow | null;
  /** The instant the substrate was authored to be "now". Null when unknown. */
  readonly datasetNow: Instant | null;
  /** Stated on the page when the substrate is not the one it should be. */
  readonly degradation: string | null;
}

/**
 * The generated seed, or the small foundation fixture with a sentence saying so.
 *
 * A missing `seed/generated/**` is a real condition on a checkout that has not
 * run `pnpm seed`. The page still renders — falling back is better than a stack
 * trace — but it names what is missing rather than presenting a thinner report as
 * if it were the whole picture.
 */
export function resolveSubstrate(): ResolvedSubstrate {
  try {
    const bundle = seedBundle();
    return {
      dataset: bundle.dataset,
      organizationId: bundle.organizationId,
      datasetWindow: bundle.window,
      datasetNow: bundle.now,
      degradation: null,
    };
  } catch (error) {
    return {
      dataset: foundationDataset,
      organizationId: SEEDED_ORGANIZATION_ID,
      datasetWindow: FOUNDATION_WINDOW,
      datasetNow: FOUNDATION_WINDOW.end,
      degradation:
        'The seeded dataset could not be read, so this is running on the small foundation fixture instead. ' +
        `Run \`pnpm seed\` to generate it. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface SeededRunInput {
  /** The host's own instant, resolved from a Clock at the process edge. */
  readonly hostNow: Instant;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SeededRun {
  readonly dataset: SeedDataset;
  readonly organizationId: string;
  readonly teamKey: string;
  readonly timezone: string;
  /** The instant the report is generated *for*. */
  readonly now: Instant;
  /** The window the report is about — the team's previous civil day. */
  readonly window: TimeWindow;
  /**
   * The window to pull through the connector.
   *
   * The whole substrate, not one day of it: a cold start has an empty knowledge
   * model, and a sprint that began three weeks ago cannot be reported on from
   * yesterday's records alone. Re-ingest is idempotent, so paying for the whole
   * span once per boot costs nothing on the second run.
   */
  readonly ingestWindow: TimeWindow;
  readonly datasetWindow: TimeWindow | null;
  /** Set when the report covers a day other than the host's own yesterday. */
  readonly timeShiftNote: string | null;
  /** Set when the intended substrate was unreadable. */
  readonly degradation: string | null;
}

export function resolveSeededRun(input: SeededRunInput): SeededRun {
  const env = input.env ?? process.env;
  const timezone = resolveTimezone(env);
  const substrate = resolveSubstrate();

  const resolved = resolveSeededInstant({
    datasetWindow: substrate.datasetWindow,
    datasetNow: substrate.datasetNow,
    hostNow: input.hostNow,
    timezone,
  });

  return {
    dataset: substrate.dataset,
    organizationId: substrate.organizationId,
    teamKey: resolveTeamKey(env),
    timezone,
    now: resolved.now,
    window: resolved.window,
    ingestWindow: substrate.datasetWindow ?? resolved.window,
    datasetWindow: substrate.datasetWindow,
    timeShiftNote: resolved.note,
    degradation: substrate.degradation,
  };
}

/**
 * The civil day a run reports on, for a log line worth reading.
 *
 * Exported so the boot script can say which day it warmed without reaching for
 * the clock formatting itself.
 */
export const seededRunWindow = (now: Instant, timezone: string): TimeWindow =>
  previousCivilDayWindow(now, timezone);
