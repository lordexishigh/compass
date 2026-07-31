import {
  type Instant,
  compareInstants,
  instantFromEpochMillis,
  toEpochMillis,
  toIso,
  MILLIS_PER_DAY,
} from './instant.js';
import { type TimeZone, addDaysInZone, startOfDayInZone } from './zone.js';

/**
 * A half-open interval `[start, end)` — start is included, end is excluded.
 *
 * This is the single window type in the product. Every connector method, every
 * ingest run and every report scope takes one of these rather than a pair of
 * loose instants, so the boundary convention cannot drift per implementation:
 * consecutive windows tile the timeline with no gap and no double-count.
 */
export interface TimeWindow {
  readonly start: Instant;
  readonly end: Instant;
}

export class InvalidTimeWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTimeWindowError';
  }
}

export function timeWindow(start: Instant, end: Instant): TimeWindow {
  if (compareInstants(end, start) < 0) {
    throw new InvalidTimeWindowError(
      `A time window may not end before it starts: [${toIso(start)}, ${toIso(end)}).`,
    );
  }
  return Object.freeze({ start, end });
}

/** `start <= instant < end`. The one place half-openness is decided. */
export function windowContains(window: TimeWindow, instant: Instant): boolean {
  return instant >= window.start && instant < window.end;
}

export function isEmptyWindow(window: TimeWindow): boolean {
  return window.start === window.end;
}

export function windowDurationMillis(window: TimeWindow): number {
  return toEpochMillis(window.end) - toEpochMillis(window.start);
}

export function windowsOverlap(left: TimeWindow, right: TimeWindow): boolean {
  return left.start < right.end && right.start < left.end;
}

/** True when `inner` lies entirely within `outer` under half-open semantics. */
export function windowContainsWindow(outer: TimeWindow, inner: TimeWindow): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function windowsAreEqual(left: TimeWindow, right: TimeWindow): boolean {
  return left.start === right.start && left.end === right.end;
}

/**
 * Splits at `at`, producing `[start, at)` and `[at, end)`. Used by the connector
 * contract suite to prove half-openness: the two halves must partition the
 * whole exactly, with no record appearing in both or in neither.
 */
export function splitWindow(window: TimeWindow, at: Instant): readonly [TimeWindow, TimeWindow] {
  if (!windowContains(window, at) && at !== window.end) {
    throw new InvalidTimeWindowError(
      `Split point ${toIso(at)} lies outside [${toIso(window.start)}, ${toIso(window.end)}).`,
    );
  }
  return [timeWindow(window.start, at), timeWindow(at, window.end)];
}

/** The window covering the civil day containing `instant`, in `zone`. */
export function civilDayWindow(instant: Instant, zone: TimeZone): TimeWindow {
  const start = startOfDayInZone(instant, zone);
  const end = startOfDayInZone(addDaysInZone(start, zone, 1), zone);
  return timeWindow(start, end);
}

/** The window covering the civil day before the one containing `instant`. */
export function previousCivilDayWindow(instant: Instant, zone: TimeZone): TimeWindow {
  const today = civilDayWindow(instant, zone);
  const start = startOfDayInZone(addDaysInZone(today.start, zone, -1), zone);
  return timeWindow(start, today.start);
}

/** A trailing window of exactly `days` × 24h ending at `instant`. */
export function trailingWindow(instant: Instant, days: number): TimeWindow {
  return timeWindow(instantFromEpochMillis(toEpochMillis(instant) - days * MILLIS_PER_DAY), instant);
}

export function formatWindow(window: TimeWindow): string {
  return `[${toIso(window.start)}, ${toIso(window.end)})`;
}
