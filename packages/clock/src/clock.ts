import { type Instant, addMillis, compareInstants, toIso } from './instant.js';

/**
 * The Clock port.
 *
 * Only the process edge — an HTTP route handler, a worker job trigger, a test —
 * holds one of these. Everything below the edge receives the resolved
 * `now: Instant` as an explicit parameter, which is what makes time travel and
 * the determinism gate possible at all.
 */
export interface Clock {
  now(): Instant;
}

/**
 * A clock frozen at one instant. Every call returns exactly the instant it was
 * constructed with — no drift, no monotonic fudging — so a golden fixture
 * generated today reproduces byte-for-byte next year.
 */
export class FixedClock implements Clock {
  readonly #instant: Instant;

  constructor(instant: Instant) {
    this.#instant = instant;
  }

  now(): Instant {
    return this.#instant;
  }

  toString(): string {
    return `FixedClock(${toIso(this.#instant)})`;
  }
}

/**
 * A clock the caller steps deliberately: the time-travel control and the
 * multi-day fixture generator both drive this. It never advances on its own.
 */
export class SimulatedClock implements Clock {
  #instant: Instant;

  constructor(start: Instant) {
    this.#instant = start;
  }

  now(): Instant {
    return this.#instant;
  }

  /** Moves to `instant`. Stepping backwards is allowed — that is time travel. */
  advanceTo(instant: Instant): void {
    this.#instant = instant;
  }

  advanceBy(millis: number): void {
    this.#instant = addMillis(this.#instant, millis);
  }

  isAt(instant: Instant): boolean {
    return compareInstants(this.#instant, instant) === 0;
  }

  toString(): string {
    return `SimulatedClock(${toIso(this.#instant)})`;
  }
}
