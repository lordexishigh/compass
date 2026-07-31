import { describe, expect, it } from 'vitest';

import {
  InvalidCivilDateError,
  InvalidTimeZoneError,
  MILLIS_PER_HOUR,
  addDaysInZone,
  assertValidTimeZone,
  civilDayWindow,
  differenceInMillis,
  formatCivilDate,
  formatCivilDateTime,
  instantFromIso,
  isSameCivilDay,
  isValidTimeZone,
  isWeekend,
  startOfCivilDate,
  startOfDayInZone,
  toIso,
  windowDurationMillis,
  zoneOffsetMinutes,
  zonedParts,
} from '@compass/clock';

describe('civil time in a zone', () => {
  it('reads wall-clock parts in the team zone, not the host zone', () => {
    const instant = instantFromIso('2026-07-30T08:12:34Z');

    expect(zonedParts(instant, 'Europe/London')).toMatchObject({
      year: 2026,
      month: 7,
      day: 30,
      hour: 9,
      minute: 12,
      second: 34,
      weekday: 4,
    });
    expect(zonedParts(instant, 'Asia/Kolkata')).toMatchObject({ hour: 13, minute: 42 });
    expect(zonedParts(instant, 'America/New_York')).toMatchObject({ day: 30, hour: 4 });
  });

  it('reports the offset including half-hour zones', () => {
    const winter = instantFromIso('2026-01-15T12:00:00Z');
    const summer = instantFromIso('2026-07-15T12:00:00Z');

    expect(zoneOffsetMinutes(winter, 'Asia/Kolkata')).toBe(330);
    expect(zoneOffsetMinutes(winter, 'America/New_York')).toBe(-300);
    expect(zoneOffsetMinutes(summer, 'America/New_York')).toBe(-240);
    expect(zoneOffsetMinutes(winter, 'UTC')).toBe(0);
  });

  it('finds the first instant of the civil day', () => {
    // 00:40 on 31 July in London, still 30 July in UTC — the day boundary is
    // the team's, not the server's.
    const instant = instantFromIso('2026-07-30T23:40:00Z');

    expect(toIso(startOfDayInZone(instant, 'Europe/London'))).toBe('2026-07-30T23:00:00.000Z');
    expect(toIso(startOfDayInZone(instant, 'UTC'))).toBe('2026-07-30T00:00:00.000Z');
    expect(formatCivilDate(instant, 'Europe/London')).toBe('2026-07-31');
    expect(formatCivilDate(instant, 'UTC')).toBe('2026-07-30');
  });

  it('keeps the wall-clock time when adding calendar days across a spring transition', () => {
    // US DST begins 2026-03-08 at 02:00 local.
    const before = instantFromIso('2026-03-07T17:00:00Z'); // 12:00 in New York, EST
    const next = addDaysInZone(before, 'America/New_York', 1);

    expect(formatCivilDateTime(next, 'America/New_York')).toBe('2026-03-08 12:00');
    expect(differenceInMillis(next, before)).toBe(23 * MILLIS_PER_HOUR);
  });

  it('keeps the wall-clock time when adding calendar days across an autumn transition', () => {
    // US DST ends 2026-11-01 at 02:00 local.
    const before = instantFromIso('2026-10-31T16:00:00Z'); // 12:00 in New York, EDT
    const next = addDaysInZone(before, 'America/New_York', 1);

    expect(formatCivilDateTime(next, 'America/New_York')).toBe('2026-11-01 12:00');
    expect(differenceInMillis(next, before)).toBe(25 * MILLIS_PER_HOUR);
  });

  it('produces a 23-hour and a 25-hour civil day at the DST boundaries', () => {
    const springForward = civilDayWindow(instantFromIso('2026-03-08T18:00:00Z'), 'America/New_York');
    const fallBack = civilDayWindow(instantFromIso('2026-11-01T18:00:00Z'), 'America/New_York');
    const ordinary = civilDayWindow(instantFromIso('2026-07-30T18:00:00Z'), 'America/New_York');

    expect(windowDurationMillis(springForward)).toBe(23 * MILLIS_PER_HOUR);
    expect(windowDurationMillis(fallBack)).toBe(25 * MILLIS_PER_HOUR);
    expect(windowDurationMillis(ordinary)).toBe(24 * MILLIS_PER_HOUR);
  });

  it('resolves a civil date string in a zone', () => {
    expect(toIso(startOfCivilDate('2026-07-30', 'Europe/London'))).toBe('2026-07-29T23:00:00.000Z');
    expect(toIso(startOfCivilDate('2026-01-30', 'Europe/London'))).toBe('2026-01-30T00:00:00.000Z');
    expect(() => startOfCivilDate('30/07/2026', 'UTC')).toThrow(InvalidCivilDateError);
    expect(() => startOfCivilDate('2026-13-01', 'UTC')).toThrow(InvalidCivilDateError);
  });

  it('answers same-day and weekend questions in the team zone', () => {
    const lateInLondon = instantFromIso('2026-07-30T23:30:00Z'); // already 31 July in London
    const alsoLate = instantFromIso('2026-07-30T23:45:00Z');

    expect(isSameCivilDay(lateInLondon, alsoLate, 'Europe/London')).toBe(true);
    expect(isSameCivilDay(lateInLondon, instantFromIso('2026-07-30T12:00:00Z'), 'Europe/London')).toBe(false);
    expect(isWeekend(instantFromIso('2026-08-01T12:00:00Z'), 'UTC')).toBe(true);
    expect(isWeekend(instantFromIso('2026-07-31T12:00:00Z'), 'UTC')).toBe(false);
  });

  it('rejects an unknown zone by name', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Middle/Earth')).toBe(false);
    expect(() => assertValidTimeZone('Middle/Earth')).toThrow(InvalidTimeZoneError);
  });
});
