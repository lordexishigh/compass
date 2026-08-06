import { instantFromIso } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { civilWindow } from '../lib/memo-window';

/**
 * The memo window leaves the server as civil dates, and this is where that is pinned.
 *
 * `ResolvedWindow` carries `Instant`s — epoch milliseconds — and the route used to hand the
 * outcome to `jsonOk` unmodified, so the confirmation a manager reads to check Compass's reading
 * of "until Thursday" said `1754179200000 → 1754438400000`. The bug was invisible to
 * `tests/memo-form.test.tsx` because that suite's fixtures were hand-written with the dates the
 * route *ought* to have produced, which is exactly the failure mode of a fixture nobody derived
 * from the thing it stands for.
 *
 * So the shape is asserted here, against real `Instant`s, at the boundary that produces it — and
 * the component test asserts that whatever arrives renders as a date rather than a number. Between
 * them there is no arrangement of the two files that leaves milliseconds on the screen.
 */

const BERLIN = 'Europe/Berlin';

describe('the memo window is formatted at the edge, never in the component', () => {
  it('turns both instants into YYYY-MM-DD in the run zone', () => {
    const formatted = civilWindow(
      {
        effectiveFrom: instantFromIso('2026-08-03T00:00:00Z'),
        effectiveUntil: instantFromIso('2026-08-06T00:00:00Z'),
        openEnded: false,
      },
      BERLIN,
    );

    expect(formatted.effectiveFrom).toBe('2026-08-03');
    expect(formatted.effectiveUntil).toBe('2026-08-06');
    expect(formatted.openEnded).toBe(false);
  });

  it('emits nothing numeric, which is the whole of the defect', () => {
    const formatted = civilWindow(
      {
        effectiveFrom: instantFromIso('2026-08-03T00:00:00Z'),
        effectiveUntil: instantFromIso('2026-08-06T00:00:00Z'),
        openEnded: false,
      },
      BERLIN,
    );

    // An `Instant` that survived would be a number here, and `String(number)` would not match.
    expect(formatted.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(formatted.effectiveUntil)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps an open-ended window open rather than inventing an end date', () => {
    // "Priya is out from Monday" has no Thursday to check, and a fabricated end would be the one
    // reading of the memo a manager could not catch.
    const formatted = civilWindow(
      { effectiveFrom: instantFromIso('2026-08-03T00:00:00Z'), effectiveUntil: null, openEnded: true },
      BERLIN,
    );

    expect(formatted.effectiveUntil).toBeNull();
    expect(formatted.openEnded).toBe(true);
  });

  it('resolves the civil date in the run zone, not in UTC', () => {
    // 23:30 UTC is already the next day in Berlin. The zone the report is written in is the one a
    // manager checks "until Thursday" against, so it has to be the one this uses.
    const formatted = civilWindow(
      { effectiveFrom: instantFromIso('2026-08-03T23:30:00Z'), effectiveUntil: null, openEnded: true },
      BERLIN,
    );

    expect(formatted.effectiveFrom).toBe('2026-08-04');
  });
});
