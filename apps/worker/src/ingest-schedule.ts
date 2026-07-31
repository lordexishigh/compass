import {
  MILLIS_PER_HOUR,
  addMillis,
  isAfter,
  isAtOrAfter,
  timeWindow,
  toIso,
  type Instant,
  type TimeWindow,
} from '@compass/clock';
import type { SourceCoverageCursor } from '@compass/db';

/**
 * Where the next incremental ingest window starts, per source.
 *
 * ## The one rule
 *
 * **Consecutive windows leave no gap, and a source that could not answer does not advance.** Both
 * halves come from the same decision: the cursor is `covered_window_end` — how far the source was
 * actually *read* — and never `ingest_runs.window_end`, which is only how far it was *asked*.
 *
 * The two diverge exactly when it matters. A rate-limited source records `covered_window = null`,
 * so it contributes no cursor and the next window still begins where the last successful read
 * finished; the unread range is retried rather than skipped. A `partial` source advances only as
 * far as it got. Taking the requested end instead would have produced a silent permanent hole in
 * the model on every transient failure — the kind of bug that shows up weeks later as a report
 * that is quietly missing a day's commits.
 *
 * ## Why the windows are half-open and contiguous
 *
 * `[start, end)` with `start` equal to the previous `end`. An inclusive end would re-read the
 * boundary instant on every run; a `start` one millisecond later would skip anything stamped
 * exactly there. Contiguity is the property the acceptance criterion names, and it is a
 * consequence of reusing the previous end verbatim rather than arithmetic on it.
 */

/** How far back a source with no history at all is read on its first run. */
export const INGEST_BACKFILL_HOURS = 24;

/**
 * The longest window a single run will ask for.
 *
 * A worker that has been down for a week should not ask one source for a week in one request — a
 * provider would page or rate-limit it, and the run would be a large `partial` that is hard to
 * reason about. Capping means the cursor catches up over several ticks, each one small enough to
 * succeed, and each one advancing the cursor it earned.
 */
export const INGEST_MAX_WINDOW_HOURS = 24;

export interface IngestSourceWindow {
  readonly sourceKey: string;
  readonly window: TimeWindow;
  /** True when this source had no usable cursor and is being backfilled. */
  readonly backfilled: boolean;
  /** True when the window was capped, so the caller knows more remains. */
  readonly capped: boolean;
}

export interface NextIngestWindowsInput {
  /** Every source the connector declares, so a source with no history is still read. */
  readonly sourceKeys: readonly string[];
  readonly cursors: readonly SourceCoverageCursor[];
  readonly now: Instant;
  readonly backfillHours?: number;
  readonly maxWindowHours?: number;
}

/**
 * The next window for each source, or nothing for a source that is already current.
 *
 * Pure: no clock, no database. `now` is the window end, passed in from the worker's one clock,
 * which is what makes the contiguity and no-advance-on-failure properties assertable in a unit
 * test rather than only observable in production.
 */
export function nextIngestWindows(input: NextIngestWindowsInput): readonly IngestSourceWindow[] {
  const backfillHours = input.backfillHours ?? INGEST_BACKFILL_HOURS;
  const maxWindowHours = input.maxWindowHours ?? INGEST_MAX_WINDOW_HOURS;

  const cursorBySource = new Map(input.cursors.map((cursor) => [cursor.sourceKey, cursor]));
  const windows: IngestSourceWindow[] = [];

  for (const sourceKey of [...input.sourceKeys].sort()) {
    const cursor = cursorBySource.get(sourceKey);
    const backfilled = cursor === undefined;

    // No cursor means this source has never answered — either it is new, or every attempt so far
    // failed. Both are read from a bounded backfill rather than from the epoch.
    const start = backfilled ? addMillis(input.now, -backfillHours * MILLIS_PER_HOUR) : cursor.coveredThrough;

    // Already current, or somehow ahead of `now` (a clock moved backwards). Nothing to ask for;
    // asking for an empty or inverted window would make `timeWindow` throw.
    if (isAtOrAfter(start, input.now)) continue;

    const cap = addMillis(start, maxWindowHours * MILLIS_PER_HOUR);
    const capped = isAfter(input.now, cap);
    const end = capped ? cap : input.now;

    windows.push({ sourceKey, window: timeWindow(start, end), backfilled, capped });
  }

  return windows;
}

/**
 * One sentence describing a computed window, for the job log.
 *
 * Written out rather than left to a generic "ingesting…" line because the two facts an operator
 * needs when a day looks thin are exactly which range was asked for and whether it was a backfill.
 */
export const describeIngestWindow = (entry: IngestSourceWindow): string =>
  `${entry.sourceKey}: [${toIso(entry.window.start)}, ${toIso(entry.window.end)})` +
  (entry.backfilled ? ' (backfill: no prior coverage)' : '') +
  (entry.capped ? ' (capped; more remains)' : '');
