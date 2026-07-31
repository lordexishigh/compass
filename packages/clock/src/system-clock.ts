import type { Clock } from './clock.js';
import { type Instant, instantFromEpochMillis } from './instant.js';

/**
 * The one place in Compass that reads the host clock.
 *
 * `compass/no-system-clock` is enabled for this package too, so the read below
 * needs an explicit disable comment. `tools/quality-gates` asserts that this is
 * the ONLY such disable in the whole workspace — if a second one appears
 * anywhere, that test fails and names the file. The exemption cannot spread by
 * copy-paste.
 *
 * Construct this at the process edge only (route handler, worker trigger). No
 * pipeline layer may construct a clock: `compass/no-clock-instantiation`.
 */
export class SystemClock implements Clock {
  now(): Instant {
    // eslint-disable-next-line compass/no-system-clock -- the single sanctioned system-clock read in Compass
    return instantFromEpochMillis(Date.now());
  }

  toString(): string {
    return 'SystemClock';
  }
}

/** Convenience for edge code that wants one shared instance. */
export const systemClock: Clock = new SystemClock();
