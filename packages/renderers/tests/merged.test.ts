import {
  MAX_MERGED_ITEMS,
  MERGED_REPORT_WORD_BUDGET,
  SECTION_ORDER,
  WordBudgetExceededError,
  assertWithinWordBudget,
  countWords,
  mergeTeamReports,
  type Instant,
  type MergeTeamInput,
  type MergedReport,
  type ReportItem,
  type SectionKey,
  type StructuredReport,
} from '@compass/analysis';
import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { renderMergedLine, renderMergedReport } from '@compass/renderers';

/**
 * The merged report's prose, and the budget enforced over it.
 *
 * The budget assertion lives here rather than in the analysis package on purpose: a word budget is a
 * fact about the sentences a manager reads, and the analysis core produces items rather than sentences.
 * This is the layer where there is a string to count.
 */

const INSTANT: Instant = instantFromIso('2026-07-31T08:12:00Z');
const WINDOW = timeWindow(instantFromIso('2026-07-29T23:00:00Z'), instantFromIso('2026-07-30T23:00:00Z'));

const item = (overrides: Partial<ReportItem> = {}): ReportItem => ({
  stableId: 'v1:0000000000000001',
  cause: { entityRef: 'ticket:PLAT-742', causeKind: 'status_dwell', causeDiscriminator: '' },
  headline: 'PLAT-742 has not moved in 4 working days',
  detail: 'Last transition on 2026-07-27.',
  changeTag: 'unchanged',
  ageDays: 4,
  firstSeenAt: INSTANT,
  severityScore: 4,
  signalOnsetAt: INSTANT,
  evidence: [{ kind: 'issue', label: 'PLAT-742', sourceKey: 'tracker', sourceRecordId: 'PLAT-742' }],
  ...overrides,
});

const reportWith = (items: Partial<Record<SectionKey, readonly ReportItem[]>>): StructuredReport =>
  ({
    schemaVersion: 2,
    organizationId: '11111111-1111-4111-8111-111111111111',
    scope: { kind: 'team', teamKey: 'x' },
    instant: INSTANT,
    timezone: 'Europe/London',
    window: WINDOW,
    sections: SECTION_ORDER.map((key, position) => ({
      key,
      index: position + 1,
      title: key,
      items: items[key] ?? [],
      emptyStatement: `Nothing for ${key}.`,
    })),
    coverage: [],
    findings: {} as StructuredReport['findings'],
    changeSummary: {
      hasPriorReport: true,
      priorInstant: (INSTANT - 86_400_000) as Instant,
      nothingMaterialChanged: false,
      statement: 'Something moved.',
      counts: { new: 0, unchanged: 1, worsened: 0, improved: 0, resolved: 0 },
      departedStableIds: [],
    },
    suppressed: [],
  }) as StructuredReport;

const merge = (teamReports: readonly MergeTeamInput[]): MergedReport =>
  mergeTeamReports({
    organizationId: '11111111-1111-4111-8111-111111111111',
    instant: INSTANT,
    timezone: 'Europe/London',
    window: WINDOW,
    teamReports,
  });

/**
 * The worst case the budget has to survive: three teams, every section full, every headline long.
 *
 * A 120-character headline is longer than anything the analysis core actually emits, so if the budget
 * holds here it holds on real data. That is the point of a worst case rather than a fixture.
 */
const worstCaseTeams = (): readonly MergeTeamInput[] =>
  ['aardvark-platform', 'brontosaurus-checkout', 'chameleon-insights'].map((teamKey, teamIndex) => ({
    teamKey,
    reportId: `report-${teamKey}`,
    report: reportWith(
      Object.fromEntries(
        SECTION_ORDER.map((key, sectionIndex) => [
          key,
          Array.from({ length: 12 }, (_unused, itemIndex) => {
            // Decades wide enough for 12 items and 6 sections. A tighter stride made two items share an
            // id — 216 candidates deduped to 177 conditions — which is the merged report behaving
            // correctly on a fixture that was wrong, and worth the arithmetic to avoid.
            const ordinal = teamIndex * 1000 + sectionIndex * 100 + itemIndex;
            return item({
              stableId: `v1:${String(ordinal).padStart(16, '0')}`,
              headline:
                `PLAT-${1000 + ordinal} has not moved in 14 working days and the reviewer requested changes ` +
                'twice before going on leave, so nothing has happened since',
              changeTag: 'worsened',
              severityScore: 300 + ordinal,
              firstSeenAt: (INSTANT - 9 * 86_400_000) as Instant,
            });
          }),
        ]),
      ),
    ),
  }));

describe('the merged report never exceeds its documented budget', () => {
  it('renders the worst case inside 400 words', () => {
    const rendered = renderMergedReport(merge(worstCaseTeams()));

    expect(rendered.wordBudget).toBe(MERGED_REPORT_WORD_BUDGET);
    expect(rendered.wordCount).toBeLessThanOrEqual(MERGED_REPORT_WORD_BUDGET);
    // And the count is the one a reader would arrive at, not a discounted one.
    expect(rendered.wordCount).toBe(countWords(rendered.prose));
  });

  it('does not simply render nothing to stay inside the budget', () => {
    // The failure mode a budget invites: an enforcer that passes by emitting almost no prose. The page
    // has to be full — every slot used — as well as short.
    const rendered = renderMergedReport(merge(worstCaseTeams()));
    const lines = rendered.sections.flatMap((section) => section.lines);

    expect(lines).toHaveLength(MAX_MERGED_ITEMS);
    expect(rendered.wordCount).toBeGreaterThan(MERGED_REPORT_WORD_BUDGET / 4);
  });

  it('states the findings it left in the per-team reports', () => {
    const rendered = renderMergedReport(merge(worstCaseTeams()));

    // 3 teams × 6 sections × 12 items = 216 candidates, 9 of which fit.
    expect(rendered.omittedLine).toContain(String(216 - MAX_MERGED_ITEMS));
    expect(rendered.omittedLine).toContain('per-team reports');
  });

  it('fails closed rather than truncating when prose exceeds a budget', () => {
    // The guard itself, exercised directly: a budget that truncated would emit a report ending
    // mid-sentence, which reads as a bug rather than as a limit.
    expect(() => assertWithinWordBudget('one two three four', 3, 'test page')).toThrow(WordBudgetExceededError);
    expect(() => assertWithinWordBudget('one two three', 3, 'test page')).not.toThrow();

    try {
      assertWithinWordBudget('one two three four', 3, 'merged cross-team report');
      expect.unreachable('the budget guard must throw');
    } catch (error) {
      expect((error as WordBudgetExceededError).counted).toBe(4);
      expect((error as WordBudgetExceededError).budget).toBe(3);
      expect((error as WordBudgetExceededError).detail).toContain('per-team report');
    }
  });
});

describe('the merged prose is an index, not a concatenation', () => {
  const rendered = renderMergedReport(
    merge([
      {
        teamKey: 'platform',
        reportId: 'report-platform',
        report: reportWith({
          recommendations: [
            item({
              stableId: 'v1:00000000000000r1',
              headline: 'Priya Raman — ask Dev Patel to review #883 today',
              severityScore: 200,
              changeTag: 'new',
            }),
          ],
        }),
      },
      {
        teamKey: 'checkout',
        reportId: 'report-checkout',
        report: reportWith({
          blockers: [
            item({
              stableId: 'v1:00000000000000b1',
              headline: 'CHK-701 has not moved in 6 working days',
              firstSeenAt: (INSTANT - 6 * 86_400_000) as Instant,
            }),
          ],
        }),
      },
    ]),
  );

  it('names the team on every line, because that is the reader’s first question', () => {
    for (const section of rendered.sections) {
      for (const line of section.lines) {
        expect(line.prose.startsWith(`${line.teamKey}: `), line.prose).toBe(true);
      }
    }
  });

  it('carries the per-team item id on every rendered line', () => {
    // The link down. Without it the merged page is a summary a reader cannot check.
    const ids = rendered.sections.flatMap((section) => section.lines.map((line) => line.stableId));
    expect(ids).toContain('v1:00000000000000r1');
    expect(ids).toContain('v1:00000000000000b1');
  });

  it('leads with the recommendation and keeps the Six Spine order', () => {
    expect(rendered.sections.map((section) => section.key)).toEqual(['blockers', 'recommendations']);
    // Spine order for the *headings*, action-impact order for what got onto the page at all.
    expect(rendered.sections.map((section) => section.numeral)).toEqual(['03', '05']);
  });

  it('appends a day counter only to an item that has recurred', () => {
    expect(renderMergedLine({
      stableId: 'v1:1',
      teamKey: 'checkout',
      sectionKey: 'blockers',
      headline: 'CHK-701 has not moved',
      changeTag: 'unchanged',
      seenDays: 6,
      impact: { score: 0, sectionWeight: 0, changeWeight: 0, severityContribution: 0 },
    })).toBe('checkout: CHK-701 has not moved, day 6.');

    expect(renderMergedLine({
      stableId: 'v1:1',
      teamKey: 'checkout',
      sectionKey: 'blockers',
      headline: 'CHK-701 has not moved',
      changeTag: 'new',
      seenDays: 0,
      impact: { score: 0, sectionWeight: 0, changeWeight: 0, severityContribution: 0 },
    })).toBe('checkout: CHK-701 has not moved.');
  });

  it('states the per-team index rather than repeating each team’s sections', () => {
    expect(rendered.teamLines).toEqual([
      'checkout has 1 finding, 1 of them here.',
      'platform has 1 finding, 1 of them here.',
    ]);
  });

  it('carries no chart, canvas or svg', () => {
    // Prose-only is structural here: this renderer emits strings. Asserted anyway, because the cheapest
    // way to break it later is a component that "just adds a sparkline".
    for (const token of ['<svg', '<canvas', 'chart', 'sparkline']) {
      expect(rendered.text.toLowerCase(), token).not.toContain(token);
    }
  });
});

describe('an empty merged page reads as good news', () => {
  it('states it in a sentence rather than rendering a blank measure', () => {
    const rendered = renderMergedReport(merge([{ teamKey: 'platform', report: reportWith({}) }]));

    expect(rendered.sections).toEqual([]);
    expect(rendered.prose).toContain('crossed a threshold worth your morning');
    expect(rendered.wordCount).toBeGreaterThan(0);
  });
});

describe('the merged render is deterministic', () => {
  it('emits identical bytes for the same merged report', () => {
    const merged = merge(worstCaseTeams());
    expect(renderMergedReport(merged).text).toBe(renderMergedReport(merged).text);
  });
});
