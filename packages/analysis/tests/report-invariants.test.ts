import { instantFromIso } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  ItemAgeError,
  SECTIONS,
  UnevidencedClaimError,
  assertEveryClaimHasEvidence,
  assertWholeDayAges,
  createEmptyStructuredReport,
  type EvidenceRef,
  type ReportItem,
  type StructuredReport,
} from '@compass/analysis';

/**
 * The two invariants a report must satisfy before anything renders it.
 *
 * Both exist because a real defect got past every other gate. Each was invisible
 * for the same reason: the small constructed snapshots the unit tests use never
 * produced the finding that broke, and nothing ran the core over the full seeded
 * dataset until the worker's cold-start test did.
 *
 * They are asserted in `generateStructuredReport`, so a regression fails in the
 * pure layer naming the offending item — rather than three packages away as an
 * ungrounded-number error, or not at all, as a confident sentence with no link.
 */

const EVIDENCE: EvidenceRef = {
  kind: 'issue',
  label: 'DEV-501',
  sourceKey: 'tracker',
  sourceRecordId: 'tracker:issue-DEV-501',
};

const item = (overrides: Partial<ReportItem> = {}): ReportItem => ({
  stableId: 'blocker:ticket:DEV-522:tracker_flag',
  headline: 'DEV-522 is blocked, day 6',
  detail: 'The tracker said so.',
  changeTag: 'unchanged',
  ageDays: 6,
  evidence: [EVIDENCE],
  ...overrides,
});

const AT = {
  instant: instantFromIso('2026-07-31T07:30:00Z'),
  windowStart: instantFromIso('2026-07-29T23:00:00Z'),
  windowEnd: instantFromIso('2026-07-30T23:00:00Z'),
} as const;

const emptyReport = (): StructuredReport =>
  createEmptyStructuredReport({
    organizationId: '00000000-0000-4000-8000-000000000001',
    scope: { kind: 'team', teamKey: 'platform' },
    instant: AT.instant,
    timezone: 'Europe/London',
    window: { start: AT.windowStart, end: AT.windowEnd },
  });

/** An otherwise well-formed report carrying one item in Blockers. */
function reportWith(only: ReportItem): StructuredReport {
  const empty = emptyReport();

  return {
    ...empty,
    sections: empty.sections.map((section) => (section.key === 'blockers' ? { ...section, items: [only] } : section)),
  };
}

describe('an item age is a whole number of days', () => {
  it('accepts a whole age', () => {
    expect(() => assertWholeDayAges(reportWith(item({ ageDays: 6 })))).not.toThrow();
    expect(() => assertWholeDayAges(reportWith(item({ ageDays: 0 })))).not.toThrow();
  });

  it('refuses a fractional age, naming the item', () => {
    // This is the shape of the real defect: a risk built from a mean. The renderer
    // wrote "day 17.6 of it", failed to recognise its own clause, and threw
    // `UngroundedNumberError` for the whole report, so the page returned nothing.
    let thrown: unknown;
    try {
      assertWholeDayAges(reportWith(item({ ageDays: 17.6 })));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ItemAgeError);
    expect((thrown as Error).message).toContain('blockers/blocker:ticket:DEV-522:tracker_flag');
    expect((thrown as Error).message).toContain('17.6');
    expect((thrown as Error).message).toContain('whole non-negative number of days');
  });

  it('refuses a negative age, which no elapsed fact can produce', () => {
    expect(() => assertWholeDayAges(reportWith(item({ ageDays: -1 })))).toThrow(ItemAgeError);
  });

  it('passes over a report with no items at all', () => {
    expect(() => assertWholeDayAges(emptyReport())).not.toThrow();
  });
});

describe('every claim carries an artifact a reader can open', () => {
  it('accepts a claim with one reference', () => {
    expect(() => assertEveryClaimHasEvidence(reportWith(item()))).not.toThrow();
  });

  it('refuses a claim with none, naming the item and quoting the headline', () => {
    let thrown: unknown;
    try {
      assertEveryClaimHasEvidence(reportWith(item({ evidence: [] })));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnevidencedClaimError);
    expect((thrown as Error).message).toContain('blockers/blocker:ticket:DEV-522:tracker_flag');
    expect((thrown as Error).message).toContain('DEV-522 is blocked, day 6');
    expect((thrown as Error).message).toContain('must not be made');
  });

  it('says nothing about a section that is honestly empty', () => {
    // An empty day has no claims, so it has nothing to link. That is a stated
    // absence, not an unevidenced claim, and the six sections still render.
    const empty = emptyReport();

    expect(() => assertEveryClaimHasEvidence(empty)).not.toThrow();
    expect(empty.sections).toHaveLength(SECTIONS.length);
  });
});
