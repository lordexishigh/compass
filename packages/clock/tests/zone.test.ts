import { describe, expect, it } from 'vitest';

import {
  InvalidCivilDateError,
  InvalidLocalTimeError,
  InvalidTimeZoneError,
  MILLIS_PER_HOUR,
  addDaysInZone,
  assertValidTimeZone,
  civilDayWindow,
  differenceInMillis,
  formatCivilDate,
  formatCivilDateTime,
  instantAtLocalTime,
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

/**
 * A subscription's send time, resolved to the instant it actually happens.
 *
 * This is the primitive delivery scheduling is built on, so the DST cases are asserted here
 * rather than in the worker: a daily that arrives an hour late twice a year is exactly the
 * failure the acceptance criterion names, and it is a property of this function.
 */
describe('a wall-clock send time in a zone', () => {
  it('resolves the same civil time to different instants either side of a transition', () => {
    // London is UTC+0 in January and UTC+1 in July. 07:30 local is one clock time and two
    // different instants, which is the whole reason a send time cannot be stored as an offset.
    expect(toIso(instantAtLocalTime('2026-01-15', '07:30', 'Europe/London'))).toBe('2026-01-15T07:30:00.000Z');
    expect(toIso(instantAtLocalTime('2026-07-15', '07:30', 'Europe/London'))).toBe('2026-07-15T06:30:00.000Z');
  });

  it('keeps the wall-clock time across the spring transition, shortening the gap to 23 hours', () => {
    // 29 March 2026 is when Europe/London springs forward (GMT → BST).
    const before = instantAtLocalTime('2026-03-28', '07:30', 'Europe/London');
    const after = instantAtLocalTime('2026-03-29', '07:30', 'Europe/London');

    expect(differenceInMillis(after, before) / MILLIS_PER_HOUR, 'less elapsed time, same wall clock').toBe(23);
    // The point of the 23: the manager's daily still lands at 07:30 on their clock.
    expect(zonedParts(after, 'Europe/London').hour).toBe(7);
    expect(zonedParts(after, 'Europe/London').minute).toBe(30);
  });

  it('keeps the wall-clock time across the autumn transition, lengthening the gap to 25 hours', () => {
    // 25 October 2026 is when Europe/London falls back (BST → GMT).
    const before = instantAtLocalTime('2026-10-24', '07:30', 'Europe/London');
    const after = instantAtLocalTime('2026-10-25', '07:30', 'Europe/London');

    expect(differenceInMillis(after, before) / MILLIS_PER_HOUR).toBe(25);
    expect(zonedParts(after, 'Europe/London').hour).toBe(7);
  });

  it('still sends on a date whose wall-clock time the transition skipped', () => {
    // On 29 March 2026 London jumps 01:00 → 02:00, so 01:30 local never happens. A send time
    // that silently never occurred would be a daily that vanished for one day a year with no
    // error anywhere, so it resolves one offset-step later and still fires.
    const resolved = instantAtLocalTime('2026-03-29', '01:30', 'Europe/London');

    expect(toIso(resolved)).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedParts(resolved, 'Europe/London').hour, 'after the skipped hour, not inside it').toBe(2);
  });

  it('resolves a repeated wall-clock time to exactly one instant', () => {
    // 01:30 local happens twice on 25 October 2026: 00:30Z under BST and 01:30Z under GMT.
    // Which one is arbitrary; that it is *one* is not — the day's idempotency key is derived
    // from this instant, and two answers would mean two sends for one scheduled day.
    const resolved = instantAtLocalTime('2026-10-25', '01:30', 'Europe/London');

    expect(toIso(resolved), 'the post-transition occurrence').toBe('2026-10-25T01:30:00.000Z');
    expect(zonedParts(resolved, 'Europe/London').hour).toBe(1);
    expect(zonedParts(resolved, 'Europe/London').minute).toBe(30);
  });

  it('handles a zone with a half-hour offset and one with none', () => {
    expect(toIso(instantAtLocalTime('2026-07-15', '09:00', 'Asia/Kolkata'))).toBe('2026-07-15T03:30:00.000Z');
    expect(toIso(instantAtLocalTime('2026-07-15', '09:00', 'UTC'))).toBe('2026-07-15T09:00:00.000Z');
  });

  it('refuses a malformed date or time rather than guessing one', () => {
    expect(() => instantAtLocalTime('15/07/2026', '09:00', 'UTC')).toThrow(InvalidCivilDateError);
    expect(() => instantAtLocalTime('2026-07-15', '9:00', 'UTC')).toThrow(InvalidLocalTimeError);
    expect(() => instantAtLocalTime('2026-07-15', '24:00', 'UTC')).toThrow(InvalidLocalTimeError);
    expect(() => instantAtLocalTime('2026-07-15', '07:60', 'UTC')).toThrow(InvalidLocalTimeError);
  });
});
