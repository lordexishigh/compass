/**
 * @compass/clock — the only source of time in the product.
 *
 * Layer position: the bottom. This package depends on nothing and is depended on
 * by every layer except `@compass/analysis`, which re-declares the `Instant`
 * brand structurally in order to declare zero dependencies.
 */
export {
  type Instant,
  InvalidInstantError,
  EPOCH,
  MILLIS_PER_SECOND,
  MILLIS_PER_MINUTE,
  MILLIS_PER_HOUR,
  MILLIS_PER_DAY,
  instantFromEpochMillis,
  instantFromIso,
  toEpochMillis,
  toIso,
  compareInstants,
  isBefore,
  isAfter,
  isAtOrBefore,
  isAtOrAfter,
  earliest,
  latest,
  addMillis,
  addSeconds,
  addMinutes,
  addHours,
  addExactDays,
  differenceInMillis,
  isInstant,
} from './instant.js';

export {
  type TimeWindow,
  InvalidTimeWindowError,
  timeWindow,
  windowContains,
  isEmptyWindow,
  windowDurationMillis,
  windowsOverlap,
  windowContainsWindow,
  windowsAreEqual,
  splitWindow,
  civilDayWindow,
  previousCivilDayWindow,
  trailingWindow,
  formatWindow,
} from './time-window.js';

export {
  type TimeZone,
  type ZonedDateParts,
  InvalidTimeZoneError,
  InvalidCivilDateError,
  InvalidLocalTimeError,
  LOCAL_TIME_PATTERN,
  instantAtLocalTime,
  isValidTimeZone,
  assertValidTimeZone,
  zonedParts,
  zoneOffsetMinutes,
  startOfDayInZone,
  addDaysInZone,
  formatCivilDate,
  formatCivilDateTime,
  isSameCivilDay,
  startOfCivilDate,
  isWeekend,
} from './zone.js';

export { type Clock, FixedClock, SimulatedClock } from './clock.js';
export { SystemClock, systemClock } from './system-clock.js';
