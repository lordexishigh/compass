import { describe, expect, it } from 'vitest';

import {
  CHANGE_ACTION_WEIGHT,
  CHANGE_BAND,
  MAX_MERGED_ITEMS,
  MAX_SEVERITY_CONTRIBUTION,
  MERGED_REPORT_WORD_BUDGET,
  SECTION_ACTION_WEIGHT,
  SECTION_BAND,
  SECTION_ORDER,
  actionImpact,
  countWords,
  generateStructuredReport,
  mergeTeamReports,
  mergedSectionKeys,
  type ChangeTag,
  type Instant,
  type MergeTeamInput,
  type ReportItem,
  type SectionKey,
  type StructuredReport,
} from '@compass/analysis';

import { SEED_NOW, SEED_TIMEZONE, SEED_WINDOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * The merged cross-team report.
 *
 * Three claims, and each is a way the merged page can quietly stop being useful: it can grow past what
 * a manager reads, it can rank by the order the teams happened to be listed in, and it can lose the
 * thread back to the per-team claim it is summarising.
 */

const TEAM_KEYS = ['platform', 'checkout', 'insights'] as const;

const seededReport = (teamKey: string): StructuredReport =>
  generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW);

const seededTeams = (): readonly MergeTeamInput[] =>
  TEAM_KEYS.map((teamKey) => ({ teamKey, report: seededReport(teamKey), reportId: `report-${teamKey}` }));

const merge = (teamReports: readonly MergeTeamInput[]) =>
  mergeTeamReports({
    organizationId: '00000000-0000-4000-8000-000000000001',
    instant: SEED_NOW,
    timezone: SEED_TIMEZONE,
    window: SEED_WINDOW,
    teamReports,
  });

// ---------------------------------------------------------------------------
// A hand-built pair of teams, so the ranking claim is not at the mercy of the seed
// ---------------------------------------------------------------------------

const item = (overrides: Partial<ReportItem> = {}): ReportItem => ({
  stableId: 'v1:0000000000000001',
  cause: { entityRef: 'ticket:PLAT-742', causeKind: 'status_dwell', causeDiscriminator: '' },
  headline: 'PLAT-742 has not moved in 4 working days',
  detail: 'Last transition on 2026-07-27.',
  changeTag: 'unchanged',
  ageDays: 4,
  firstSeenAt: SEED_NOW,
  severityScore: 4,
  signalOnsetAt: SEED_NOW,
  evidence: [{ kind: 'issue', label: 'PLAT-742', sourceKey: 'tracker', sourceRecordId: 'PLAT-742' }],
  ...overrides,
});

/** A report carrying one item in one section, so a test can state exactly what it is ranking. */
const reportWith = (sectionKey: SectionKey, items: readonly ReportItem[], hasPrior = true): StructuredReport =>
  ({
    schemaVersion: 2,
    organizationId: '00000000-0000-4000-8000-000000000001',
    scope: { kind: 'team', teamKey: 'x' },
    instant: SEED_NOW,
    timezone: SEED_TIMEZONE,
    window: SEED_WINDOW,
    sections: SECTION_ORDER.map((key, position) => ({
      key,
      index: position + 1,
      title: key,
      items: key === sectionKey ? items : [],
      emptyStatement: `Nothing for ${key}.`,
    })),
    coverage: [],
    findings: {} as StructuredReport['findings'],
    changeSummary: {
      hasPriorReport: hasPrior,
      priorInstant: hasPrior ? ((SEED_NOW - 86_400_000) as Instant) : null,
      nothingMaterialChanged: false,
      statement: 'Something moved.',
      counts: { new: 0, unchanged: 1, worsened: 0, improved: 0, resolved: 0 },
      departedStableIds: [],
    },
    suppressed: [],
  }) as StructuredReport;

describe('the action-impact score is a documented number', () => {
  it('keeps the three considerations in strict bands', () => {
    // The property the whole ranking rests on: no amount of movement or severity can promote an item
    // out of its section band, so a worsened Win never outranks an unchanged recommendation.
    const largestChange = Math.max(...Object.values(CHANGE_ACTION_WEIGHT)) * CHANGE_BAND;
    expect(largestChange).toBeLessThan(SECTION_BAND);
    expect(MAX_SEVERITY_CONTRIBUTION).toBeLessThan(CHANGE_BAND);
  });

  it('ranks recommendations over blockers over risks over the informational three', () => {
    const order = [...SECTION_ORDER].sort((left, right) => SECTION_ACTION_WEIGHT[right] - SECTION_ACTION_WEIGHT[left]);
    expect(order).toEqual(['recommendations', 'blockers', 'risks', 'progress', 'yesterday', 'wins']);
  });

  it('composes the score from the section, the movement and the severity', () => {
    const impact = actionImpact('risks', item({ changeTag: 'worsened', severityScore: 210 }));

    expect(impact.sectionWeight).toBe(SECTION_ACTION_WEIGHT.risks);
    expect(impact.changeWeight).toBe(CHANGE_ACTION_WEIGHT.worsened);
    expect(impact.severityContribution).toBe(210);
    expect(impact.score).toBe(4 * SECTION_BAND + 120 * CHANGE_BAND + 210);
  });

  it('caps a severity that would otherwise cross into the change band', () => {
    // A blocker measured in thousands of days, or a family whose score is on another scale entirely,
    // must not be able to outrank a whole change tag.
    expect(actionImpact('blockers', item({ severityScore: 99_999 })).severityContribution).toBe(
      MAX_SEVERITY_CONTRIBUTION,
    );
  });
});

describe('ranking ignores the order the teams were listed in', () => {
  it('puts a high-impact team’s item above a low-impact team’s, with the low-impact team first', () => {
    // The acceptance criterion, stated exactly: the low-impact team is passed *first*, and a
    // concatenating implementation would therefore lead with its Win.
    const lowImpact: MergeTeamInput = {
      teamKey: 'aardvark',
      report: reportWith('wins', [
        item({ stableId: 'v1:00000000000000aa', headline: 'DEV-1 landed the batch writer', changeTag: 'resolved' }),
      ]),
    };
    const highImpact: MergeTeamInput = {
      teamKey: 'zebra',
      report: reportWith('recommendations', [
        item({ stableId: 'v1:00000000000000zz', headline: 'Ask Dev to review #883 today', severityScore: 200 }),
      ]),
    };

    const merged = merge([lowImpact, highImpact]);

    expect(merged.items[0]?.teamKey).toBe('zebra');
    expect(merged.items[0]?.sectionKey).toBe('recommendations');
    expect(merged.items[1]?.teamKey).toBe('aardvark');
  });

  it('produces the same page whichever order the teams arrive in', () => {
    const teams = seededTeams();
    const forwards = merge(teams);
    const backwards = merge([...teams].reverse());

    expect(forwards.items.map((entry) => entry.stableId)).toEqual(backwards.items.map((entry) => entry.stableId));
    expect(forwards.changeLine).toBe(backwards.changeLine);
    // And the per-team index is in team-key order rather than arrival order, so it does not reshuffle.
    expect(forwards.teams.map((team) => team.teamKey)).toEqual(backwards.teams.map((team) => team.teamKey));
    expect(forwards.teams.map((team) => team.teamKey)).toEqual([...TEAM_KEYS].sort());
  });

  it('breaks a tie on the item id rather than on input order', () => {
    // Two items identical in every scoring component. `Array.prototype.sort` is stable, so without the
    // explicit tiebreak these would resolve to team order — which is the thing being forbidden.
    const first: MergeTeamInput = {
      teamKey: 'zebra',
      report: reportWith('risks', [item({ stableId: 'v1:00000000000000ff' })]),
    };
    const second: MergeTeamInput = {
      teamKey: 'aardvark',
      report: reportWith('risks', [item({ stableId: 'v1:00000000000000a1' })]),
    };

    expect(merge([first, second]).items.map((entry) => entry.stableId)).toEqual([
      'v1:00000000000000a1',
      'v1:00000000000000ff',
    ]);
    expect(merge([second, first]).items.map((entry) => entry.stableId)).toEqual([
      'v1:00000000000000a1',
      'v1:00000000000000ff',
    ]);
  });
});

describe('every merged item points back at a per-team item', () => {
  const merged = merge(seededTeams());

  it('merges the seeded three-team organization at all', () => {
    expect(merged.teams).toHaveLength(3);
    expect(merged.items.length).toBeGreaterThan(0);
  });

  it('carries the per-team item’s own id, never a new one', () => {
    // The foreign key. A second identity for one condition is how a dismissal, a day counter and a
    // presence trail stop resolving — every one of them looks the item up by this string.
    const perTeam = new Map<string, string>();
    for (const team of seededTeams()) {
      for (const section of team.report.sections) {
        for (const entry of section.items) perTeam.set(entry.stableId, team.teamKey);
      }
    }

    for (const entry of merged.items) {
      expect(perTeam.has(entry.stableId), entry.stableId).toBe(true);
      expect(perTeam.get(entry.stableId)).toBe(entry.teamKey);
    }
  });

  it('names the team’s own report, so the link down is to a specific report', () => {
    for (const team of merged.teams) {
      expect(team.reportId, team.teamKey).toBe(`report-${team.teamKey}`);
    }
  });

  it('states how many findings each team has and how many reached the page', () => {
    for (const team of merged.teams) {
      expect(team.mergedItemCount).toBeLessThanOrEqual(team.itemCount);
      expect(team.mergedItemCount).toBe(merged.items.filter((entry) => entry.teamKey === team.teamKey).length);
    }
  });

  it('groups into the Six Spine without reordering it', () => {
    const keys = mergedSectionKeys(merged);
    expect(keys).toEqual(SECTION_ORDER.filter((key) => keys.includes(key)));
  });
});

describe('the page is cut to the budget rather than growing with the teams', () => {
  const merged = merge(seededTeams());

  it('carries no more than the documented item cap', () => {
    expect(merged.items.length).toBeLessThanOrEqual(MAX_MERGED_ITEMS);
    expect(merged.wordBudget).toBe(MERGED_REPORT_WORD_BUDGET);
  });

  it('states how many findings it left in the per-team reports', () => {
    const total = seededTeams().reduce(
      (sum, team) => sum + team.report.sections.reduce((inner, section) => inner + section.items.length, 0),
      0,
    );

    expect(merged.omittedItemCount).toBe(Math.max(0, total - merged.items.length));
    // The seeded three-team org has more findings than the page holds, so this is a real assertion
    // rather than a vacuous one about zero.
    expect(total).toBeGreaterThan(MAX_MERGED_ITEMS);
    expect(merged.omittedItemCount).toBeGreaterThan(0);
  });

  it('keeps the highest-ranked items rather than the first ones found', () => {
    const scores = merged.items.map((entry) => entry.impact.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });
});

describe('the merged change line agrees with the per-team reports', () => {
  it('says nothing moved when every team says nothing moved', () => {
    const quiet = (teamKey: string): MergeTeamInput => {
      const base = reportWith('risks', [item()]);
      return {
        teamKey,
        report: {
          ...base,
          changeSummary: {
            ...base.changeSummary,
            nothingMaterialChanged: true,
            statement: 'Nothing material changed since yesterday.',
          },
        } as StructuredReport,
      };
    };

    expect(merge([quiet('a'), quiet('b')]).changeLine).toBe(
      'Nothing material changed since yesterday on any of these teams.',
    );
  });

  it('says so plainly on a first merged report', () => {
    const first = merge([{ teamKey: 'a', report: reportWith('risks', [item()], false) }]);
    expect(first.changeLine).toContain('first merged report');
  });

  it('counts what moved, across how many teams', () => {
    const moved = (teamKey: string, tag: ChangeTag, stableId: string): MergeTeamInput => ({
      teamKey,
      report: reportWith('risks', [item({ stableId, changeTag: tag })]),
    });

    const line = merge([
      moved('a', 'worsened', 'v1:00000000000000a1'),
      moved('b', 'new', 'v1:00000000000000b1'),
    ]).changeLine;

    expect(line).toBe('2 items moved across 2 teams since the previous report.');
  });
});

describe('determinism', () => {
  it('produces an identical page for the same inputs', () => {
    // The merged report is never narrated, so this is byte-identity rather than a grounding check.
    expect(JSON.stringify(merge(seededTeams()))).toBe(JSON.stringify(merge(seededTeams())));
  });

  it('counts words the way a reader would', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('one two  three\nfour')).toBe(4);
    // No exclusions: a mono token is a word on the page.
    expect(countWords('PLAT-742 is #9201 at 01')).toBe(5);
  });
});
