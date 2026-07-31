import { describe, expect, it } from 'vitest';

import {
  EPOCH,
  InvalidInstantError,
  MILLIS_PER_DAY,
  addExactDays,
  addHours,
  compareInstants,
  differenceInMillis,
  earliest,
  instantFromEpochMillis,
  instantFromIso,
  isAfter,
  isAtOrAfter,
  isBefore,
  isInstant,
  latest,
  toEpochMillis,
  toIso,
} from '@compass/clock';

describe('Instant', () => {
  it('round-trips ISO-8601 through epoch millis', () => {
    const instant = instantFromIso('2026-07-30T08:12:00.000Z');
    expect(toIso(instant)).toBe('2026-07-30T08:12:00.000Z');
    expect(toEpochMillis(instant)).toBe(Date.parse('2026-07-30T08:12:00.000Z'));
  });

  it('accepts an explicit numeric offset', () => {
    expect(toIso(instantFromIso('2026-07-30T10:12:00+02:00'))).toBe('2026-07-30T08:12:00.000Z');
  });

  it('refuses a timestamp with no offset, because it would depend on the host zone', () => {
    expect(() => instantFromIso('2026-07-30T08:12:00')).toThrow(InvalidInstantError);
  });

  it('refuses nonsense', () => {
    expect(() => instantFromIso('not-a-timestamp')).toThrow(InvalidInstantError);
    expect(() => instantFromEpochMillis(Number.NaN)).toThrow(InvalidInstantError);
    expect(() => instantFromEpochMillis(1.5)).toThrow(InvalidInstantError);
    expect(() => instantFromEpochMillis(Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidInstantError);
  });

  it('orders and compares without any timezone involvement', () => {
    const early = instantFromIso('2026-07-30T08:00:00Z');
    const late = instantFromIso('2026-07-30T09:00:00Z');

    expect(compareInstants(early, late)).toBe(-1);
    expect(compareInstants(late, early)).toBe(1);
    expect(compareInstants(early, early)).toBe(0);
    expect(isBefore(early, late)).toBe(true);
    expect(isAfter(early, late)).toBe(false);
    expect(isAtOrAfter(early, early)).toBe(true);
    expect(earliest(late, early)).toBe(early);
    expect(latest(late, early)).toBe(late);
    expect(differenceInMillis(late, early)).toBe(3_600_000);
  });

  it('adds exact durations', () => {
    const start = instantFromIso('2026-07-30T08:00:00Z');
    expect(toIso(addHours(start, 3))).toBe('2026-07-30T11:00:00.000Z');
    expect(differenceInMillis(addExactDays(start, 2), start)).toBe(2 * MILLIS_PER_DAY);
  });

  it('recognises instants at runtime', () => {
    expect(isInstant(EPOCH)).toBe(true);
    expect(isInstant(1.25)).toBe(false);
    expect(isInstant('2026-07-30T08:00:00Z')).toBe(false);
    expect(isInstant(null)).toBe(false);
  });
});
