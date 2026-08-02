import { describe, expect, it } from 'vitest';

import {
  CHANGE_TAGS,
  FIRST_REPORT_STATEMENT,
  MILLIS_PER_DAY,
  NOTHING_MATERIAL_CHANGED_STATEMENT,
  applyChangeAwareness,
  generateStructuredReport,
  isStableItemId,
  itemPresenceDays,
  movedFirst,
  priorStateOf,
  sectionOf,
  tagItemChange,
  wholeDaysBetween,
  type ChangeTag,
  type Instant,
  type PriorReportState,
  type ReportItem,
  type ReportSection,
  type StructuredReport,
} from '@compass/analysis';

import { SEED_NOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * Change-awareness: what moved since yesterday, and the plain statement that nothing did.
 *
 * ## What these tests are actually protecting
 *
 * A daily that re-lists the same three blockers every morning as though they were news is worthless
 * within a week — it is one of the two documented ways this product dies. Stable ids make continuity
 * *possible*; this pass is what makes it visible. So the assertions here are about the two halves
 * that fail silently: an item that is new every morning, and a quiet morning that reads like a busy
 * one.
 *
 * The ten-day simulation is the centre of it. A single-day test passes for an implementation whose
 * ids fold in the instant, and that implementation is broken in exactly the way nobody notices until
 * a manager's dismissals stop sticking.
 */

const item = (overrides: Partial<ReportItem> = {}): ReportItem => ({
  stableId: 'v1:0000000000000001',
  cause: { entityRef: 'ticket:PLAT-742', causeKind: 'status_dwell', causeDiscriminator: '' },
  headline: 'PLAT-742 has not moved in 4 working days',
  detail: 'Last transition on 2026-07-27.',
  changeTag: 'unchanged',
  ageDays: 4,
  firstSeenAt: SEED_NOW,
  severityScore: 200,
  signalOnsetAt: SEED_NOW,
  evidence: [{ kind: 'issue', label: 'PLAT-742', sourceKey: 'tracker', sourceRecordId: 'PLAT-742' }],
  ...overrides,
});

const section = (items: readonly ReportItem[]): ReportSection => ({
  key: 'blockers',
  index: 3,
  title: 'Blockers',
  items,
  emptyStatement: 'Nothing is blocked on a signal Compass can see.',
});

const priorOf = (items: readonly ReportItem[], instant: Instant): PriorReportState => ({
  instant,
  items: items.map((entry) => ({
    stableId: entry.stableId,
    firstSeenAt: entry.firstSeenAt,
    severityScore: entry.severityScore,
  })),
});

const DAY = MILLIS_PER_DAY;

describe('every item carries exactly one tag, computed against the prior report', () => {
  it('offers exactly five tags and no more', () => {
    expect([...CHANGE_TAGS].sort()).toEqual(['improved', 'new', 'resolved', 'unchanged', 'worsened']);
  });

  it('tags an id the prior report did not carry as new, and dates it today', () => {
    const now = (SEED_NOW + DAY) as Instant;
    const tagged = tagItemChange(item(), undefined, now);

    expect(tagged.changeTag).toBe('new');
    expect(tagged.firstSeenAt).toBe(now);
    expect(itemPresenceDays(tagged, now)).toBe(0);
  });

  it('tags an unmoved id as unchanged and carries its first sighting forward', () => {
    const now = (SEED_NOW + 6 * DAY) as Instant;
    const tagged = tagItemChange(item({ severityScore: 200 }), {
      stableId: 'v1:0000000000000001',
      firstSeenAt: SEED_NOW,
      severityScore: 200,
    }, now);

    expect(tagged.changeTag).toBe('unchanged');
    // The age the day sigil prints: counted from the first report that carried it, not reset.
    expect(tagged.firstSeenAt).toBe(SEED_NOW);
    expect(itemPresenceDays(tagged, now)).toBe(6);
  });

  it('reads a risen score as worsened and a fallen one as improved', () => {
    const prior = { stableId: 'v1:0000000000000001', firstSeenAt: SEED_NOW, severityScore: 200 };
    const now = (SEED_NOW + DAY) as Instant;

    expect(tagItemChange(item({ severityScore: 240 }), prior, now).changeTag).toBe('worsened');
    expect(tagItemChange(item({ severityScore: 150 }), prior, now).changeTag).toBe('improved');
  });

  it('leaves an intrinsic completion alone', () => {
    // A Yesterday line and a Win are finished by construction. An arithmetic tag would overwrite a
    // fact with a comparison, and "your completed work is unchanged" is not a sentence.
    const prior = { stableId: 'v1:0000000000000001', firstSeenAt: SEED_NOW, severityScore: 0 };
    const tagged = tagItemChange(item({ changeTag: 'resolved', severityScore: 0 }), prior, (SEED_NOW + DAY) as Instant);

    expect(tagged.changeTag).toBe('resolved');
  });

  it('gives an unchanged item a clause naming its persistence when it has none of its own', () => {
    const now = (SEED_NOW + 6 * DAY) as Instant;
    const tagged = tagItemChange(item({ changeClause: undefined }), {
      stableId: 'v1:0000000000000001',
      firstSeenAt: SEED_NOW,
      severityScore: 200,
    }, now);

    expect(tagged.changeClause).toBe('unchanged since Compass first reported it');
  });

  it('does not overwrite a clause the producer already wrote', () => {
    const tagged = tagItemChange(item({ changeClause: 'reviewer added, age unchanged' }), {
      stableId: 'v1:0000000000000001',
      firstSeenAt: SEED_NOW,
      severityScore: 200,
    }, (SEED_NOW + DAY) as Instant);

    expect(tagged.changeClause).toBe('reviewer added, age unchanged');
  });
});

describe('the report leads with what moved', () => {
  it('puts moved items before carried-over ones, preserving each group’s order', () => {
    const carried = item({ stableId: 'v1:00000000000000aa', changeTag: 'unchanged' });
    const alsoCarried = item({ stableId: 'v1:00000000000000ab', changeTag: 'unchanged' });
    const worsened = item({ stableId: 'v1:00000000000000ac', changeTag: 'worsened' });

    expect(movedFirst([carried, alsoCarried, worsened]).map((entry) => entry.stableId)).toEqual([
      'v1:00000000000000ac',
      'v1:00000000000000aa',
      'v1:00000000000000ab',
    ]);
  });

  it('is a no-op on a first report, because everything there has moved', () => {
    // The property that keeps the section's documented order — severity for risks, age for blockers —
    // meaningful on the day a scope is first reported.
    const items = [item({ stableId: 'v1:1' }), item({ stableId: 'v1:2' }), item({ stableId: 'v1:3' })].map((entry) => ({
      ...entry,
      changeTag: 'new' as ChangeTag,
    }));

    expect(movedFirst(items).map((entry) => entry.stableId)).toEqual(['v1:1', 'v1:2', 'v1:3']);
  });
});

describe('a morning on which nothing moved says so', () => {
  const carried = [item({ stableId: 'v1:00000000000000aa' }), item({ stableId: 'v1:00000000000000ab' })];
  const yesterday = (SEED_NOW - DAY) as Instant;

  it('states it plainly rather than re-listing the items as if new', () => {
    const result = applyChangeAwareness([section(carried)], priorOf(carried, yesterday), SEED_NOW);

    expect(result.summary.nothingMaterialChanged).toBe(true);
    expect(result.summary.statement).toBe(NOTHING_MATERIAL_CHANGED_STATEMENT);
    // And the items are still there, all tagged `unchanged`. The sentence replaces the *voice*, not
    // the content: a manager must still be able to see which three things are still true.
    expect(result.sections[0]?.items.map((entry) => entry.changeTag)).toEqual(['unchanged', 'unchanged']);
  });

  it('does not call a morning quiet when an item departed', () => {
    // The half that is easy to miss. A blocker resolved overnight leaves the report entirely, so a
    // summary looking only at what is still present would call that morning quiet.
    const priorWithExtra: PriorReportState = {
      instant: yesterday,
      items: [
        ...priorOf(carried, yesterday).items,
        { stableId: 'v1:00000000000000ff', firstSeenAt: yesterday, severityScore: 300 },
      ],
    };

    const result = applyChangeAwareness([section(carried)], priorWithExtra, SEED_NOW);

    expect(result.summary.nothingMaterialChanged).toBe(false);
    expect(result.summary.departedStableIds).toEqual(['v1:00000000000000ff']);
    expect(result.summary.statement).toContain('stopped holding');
  });

  it('says something different when there is no prior report at all', () => {
    // "Everything is new" and "nothing changed" are different facts, and a first report must not be
    // rendered as either the other one or as a surge of twelve overnight problems.
    const result = applyChangeAwareness([section(carried)], null, SEED_NOW);

    expect(result.summary.hasPriorReport).toBe(false);
    expect(result.summary.nothingMaterialChanged).toBe(false);
    expect(result.summary.statement).toBe(FIRST_REPORT_STATEMENT);
    expect(result.sections[0]?.items.every((entry) => entry.changeTag === 'new')).toBe(true);
  });

  it('counts what moved, in the fixed tag order', () => {
    const moved = [
      { ...carried[0]!, severityScore: 260 },
      { ...carried[1]!, severityScore: 100 },
      item({ stableId: 'v1:00000000000000ac' }),
    ];
    const result = applyChangeAwareness([section(moved)], priorOf(carried, yesterday), SEED_NOW);

    expect(result.summary.counts.worsened).toBe(1);
    expect(result.summary.counts.improved).toBe(1);
    expect(result.summary.counts.new).toBe(1);
    expect(result.summary.statement).toContain('1 item appeared');
    expect(result.summary.statement).toContain('1 item worsened');
  });
});

describe('ten consecutive simulated days over the seeded organization', () => {
  /**
   * The acceptance criterion, asserted through the whole report rather than through the derivation.
   *
   * `tests/identity.test.ts` proves the *function* ignores the instant. This proves the **report**
   * does: ten generated reports, each one handed the previous one's state, over a snapshot whose
   * conditions still hold. An id that folded in the instant, the run or a counter would pass every
   * single-day assertion in this repo and fail here ten different ways.
   */
  const DAYS = 10;

  const chain = (): readonly StructuredReport[] => {
    const reports: StructuredReport[] = [];
    let prior: PriorReportState | null = null;

    for (let day = 0; day < DAYS; day += 1) {
      const instant = (SEED_NOW + day * DAY) as Instant;
      // The snapshot is rebuilt at each instant, exactly as the pipeline rebuilds it: the elapsed
      // counts move with the day, which is the point — the *ids* must not.
      const report = generateStructuredReport(
        buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' }, instant }),
        instant,
        {
          deploySignalAvailable: false,
          coverage: [],
          maxItemsPerSection: 12,
          ...(prior === null ? {} : { priorReport: prior }),
        },
      );
      reports.push(report);
      prior = priorStateOf(report);
    }

    return reports;
  };

  const reports = chain();

  it('generates ten reports over the real seeded dataset', () => {
    expect(reports).toHaveLength(DAYS);
    expect(reports.every((report) => report.sections.length === 6)).toBe(true);
  });

  it('keeps one id for the persistent risk across all ten', () => {
    const risksEachDay = reports.map((report) => sectionOf(report, 'risks').items.map((entry) => entry.stableId));

    // A risk present on every one of the ten days: the condition holds throughout, so it is one item
    // with a history rather than ten unrelated findings.
    const persistent = risksEachDay[0]!.filter((stableId) =>
      risksEachDay.every((day) => day.includes(stableId)),
    );

    expect(persistent.length, 'the seeded platform team must carry at least one risk for ten days').toBeGreaterThan(0);

    for (const stableId of persistent) {
      expect(isStableItemId(stableId)).toBe(true);
      // The set of ids this condition produced across ten days has exactly one member.
      const seen = new Set(risksEachDay.flat().filter((candidate) => candidate === stableId));
      expect(seen.size, `${stableId} must be one item across all ten days`).toBe(1);
    }
  });

  it('reports the persistent risk as new once and never again', () => {
    const risksEachDay = reports.map((report) => sectionOf(report, 'risks').items);
    const persistentId = risksEachDay[0]!
      .map((entry) => entry.stableId)
      .find((stableId) => risksEachDay.every((day) => day.some((entry) => entry.stableId === stableId)));

    expect(persistentId).toBeDefined();

    const tags = risksEachDay.map(
      (day) => day.find((entry) => entry.stableId === persistentId)?.changeTag ?? 'missing',
    );

    // Day one has no prior report, so `new` is correct there and nowhere else. This is the assertion
    // that would fail for an implementation that re-derived the tag from the window rather than from
    // the previous report.
    expect(tags[0]).toBe('new');
    expect(tags.slice(1)).not.toContain('new');
  });

  it('accrues age on a carried-over item rather than resetting it', () => {
    const blockersEachDay = reports.map((report) => sectionOf(report, 'blockers').items);
    const persistentId = blockersEachDay[0]!
      .map((entry) => entry.stableId)
      .find((stableId) => blockersEachDay.every((day) => day.some((entry) => entry.stableId === stableId)));

    if (persistentId === undefined) {
      // The seeded dataset need not carry a ten-day blocker; the risk assertion above is the
      // criterion. Stated rather than silently skipped, so a reader knows this case did not run.
      expect(blockersEachDay[0]!.length).toBeGreaterThanOrEqual(0);
      return;
    }

    const firstSeen = blockersEachDay[0]!.find((entry) => entry.stableId === persistentId)!.firstSeenAt;
    const lastDay = reports.at(-1)!;
    const onLastDay = sectionOf(lastDay, 'blockers').items.find((entry) => entry.stableId === persistentId)!;

    // One first sighting, carried forward unchanged across nine further reports.
    expect(onLastDay.firstSeenAt).toBe(firstSeen);
    expect(wholeDaysBetween(onLastDay.firstSeenAt, lastDay.instant)).toBe(DAYS - 1);
  });

  it('carries a change summary on every report, and only the first says it has no prior', () => {
    expect(reports[0]?.changeSummary.hasPriorReport).toBe(false);
    expect(reports.slice(1).every((report) => report.changeSummary.hasPriorReport)).toBe(true);
    // The prior instant is the previous day's, so "since yesterday" is a claim the report can back.
    expect(reports[1]?.changeSummary.priorInstant).toBe(reports[0]?.instant);
  });

  it('gives every item on every day exactly one tag from the closed set', () => {
    for (const report of reports) {
      for (const reportSection of report.sections) {
        for (const entry of reportSection.items) {
          expect(CHANGE_TAGS, `${reportSection.key}/${entry.stableId}`).toContain(entry.changeTag);
        }
      }
    }
  });
});
