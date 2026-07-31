import { type Instant, instantFromEpochMillis, toEpochMillis, MILLIS_PER_MINUTE } from './instant.js';

/**
 * An IANA timezone name, e.g. `Europe/London`. Reports are scoped in the team's
 * calendar zone — "yesterday" is the team's previous working day, never a UTC
 * day boundary — so every civil-time helper takes the zone explicitly.
 */
export type TimeZone = string;

export class InvalidTimeZoneError extends Error {
  constructor(zone: string) {
    super(`\`${zone}\` is not an IANA timezone recognised by this runtime.`);
    this.name = 'InvalidTimeZoneError';
  }
}

export class InvalidCivilDateError extends Error {
  constructor(civilDate: string) {
    super(`\`${civilDate}\` is not a YYYY-MM-DD civil date.`);
    this.name = 'InvalidCivilDateError';
  }
}

/** Civil (wall-clock) time in some zone. `weekday` is ISO: 1 = Monday … 7 = Sunday. */
export interface ZonedDateParts {
  readonly zone: TimeZone;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly weekday: number;
}

const formatterCache = new Map<TimeZone, Intl.DateTimeFormat>();

function formatterFor(zone: TimeZone): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new InvalidTimeZoneError(zone);
  }
  formatterCache.set(zone, formatter);
  return formatter;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimeZone(zone: string): TimeZone {
  formatterFor(zone);
  return zone;
}

/** ISO weekday (1 = Monday … 7 = Sunday) for a civil date. */
function isoWeekday(year: number, month: number, day: number): number {
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

export function zonedParts(instant: Instant, zone: TimeZone): ZonedDateParts {
  const parts = formatterFor(zone).formatToParts(new Date(toEpochMillis(instant)));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number.parseInt(part.value, 10) : 0;
  };
  const year = read('year');
  const month = read('month');
  const day = read('day');
  return {
    zone,
    year,
    month,
    day,
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: ((toEpochMillis(instant) % 1000) + 1000) % 1000,
    weekday: isoWeekday(year, month, day),
  };
}

/** Minutes east of UTC in `zone` at `instant` (e.g. +330 for Asia/Kolkata). */
export function zoneOffsetMinutes(instant: Instant, zone: TimeZone): number {
  const parts = zonedParts(instant, zone);
  const civilAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const instantWithoutMillis = toEpochMillis(instant) - parts.millisecond;
  return Math.round((civilAsUtc - instantWithoutMillis) / MILLIS_PER_MINUTE);
}

/**
 * Resolves a civil time — encoded as if it were UTC — to the real instant in
 * `zone`. Two passes, because the offset that applies depends on the instant we
 * are still computing.
 *
 * DST edge: for a civil time that does not exist (the hour skipped by a spring
 * transition) this returns the instant one offset-step later, i.e. the first
 * instant that exists on or after the requested wall-clock time. For an
 * ambiguous civil time (the repeated autumn hour) it returns the first
 * occurrence. Both are stated here rather than left to chance because report
 * windows are derived from them.
 */
function resolveCivilAsUtc(civilAsUtcMillis: number, zone: TimeZone): Instant {
  const firstGuess = instantFromEpochMillis(civilAsUtcMillis);
  const firstOffset = zoneOffsetMinutes(firstGuess, zone);
  const secondGuess = instantFromEpochMillis(civilAsUtcMillis - firstOffset * MILLIS_PER_MINUTE);
  const secondOffset = zoneOffsetMinutes(secondGuess, zone);
  return instantFromEpochMillis(civilAsUtcMillis - secondOffset * MILLIS_PER_MINUTE);
}

export function startOfDayInZone(instant: Instant, zone: TimeZone): Instant {
  const parts = zonedParts(instant, zone);
  return resolveCivilAsUtc(Date.UTC(parts.year, parts.month - 1, parts.day), zone);
}

/**
 * Calendar-day arithmetic in a zone: keeps the wall-clock time and moves the
 * civil date, so "one day later" survives DST transitions.
 */
export function addDaysInZone(instant: Instant, zone: TimeZone, days: number): Instant {
  const parts = zonedParts(instant, zone);
  const shifted = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + days,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return resolveCivilAsUtc(shifted, zone);
}

/** `YYYY-MM-DD` for the civil date containing `instant` in `zone`. */
export function formatCivilDate(instant: Instant, zone: TimeZone): string {
  const { year, month, day } = zonedParts(instant, zone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD HH:MM` — for report mastheads and freshness lines, never for storage. */
export function formatCivilDateTime(instant: Instant, zone: TimeZone): string {
  const { hour, minute } = zonedParts(instant, zone);
  return `${formatCivilDate(instant, zone)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function isSameCivilDay(left: Instant, right: Instant, zone: TimeZone): boolean {
  return formatCivilDate(left, zone) === formatCivilDate(right, zone);
}

/** Parses `YYYY-MM-DD` as the first instant of that civil date in `zone`. */
export function startOfCivilDate(civilDate: string, zone: TimeZone): Instant {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civilDate);
  if (!match) {
    throw new InvalidCivilDateError(civilDate);
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new InvalidCivilDateError(civilDate);
  }
  return resolveCivilAsUtc(Date.UTC(year, month - 1, day), zone);
}

/** Monday–Friday. Team holidays live on the WorkingCalendar and are applied above this. */
export function isWeekend(instant: Instant, zone: TimeZone): boolean {
  return zonedParts(instant, zone).weekday >= 6;
}
