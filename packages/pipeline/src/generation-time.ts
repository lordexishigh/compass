import { LOCAL_TIME_PATTERN, instantAtLocalTime, type Instant, type TimeZone } from '@compass/clock';

/**
 * When a report for a civil date is generated *for* — the one derivation, shared by every caller.
 *
 * ## Why this is not in the worker any more
 *
 * It was, and that made a real bug possible. The worker's `generate.tick` derives
 * `reportInstant = instantAtLocalTime(reportDate, generationTime, timezone)`; the web app's time-travel
 * control had to derive the same instant to land on the same row, could not import from `apps/worker`,
 * and so grew its own version — which copied the UTC hour and minute off the host clock's `now`. The two
 * paths therefore disagreed about which instant `2026-07-24` names, and worse, the web one was not even
 * *stable*: two requests a minute apart produced two instants, and therefore two report rows for one
 * morning, because the row id is derived from `(organization, scope, instant)`.
 *
 * A report instant is a pure function of `(civil date, local generation time, zone)`. Putting it in the
 * one package both processes already depend on is what makes "step to Tuesday twice and read the same
 * report" true by construction rather than by two implementations agreeing.
 */

/**
 * 06:00 in the team's own zone.
 *
 * Early enough to precede a delivery: the subscription default is 07:30 local, so generation has finished
 * before the first daily goes out, which is the ordering the delivery job also enforces for itself by
 * deferring when no report exists.
 */
export const DEFAULT_GENERATION_LOCAL_TIME = '06:00';

export const GENERATION_LOCAL_TIME_ENV_VAR = 'COMPASS_GENERATION_LOCAL_TIME';

/**
 * The deployment's generation time, or the default.
 *
 * A malformed override falls back rather than throwing, because this is read on every tick and a typo in
 * an environment variable must not stop reports being generated altogether. `generationJobsDue` applies
 * the stricter rule for a *per-team* value, where a malformed entry disqualifies that team — the
 * difference being that a deployment-wide typo has a sensible default and a per-team one does not.
 */
export function resolveGenerationLocalTime(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[GENERATION_LOCAL_TIME_ENV_VAR];
  return configured !== undefined && LOCAL_TIME_PATTERN.test(configured)
    ? configured
    : DEFAULT_GENERATION_LOCAL_TIME;
}

/**
 * The instant a report for one civil date is generated for.
 *
 * A pure function of its three arguments: no clock, no environment, nothing that could differ between two
 * calls. That is the whole point — the scheduled run and the time-travel control both call this, so they
 * cannot land on different rows for the same morning.
 *
 * Daylight saving falls out of `instantAtLocalTime`: 06:00 local stays 06:00 across both transitions, so
 * the elapsed gap between consecutive generations is 23 hours in spring and 25 in autumn with no
 * daylight-saving code here.
 */
export function reportInstantForDate(
  reportDate: string,
  timezone: TimeZone,
  localTime: string = DEFAULT_GENERATION_LOCAL_TIME,
): Instant {
  return instantAtLocalTime(reportDate, localTime, timezone);
}
