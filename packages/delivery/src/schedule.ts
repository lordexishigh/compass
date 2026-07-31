import {
  assertValidTimeZone,
  compareInstants,
  formatCivilDate,
  instantAtLocalTime,
  isAfter,
  type Instant,
  LOCAL_TIME_PATTERN,
} from '@compass/clock';

/**
 * When each subscription's next daily is due, and which ones are due now.
 *
 * Nothing here reads a clock: `now` arrives as a parameter, which is what lets a test walk a
 * subscription across a DST transition without waiting six months. The DST behaviour itself is
 * not implemented here either — `instantAtLocalTime` in `@compass/clock` owns it, and this
 * module just asks "when does 07:30 happen on this civil date in this zone".
 *
 * ## Why the scheduler ticks rather than sleeps
 *
 * The worker calls `dueDeliveries` on an interval and acts on what it returns. The alternative —
 * computing a delay and sleeping until the next send — has to be recomputed on every
 * subscription edit and re-derived after every restart, and gets DST wrong in the one place
 * nobody tests. A tick is idempotent by construction: the exactly-once guarantee lives in the
 * `delivery_log` partial unique index, not in the precision of a timer.
 */

export type DeliveryChannel = 'email' | 'slack';
export type DeliveryScope = 'team' | 'merged' | 'both';

export interface SubscriptionSchedule {
  readonly id: string;
  readonly channel: DeliveryChannel;
  readonly scope: DeliveryScope;
  /** `HH:MM` in `timezone`. */
  readonly sendTime: string;
  readonly timezone: string;
  readonly active: boolean;
}

export class InvalidScheduleError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidScheduleError';
    this.detail = detail;
  }
}

/**
 * Validates a send time and zone before either is written.
 *
 * At the write boundary rather than at read time, because a subscription with an unparseable
 * zone is a daily that silently never arrives — the worst failure this feature has. A manager
 * who typed something wrong gets told immediately instead.
 */
export function assertSchedulable(sendTime: string, timezone: string): void {
  if (!LOCAL_TIME_PATTERN.test(sendTime)) {
    throw new InvalidScheduleError(
      `\`${sendTime}\` is not a send time. Use 24-hour \`HH:MM\` — 07:30 for half past seven in the morning.`,
    );
  }
  try {
    assertValidTimeZone(timezone);
  } catch {
    throw new InvalidScheduleError(
      `\`${timezone}\` is not an IANA timezone name. Use the zone the team actually works in, e.g. Europe/London.`,
    );
  }
}

export interface DueDelivery {
  readonly subscriptionId: string;
  readonly channel: DeliveryChannel;
  readonly scope: DeliveryScope;
  /**
   * The civil date, in the subscription's zone, of the send this represents.
   *
   * The idempotency dimension: two ticks either side of 07:30 on the same day produce the same
   * `deliveryDate`, so the second one is recognised as the same scheduled delivery rather than
   * as a new one.
   */
  readonly deliveryDate: string;
  /** The instant 07:30 actually happened at, on that date, in that zone. */
  readonly dueAt: Instant;
}

/**
 * The instant a subscription's send time occurs on a given civil date.
 *
 * Exported because the worker records it and a test asserts on it directly.
 */
export const dueAtOn = (subscription: SubscriptionSchedule, civilDate: string): Instant =>
  instantAtLocalTime(civilDate, subscription.sendTime, subscription.timezone);

/**
 * One scheduled delivery, identified.
 *
 * These four fields are what "the same send" means everywhere in the system: the partial unique
 * index on `delivery_log`, the pg-boss `singletonKey`, and the provider-side idempotency key are
 * all derived from them. A `both` subscription's merged and per-team sends differ in
 * `scopeKind`/`scopeKey`, so they are distinct scheduled deliveries rather than duplicates.
 */
export interface ScheduledDelivery {
  readonly subscriptionId: string;
  readonly deliveryDate: string;
  readonly scopeKind: 'team' | 'merged';
  readonly scopeKey: string;
}

/**
 * The idempotency key for one scheduled delivery.
 *
 * Used for the pg-boss `singletonKey` *and* handed to the email provider, so the queue and the
 * provider cannot disagree about what counts as the same message. Deriving both from one function
 * is the point: the bug this replaced used the email *subject* as the provider key, and because
 * the subject is the masthead — identical for every recipient of the same team and date — the
 * first subscriber's copy won at Resend and every other subscriber's was silently deduplicated
 * away while the transport still reported `sent`.
 *
 * The recipient is not in the key because the subscription determines it: two subscriptions are
 * two keys even when they point at the same address, and one subscription is one recipient.
 */
export const deliveryIdempotencyKey = (delivery: ScheduledDelivery): string =>
  `compass:${delivery.subscriptionId}:${delivery.deliveryDate}:${delivery.scopeKind}:${delivery.scopeKey}`;

/**
 * Which subscriptions are due at `now`, and for which civil date.
 *
 * "Due" means the send time for *today in the subscription's own zone* has passed. A tick at
 * 09:00 London finds a 07:30 London subscription due for today; a tick at 06:00 finds it not
 * due yet. Because the answer is derived from the zone's offset on that date, a DST transition
 * shifts the boundary without any code here mentioning daylight saving.
 *
 * `lookbackDays` exists for the restart case: a worker that was down over the send time would
 * otherwise skip that day entirely and the manager would simply never get Tuesday's report. One
 * day back by default, so a short outage still delivers — late, which the report itself states
 * through its masthead date, rather than never. The `delivery_log` index makes the catch-up
 * harmless: an already-sent day cannot be sent twice.
 */
export function dueDeliveries(
  subscriptions: readonly SubscriptionSchedule[],
  now: Instant,
  options: { readonly lookbackDays?: number } = {},
): readonly DueDelivery[] {
  const lookback = Math.max(0, options.lookbackDays ?? 1);
  const due: DueDelivery[] = [];

  for (const subscription of subscriptions) {
    if (!subscription.active) continue;

    // Skip a row that cannot be scheduled rather than throwing: one malformed subscription
    // must not stop every other manager's daily.
    try {
      assertSchedulable(subscription.sendTime, subscription.timezone);
    } catch {
      continue;
    }

    const today = formatCivilDate(now, subscription.timezone);

    for (let back = lookback; back >= 0; back -= 1) {
      const civilDate = shiftCivilDate(today, -back);
      const dueAt = dueAtOn(subscription, civilDate);
      // `isAfter` rather than `>`: an Instant is nominal, and the clock package owns comparison
      // so no layer has to know it is a number underneath.
      if (isAfter(dueAt, now)) continue;

      due.push({
        subscriptionId: subscription.id,
        channel: subscription.channel,
        scope: subscription.scope,
        deliveryDate: civilDate,
        dueAt,
      });
    }
  }

  // Oldest first, so a catch-up delivers Monday before Tuesday.
  return due.sort(
    (left, right) =>
      compareInstants(left.dueAt, right.dueAt) || (left.subscriptionId < right.subscriptionId ? -1 : 1),
  );
}

/**
 * Civil-date arithmetic on the `YYYY-MM-DD` string itself.
 *
 * Deliberately not instant arithmetic: shifting a date by a day is a calendar operation, and
 * doing it by subtracting 86,400,000 milliseconds from an instant is exactly the bug that makes
 * a DST day either repeat or skip a date. `Date.UTC` is calendar arithmetic on a civil triple
 * with no zone involved, which is what this is.
 */
export function shiftCivilDate(civilDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civilDate);
  if (!match) throw new InvalidScheduleError(`\`${civilDate}\` is not a \`YYYY-MM-DD\` civil date.`);

  const shifted = new Date(
    Date.UTC(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10) + days,
    ),
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * The scopes one due delivery expands into.
 *
 * A `both` subscription is two sends — the merged report and each team's — and they are separate
 * scheduled deliveries with separate `delivery_log` rows, so one failing does not block the
 * other and neither can be sent twice.
 *
 * The team keys come from the caller, which reads them from the roster's membership scopes.
 * Nothing here holds a copy of who is on which team.
 */
export function scopesFor(
  scope: DeliveryScope,
  teamKeys: readonly string[],
): readonly { readonly scopeKind: 'team' | 'merged'; readonly scopeKey: string }[] {
  const merged = { scopeKind: 'merged' as const, scopeKey: '*' };
  const perTeam = teamKeys.map((teamKey) => ({ scopeKind: 'team' as const, scopeKey: teamKey }));

  if (scope === 'merged') return [merged];
  if (scope === 'team') return perTeam;
  return [merged, ...perTeam];
}

/**
 * The scope a new subscription should default to, from roster membership.
 *
 * One team means the team's own report; two or more means the merged one. That is the documented
 * default and the reasoning is about what a manager can act on: with one team the merged report
 * is the same report with a vaguer masthead, and with three the per-team reports are three
 * things to read before breakfast.
 */
export const defaultScopeFor = (teamKeys: readonly string[]): DeliveryScope =>
  teamKeys.length >= 2 ? 'merged' : 'team';
