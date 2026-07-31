/**
 * The analysis core declares zero dependencies — not even @compass/clock — so
 * that "analysis imports I/O or time" is a build error rather than a habit.
 *
 * `Instant` is therefore re-declared here with the *identical* structural brand
 * used by @compass/clock. TypeScript compares these structurally, so the two are
 * mutually assignable with no import edge between the packages;
 * `tests/instant.test.ts` asserts that assignability in both directions and
 * fails if either brand is ever changed.
 */
export type Instant = number & { readonly __brand: 'compass.Instant' };

/** Half-open `[start, end)`, matching @compass/clock's TimeWindow exactly. */
export interface TimeWindow {
  readonly start: Instant;
  readonly end: Instant;
}

export function compareInstants(left: Instant, right: Instant): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function windowContains(window: TimeWindow, instant: Instant): boolean {
  return instant >= window.start && instant < window.end;
}

/**
 * Locale-independent string ordering. Never `localeCompare`: a report generated
 * on a machine with a different default locale must sort identically.
 */
export function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
