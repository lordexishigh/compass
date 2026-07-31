import { describe, expect, it } from 'vitest';

import {
  InvalidTimeWindowError,
  MILLIS_PER_HOUR,
  formatWindow,
  instantFromIso,
  isEmptyWindow,
  previousCivilDayWindow,
  splitWindow,
  timeWindow,
  trailingWindow,
  windowContains,
  windowContainsWindow,
  windowDurationMillis,
  windowsAreEqual,
  windowsOverlap,
} from '@compass/clock';

const start = instantFromIso('2026-07-30T00:00:00Z');
const middle = instantFromIso('2026-07-30T12:00:00Z');
const end = instantFromIso('2026-07-31T00:00:00Z');

describe('TimeWindow', () => {
  it('is half-open: the start instant is inside, the end instant is not', () => {
    const window = timeWindow(start, end);

    expect(windowContains(window, start)).toBe(true);
    expect(windowContains(window, middle)).toBe(true);
    expect(windowContains(window, end)).toBe(false);
    expect(windowContains(window, instantFromIso('2026-07-29T23:59:59.999Z'))).toBe(false);
  });

  it('tiles the timeline with no gap and no double count', () => {
    const [first, second] = splitWindow(timeWindow(start, end), middle);

    expect(first.end).toBe(second.start);
    expect(windowContains(first, middle)).toBe(false);
    expect(windowContains(second, middle)).toBe(true);
    expect(windowDurationMillis(first) + windowDurationMillis(second)).toBe(24 * MILLIS_PER_HOUR);
  });

  it('rejects an end before the start', () => {
    expect(() => timeWindow(end, start)).toThrow(InvalidTimeWindowError);
    expect(() => splitWindow(timeWindow(start, middle), end)).toThrow(InvalidTimeWindowError);
  });

  it('allows a degenerate empty window that contains nothing', () => {
    const empty = timeWindow(start, start);

    expect(isEmptyWindow(empty)).toBe(true);
    expect(windowContains(empty, start)).toBe(false);
    expect(windowDurationMillis(empty)).toBe(0);
  });

  it('answers containment and overlap under half-open semantics', () => {
    const day = timeWindow(start, end);
    const morning = timeWindow(start, middle);
    const nextDay = timeWindow(end, instantFromIso('2026-08-01T00:00:00Z'));

    expect(windowContainsWindow(day, morning)).toBe(true);
    expect(windowContainsWindow(morning, day)).toBe(false);
    expect(windowsOverlap(day, morning)).toBe(true);
    // Abutting windows do not overlap — that is the whole point of half-open.
    expect(windowsOverlap(day, nextDay)).toBe(false);
    expect(windowsAreEqual(day, timeWindow(start, end))).toBe(true);
  });

  it('derives the previous civil day in the team zone', () => {
    const window = previousCivilDayWindow(instantFromIso('2026-07-30T08:12:00Z'), 'Europe/London');

    expect(formatWindow(window)).toBe('[2026-07-28T23:00:00.000Z, 2026-07-29T23:00:00.000Z)');
  });

  it('derives a trailing window ending at the instant', () => {
    const window = trailingWindow(instantFromIso('2026-07-30T08:00:00Z'), 14);

    expect(formatWindow(window)).toBe('[2026-07-16T08:00:00.000Z, 2026-07-30T08:00:00.000Z)');
  });

  it('is frozen, so a stage cannot widen a window it was handed', () => {
    const window = timeWindow(start, end);

    expect(Object.isFrozen(window)).toBe(true);
  });
});
