import { instantFromIso, type Instant } from '@compass/clock';

/**
 * Real time, for the one thing in a test that must be built from real time: a session cookie.
 *
 * `guard` resolves a cookie through `nowAtEdge()` — the system clock — and `sessionRejection`
 * refuses a session once `now >= lastUsedAt + SESSION_IDLE_TTL_DAYS`. So a session minted at a
 * fixed fixture instant is fine on the day the fixture was written and **permanently refused
 * fourteen days later**, for being idle rather than for whatever the test is actually about.
 *
 * That is not hypothetical: it took `@compass/web` red. Four suites — `app-feedback`,
 * `feedback-routes`, `login-route`, `time-travel` — failed 15 assertions with
 * `401 authentication_required` where they expected 200/400/403, purely because their `T0`
 * (2026-07-31 and 2026-08-03) had aged past the idle window. `second-factor.test.ts` had
 * already worked this out and defined this helper locally; the reasoning never reached the
 * other suites, so they went red one fixture date at a time.
 *
 * Everything else in a fixture should stay pinned to `T0`. Seeded history, report windows and
 * ordering assertions all want a fixed clock — only the session's own issued-at has to track
 * the clock the guard will judge it by.
 *
 * Read through `instantFromIso` rather than by instantiating a clock, because
 * `compass/no-clock-instantiation` is right that a `SystemClock` in a test is usually a bug.
 */
export const edgeNow = (): Instant => instantFromIso(new Date().toISOString());
