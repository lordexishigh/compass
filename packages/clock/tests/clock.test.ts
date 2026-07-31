import { describe, expect, it } from 'vitest';

import {
  type Clock,
  FixedClock,
  MILLIS_PER_HOUR,
  SimulatedClock,
  SystemClock,
  instantFromIso,
  isInstant,
  toIso,
} from '@compass/clock';

const anchor = instantFromIso('2026-07-30T08:12:00.000Z');

describe('FixedClock', () => {
  it('returns the exact instant it was constructed with, on every call', () => {
    const clock = new FixedClock(anchor);

    const readings = Array.from({ length: 1_000 }, () => clock.now());

    expect(new Set(readings).size).toBe(1);
    expect(readings[0]).toBe(anchor);
    expect(toIso(clock.now())).toBe('2026-07-30T08:12:00.000Z');
  });

  it('does not drift while other work happens', () => {
    const clock = new FixedClock(anchor);
    const before = clock.now();

    let accumulator = 0;
    for (let index = 0; index < 2_000_000; index += 1) accumulator += index;

    expect(accumulator).toBeGreaterThan(0);
    expect(clock.now()).toBe(before);
  });
});

describe('SimulatedClock', () => {
  it('only moves when the caller steps it', () => {
    const clock = new SimulatedClock(anchor);

    expect(clock.now()).toBe(anchor);
    expect(clock.now()).toBe(anchor);

    clock.advanceBy(2 * MILLIS_PER_HOUR);
    expect(toIso(clock.now())).toBe('2026-07-30T10:12:00.000Z');

    clock.advanceTo(anchor);
    expect(clock.isAt(anchor)).toBe(true);
  });

  it('steps backwards, because that is what time travel means', () => {
    const clock = new SimulatedClock(anchor);
    clock.advanceBy(-24 * MILLIS_PER_HOUR);

    expect(toIso(clock.now())).toBe('2026-07-29T08:12:00.000Z');
  });
});

describe('SystemClock', () => {
  it('is the only clock that reads the host and still returns a plain Instant', () => {
    const clock: Clock = new SystemClock();
    const reading = clock.now();

    expect(isInstant(reading)).toBe(true);
    expect(reading).toBeGreaterThan(instantFromIso('2020-01-01T00:00:00Z'));
  });

  it('satisfies the same port as the deterministic clocks', () => {
    const clocks: readonly Clock[] = [new SystemClock(), new FixedClock(anchor), new SimulatedClock(anchor)];

    for (const clock of clocks) {
      expect(typeof clock.now).toBe('function');
      expect(isInstant(clock.now())).toBe(true);
    }
  });
});
