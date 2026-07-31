import { MILLIS_PER_HOUR, addMillis, differenceInMillis, instantFromIso, toIso, type Instant } from '@compass/clock';
import type { SourceCoverageCursor } from '@compass/db';
import { describe, expect, it } from 'vitest';

import {
  INGEST_BACKFILL_HOURS,
  INGEST_MAX_WINDOW_HOURS,
  describeIngestWindow,
  nextIngestWindows,
} from '../src/ingest-schedule.js';

/**
 * Incremental ingest windows.
 *
 * The acceptance criteria for this job are all properties of one pure function, which is why it is
 * one: "no gap between consecutive windows" and "does not advance past the unfetched range" are
 * assertions about arithmetic, and a test that had to run a real connector to check them would be
 * checking the connector instead.
 *
 * The distinction the whole design turns on: the cursor is how far a source was **read**
 * (`covered_window_end`), never how far it was **asked** (`ingest_runs.window_end`). The two differ
 * exactly when a source failed, and taking the second would silently skip the range that failed.
 */

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-03T12:00:00Z');

const cursor = (sourceKey: string, coveredThrough: string): SourceCoverageCursor => ({
  sourceKey,
  coveredThrough: at(coveredThrough),
  lastObservedAt: at(coveredThrough),
});

describe('consecutive windows', () => {
  it('start exactly where the last covered range ended, leaving no gap', () => {
    const windows = nextIngestWindows({
      sourceKeys: ['primary-code'],
      cursors: [cursor('primary-code', '2026-08-03T06:00:00Z')],
      now: NOW,
    });

    expect(windows).toHaveLength(1);
    expect(toIso(windows[0]!.window.start)).toBe('2026-08-03T06:00:00.000Z');
    expect(toIso(windows[0]!.window.end)).toBe('2026-08-03T12:00:00.000Z');
    expect(windows[0]!.backfilled).toBe(false);
  });

  it('chain with no gap and no overlap across three successive runs', () => {
    // The property stated directly: run, advance the cursor to what was covered, run again. The
    // end of each window is the start of the next, exactly.
    let cursors: readonly SourceCoverageCursor[] = [];
    const ends: string[] = [];
    const starts: string[] = [];

    for (const tick of ['2026-08-03T06:00:00Z', '2026-08-03T12:00:00Z', '2026-08-03T18:00:00Z']) {
      const [window] = nextIngestWindows({ sourceKeys: ['primary-code'], cursors, now: at(tick) });
      expect(window, `nothing due at ${tick}`).toBeDefined();

      starts.push(toIso(window!.window.start));
      ends.push(toIso(window!.window.end));
      // A complete read covers the whole requested window.
      cursors = [{ sourceKey: 'primary-code', coveredThrough: window!.window.end, lastObservedAt: at(tick) }];
    }

    expect(starts.slice(1)).toEqual(ends.slice(0, -1));
  });

  it('are half-open, so the boundary instant is read exactly once', () => {
    const boundary = '2026-08-03T06:00:00Z';
    const [window] = nextIngestWindows({
      sourceKeys: ['primary-code'],
      cursors: [cursor('primary-code', boundary)],
      now: NOW,
    });

    // `[start, end)`: the previous window's end is this window's start verbatim. One millisecond
    // later would skip anything stamped exactly on the boundary; earlier would re-read it.
    expect(toIso(window!.window.start)).toBe('2026-08-03T06:00:00.000Z');
  });
});

describe('a source that could not answer', () => {
  it('does not advance, so the unfetched range is retried rather than skipped', () => {
    // An unavailable source records `covered_window = null`, so `sourceCoverageCursors` yields no
    // cursor for it and the window still begins where the last successful read finished. This is
    // the criterion "SHALL NOT advance the window past the unfetched range".
    const beforeFailure = [cursor('primary-code', '2026-08-03T06:00:00Z')];

    const firstAttempt = nextIngestWindows({ sourceKeys: ['primary-code'], cursors: beforeFailure, now: NOW });
    // The fetch fails: nothing was covered, so the cursor is unchanged.
    const secondAttempt = nextIngestWindows({
      sourceKeys: ['primary-code'],
      cursors: beforeFailure,
      now: at('2026-08-03T18:00:00Z'),
    });

    expect(toIso(firstAttempt[0]!.window.start)).toBe('2026-08-03T06:00:00.000Z');
    // Same start: the failed range is asked for again, extended to the newer `now`.
    expect(toIso(secondAttempt[0]!.window.start)).toBe('2026-08-03T06:00:00.000Z');
    expect(toIso(secondAttempt[0]!.window.end)).toBe('2026-08-03T18:00:00.000Z');
  });

  it('advances only as far as a partial read actually got', () => {
    // A rate-limited source that paged halfway records a `covered_window` ending mid-request. The
    // next window starts there — not at the end it was asked for.
    const [window] = nextIngestWindows({
      sourceKeys: ['primary-code'],
      cursors: [cursor('primary-code', '2026-08-03T09:00:00Z')],
      now: NOW,
    });

    expect(toIso(window!.window.start)).toBe('2026-08-03T09:00:00.000Z');
  });

  it('does not hold up a source that is answering', () => {
    // One source failing must not stall the others: each has its own cursor and its own window.
    const windows = nextIngestWindows({
      sourceKeys: ['primary-code', 'primary-tracker'],
      cursors: [cursor('primary-tracker', '2026-08-03T11:00:00Z')],
      now: NOW,
    });

    const bySource = new Map(windows.map((entry) => [entry.sourceKey, entry]));
    expect(bySource.get('primary-tracker')!.backfilled).toBe(false);
    expect(bySource.get('primary-code')!.backfilled, 'no cursor yet, so a bounded backfill').toBe(true);
  });
});

describe('a source with no history at all', () => {
  it('is backfilled a bounded distance rather than from the epoch', () => {
    const [window] = nextIngestWindows({ sourceKeys: ['new-source'], cursors: [], now: NOW });

    expect(window!.backfilled).toBe(true);
    expect(differenceInMillis(window!.window.end, window!.window.start) / MILLIS_PER_HOUR).toBe(
      INGEST_BACKFILL_HOURS,
    );
    expect(toIso(window!.window.start)).toBe('2026-08-02T12:00:00.000Z');
  });

  it('honours an explicit backfill span', () => {
    const [window] = nextIngestWindows({
      sourceKeys: ['new-source'],
      cursors: [],
      now: NOW,
      backfillHours: 2,
    });

    expect(differenceInMillis(window!.window.end, window!.window.start) / MILLIS_PER_HOUR).toBe(2);
  });
});

describe('a worker that has been down', () => {
  it('caps one window rather than asking a source for a week at once', () => {
    // A week-long request would page or rate-limit, producing one large `partial` that is hard to
    // reason about. Capping means the cursor catches up over several ticks, each one earning its
    // own advance.
    const [window] = nextIngestWindows({
      sourceKeys: ['primary-code'],
      cursors: [cursor('primary-code', '2026-07-27T12:00:00Z')],
      now: NOW,
    });

    expect(window!.capped).toBe(true);
    expect(differenceInMillis(window!.window.end, window!.window.start) / MILLIS_PER_HOUR).toBe(
      INGEST_MAX_WINDOW_HOURS,
    );
    expect(toIso(window!.window.end)).toBe('2026-07-28T12:00:00.000Z');
  });

  it('catches up over successive ticks with no gap between the capped windows', () => {
    let cursors: readonly SourceCoverageCursor[] = [cursor('primary-code', '2026-08-01T12:00:00Z')];
    const spans: string[] = [];

    for (let tick = 0; tick < 3; tick += 1) {
      const [window] = nextIngestWindows({ sourceKeys: ['primary-code'], cursors, now: NOW });
      if (window === undefined) break;
      spans.push(`${toIso(window.window.start)}..${toIso(window.window.end)}`);
      cursors = [{ sourceKey: 'primary-code', coveredThrough: window.window.end, lastObservedAt: NOW }];
    }

    expect(spans).toEqual([
      '2026-08-01T12:00:00.000Z..2026-08-02T12:00:00.000Z',
      '2026-08-02T12:00:00.000Z..2026-08-03T12:00:00.000Z',
    ]);
    // Third tick: already current, so nothing is asked for.
    expect(spans).toHaveLength(2);
  });
});

describe('a source that is already current', () => {
  it('is asked for nothing rather than an empty window', () => {
    // `timeWindow` refuses an empty or inverted span, so a source whose cursor equals `now` must be
    // skipped here rather than producing a window the constructor would reject.
    expect(nextIngestWindows({ sourceKeys: ['primary-code'], cursors: [cursor('primary-code', toIso(NOW))], now: NOW })).toEqual(
      [],
    );
  });

  it('is skipped when its cursor is somehow ahead of now', () => {
    // A clock that moved backwards, or a cursor written by a host whose time was wrong. Skipping is
    // the safe direction: an inverted window would throw and take out the whole tick.
    const ahead = toIso(addMillis(NOW, MILLIS_PER_HOUR));
    expect(nextIngestWindows({ sourceKeys: ['primary-code'], cursors: [cursor('primary-code', ahead)], now: NOW })).toEqual(
      [],
    );
  });
});

describe('the log line for a window', () => {
  it('names the range, and says when it is a backfill or capped', () => {
    const [backfill] = nextIngestWindows({ sourceKeys: ['new-source'], cursors: [], now: NOW });
    expect(describeIngestWindow(backfill!)).toContain('backfill: no prior coverage');
    expect(describeIngestWindow(backfill!)).toContain('2026-08-02T12:00:00.000Z');

    const [capped] = nextIngestWindows({
      sourceKeys: ['primary-code'],
      cursors: [cursor('primary-code', '2026-07-27T12:00:00Z')],
      now: NOW,
    });
    expect(describeIngestWindow(capped!)).toContain('capped; more remains');
  });
});

describe('the scheduled ingest job projects into the model', () => {
  it('uses the model projection when one is supplied, and journals the same run', async () => {
    // The hollowness this guards: without a projection the job advances its cursor over a model
    // nothing is being written into, so the pipeline would look healthy and accumulate nothing.
    const { handleIngestWindow } = await import('../src/jobs.js');
    const { SeedConnector } = await import('@compass/seed-connector');

    const projected: { readonly runId: string; readonly windowStart: string }[] = [];
    const journalled: string[] = [];

    const summary = await handleIngestWindow(
      {
        connector: new SeedConnector(),
        persistIngestRun: async (run, ids) => {
          journalled.push(ids.runId);
          expect(run.window.start).toBeDefined();
        },
        projectIntoModel: async (request) => {
          projected.push({ runId: request.runId, windowStart: toIso(request.window.start) });
          return {
            connectorId: 'seed:test',
            organizationId: request.organizationId,
            window: request.window,
            startedAt: request.now,
            status: 'complete',
            totalRecords: 3,
            artifactCounts: {} as never,
            coverage: [],
            degradedDetails: [],
          } as never;
        },
        newId: () => 'run-1',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      {
        organizationId: '11111111-1111-4111-8111-111111111111',
        windowStart: '2026-08-03T06:00:00Z',
        windowEnd: '2026-08-03T12:00:00Z',
      },
      NOW,
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?.windowStart).toBe('2026-08-03T06:00:00.000Z');
    // One run id shared by the projection and the journal, so the coverage rows attach to the run
    // the model was actually written under.
    expect(projected[0]?.runId).toBe('run-1');
    expect(journalled).toEqual(['run-1']);
    expect(summary.totalRecords).toBe(3);
  });
});

describe('every source gets its own window', () => {
  it('returns them in a stable order', () => {
    // Deterministic ordering so a tick's log and its enqueued jobs read the same way every run.
    const windows = nextIngestWindows({
      sourceKeys: ['primary-tracker', 'archive-code', 'primary-code'],
      cursors: [],
      now: NOW,
    });

    expect(windows.map((entry) => entry.sourceKey)).toEqual(['archive-code', 'primary-code', 'primary-tracker']);
  });
});
