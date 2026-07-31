import {
  MILLIS_PER_DAY,
  addDaysInZone,
  startOfDayInZone,
  type Instant,
  type TimeWindow,
} from '@compass/clock';

/**
 * Elapsed facts.
 *
 * This is the arithmetic behind the sentences the product exists to say: "still
 * blocked, day 6", "reviewer added, age unchanged", "reported blocked yesterday,
 * actually merged". None of it is possible from a per-run summary — it needs a
 * persisted `first_seen_at`, which is why the knowledge model is a store rather
 * than a projection.
 *
 * Every function here takes the instant it should measure against. There is no
 * clock in this file and lint enforces that: an age that depended on the host
 * clock would change between the moment a report was generated and the moment it
 * was read.
 */

/** The trail length the elapsed-fact sigil renders: fourteen 2px ticks. */
export const PRESENCE_TRAIL_DAYS = 14;

/**
 * Whole elapsed days between two instants, floored.
 *
 * Exact 24-hour periods, not calendar days: an item first seen at 08:15 on the
 * 24th is "day 6" at 08:15 on the 30th and stays day 6 until 08:15 on the 31st.
 * Calendar-day counting would make the same blocker jump a day at local midnight
 * and change the number a manager read an hour earlier.
 */
export function ageInDays(firstSeenAt: Instant, instant: Instant): number {
  return Math.max(0, Math.floor((instant - firstSeenAt) / MILLIS_PER_DAY));
}

/** Days between two instants, floored, clamped at zero. */
export function elapsedDays(earlier: Instant, later: Instant): number {
  return ageInDays(earlier, later);
}

/**
 * Whole days an entity has been continuously present, counted from its first
 * sighting to its last — not to `instant`. An item last seen four days ago has a
 * span of however long it lasted, which is a different fact from its age.
 */
export function presenceSpanDays(firstSeenAt: Instant, lastSeenAt: Instant): number {
  return ageInDays(firstSeenAt, lastSeenAt);
}

export interface ElapsedFact {
  /** Whole days since the entity was first observed, as of the report instant. */
  readonly ageDays: number;
  /** Whole days since it was last observed. Zero for something seen today. */
  readonly staleDays: number;
  /** True when the last sighting is within `[instant - 1 day, instant]`. */
  readonly seenToday: boolean;
  /**
   * Which of the last `PRESENCE_TRAIL_DAYS` civil days this entity was present
   * on, oldest first. Presence means the day intersects
   * `[first_seen_at, last_seen_at]` — the entity was known to Compass on that day.
   */
  readonly trail: readonly boolean[];
}

/**
 * The complete elapsed-fact set for one entity, in the team's zone.
 *
 * `trail` is derived from the sighting interval rather than from a per-day
 * presence table, which is a deliberate simplification with a stated meaning:
 * a filled tick says "Compass knew about this on that day", not "a source
 * mentioned it on that day". The two only differ for an entity that vanished from
 * its source and came back, and for that case the honest answer is the one the
 * store can actually support.
 */
export function elapsedFactsFor(
  sighting: { readonly firstSeenAt: Instant; readonly lastSeenAt: Instant },
  instant: Instant,
  timezone: string,
  trailDays: number = PRESENCE_TRAIL_DAYS,
): ElapsedFact {
  return {
    ageDays: ageInDays(sighting.firstSeenAt, instant),
    staleDays: ageInDays(sighting.lastSeenAt, instant),
    seenToday: instant - sighting.lastSeenAt < MILLIS_PER_DAY,
    trail: presenceTrail(sighting, instant, timezone, trailDays),
  };
}

/**
 * A hairline trail of `trailDays` ticks, oldest first, ending with the civil day
 * that contains `instant`.
 */
export function presenceTrail(
  sighting: { readonly firstSeenAt: Instant; readonly lastSeenAt: Instant },
  instant: Instant,
  timezone: string,
  trailDays: number = PRESENCE_TRAIL_DAYS,
): readonly boolean[] {
  if (trailDays <= 0) return [];

  const today = startOfDayInZone(instant, timezone);
  const trail: boolean[] = [];

  for (let offset = trailDays - 1; offset >= 0; offset -= 1) {
    const dayStart = addDaysInZone(today, timezone, -offset);
    const dayEnd = addDaysInZone(today, timezone, -offset + 1);
    // The day is "present" when it overlaps the sighting interval at all.
    trail.push(sighting.firstSeenAt < dayEnd && sighting.lastSeenAt >= dayStart);
  }

  return trail;
}

/** True when the entity was observed inside the window at all. */
export function sightedWithin(
  sighting: { readonly firstSeenAt: Instant; readonly lastSeenAt: Instant },
  window: TimeWindow,
): boolean {
  return sighting.lastSeenAt >= window.start && sighting.firstSeenAt < window.end;
}

/**
 * How a recurring item is described relative to yesterday.
 *
 * `new` for something first seen inside the window; `unchanged` for something
 * that was already known and gained no new version; `changed` when a tracked
 * field moved. The report writes this as a run-in italic clause ("reviewer added,
 * age unchanged"), never a badge saying NEW.
 */
export type ChangeSinceLastReport = 'new' | 'changed' | 'unchanged' | 'resolved';

export function changeSince(input: {
  readonly firstSeenAt: Instant;
  readonly window: TimeWindow;
  readonly changedFieldsInWindow: readonly string[];
  readonly resolvedAt: Instant | null;
}): ChangeSinceLastReport {
  if (input.resolvedAt !== null && input.resolvedAt >= input.window.start) return 'resolved';
  if (input.firstSeenAt >= input.window.start) return 'new';
  return input.changedFieldsInWindow.length > 0 ? 'changed' : 'unchanged';
}
