/**
 * An instant on the timeline, as whole milliseconds since the Unix epoch.
 *
 * It is a branded `number` rather than a `Date` for three reasons that matter
 * to this product: it is trivially serialisable into a snapshot, it compares and
 * sorts with no locale or timezone involvement, and it cannot accidentally carry
 * a mutable "now" with it.
 *
 * The brand is a plain string literal, deliberately: `@compass/analysis` declares
 * zero dependencies and re-declares this exact shape, so the two types stay
 * mutually assignable by TypeScript's structural rules without an import edge.
 */
export type Instant = number & { readonly __brand: 'compass.Instant' };

export class InvalidInstantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInstantError';
  }
}

export const MILLIS_PER_SECOND = 1_000;
export const MILLIS_PER_MINUTE = 60_000;
export const MILLIS_PER_HOUR = 3_600_000;
export const MILLIS_PER_DAY = 86_400_000;

/** The Unix epoch — a well-defined lower bound for "no instant recorded yet". */
export const EPOCH: Instant = 0 as Instant;

export function instantFromEpochMillis(epochMillis: number): Instant {
  if (!Number.isSafeInteger(epochMillis)) {
    throw new InvalidInstantError(
      `An Instant must be a whole number of milliseconds since the epoch; received ${String(epochMillis)}.`,
    );
  }
  return epochMillis as Instant;
}

/**
 * Parses an ISO-8601 timestamp. Requires an explicit offset or `Z`: a bare
 * `2026-07-30T08:00:00` would be interpreted in the host's local zone, which is
 * exactly the ambient-time dependency this package exists to remove.
 */
export function instantFromIso(iso: string): Instant {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new InvalidInstantError(
      `\`${iso}\` has no UTC offset. Write an explicit offset or Z so the instant does not depend on the host timezone.`,
    );
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new InvalidInstantError(`\`${iso}\` is not a valid ISO-8601 timestamp.`);
  }
  return parsed as Instant;
}

export function toEpochMillis(instant: Instant): number {
  return instant;
}

/** Canonical serialisation: always UTC, always millisecond precision. */
export function toIso(instant: Instant): string {
  return new Date(toEpochMillis(instant)).toISOString();
}

export function compareInstants(left: Instant, right: Instant): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isBefore(left: Instant, right: Instant): boolean {
  return left < right;
}

export function isAfter(left: Instant, right: Instant): boolean {
  return left > right;
}

export function isAtOrBefore(left: Instant, right: Instant): boolean {
  return left <= right;
}

export function isAtOrAfter(left: Instant, right: Instant): boolean {
  return left >= right;
}

export function earliest(first: Instant, ...rest: readonly Instant[]): Instant {
  return rest.reduce<Instant>((accumulator, candidate) => (candidate < accumulator ? candidate : accumulator), first);
}

export function latest(first: Instant, ...rest: readonly Instant[]): Instant {
  return rest.reduce<Instant>((accumulator, candidate) => (candidate > accumulator ? candidate : accumulator), first);
}

export function addMillis(instant: Instant, millis: number): Instant {
  return instantFromEpochMillis(instant + millis);
}

export function addSeconds(instant: Instant, seconds: number): Instant {
  return addMillis(instant, seconds * MILLIS_PER_SECOND);
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return addMillis(instant, minutes * MILLIS_PER_MINUTE);
}

export function addHours(instant: Instant, hours: number): Instant {
  return addMillis(instant, hours * MILLIS_PER_HOUR);
}

/**
 * Adds exact 24-hour periods. This is NOT calendar-day arithmetic — across a DST
 * boundary the local wall-clock time will shift. Use `addDaysInZone` when you
 * mean "the same time tomorrow" for a team.
 */
export function addExactDays(instant: Instant, days: number): Instant {
  return addMillis(instant, days * MILLIS_PER_DAY);
}

export function differenceInMillis(later: Instant, earlier: Instant): number {
  return later - earlier;
}

export function isInstant(value: unknown): value is Instant {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
