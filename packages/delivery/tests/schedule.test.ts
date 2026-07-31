import { instantFromIso, toIso } from '@compass/clock';
import {
  InvalidScheduleError,
  assertSchedulable,
  defaultScopeFor,
  dueAtOn,
  dueDeliveries,
  scopesFor,
  shiftCivilDate,
  type SubscriptionSchedule,
} from '@compass/delivery';
import { describe, expect, it } from 'vitest';

/**
 * Scheduling, against an injected instant.
 *
 * Nothing here reads a clock, which is the point: a subscription can be walked across a DST
 * transition in a unit test instead of waiting six months for one. The DST arithmetic itself is
 * `@compass/clock`'s and is asserted there against measured values; these tests are about the
 * decisions this layer makes — which subscriptions are due, for which civil date, and what a
 * `both` subscription expands into.
 */

const at = (iso: string) => instantFromIso(iso);

const subscription = (overrides: Partial<SubscriptionSchedule> = {}): SubscriptionSchedule => ({
  id: 'sub-1',
  channel: 'email',
  scope: 'team',
  sendTime: '07:30',
  timezone: 'Europe/London',
  active: true,
  ...overrides,
});

describe('which subscriptions are due', () => {
  it('is due once the send time has passed in the subscription own zone', () => {
    const due = dueDeliveries([subscription()], at('2026-08-03T08:00:00Z'), { lookbackDays: 0 });

    expect(due).toHaveLength(1);
    expect(due[0]?.deliveryDate).toBe('2026-08-03');
    // 07:30 London in August is 06:30Z.
    expect(toIso(due[0]?.dueAt ?? at('1970-01-01T00:00:00Z'))).toBe('2026-08-03T06:30:00.000Z');
  });

  it('is not due before it', () => {
    // 05:00Z is 06:00 London — before 07:30.
    expect(dueDeliveries([subscription()], at('2026-08-03T05:00:00Z'), { lookbackDays: 0 })).toEqual([]);
  });

  it('reads the boundary in the subscription zone, not the server zone', () => {
    // Same instant, two subscribers. 12:00Z is 08:00 in New York (due) and 21:00 in Tokyo (due),
    // but 03:00 in Los Angeles (not yet).
    const due = dueDeliveries(
      [
        subscription({ id: 'ny', timezone: 'America/New_York' }),
        subscription({ id: 'tokyo', timezone: 'Asia/Tokyo' }),
        subscription({ id: 'la', timezone: 'America/Los_Angeles' }),
      ],
      at('2026-08-03T12:00:00Z'),
      { lookbackDays: 0 },
    );

    expect(due.map((entry) => entry.subscriptionId).sort()).toEqual(['ny', 'tokyo']);
  });

  it('keeps the wall-clock send time across a DST transition', () => {
    // 29 March 2026, London springs forward. A tick at 06:45Z is 07:45 BST — past 07:30 — so
    // the daily is due, and its instant is 06:30Z rather than the 07:30Z it was in winter.
    const due = dueDeliveries([subscription()], at('2026-03-29T06:45:00Z'), { lookbackDays: 0 });

    expect(due).toHaveLength(1);
    expect(toIso(due[0]?.dueAt ?? at('1970-01-01T00:00:00Z'))).toBe('2026-03-29T06:30:00.000Z');

    // The day before, the same 06:45Z tick is 06:45 GMT and 07:30 has not arrived.
    expect(dueDeliveries([subscription()], at('2026-03-28T06:45:00Z'), { lookbackDays: 0 })).toEqual([]);
  });

  it('skips an inactive subscription', () => {
    expect(dueDeliveries([subscription({ active: false })], at('2026-08-03T08:00:00Z'))).toEqual([]);
  });

  it('skips a malformed row rather than failing the whole tick', () => {
    // One manager's bad timezone must not stop every other manager's daily.
    const due = dueDeliveries(
      [
        subscription({ id: 'broken', timezone: 'Middle/Earth' }),
        subscription({ id: 'also-broken', sendTime: '7:30' }),
        subscription({ id: 'fine' }),
      ],
      at('2026-08-03T08:00:00Z'),
      { lookbackDays: 0 },
    );

    expect(due.map((entry) => entry.subscriptionId)).toEqual(['fine']);
  });

  it('catches up a day the worker was down for, oldest first', () => {
    // A worker down over Monday's send time would otherwise skip Monday entirely and the
    // manager would simply never get it. The `delivery_log` index makes the catch-up harmless.
    const due = dueDeliveries([subscription()], at('2026-08-04T08:00:00Z'), { lookbackDays: 1 });

    expect(due.map((entry) => entry.deliveryDate)).toEqual(['2026-08-03', '2026-08-04']);
  });

  it('does not look back when told not to', () => {
    const due = dueDeliveries([subscription()], at('2026-08-04T08:00:00Z'), { lookbackDays: 0 });
    expect(due.map((entry) => entry.deliveryDate)).toEqual(['2026-08-04']);
  });

  it('gives the same delivery date for two ticks on the same day, so the second is a duplicate', () => {
    // The idempotency dimension: `deliveryDate` is what the partial unique index keys on, so
    // two ticks either side of 07:30 must agree about which scheduled delivery this is.
    const first = dueDeliveries([subscription()], at('2026-08-03T06:31:00Z'), { lookbackDays: 0 });
    const second = dueDeliveries([subscription()], at('2026-08-03T18:00:00Z'), { lookbackDays: 0 });

    expect(first[0]?.deliveryDate).toBe(second[0]?.deliveryDate);
    expect(first[0]?.dueAt).toBe(second[0]?.dueAt);
  });
});

describe('the instant a send time occurs on a date', () => {
  it('is the wall-clock time in the zone, not an offset from midnight', () => {
    expect(toIso(dueAtOn(subscription(), '2026-01-15'))).toBe('2026-01-15T07:30:00.000Z');
    expect(toIso(dueAtOn(subscription(), '2026-07-15'))).toBe('2026-07-15T06:30:00.000Z');
  });
});

describe('validating a schedule before it is stored', () => {
  it('accepts a 24-hour time and an IANA zone', () => {
    expect(() => assertSchedulable('07:30', 'Europe/London')).not.toThrow();
    expect(() => assertSchedulable('00:00', 'UTC')).not.toThrow();
    expect(() => assertSchedulable('23:59', 'Asia/Kolkata')).not.toThrow();
  });

  it('refuses a time that is not `HH:MM`, naming the format', () => {
    // A subscription with an unparseable send time is a daily that silently never arrives, so
    // the manager who typed it is told immediately.
    for (const bad of ['7:30', '25:00', '07:60', '0730', 'morning', '']) {
      expect(() => assertSchedulable(bad, 'UTC'), bad).toThrow(InvalidScheduleError);
    }
    expect(() => assertSchedulable('7:30', 'UTC')).toThrow(/HH:MM/);
  });

  it('refuses a zone that is not an IANA name', () => {
    expect(() => assertSchedulable('07:30', 'Middle/Earth')).toThrow(InvalidScheduleError);
    expect(() => assertSchedulable('07:30', 'GMT+1')).toThrow(/IANA/);
  });
});

describe('what a scope expands into', () => {
  it('sends one merged report for a merged subscription', () => {
    expect(scopesFor('merged', ['platform', 'checkout'])).toEqual([{ scopeKind: 'merged', scopeKey: '*' }]);
  });

  it('sends one report per team for a team subscription', () => {
    expect(scopesFor('team', ['platform', 'checkout'])).toEqual([
      { scopeKind: 'team', scopeKey: 'platform' },
      { scopeKind: 'team', scopeKey: 'checkout' },
    ]);
  });

  it('sends both for a both subscription, merged first', () => {
    // Separate scheduled deliveries with separate log rows, so one failing does not block the
    // other and neither can be sent twice.
    expect(scopesFor('both', ['platform'])).toEqual([
      { scopeKind: 'merged', scopeKey: '*' },
      { scopeKind: 'team', scopeKey: 'platform' },
    ]);
  });

  it('sends nothing for a team subscription with no teams', () => {
    // Better than inventing a merged report they did not ask for.
    expect(scopesFor('team', [])).toEqual([]);
  });
});

describe('the default scope derived from roster membership', () => {
  it('is the team report for somebody on one team', () => {
    expect(defaultScopeFor(['platform'])).toBe('team');
  });

  it('is the merged report for somebody on two or more', () => {
    expect(defaultScopeFor(['platform', 'checkout'])).toBe('merged');
    expect(defaultScopeFor(['platform', 'checkout', 'insights'])).toBe('merged');
  });

  it('is the team report for somebody with no team yet', () => {
    // Nothing to merge, so the merged default would be a report about nothing.
    expect(defaultScopeFor([])).toBe('team');
  });
});

describe('civil-date arithmetic', () => {
  it('shifts the calendar date rather than subtracting elapsed time', () => {
    expect(shiftCivilDate('2026-08-03', -1)).toBe('2026-08-02');
    expect(shiftCivilDate('2026-08-03', 1)).toBe('2026-08-04');
    // Across a DST boundary and a month end, where millisecond arithmetic goes wrong.
    expect(shiftCivilDate('2026-03-29', -1)).toBe('2026-03-28');
    expect(shiftCivilDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftCivilDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('refuses a string that is not a civil date', () => {
    expect(() => shiftCivilDate('03/08/2026', -1)).toThrow(InvalidScheduleError);
  });
});
