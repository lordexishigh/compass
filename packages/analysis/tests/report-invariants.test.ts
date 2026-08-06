import { instantFromIso } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  AccusatoryLanguageError,
  ItemAgeError,
  OFF_GOAL_LABEL,
  OffGoalGateError,
  SECTIONS,
  SEMANTIC_CONFIDENCE_THRESHOLD,
  UnevidencedClaimError,
  assertEveryClaimHasEvidence,
  assertOffGoalGate,
  assertUnattributedNamesNobody,
  unattributedRefId,
  assertWholeDayAges,
  createEmptyStructuredReport,
  generateStructuredReport,
  offGoalVerdict,
  passesOffGoalGate,
  sectionOf,
  yesterdaySubject,
  type AlignmentAssessment,
  type AlignmentVerdict,
  type EvidenceRef,
  type OffGoalCandidate,
  type ReportItem,
  type StructuredReport,
} from '@compass/analysis';

import { SEED_NOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

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
  cause: { entityRef: 'ticket:DEV-522', causeKind: 'tracker_flag', causeDiscriminator: '' },
  headline: 'DEV-522 is blocked, day 6',
  detail: 'The tracker said so.',
  changeTag: 'unchanged',
  ageDays: 6,
  // Six days before `AT.instant`: the age the day sigil prints is counted from here, and a zero
  // would render as day 20,000 rather than failing an assertion anybody would notice.
  firstSeenAt: instantFromIso('2026-07-25T07:30:00Z'),
  severityScore: 0,
  signalOnsetAt: instantFromIso('2026-07-25T07:30:00Z'),
  evidence: [EVIDENCE],
  ...overrides,
});

const AT = {
  instant: instantFromIso('2026-07-31T07:30:00Z'),
  windowStart: instantFromIso('2026-07-29T23:00:00Z'),
  windowEnd: instantFromIso('2026-07-30T23:00:00Z'),
} as const;

/**
 * The tenant every derived item id is scoped to.
 *
 * `offGoalVerdict` takes it because a stable item id is derived from the organization as well as
 * the condition — two tenants with the same off-goal objective are two different items, and one
 * manager's dismissal must not suppress the other's.
 */
const ORGANIZATION = '00000000-0000-4000-8000-000000000001';

const emptyReport = (): StructuredReport =>
  createEmptyStructuredReport({
    organizationId: ORGANIZATION,
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

/**
 * The Yesterday suffix and the projection's reasoning, over the real dataset.
 *
 * Both are invariants rather than features, and both are asserted over every seeded
 * team rather than over one: the failure mode is a single line somewhere in a
 * forty-line report that lost its clause, and a spot check on one team is exactly
 * how that ships.
 */
describe('no Yesterday line is emitted without its rung suffix', () => {
  const teams = ['platform', 'checkout', 'insights'] as const;

  it.each(teams)('suffixes every %s line with the furthest rung it reached', (teamKey) => {
    const report = generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW);
    const yesterday = sectionOf(report, 'yesterday');

    expect(yesterday.items.length, `${teamKey} produced no Yesterday items`).toBeGreaterThan(0);
    for (const line of yesterday.items) {
      const ladder = line.ladder;
      expect(ladder, `${line.stableId} carries no ladder`).toBeDefined();
      expect(line.headline.endsWith(ladder!.rungSuffix), `"${line.headline}" states no rung`).toBe(true);
      // And the suffix is appended to a real subject rather than standing alone.
      expect(line.headline.length).toBeGreaterThan(ladder!.rungSuffix.length + 3);
    }
  });

  it('builds the headline from the subject plus the suffix, and nothing else', () => {
    const report = generateStructuredReport(
      buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'checkout' } }),
      SEED_NOW,
    );
    for (const item of report.findings.yesterday) {
      expect(`${yesterdaySubject(item)} — ${item.ladder.rungSuffix}`).toBe(
        sectionOf(report, 'yesterday').items.find((line) => line.stableId === item.stableId)?.headline,
      );
    }
  });
});

describe('the projection states its method, the verdicts that chose it and its band', () => {
  const platform = generateStructuredReport(
    buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } }),
    SEED_NOW,
  );
  const insights = generateStructuredReport(
    buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'insights' } }),
    SEED_NOW,
  );

  it('projects by cycle time and says it is a guess when points are uninformative', () => {
    const projection = platform.findings.projection;

    expect(platform.findings.calibrationAudit.verdictNames).toContain('points_uninformative');
    expect(projection.kind).toBe('projected');
    if (projection.kind !== 'projected') return;

    expect(projection.method).toBe('cycle_time');
    expect(projection.reasoning.method).toBe('cycle_time');
    expect(projection.selectedByVerdicts).toContain('points_uninformative');
    expect(projection.reasoning.selectedByVerdicts).toContain('points_uninformative');
    expect(projection.reasoning.confidence).toBe(projection.band.confidence);
    expect(projection.statement).toContain('cycle-time guess, not a velocity forecast');
  });

  /**
   * A sprint team with no trailing sprints gets no date, and this is where that is pinned.
   *
   * It used to be pinned on the *Kanban* team, which made it assert the bug: a Kanban team
   * has 0 completed sprints permanently and by design, so `insufficient_history` refused its
   * date forever and the sentence it read was "Compass needs 2 completed sprints before it
   * will give you a date". The refusal is real and worth keeping — for a team that runs
   * sprints and has not finished two yet, which is what the early instant below builds.
   */
  it('emits no date at all when a sprint team has not enough history, and says why', () => {
    const early = generateStructuredReport(
      buildSeedSnapshot({
        scope: { kind: 'team', teamKey: 'platform' },
        instant: instantFromIso('2026-05-25T09:00:00.000Z'),
      }),
      instantFromIso('2026-05-25T09:00:00.000Z'),
    );
    const projection = early.findings.projection;

    expect(early.findings.calibrationAudit.verdictNames).toContain('insufficient_history');
    expect(projection.kind).toBe('undefined');
    if (projection.kind !== 'undefined') return;

    expect(projection.reason).toBe('insufficient_history');
    expect(projection.threshold.id).toBe('T7');
    expect(projection.statement).toContain('completed sprints');
    // And the refusal reaches the page rather than being left in `findings`.
    const line = sectionOf(early, 'progress').items.find((item) => item.headline === 'No completion date');
    expect(line, 'a report with no date must still carry the line that says so').toBeDefined();
    expect(line?.detail).toContain('insufficient_history');
  });

  /**
   * The Kanban team's date comes from flow, and the sprint-count verdict only explains
   * why velocity was not the method.
   */
  it('projects a Kanban team from cycle time rather than refusing it for want of sprints', () => {
    const projection = insights.findings.projection;

    // Not suppressed — still measured, still stated. It just no longer decides.
    expect(insights.findings.calibrationAudit.verdictNames).toContain('insufficient_history');
    expect(projection.kind).toBe('projected');
    if (projection.kind !== 'projected') return;

    expect(projection.method).toBe('cycle_time');
    expect(projection.selectedByVerdicts).toContain('insufficient_history');
    expect(projection.statement).not.toContain('completed sprints');

    // And it reaches the page as a date rather than as the old refusal line.
    const items = sectionOf(insights, 'progress').items;
    expect(items.find((item) => item.headline === 'No completion date')).toBeUndefined();
    const line = items.find((item) => item.headline.startsWith('Projected completion'));
    expect(line, 'the Kanban team must carry its projected date on the page').toBeDefined();
    expect(line?.detail).toContain('measured cycle time');
  });

  it('names the audit’s verdicts on the page beside the date', () => {
    const line = sectionOf(platform, 'progress').items.find((item) => item.headline.startsWith('Projected completion'));

    expect(line?.detail).toContain('points_uninformative');
    expect(line?.detail).toContain('measured cycle time');
  });
});

/**
 * The OFF-GOAL gate, enumerated.
 *
 * One wrong OFF-GOAL flag against a named developer is the failure mode that ends
 * adoption of a product like this: the manager either has to defend it to their
 * team or quietly stops trusting every other sentence on the page. So the label has
 * exactly one constructor, that constructor's first statement consults
 * `passesOffGoalGate`, and this suite generates the whole space of inputs the gate
 * must refuse and asserts no label can come out of any of them.
 *
 * The generation is exhaustive rather than random on purpose. The input space that
 * matters is small — a confidence, a currency, an id, a rival score — and covering
 * it completely is strictly better than sampling it and hoping.
 */
describe('no low-confidence or unattributed input can produce an OFF-GOAL label', () => {
  const THRESHOLD = SEMANTIC_CONFIDENCE_THRESHOLD;

  const candidate = (overrides: Partial<OffGoalCandidate> = {}): OffGoalCandidate => ({
    objectiveNodeId: 'OBJ-Q2-BILL',
    objectiveTitle: 'Migrate every merchant off the legacy billing client',
    objectiveEffectiveUntil: null,
    score: 0.62,
    threshold: THRESHOLD,
    currentScore: 0,
    comparedTextA: 'port the legacy billing client onto the new SDK surface',
    comparedTextB: 'Migrate every merchant off the legacy billing client',
    matchedTokens: ['billing', 'client', 'legacy'],
    chainNodeIds: ['OBJ-Q2-BILL', 'OBJ-CO-1'],
    ...overrides,
  });

  const SUBJECTS = [{ kind: 'commit' as const, key: 'platform-api@0f1a2b3', label: '0f1a2b3' }];
  const REFS: readonly EvidenceRef[] = [
    { kind: 'commit', label: '0f1a2b3', sourceKey: 'code', sourceRecordId: 'platform-api@0f1a2b3' },
  ];

  const attempt = (
    overrides: Partial<OffGoalCandidate>,
    isCurrent: boolean | null = false,
  ): AlignmentVerdict | null =>
    offGoalVerdict(ORGANIZATION, candidate(overrides), SUBJECTS, REFS, 0, 'semantic', isCurrent);

  /**
   * Every confidence at or below the threshold, plus the values that are not
   * numbers at all. `NaN` is the one a comparison-based guard gets wrong: `NaN <
   * threshold` is false, so a naive `if (confidence < threshold) refuse` would let
   * it through.
   */
  const BELOW_THRESHOLD = [
    0,
    -0,
    0.0001,
    0.1,
    0.2,
    THRESHOLD - 0.01,
    THRESHOLD - Number.EPSILON,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    -1,
  ];

  it.each(BELOW_THRESHOLD)('refuses confidence %p, which is below the threshold', (score) => {
    expect(passesOffGoalGate({
      confidence: score,
      threshold: THRESHOLD,
      attributedObjectiveNodeId: 'OBJ-Q2-BILL',
      attributedObjectiveIsCurrent: false,
      currentObjectiveConfidence: 0,
    })).toBe(false);
    expect(attempt({ score })).toBeNull();
  });

  /** No attribution at all: the unattributed bucket, in every shape it can take. */
  it.each([null, ''])('refuses an unattributed input whose objective id is %p', (objectiveNodeId) => {
    expect(attempt({ objectiveNodeId: objectiveNodeId as string })).toBeNull();
  });

  it.each([true, null])('refuses an objective whose currency is %p rather than false', (isCurrent) => {
    // `null` is "Compass does not know", and not knowing must never read as "not
    // current". That is the difference between a question and an accusation.
    expect(attempt({}, isCurrent)).toBeNull();
  });

  it.each([0.62, 0.7, 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'refuses an attribution that does not beat the chain the work sits on (%p)',
    (currentScore) => {
      expect(attempt({ score: 0.62, currentScore })).toBeNull();
    },
  );

  /**
   * The whole cross product, mechanically. 10 confidences × 3 currencies × 3
   * objective ids × 4 rival scores, and the only combination that may produce a
   * label is the one where all four limbs hold.
   */
  it('produces a label only where every limb of the gate holds', () => {
    const confidences = [0, 0.1, 0.2, 0.29, THRESHOLD, 0.31, 0.5, 0.62, 1, Number.NaN];
    const currencies: readonly (boolean | null)[] = [true, false, null];
    const ids: readonly (string | null)[] = ['OBJ-Q2-BILL', '', null];
    const rivals = [0, 0.29, 0.62, 1];

    let produced = 0;
    let refused = 0;

    for (const confidence of confidences) {
      for (const isCurrent of currencies) {
        for (const objectiveNodeId of ids) {
          for (const currentScore of rivals) {
            const verdict = attempt(
              { score: confidence, currentScore, objectiveNodeId: objectiveNodeId as string },
              isCurrent,
            );
            const shouldPass =
              objectiveNodeId !== null &&
              objectiveNodeId.length > 0 &&
              isCurrent === false &&
              Number.isFinite(confidence) &&
              confidence >= THRESHOLD &&
              confidence > currentScore;

            if (verdict === null) {
              refused += 1;
              expect(shouldPass, `refused an input that satisfies every limb: ${confidence}/${currentScore}`).toBe(
                false,
              );
              continue;
            }

            produced += 1;
            expect(shouldPass, `produced ${OFF_GOAL_LABEL} from ${confidence} against ${currentScore}`).toBe(true);
            expect(verdict.label).toBe(OFF_GOAL_LABEL);
            expect(verdict.objectiveNodeId).toBe(objectiveNodeId);
          }
        }
      }
    }

    // Both branches were exercised: a test where nothing passed would prove only
    // that the constructor is broken.
    expect(produced).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(produced);
  });

  it('refuses to emit a label with no subject to point at', () => {
    expect(offGoalVerdict(ORGANIZATION, candidate(), [], REFS, 0, 'semantic', false)).toBeNull();
  });

  it('fails the report rather than shipping a label the gate would not have made', () => {
    const smuggled: AlignmentVerdict = {
      stableId: 'alignment:off_goal:smuggled',
      kind: 'off_goal',
      label: OFF_GOAL_LABEL,
      headline: `${OFF_GOAL_LABEL} — something is wrong here`,
      detail: 'Hand-built, bypassing the constructor.',
      question: null,
      confidence: 0.05,
      threshold: { id: 'T17', value: 3_000, unit: 'basis_points', statement: 'x'.repeat(30) },
      resolvedTier: 'semantic',
      objectiveNodeId: 'OBJ-Q2-BILL',
      objectiveTitle: 'Migrate every merchant off the legacy billing client',
      subjects: SUBJECTS,
      evidence: {
        tier: 'unattributed',
        score: 0.05,
        threshold: THRESHOLD,
        comparedTextA: 'wip',
        comparedTextB: null,
        matchedTokens: [],
        question: 'What was this commit for?',
      },
      evidenceRefs: REFS,
      ageDays: 0,
    };

    const assessment: AlignmentAssessment = {
      threshold: smuggled.threshold,
      hierarchyResolvedAt: 0,
      goalNodeCount: 1,
      resolutions: [],
      coverage: [],
      verdicts: [smuggled],
      statement: 'x',
    };

    expect(() => assertOffGoalGate(assessment)).toThrow(OffGoalGateError);
    expect(() => assertOffGoalGate({ ...assessment, verdicts: [] })).not.toThrow();
  });
});

describe('the unattributed bucket accuses nobody', () => {
  const question = 'What were these 3 commits for?';

  const unattributed = (overrides: Partial<AlignmentVerdict> = {}): AlignmentVerdict => ({
    stableId: 'alignment:unattributed:commits',
    kind: 'unattributed',
    label: null,
    headline: '3 commits could not be tied to a sprint objective',
    detail: 'a1b2c30, a1b2c36, a1b2c38 name no tracker key in a commit message or a branch.',
    question,
    confidence: 0.08,
    threshold: { id: 'T17', value: 3_000, unit: 'basis_points', statement: 'x'.repeat(30) },
    resolvedTier: 'unattributed',
    objectiveNodeId: null,
    objectiveTitle: null,
    subjects: [],
    evidence: {
      tier: 'unattributed',
      score: 0.08,
      threshold: 0.3,
      comparedTextA: 'wip',
      comparedTextB: null,
      matchedTokens: [],
      question,
    },
    evidenceRefs: [EVIDENCE],
    ageDays: 0,
    ...overrides,
  });

  const NAMES = ['Priya Raman', 'Tom Whitfield'];

  it('accepts a question that names no person', () => {
    expect(() => assertUnattributedNamesNobody([unattributed()], NAMES)).not.toThrow();
  });

  it('refuses one that names a developer, whatever else it says', () => {
    let thrown: unknown;
    try {
      assertUnattributedNamesNobody(
        [unattributed({ detail: 'Tom Whitfield wrote three commits nobody can place.' })],
        NAMES,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AccusatoryLanguageError);
    expect((thrown as Error).message).toContain('Tom Whitfield');
    expect((thrown as Error).message).toContain('never attributed to a person');
  });

  it.each(['misaligned', 'wasted', 'off-goal', 'should not have'])(
    'refuses the word "%s", which turns a question into a verdict',
    (phrase) => {
      expect(() =>
        assertUnattributedNamesNobody([unattributed({ detail: `This work is ${phrase} effort.` })], NAMES),
      ).toThrow(AccusatoryLanguageError);
    },
  );

  it('refuses an unattributed item that carries a label at all', () => {
    expect(() => assertUnattributedNamesNobody([unattributed({ label: OFF_GOAL_LABEL })], NAMES)).toThrow(
      AccusatoryLanguageError,
    );
  });

  it('refuses one that states no question, so it cannot read as a finding', () => {
    expect(() => assertUnattributedNamesNobody([unattributed({ question: null })], NAMES)).toThrow(
      AccusatoryLanguageError,
    );
    expect(() =>
      assertUnattributedNamesNobody([unattributed({ question: 'These commits are unaccounted for.' })], NAMES),
    ).toThrow(AccusatoryLanguageError);
  });

  it('says nothing about an off-goal verdict, which is allowed to be a verdict', () => {
    expect(() =>
      assertUnattributedNamesNobody(
        [unattributed({ kind: 'off_goal', label: OFF_GOAL_LABEL, question: null })],
        NAMES,
      ),
    ).not.toThrow();
  });
});

/**
 * The question is keyed on the commits it is about, which is what makes an answer bindable.
 *
 * Feedback is matched by cause. With a scope-only key — which this had — a manager's answer
 * attached to "this team's unattributed question" in the abstract, so it went on suppressing the
 * bucket after the window rolled and the bucket held three commits nobody had explained. Silencing
 * an unanswered question is the one outcome this feature must not produce, because the manager
 * believes they answered it and Compass believes it was told.
 */
describe('the unattributed question is identified by the work it asks about', () => {
  const orphans = (...keys: string[]) => keys.map((subjectKey) => ({ subjectKey }));

  it('gives the same set the same id however it is ordered', () => {
    // Resolution order is not meaningful, and an id that moved with it would make an answer stop
    // matching the very next generation for no reason a manager could see.
    expect(unattributedRefId('platform', orphans('repo@aaa', 'repo@bbb', 'repo@ccc'))).toBe(
      unattributedRefId('platform', orphans('repo@ccc', 'repo@aaa', 'repo@bbb')),
    );
  });

  it('gives a different set a different id, so an answer does not cover work it never saw', () => {
    const answered = unattributedRefId('platform', orphans('repo@aaa', 'repo@bbb'));

    // One commit added: a different question, asked again.
    expect(unattributedRefId('platform', orphans('repo@aaa', 'repo@bbb', 'repo@ccc'))).not.toBe(answered);
    // One commit gone, and one swapped for another.
    expect(unattributedRefId('platform', orphans('repo@aaa'))).not.toBe(answered);
    expect(unattributedRefId('platform', orphans('repo@aaa', 'repo@zzz'))).not.toBe(answered);
  });

  it('keeps the scope in the key, so one team’s answer is not another’s', () => {
    /**
     * The collision this key already had to fix once. Two teams — or a team and the merged view —
     * can hold exactly the same unattributed commits, and before the scope was in the key that made
     * their questions one item: a dismissal on one suppressed the other, and the merged report
     * could not attribute it. Adding the commit set must not quietly undo that.
     */
    const same = orphans('repo@aaa', 'repo@bbb');

    expect(unattributedRefId('platform', same)).not.toBe(unattributedRefId('checkout', same));
    expect(unattributedRefId('platform', same)).not.toBe(unattributedRefId('merged', same));
  });

  it('is stable across calls, so an unchanged set stays answered tomorrow', () => {
    const set = orphans('repo@aaa', 'repo@bbb');
    expect(unattributedRefId('platform', set)).toBe(unattributedRefId('platform', set));
  });
});
