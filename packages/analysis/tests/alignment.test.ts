import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  ALIGNMENT_CLASSES,
  OFF_GOAL_LABEL,
  SEMANTIC_CONFIDENCE_THRESHOLD,
  THRESHOLDS,
  alignmentTokens,
  assessAlignment,
  diceSimilarity,
  findTicketKey,
  goalHierarchyFromSnapshot,
  resolveScope,
  sectionOf,
  generateStructuredReport,
  type AlignmentAssessment,
  type AlignmentClass,
  type AnalysisSnapshot,
} from '@compass/analysis';

import { SEED_NOW, SEED_WINDOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * Alignment over the real seeded dataset.
 *
 * The four resolution classes are the one part of this product that cannot be
 * tested against a hand-rolled fixture. A fixture would give every commit a tidy
 * ticket key, the semantic tier would never fire, and the unattributed bucket —
 * the thing that keeps Compass from accusing anybody — would have no test at all.
 * So the seed plants all four in documented proportions and this asserts the
 * analysis core reproduces them.
 *
 * The strongest assertion here is the distribution one. `seed/generated/manifest.json`
 * records what the *seed generator's* own classifier found over all 912 commits,
 * computed by a completely separate implementation in
 * `packages/seed-connector/src/traceability.ts`. The analysis core cannot import
 * that implementation — the analysis package declares zero dependencies — so the
 * two are held together by this count. If either drifts, the numbers part.
 */
const MANIFEST_PATH = new URL('../../../seed/generated/manifest.json', import.meta.url);

interface ManifestDistributionEntry {
  readonly traceabilityClass: string;
  readonly count: number;
}

interface Manifest {
  readonly reportWindow: { readonly start: string; readonly end: string };
  readonly traceability: {
    readonly threshold: number;
    readonly dataset: readonly ManifestDistributionEntry[];
    readonly reportWindow: readonly ManifestDistributionEntry[];
  };
}

const manifest = JSON.parse(readFileSync(fileURLToPath(MANIFEST_PATH), 'utf8')) as Manifest;

/** The seed calls the first tier `structural`; the store calls it `configured`. */
const CLASS_ALIASES: Readonly<Record<string, AlignmentClass>> = {
  structural: 'configured',
  inferred: 'inferred',
  semantic: 'semantic',
  unattributed: 'unattributed',
};

const DATASET_WINDOW = timeWindow(
  instantFromIso('2026-05-18T00:00:00.000Z'),
  instantFromIso('2026-07-31T00:00:00.000Z'),
);

const merged = (): AnalysisSnapshot => buildSeedSnapshot({ scope: { kind: 'merged' } });

function commitCounts(assessment: AlignmentAssessment): Readonly<Record<AlignmentClass, number>> {
  const counts: Record<AlignmentClass, number> = { configured: 0, inferred: 0, semantic: 0, unattributed: 0 };
  for (const resolution of assessment.resolutions) {
    if (resolution.subjectKind !== 'commit') continue;
    counts[resolution.alignmentClass] += 1;
  }
  return counts;
}

const expected = (rows: readonly ManifestDistributionEntry[]): Readonly<Record<AlignmentClass, number>> => {
  const counts: Record<AlignmentClass, number> = { configured: 0, inferred: 0, semantic: 0, unattributed: 0 };
  for (const row of rows) {
    const alignmentClass = CLASS_ALIASES[row.traceabilityClass];
    if (alignmentClass !== undefined) counts[alignmentClass] = row.count;
  }
  return counts;
};

describe('the semantic scorer is deterministic and local', () => {
  it('gives the same text pair the same score on every call', () => {
    const left = 'Migrate the legacy billing client onto the new SDK';
    const right = 'Migrate every merchant off the legacy billing client';
    const scores = Array.from({ length: 25 }, () =>
      diceSimilarity(new Set(alignmentTokens(left)), new Set(alignmentTokens(right))),
    );

    expect(new Set(scores).size, 'the same pair scored differently across calls').toBe(1);
    expect(scores[0]).toBeGreaterThan(SEMANTIC_CONFIDENCE_THRESHOLD);
  });

  it('is symmetric, bounded and zero on no shared vocabulary', () => {
    const a = new Set(alignmentTokens('bound the ingest retries in the batch writer'));
    const b = new Set(alignmentTokens('Ship the batch writer so ingest retries stay bounded'));

    expect(diceSimilarity(a, b)).toBe(diceSimilarity(b, a));
    expect(diceSimilarity(a, a)).toBe(1);
    expect(diceSimilarity(a, new Set(alignmentTokens('wip')))).toBe(0);
    expect(diceSimilarity(new Set(), b)).toBe(0);
  });

  it('reads the threshold from T17 rather than from a literal', () => {
    expect(SEMANTIC_CONFIDENCE_THRESHOLD).toBe(THRESHOLDS.T17.value / 10_000);
    // The seed designed its traceability classes against the same number. A
    // divergence here would make every distribution assertion below meaningless.
    expect(SEMANTIC_CONFIDENCE_THRESHOLD).toBe(manifest.traceability.threshold);
  });

  it('finds a tracker key with the offset the evidence panel underlines', () => {
    const match = findTicketKey('feature/PLAT-742-legacy-billing-migration');

    expect(match).not.toBeNull();
    expect(match?.key).toBe('PLAT-742');
    expect(match?.offset).toBe(8);
    expect('feature/PLAT-742-legacy-billing-migration'.slice(match?.offset ?? 0, (match?.offset ?? 0) + (match?.length ?? 0))).toBe(
      'PLAT-742',
    );
  });
});

describe('every commit in the seeded dataset resolves through the expected tier', () => {
  const snapshot = merged();
  const assessment = assessAlignment(snapshot, SEED_NOW, resolveScope(snapshot), { window: DATASET_WINDOW });

  it('reproduces the whole-dataset distribution the seed manifest recorded', () => {
    // 912 commits, classified twice by two independent implementations.
    expect(commitCounts(assessment)).toEqual(expected(manifest.traceability.dataset));
  });

  it('exercises all four resolution paths, so none is untested', () => {
    const counts = commitCounts(assessment);
    for (const alignmentClass of ALIGNMENT_CLASSES) {
      expect(counts[alignmentClass], `no commit resolved as ${alignmentClass}`).toBeGreaterThan(0);
    }
  });
});

describe('a single report window exercises all four paths too', () => {
  const snapshot = merged();
  const assessment = assessAlignment(snapshot, SEED_NOW, resolveScope(snapshot), { window: SEED_WINDOW });

  it('reproduces the report-window distribution the manifest recorded', () => {
    expect(commitCounts(assessment)).toEqual(expected(manifest.traceability.reportWindow));
  });

  it('persists a configured link with the full chain of node ids', () => {
    const structural = assessment.resolutions.find(
      (resolution) => resolution.subjectLabel === '4f5a6b7' && resolution.subjectKind === 'commit',
    );

    expect(structural?.alignmentClass).toBe('configured');
    // Leaf first: the sprint goal, then the quarter objective, then the company one.
    expect(structural?.chainNodeIds).toEqual(['PLAT/Sprint 46', 'OBJ-Q3-PLAT', 'OBJ-CO-1']);
    expect(structural?.evidence.tier).toBe('configured');
    if (structural?.evidence.tier === 'configured') {
      expect(structural.evidence.via).toBe('ticket_sprint_goal');
      expect(structural.evidence.matchedSubstring).toBe('PLAT-742');
      expect(structural.evidence.matchedIn).toBe('commit_message');
    }
  });

  it('persists an inferred link with the exact matched substring and its offset', () => {
    const inferred = assessment.resolutions.find(
      (resolution) => resolution.subjectKind === 'commit' && resolution.alignmentClass === 'inferred',
    );

    expect(inferred, 'no commit resolved from a branch name alone').toBeDefined();
    expect(inferred?.evidence.tier).toBe('inferred');
    if (inferred?.evidence.tier !== 'inferred') return;

    const { searchedText, matchedOffset, matchedSubstring, matchedIn } = inferred.evidence;
    expect(matchedIn).toBe('branch_name');
    // The offset has to be usable as a slice index, or the panel highlights the
    // wrong span — which is worse than showing no highlight at all.
    expect(searchedText.slice(matchedOffset, matchedOffset + matchedSubstring.length)).toBe(matchedSubstring);
    expect(inferred.confidence).toBe(1);
  });

  it('persists a semantic link with the score and both compared texts', () => {
    const semantic = assessment.resolutions.find(
      (resolution) => resolution.subjectKind === 'commit' && resolution.alignmentClass === 'semantic',
    );

    expect(semantic?.evidence.tier).toBe('semantic');
    if (semantic?.evidence.tier !== 'semantic') return;

    expect(semantic.evidence.score).toBeGreaterThanOrEqual(SEMANTIC_CONFIDENCE_THRESHOLD);
    expect(semantic.evidence.threshold).toBe(SEMANTIC_CONFIDENCE_THRESHOLD);
    expect(semantic.evidence.comparedTextA.length).toBeGreaterThan(0);
    expect(semantic.evidence.comparedTextB.length).toBeGreaterThan(0);
    expect(semantic.evidence.matchedTokens.length).toBeGreaterThan(0);
    // Sorted, so two runs print the shared wording in the same order.
    expect([...semantic.evidence.matchedTokens]).toEqual([...semantic.evidence.matchedTokens].sort());
  });

  it('leaves a below-threshold subject unattributed, with no node and no verdict', () => {
    const orphan = assessment.resolutions.find(
      (resolution) => resolution.subjectKind === 'commit' && resolution.alignmentClass === 'unattributed',
    );

    expect(orphan?.nodeId).toBeNull();
    expect(orphan?.objectiveNodeId).toBeNull();
    expect(orphan?.servesCurrentObjective).toBeNull();
    expect(orphan?.evidence.tier).toBe('unattributed');
    if (orphan?.evidence.tier !== 'unattributed') return;
    expect(orphan.evidence.score).toBeLessThan(SEMANTIC_CONFIDENCE_THRESHOLD);
    expect(orphan.evidence.question.endsWith('?')).toBe(true);
  });

  it('resolves the Kanban team against its quarter objective, having no sprint to use', () => {
    const insights = assessment.resolutions.filter(
      (resolution) => resolution.subjectKind === 'ticket' && resolution.subjectKey.startsWith('INS-'),
    );

    expect(insights.length).toBeGreaterThan(0);
    for (const resolution of insights) {
      expect(resolution.objectiveNodeId, resolution.subjectKey).toBe('OBJ-Q3-INS');
      expect(resolution.servesCurrentObjective).toBe(true);
    }
  });
});

describe('the goal hierarchy derived from the model', () => {
  const snapshot = merged();
  const hierarchy = goalHierarchyFromSnapshot(snapshot, SEED_NOW);

  it('holds every declared objective and every sprint that carries a goal', () => {
    const byKind = (kind: string): readonly string[] =>
      hierarchy.nodes.filter((node) => node.kind === kind).map((node) => node.nodeId);

    expect(byKind('company')).toEqual(['OBJ-CO-1']);
    expect(byKind('quarter')).toEqual(['OBJ-Q2-BILL', 'OBJ-Q3-CHK', 'OBJ-Q3-INS', 'OBJ-Q3-PLAT']);
    expect(byKind('sprint_goal')).toContain('PLAT/Sprint 46');
  });

  it('keeps the non-current objective in the graph rather than dropping it', () => {
    // Dropping it would make the off-goal stream unattributed instead — the work
    // would vanish from the report rather than being named.
    const abandoned = hierarchy.nodes.find((node) => node.nodeId === 'OBJ-Q2-BILL');

    expect(abandoned?.isCurrent).toBe(false);
    expect(abandoned?.effectiveUntil).toBe(instantFromIso('2026-06-30T00:00:00Z'));
  });

  it('is sorted by node id, so the semantic tie-break is a total order', () => {
    const ids = hierarchy.nodes.map((node) => node.nodeId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('the seeded off-goal work stream', () => {
  const snapshot = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } });
  const report = generateStructuredReport(snapshot, SEED_NOW);
  const alignment = report.findings.alignment;

  it('produces exactly one OFF-GOAL verdict, naming the non-current objective it serves', () => {
    const offGoal = alignment.verdicts.filter((verdict) => verdict.kind === 'off_goal');

    expect(offGoal).toHaveLength(1);
    expect(offGoal[0]?.label).toBe(OFF_GOAL_LABEL);
    expect(offGoal[0]?.objectiveNodeId).toBe('OBJ-Q2-BILL');
    expect(offGoal[0]?.objectiveTitle).toBe('Migrate every merchant off the legacy billing client');
    expect(offGoal[0]?.headline).toContain(OFF_GOAL_LABEL);
    expect(offGoal[0]?.headline).toContain('OBJ-Q2-BILL');
  });

  it('names the billing-migration items rather than the developer who wrote them', () => {
    const offGoal = alignment.verdicts.find((verdict) => verdict.kind === 'off_goal');
    const labels = offGoal?.subjects.map((subject) => subject.label) ?? [];

    expect(labels).toContain('PLAT-742');
    expect(labels).toContain('PLAT-743');
    expect(labels).toContain('PLAT-744');
    // Tom Whitfield authored every one of them. His name appears nowhere in it.
    expect(`${offGoal?.headline} ${offGoal?.detail}`).not.toContain('Tom Whitfield');
  });

  it('clears the threshold and beats the chain the work sits on', () => {
    const offGoal = alignment.verdicts.find((verdict) => verdict.kind === 'off_goal');

    expect(offGoal?.confidence).toBeGreaterThanOrEqual(SEMANTIC_CONFIDENCE_THRESHOLD);
    expect(offGoal?.threshold.id).toBe('T17');
    // The detail quotes both scores, so a manager can see the comparison.
    expect(offGoal?.detail).toContain('more closely than the goal chain they sit on');
  });

  it('renders one Risks item per verdict, with the evidence attached to the item', () => {
    const risks = sectionOf(report, 'risks');
    const alignmentItems = risks.items.filter((item) => item.alignment !== undefined);

    expect(alignmentItems.length).toBe(alignment.verdicts.length);
    for (const item of alignmentItems) {
      expect(item.alignment?.evidence, item.stableId).toBeDefined();
      expect(item.evidence.length, `${item.stableId} carries no artifact to open`).toBeGreaterThan(0);
      expect(item.alignment?.thresholdId).toBe('T17');
    }
  });

  it('asks about the unattributed commits instead of judging them', () => {
    const unattributed = alignment.verdicts.find((verdict) => verdict.kind === 'unattributed');

    expect(unattributed, 'the platform window has commits with no key at all').toBeDefined();
    expect(unattributed?.label).toBeNull();
    expect(unattributed?.question?.endsWith('?')).toBe(true);
    expect(unattributed?.headline).toContain('could not be tied to a sprint objective');
    expect(unattributed?.headline).not.toContain(OFF_GOAL_LABEL);
    expect(unattributed?.subjects.every((subject) => subject.kind === 'commit')).toBe(true);
  });

  it('states how much of the window it could actually place', () => {
    expect(alignment.statement).toMatch(/\d+ of \d+ commits in this window resolve to a goal/);
  });
});

describe('alignment is deterministic across runs', () => {
  it('produces identical resolutions for two independently built snapshots', () => {
    const first = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } });
    const second = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } });

    const left = assessAlignment(first, SEED_NOW, resolveScope(first));
    const right = assessAlignment(second, SEED_NOW, resolveScope(second));

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });
});
