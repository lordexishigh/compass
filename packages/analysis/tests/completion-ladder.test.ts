import { describe, expect, it } from 'vitest';

import {
  LADDER_RUNGS,
  NO_DEPLOY_SIGNAL_STATEMENT,
  RUNG_DETECTORS,
  RUNG_LABELS,
  assessLadder,
  commitNodeKey,
  detectYesterdayItems,
  emptyCommitGraph,
  generateStructuredReport,
  indexCommitGraph,
  reachesCommit,
  resolveScope,
  sectionOf,
  type AnalysisSnapshot,
} from '@compass/analysis';

import {
  SEED_NOW,
  buildSeedSnapshot,
  mergedButUnreachableSnapshot,
} from './helpers/seed-snapshot.js';

/**
 * The Completion Ladder: five rungs, five deterministic detectors, and one rung
 * that is never inferred.
 *
 * The rung this file exists for is **R3**. Every other rung can be decided by
 * reading a field — a status category, a merge instant, a tag — and a wrong answer
 * there is a bug. R3 is decided by walking parent edges, and a wrong answer there
 * is a *lie of the most expensive kind*: "this is on the branch everyone builds
 * from" is the claim a manager acts on when they decide the work is finished. Merge
 * state is not that claim, and the assertion below proves Compass does not treat it
 * as one.
 */
const ladderOptions = (snapshot: AnalysisSnapshot) =>
  ({ deploySignalAvailable: false, graph: indexCommitGraph(snapshot) }) as const;

const checkout = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'checkout' } });
const checkoutItems = detectYesterdayItems(checkout, SEED_NOW, resolveScope(checkout), ladderOptions(checkout));

describe('every rung is decided by a documented deterministic detector', () => {
  it('documents one detector per rung, naming the ingested field it reads', () => {
    expect(RUNG_DETECTORS.map((entry) => entry.rung)).toEqual([...LADDER_RUNGS]);

    for (const entry of RUNG_DETECTORS) {
      expect(entry.detector.length, `${entry.rung} states no detector`).toBeGreaterThan(30);
      expect(RUNG_LABELS[entry.rung].length).toBeGreaterThan(0);
    }
  });

  it('marks R5 as the one rung that is not inferable, and says so in the rule', () => {
    const inferable = RUNG_DETECTORS.filter((entry) => entry.inferable).map((entry) => entry.rung);
    const notInferable = RUNG_DETECTORS.filter((entry) => !entry.inferable);

    expect(inferable).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(notInferable.map((entry) => entry.rung)).toEqual(['R5']);
    expect(notInferable[0]?.detector).toContain('never inferred');
  });

  it('names branch topology in the R3 rule and a tag ancestry walk in R4', () => {
    const byRung = new Map(RUNG_DETECTORS.map((entry) => [entry.rung, entry.detector]));

    expect(byRung.get('R3')).toContain('parentRevisionIds');
    expect(byRung.get('R3')).toContain('branch_ref');
    expect(byRung.get('R4')).toContain('parentRevisionIds');
  });
});

describe('R3 is branch-topology reachability, not merge state', () => {
  const snapshot = mergedButUnreachableSnapshot();
  const scope = resolveScope(snapshot);
  const items = detectYesterdayItems(snapshot, SEED_NOW, scope, ladderOptions(snapshot));
  const str2 = items.find((item) => item.ticketKey === 'STR-2');
  const notch = (rung: string) => str2?.ladder.notches.find((entry) => entry.rung === rung);

  it('finds the merged item at all, so the assertion below is about the rung', () => {
    expect(str2, 'STR-2 merged inside the report window').toBeDefined();
    expect(notch('R1')?.crossed, 'the tracker accepted it').toBe(true);
    expect(notch('R2')?.crossed, 'the forge merged it').toBe(true);
  });

  it('refuses R3 for a merge commit the default branch cannot reach', () => {
    // #77 merged into `release/2.1`. `main` points at `aaa1111`, and no chain of
    // parent edges from `aaa1111` reaches the merge commit `ccc3333`.
    expect(notch('R3')?.crossed, 'a merge into a release branch is not integration').toBe(false);
  });

  it('states why R3 was withheld rather than leaving a silent empty notch', () => {
    expect(notch('R3')?.statement).toContain('not reachable from the default branch');
  });

  it('still awards R4, and shows the gap at R3 rather than hiding it', () => {
    // `v2.1.1` points at `ccc3333`, so the work genuinely is inside a release — it
    // is simply not on the trunk. Both facts are true and the notches carry both:
    // R2 and R4 crossed, R3 empty. `highestContiguous` is what the win rule reads,
    // so this still does not qualify as an achievement.
    expect(notch('R4')?.crossed).toBe(true);
    expect(str2?.ladder.highestCrossed).toBe('R4');
    expect(str2?.ladder.highestContiguous).toBe('R2');
    expect(str2?.ladder.notches.map((entry) => entry.crossed)).toEqual([true, true, false, true, false]);
  });

  it('awards R3 in the seeded dataset, so the refusal above is not vacuous', () => {
    const integrated = checkoutItems.filter(
      (item) => item.ladder.notches.find((entry) => entry.rung === 'R3')?.crossed === true,
    );

    expect(integrated.length, 'no seeded merge reaches its trunk — the detector cannot pass anything').toBeGreaterThan(
      0,
    );
    for (const item of integrated) {
      expect(item.ladder.notches.find((entry) => entry.rung === 'R2')?.crossed).toBe(true);
    }
  });
});

describe('reachability is a walk over declared parent edges', () => {
  const snapshot = mergedButUnreachableSnapshot();
  const graph = indexCommitGraph(snapshot);
  const node = (revisionId: string) => commitNodeKey('strand-api', revisionId);

  it('reaches a commit from itself', () => {
    expect(reachesCommit(graph, node('aaa1111'), node('aaa1111'))).toBe(true);
  });

  it('reaches a parent from its child', () => {
    expect(reachesCommit(graph, node('ccc3333'), node('bbb2222'))).toBe(true);
  });

  it('does not reach a child from its parent', () => {
    expect(reachesCommit(graph, node('bbb2222'), node('ccc3333'))).toBe(false);
  });

  it('does not reach across two unconnected histories', () => {
    expect(reachesCommit(graph, node('aaa1111'), node('ccc3333'))).toBe(false);
  });

  it('reaches nothing from a tip Compass does not have', () => {
    expect(reachesCommit(graph, undefined, node('aaa1111'))).toBe(false);
    expect(reachesCommit(emptyCommitGraph(), node('aaa1111'), node('aaa1111'))).toBe(true);
  });

  it('reads the trunk tip from the default branch ref rather than guessing', () => {
    expect(graph.defaultBranchTips.get('strand-api')).toBe(node('aaa1111'));
    expect(graph.defaultBranches.get('strand-api')?.fields['name']).toBe('main');
  });

  it('awards no rung above R2 when Compass holds no repository data at all', () => {
    const bare = assessLadder(
      { ticket: null, pullRequests: [], commits: [], releaseTags: [], doneAt: null },
      { deploySignalAvailable: false, graph: emptyCommitGraph() },
    );

    expect(bare.highestCrossed).toBe('R0');
    expect(bare.rungSuffix).toBe('nothing reached a completion rung');
  });
});

describe('R5 is never inferred and always says so', () => {
  it('renders the literal words the design requires on every seeded item', () => {
    expect(checkoutItems.length).toBeGreaterThan(0);
    for (const item of checkoutItems) {
      const deployed = item.ladder.notches.find((entry) => entry.rung === 'R5');
      expect(deployed?.crossed).toBe(false);
      expect(deployed?.reachable).toBe(false);
      expect(deployed?.statement).toBe(NO_DEPLOY_SIGNAL_STATEMENT);
    }
  });

  it('stays uncrossed even when a connector reports a deploy signal, until a deploy is observed', () => {
    // A capability is not an event. With the signal available the notch becomes
    // reachable — the hollow mark and the sentence go away — but nothing is crossed
    // until an actual deploy record arrives.
    const withSignal = detectYesterdayItems(checkout, SEED_NOW, resolveScope(checkout), {
      ...ladderOptions(checkout),
      deploySignalAvailable: true,
    });

    for (const item of withSignal) {
      const deployed = item.ladder.notches.find((entry) => entry.rung === 'R5');
      expect(deployed?.reachable).toBe(true);
      expect(deployed?.crossed).toBe(false);
      expect(deployed?.statement).toBeNull();
    }
  });

  it('never puts a deploy claim in a rung suffix', () => {
    for (const item of checkoutItems) {
      expect(item.ladder.rungSuffix).not.toContain('deployed');
    }
  });
});

describe('every Yesterday line carries its furthest reached rung', () => {
  const teams = ['platform', 'checkout', 'insights'] as const;

  it.each(teams)('suffixes every %s line, with no exceptions', (teamKey) => {
    const report = generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW);
    const yesterday = sectionOf(report, 'yesterday');

    expect(yesterday.items.length, `${teamKey} has no Yesterday items to check`).toBeGreaterThan(0);
    for (const item of yesterday.items) {
      const suffix = item.ladder?.rungSuffix;
      expect(suffix, `${item.stableId} has no ladder`).toBeDefined();
      expect(suffix!.length).toBeGreaterThan(0);
      expect(
        item.headline.endsWith(suffix as string),
        `${item.stableId} does not end in its rung suffix: "${item.headline}"`,
      ).toBe(true);
    }
  });

  it('spells the suffix as the rung reached and the next one it has not', () => {
    const report = generateStructuredReport(
      buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } }),
      SEED_NOW,
    );
    const suffixes = new Set(sectionOf(report, 'yesterday').items.map((item) => item.ladder?.rungSuffix));

    // The seeded platform team merges to trunk and has not cut a tag since, which is
    // exactly the `merged-not-released-platform-api` pathology.
    expect(suffixes.has('integrated, not yet released')).toBe(true);
    for (const suffix of suffixes) {
      expect(suffix).toMatch(
        /^(nothing reached a completion rung|accepted|merged|integrated|released)(, not yet (merged|integrated|released)|, and no deploy signal available)?$/,
      );
    }
  });
});
