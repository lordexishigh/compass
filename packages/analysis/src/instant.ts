/**
 * The analysis core declares zero dependencies — not even @compass/clock — so
 * that "analysis imports I/O or time" is a build error rather than a habit.
 *
 * `Instant` is therefore re-declared here with the *identical* structural brand
 * used by @compass/clock. TypeScript compares these structurally, so the two are
 * mutually assignable with no import edge between the packages;
 * `tests/analysis.test.ts` asserts that assignability in both directions and
 * fails if either brand is ever changed.
 *
 * Everything below is integer arithmetic over epoch millis. There is no `Date`,
 * no `Intl` and no locale anywhere in this file, because all three are inputs the
 * host supplies: a report generated on a machine with a different default locale
 * or ICU build must come out byte-identical.
 */
export type Instant = number & { readonly __brand: 'compass.Instant' };

/** Half-open `[start, end)`, matching @compass/clock's TimeWindow exactly. */
export interface TimeWindow {
  readonly start: Instant;
  readonly end: Instant;
}

export const MILLIS_PER_SECOND = 1_000;
export const MILLIS_PER_MINUTE = 60 * MILLIS_PER_SECOND;
export const MILLIS_PER_HOUR = 60 * MILLIS_PER_MINUTE;
export const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR;

export function compareInstants(left: Instant, right: Instant): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function windowContains(window: TimeWindow, instant: Instant): boolean {
  return instant >= window.start && instant < window.end;
}

/** The window of equal length immediately before `window`, for trend comparison. */
export function priorWindow(window: TimeWindow): TimeWindow {
  const span = window.end - window.start;
  return { start: (window.start - span) as Instant, end: window.start };
}

/** A window of `days` ending at `instant`, for trailing-window signals. */
export function trailingDays(instant: Instant, days: number): TimeWindow {
  return { start: (instant - days * MILLIS_PER_DAY) as Instant, end: instant };
}

export const windowDays = (window: TimeWindow): number => (window.end - window.start) / MILLIS_PER_DAY;

export const addDays = (instant: Instant, days: number): Instant => (instant + days * MILLIS_PER_DAY) as Instant;

export const earliest = (left: Instant, right: Instant): Instant => (left <= right ? left : right);

export const latest = (left: Instant, right: Instant): Instant => (left >= right ? left : right);

/**
 * Whole elapsed days between two instants, floored and clamped at zero.
 *
 * Exact 24-hour periods, not calendar days — the same rule
 * `@compass/knowledge-model`'s `ageInDays` applies, deliberately, so an "age 6"
 * computed here and a "day 6" pill rendered from a stored elapsed fact can never
 * disagree by one. Calendar counting would make the same blocker jump a day at
 * local midnight and change a number the manager read an hour earlier.
 */
export function wholeDaysBetween(earlierInstant: Instant, laterInstant: Instant): number {
  return Math.max(0, Math.floor((laterInstant - earlierInstant) / MILLIS_PER_DAY));
}

/**
 * UTC days since the epoch. 1970-01-01 is day 0 and was a Thursday, which is the
 * only fact `dayOfWeek` needs.
 */
export const utcDayIndex = (instant: Instant): number => Math.floor(instant / MILLIS_PER_DAY);

/** 0 = Sunday … 6 = Saturday, for a UTC day index. */
export const dayOfWeek = (dayIndex: number): number => (((dayIndex + 4) % 7) + 7) % 7;

export const isWeekendDay = (dayIndex: number): boolean => {
  const weekday = dayOfWeek(dayIndex);
  return weekday === 0 || weekday === 6;
};

/**
 * Working days in the half-open span `[earlierInstant, laterInstant)`.
 *
 * Two documented simplifications, both chosen so the number is reproducible
 * rather than approximately fair:
 *
 *  - **UTC calendar days, Monday to Friday.** A team's own zone would be more
 *    accurate by a few hours at the boundary, and would make the count depend on
 *    the host's ICU timezone database — a value that changes when the container's
 *    base image changes. A threshold expressed in working days is a coarse
 *    instrument; it must not be a *drifting* one.
 *  - **Public holidays and Absences are not deducted here.** The WorkingCalendar
 *    and Absence entities exist and belong in this calculation, but deducting
 *    them changes the meaning of every threshold at once, so it lands with the
 *    calendar work rather than being half-applied now.
 */
export function workingDaysBetween(earlierInstant: Instant, laterInstant: Instant): number {
  if (laterInstant <= earlierInstant) return 0;

  const firstDay = utcDayIndex(earlierInstant);
  const lastDay = utcDayIndex(laterInstant);
  let working = 0;
  for (let day = firstDay; day < lastDay; day += 1) {
    if (!isWeekendDay(day)) working += 1;
  }
  return working;
}

/**
 * Locale-independent string ordering. Never `localeCompare`: a report generated
 * on a machine with a different default locale must sort identically.
 */
export function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The documented rounding helper.
 *
 * Every percentage and share in a report goes through here or through
 * `basisPoints`, so "42%" always means the same arithmetic. Ties round up (away
 * from zero for positives), which is `Math.round`'s behaviour, stated rather than
 * inherited. A zero denominator returns 0 rather than `NaN`: `NaN` would poison
 * the canonical serialiser, and "0% of nothing" is the honest reading.
 */
export function percent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator * 100) / denominator);
}

/**
 * Hundredths of a percent, for shares and correlations that need more resolution
 * than an integer percentage without ever introducing a float into the output.
 */
export function basisPoints(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator * 10_000) / denominator);
}

/** Scaled-decimal rounding to `places`, returned as an integer of that scale. */
export function scaled(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * The UTC civil date of an instant as `YYYY-MM-DD`, by pure arithmetic.
 *
 * Not `toISOString()`, and not `Intl`: this is the one place a projected date is
 * written down for a log line, a fixture or a test, and it must not depend on a
 * `Date` implementation. Renderers format dates in the *team's* zone — zone
 * knowledge lives in @compass/clock, which this package cannot see.
 */
export function utcCivilDate(instant: Instant): string {
  // Days → civil date by the standard proleptic-Gregorian algorithm, shifted so
  // the era starts on 0000-03-01 and leap days land at the end of a cycle.
  const days = utcDayIndex(instant);
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
  const year = era * 400 + yearOfEra + (month <= 2 ? 1 : 0);

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The median of a sample, as a scaled decimal with one place.
 *
 * The input is copied before sorting — sorting a caller's array in place would
 * mutate a snapshot collection — and sorted with an explicit numeric comparator,
 * never `Array.prototype.sort`'s default lexicographic order.
 */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort(compareNumbers);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return scaled(value, 1);
}

/** The value at `fraction` through a sorted sample, by nearest-rank. */
export function percentileOf(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort(compareNumbers);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return scaled(sorted[rank], 1);
}

export function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return scaled(values.reduce((sum, value) => sum + value, 0) / values.length, 1);
}

/**
 * Pearson's r between two equal-length samples, in basis points.
 *
 * Returned as an integer so it can sit in a canonically serialised report
 * without a float's last-bit ambiguity. `null` when either sample has no
 * variance at all, which is a real answer: a column of identical estimates
 * cannot correlate with anything.
 */
export function pearsonBasisPoints(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;

  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;

  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }

  if (leftVariance === 0 || rightVariance === 0) return null;
  return Math.round((covariance / Math.sqrt(leftVariance * rightVariance)) * 10_000);
}
