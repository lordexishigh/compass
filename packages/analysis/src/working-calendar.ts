import {
  entitiesAt,
  resolvedNumberList,
  resolvedText,
  resolvedTextList,
  type ConfigSnapshot,
} from './configuration.js';
import { dayOfWeek, utcDayIndex, type Instant } from './instant.js';

/**
 * A team's working days, and the one place a threshold is measured against them.
 *
 * Every threshold in the product is expressed in *working* days — "has not moved for 3
 * working days", "waiting 5 working days for review" — and `instant.ts` measured them
 * Monday-to-Friday UTC with a comment saying so:
 *
 *   > **Public holidays and Absences are not deducted here.** The WorkingCalendar and
 *   > Absence entities exist and belong in this calculation, but deducting them changes
 *   > the meaning of every threshold at once, so it lands with the calendar work rather
 *   > than being half-applied now.
 *
 * This is the calendar work. `workingDaysBetween` keeps its signature and its default, so
 * a deployment with no configured calendar counts exactly as it did before; a deployment
 * *with* one gets its own week. Nothing silently changes for anybody, which is the only
 * safe way to alter the meaning of every threshold at once.
 *
 * ## What is deliberately not deducted
 *
 * A person's Absence is **not** subtracted from an elapsed count. "This ticket has not
 * moved for four working days" is a fact about the ticket, and shortening it because its
 * assignee was on leave would state a smaller number than the one a manager can verify on
 * the board. Absence *suppresses the finding* instead, with the reason attached — see
 * `absence-suppression.ts`. The number stays true; the accusation is withdrawn.
 */

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Monday to Friday. What a week means before anybody configures one. */
export const DEFAULT_WORKING_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

export interface WorkingCalendar {
  /** Null for the default calendar, so a caller can tell "configured" from "assumed". */
  readonly teamKey: string | null;
  /** ISO weekday numbers that count as working. Sorted. */
  readonly workingWeekdays: readonly number[];
  /** `YYYY-MM-DD` civil dates that do not count, however they fall. Sorted. */
  readonly holidays: readonly string[];
  readonly timezone: string | null;
  /** False when no `working_calendar` row covered the scope. */
  readonly configured: boolean;
}

export const DEFAULT_WORKING_CALENDAR: WorkingCalendar = Object.freeze({
  teamKey: null,
  workingWeekdays: DEFAULT_WORKING_WEEKDAYS,
  holidays: [] as readonly string[],
  timezone: null,
  configured: false,
});

/**
 * `dayOfWeek` returns 0 = Sunday … 6 = Saturday; ISO wants 1 = Monday … 7 = Sunday.
 *
 * Converted here, once, rather than at each comparison. Two numbering schemes for the days
 * of the week is exactly the kind of detail that produces an off-by-one nobody notices
 * until a Sunday-working team is told it did nothing all week.
 */
export const isoWeekdayOfDayIndex = (dayIndex: number): number => {
  const sundayFirst = dayOfWeek(dayIndex);
  return sundayFirst === 0 ? 7 : sundayFirst;
};

/** The `YYYY-MM-DD` civil date of a UTC day index. */
export function civilDateOfDayIndex(dayIndex: number): string {
  const millis = dayIndex * 86_400_000;
  const date = new Date(millis);
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whether one UTC calendar day counts as a working day under this calendar. */
export function isWorkingDay(calendar: WorkingCalendar, dayIndex: number): boolean {
  if (!calendar.workingWeekdays.includes(isoWeekdayOfDayIndex(dayIndex))) return false;
  return !calendar.holidays.includes(civilDateOfDayIndex(dayIndex));
}

/**
 * Working days in the half-open span `[earlier, later)`, under a calendar.
 *
 * The UTC-day simplification `instant.ts` documents is kept: a team's own zone would be
 * more accurate by a few hours at the boundary and would make the count depend on the
 * container's ICU timezone database, which changes when the base image does. A threshold in
 * working days is a coarse instrument; it must not be a *drifting* one. Holidays are
 * therefore compared as UTC civil dates, which is right to within those same few hours.
 */
export function workingDaysBetweenOn(
  calendar: WorkingCalendar,
  earlierInstant: Instant,
  laterInstant: Instant,
): number {
  if (laterInstant <= earlierInstant) return 0;

  const firstDay = utcDayIndex(earlierInstant);
  const lastDay = utcDayIndex(laterInstant);

  let working = 0;
  for (let day = firstDay; day < lastDay; day += 1) {
    if (isWorkingDay(calendar, day)) working += 1;
  }
  return working;
}

/**
 * The calendar a report is measured against, resolved as of its instant.
 *
 * A team report takes its team's calendar. A merged report takes none — two teams may work
 * different weeks, and picking one of them would silently apply one team's holidays to the
 * other's tickets. The default is stated rather than hidden, so `configured: false` is a
 * fact the masthead can print.
 */
export function calendarFor(
  snapshot: ConfigSnapshot,
  teamKey: string | null,
  instant: Instant,
): WorkingCalendar {
  if (teamKey === null) return DEFAULT_WORKING_CALENDAR;

  const configured = entitiesAt(snapshot, 'working_calendar', instant).find(
    (resolved) => (resolvedText(resolved, 'teamKey') ?? resolved.naturalKey) === teamKey,
  );
  if (configured === undefined) return DEFAULT_WORKING_CALENDAR;

  const workingWeekdays = [...new Set(resolvedNumberList(configured, 'workingWeekdays'))]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((left, right) => left - right);

  // A calendar that survived validation cannot be empty, but a hand-edited row could be.
  // Falling back beats counting every day as non-working, which would silence the product.
  if (workingWeekdays.length === 0) return DEFAULT_WORKING_CALENDAR;

  return {
    teamKey,
    workingWeekdays,
    holidays: [...new Set(resolvedTextList(configured, 'holidays'))].sort(),
    timezone: resolvedText(configured, 'timezone'),
    configured: true,
  };
}

/** One line a masthead can print about how these numbers were counted. */
export function describeCalendar(calendar: WorkingCalendar): string {
  if (!calendar.configured) {
    return 'Working days are counted Monday to Friday, UTC — no working calendar is configured for this scope.';
  }

  const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = calendar.workingWeekdays.map((day) => names[day] ?? String(day)).join(', ');
  const holidays =
    calendar.holidays.length === 0
      ? 'no holidays'
      : `${calendar.holidays.length} ${calendar.holidays.length === 1 ? 'holiday' : 'holidays'}`;

  return `Working days are counted ${days}, with ${holidays}, from this team's working calendar.`;
}
