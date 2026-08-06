import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SNOOZE_DAYS,
  EMPTY_FEEDBACK_LEDGER,
  FEEDBACK_ACTIONS,
  MATERIAL_WORSENING_DELTA,
  MILLIS_PER_DAY,
  OFF_GOAL_CAUSE_KIND,
  SEVERITY_BAND_POINTS,
  TERMINAL_FEEDBACK_ACTIONS,
  applyFeedback,
  feedbackActionIsOffered,
  feedbackOffersFor,
  feedbackVerdictFor,
  isFeedbackAction,
  offGoalFlagCause,
  riskSeverityScore,
  thresholdRef,
  type FeedbackLedger,
  type FeedbackRecord,
  type Instant,
  type ItemCause,
  type ReportItem,
  type ReportSection,
  type SectionKey,
} from '@compass/analysis';

/**
 * Feedback, and whether it sticks.
 *
 * "Feedback that visibly doesn't stick" is the second documented way this product dies. A manager who
 * dismisses a risk and reads it again the next morning has learned that the buttons are decoration,
 * and nothing after that recovers their trust. So every one of these tests asks the same question in
 * a different shape: **does tomorrow's report actually change?**
 *
 * The threshold is imported rather than restated. A test that spelled `100` would keep passing after
 * somebody moved the constant, which is the one change these assertions exist to catch.
 */

const NOW: Instant = 1_780_000_000_000 as Instant;
const DAY = MILLIS_PER_DAY;
const YESTERDAY = (NOW - DAY) as Instant;

const cause = (overrides: Partial<ItemCause> = {}): ItemCause => ({
  entityRef: 'developer:priya',
  causeKind: 'review_bottleneck',
  causeDiscriminator: '',
  ...overrides,
});

const record = (overrides: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  action: 'dismiss_risk',
  cause: cause(),
  reason: 'Priya is covering for Marcus this sprint; it is deliberate.',
  submittedAt: YESTERDAY,
  snoozeUntil: null,
  severityScoreAtVerdict: 210,
  sourceChannel: 'web',
  authorUserId: null,
  ...overrides,
});

const ledger = (...records: readonly FeedbackRecord[]): FeedbackLedger => ({ records });

const subject = (overrides: Partial<Parameters<typeof feedbackVerdictFor>[1]> = {}) => ({
  cause: cause(),
  severityScore: 210,
  signalOnsetAt: (NOW - 5 * DAY) as Instant,
  presentInPriorReport: true,
  ...overrides,
});

const item = (overrides: Partial<ReportItem> = {}): ReportItem => ({
  stableId: 'v1:0000000000000001',
  cause: cause(),
  headline: 'Priya has reviewed 6 of the 8 open pull requests',
  detail: 'Review load is concentrated.',
  changeTag: 'unchanged',
  ageDays: 5,
  firstSeenAt: (NOW - 5 * DAY) as Instant,
  severityScore: 210,
  signalOnsetAt: (NOW - 5 * DAY) as Instant,
  evidence: [{ kind: 'pull_request', label: '#9201', sourceKey: 'code', sourceRecordId: 'pr-9201' }],
  ...overrides,
});

const section = (key: SectionKey, items: readonly ReportItem[]): ReportSection => ({
  key,
  index: 4,
  title: key,
  items,
  emptyStatement: `Nothing for ${key}.`,
});

const apply = (
  sections: readonly ReportSection[],
  feedback: FeedbackLedger,
  at: Instant = NOW,
  priorInstant: Instant | null = YESTERDAY,
) =>
  applyFeedback(sections, feedback, {
    instant: at,
    priorInstant,
    priorStableIds: new Set(sections.flatMap((entry) => entry.items.map((claim) => claim.stableId))),
  });

describe('the action vocabulary is closed', () => {
  it('has exactly seven actions', () => {
    expect([...FEEDBACK_ACTIONS].sort()).toEqual([
      'accept_recommendation',
      'blocker_already_resolved',
      'dismiss_risk',
      'explain_unattributed',
      'off_goal_flag_wrong',
      'reject_recommendation',
      'snooze',
    ]);
  });

  it('refuses an eighth', () => {
    expect(isFeedbackAction('dismiss_risk')).toBe(true);
    expect(isFeedbackAction('thumbs_up')).toBe(false);
  });

  it('names which are permanent, so a manager can be told', () => {
    expect([...TERMINAL_FEEDBACK_ACTIONS].sort()).toEqual([
      'explain_unattributed',
      'off_goal_flag_wrong',
      'reject_recommendation',
    ]);
  });
});

describe('which actions an item offers', () => {
  it('offers nothing on a completion, a win or a progress figure', () => {
    // Statements of fact about work that already happened. A "dismiss" under one would invite a
    // manager to argue with their own team's merge history.
    for (const key of ['yesterday', 'wins', 'progress'] as const) {
      expect(feedbackOffersFor(key, cause()), key).toEqual([]);
    }
  });

  it('offers dismissal on a measured risk and a correction on an off-goal flag', () => {
    expect(feedbackOffersFor('risks', cause()).map((offer) => offer.action)).toEqual(['dismiss_risk', 'snooze']);
    expect(
      feedbackOffersFor('risks', cause({ causeKind: OFF_GOAL_CAUSE_KIND })).map((offer) => offer.action),
    ).toEqual(['off_goal_flag_wrong', 'snooze']);
  });

  it('offers an answer and a snooze on the unattributed question, and nothing else', () => {
    // It is a question — "what were these 3 commits for?" — so neither "wrong" nor "dismiss"
    // applies: Compass has stated no verdict to be wrong about and nothing to dismiss. What a
    // question needs is a way to answer it and a way to defer it, and those are the two.
    expect(feedbackOffersFor('risks', cause({ causeKind: 'unattributed' })).map((offer) => offer.action)).toEqual([
      'explain_unattributed',
      'snooze',
    ]);
  });

  it('words the answer as the manager’s side of the question', () => {
    /**
     * The label is the acceptance criterion's own phrase, and it is load-bearing rather than
     * cosmetic. The item above the button asks what the work was for; a verb reading "Dismiss" or
     * "Mark reviewed" would turn the question into a thing to be cleared, which is the accusatory
     * reading the whole bucket is designed to avoid.
     */
    const [answer] = feedbackOffersFor('risks', cause({ causeKind: 'unattributed' }));

    expect(answer?.label).toBe('Tell us what these were for');
  });

  it('offers the answer nowhere else — it answers one question and no other item asks it', () => {
    for (const causeKind of ['review_latency', OFF_GOAL_CAUSE_KIND]) {
      expect(
        feedbackOffersFor('risks', cause({ causeKind })).map((offer) => offer.action),
        causeKind,
      ).not.toContain('explain_unattributed');
    }
    expect(feedbackActionIsOffered('risks', cause({ causeKind: 'unattributed' }), 'explain_unattributed')).toBe(true);
    expect(feedbackActionIsOffered('risks', cause(), 'explain_unattributed')).toBe(false);
  });

  it('refuses an action the item does not offer', () => {
    expect(feedbackActionIsOffered('yesterday', cause(), 'dismiss_risk')).toBe(false);
    expect(feedbackActionIsOffered('risks', cause(), 'dismiss_risk')).toBe(true);
    expect(feedbackActionIsOffered('risks', cause(), 'accept_recommendation')).toBe(false);
  });
});

describe('a rejected recommendation is never suggested again', () => {
  it('suppresses it, permanently', () => {
    const rejected = record({ action: 'reject_recommendation', cause: cause({ causeKind: 'recommend_blocker' }) });
    const result = apply(
      [section('recommendations', [item({ cause: cause({ causeKind: 'recommend_blocker' }) })])],
      ledger(rejected),
    );

    expect(result.sections[0]?.items).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.action).toBe('reject_recommendation');
  });

  it('is still suppressed a year later, and the note says why', () => {
    const rejected = record({ action: 'reject_recommendation', cause: cause({ causeKind: 'recommend_blocker' }) });
    const result = apply(
      [section('recommendations', [item({ cause: cause({ causeKind: 'recommend_blocker' }) })])],
      ledger(rejected),
      (NOW + 365 * DAY) as Instant,
    );

    expect(result.sections[0]?.items).toEqual([]);
    expect(result.suppressed[0]?.statement).toContain('will not suggest it again');
  });

  it('leaves a different cause on the same entity alone', () => {
    // The discriminator is load-bearing: two recommendations about one ticket for two reasons are two
    // records, and rejecting one must not silence the other.
    const rejected = record({
      action: 'reject_recommendation',
      cause: cause({ causeKind: 'recommend_blocker', causeDiscriminator: 'status_dwell' }),
    });
    const other = item({ cause: cause({ causeKind: 'recommend_blocker', causeDiscriminator: 'no_reviewer' }) });

    expect(apply([section('recommendations', [other])], ledger(rejected)).sections[0]?.items).toHaveLength(1);
  });
});

describe('an accepted recommendation renders as accepted, with its date', () => {
  const accepted = record({
    action: 'accept_recommendation',
    cause: cause({ causeKind: 'recommend_review_bottleneck' }),
    reason: null,
    severityScoreAtVerdict: 200,
  });
  const step = () => item({ cause: cause({ causeKind: 'recommend_review_bottleneck' }) });

  /**
   * Three consecutive simulated days, as the criterion names.
   *
   * Day one suggests it. Day two the manager accepts. Day three it is still there — marked as their
   * decision with the acceptance date, and *not* re-suggested. That third day is the whole assertion:
   * an implementation that simply dropped the item would pass a two-day test and would silently lose
   * the manager's own record of what they decided.
   */
  it('shows the acceptance on the two reports after it, rather than suggesting it again', () => {
    const dayTwo = apply([section('recommendations', [step()])], ledger(accepted), NOW);
    const dayThree = apply([section('recommendations', [step()])], ledger(accepted), (NOW + DAY) as Instant);

    for (const [label, day] of [
      ['day two', dayTwo],
      ['day three', dayThree],
    ] as const) {
      const rendered = day.sections[0]?.items[0];
      expect(rendered, label).toBeDefined();
      expect(rendered?.feedback?.state, label).toBe('accepted');
      expect(rendered?.feedback?.at, label).toBe(YESTERDAY);
      // The date, so the manager can see it is their own decision and not a fresh suggestion.
      expect(rendered?.changeClause, label).toContain('accepted on');
      expect(day.suppressed, label).toEqual([]);
    }
  });

  it('asks again once the condition has lapsed and returned', () => {
    // "Unless the triggering condition recurs after the accepted item resolves." The evidence that it
    // resolved is a report that post-dates the acceptance and did not carry it.
    const lapsed = applyFeedback([section('recommendations', [step()])], ledger(accepted), {
      instant: (NOW + 3 * DAY) as Instant,
      priorInstant: (NOW + 2 * DAY) as Instant,
      // The prior report did not carry it: the condition stopped holding, and today's appearance is a
      // recurrence rather than the same one.
      priorStableIds: new Set<string>(),
    });

    expect(lapsed.sections[0]?.items[0]?.feedback).toBeUndefined();
    expect(lapsed.suppressed).toEqual([]);
  });

  it('holds while the condition keeps holding, even without a prior report to compare', () => {
    const first = applyFeedback([section('recommendations', [step()])], ledger(accepted), {
      instant: NOW,
      priorInstant: null,
      priorStableIds: new Set<string>(),
    });

    expect(first.sections[0]?.items[0]?.feedback?.state).toBe('accepted');
  });
});

describe('a blocker marked already resolved stays out until a new signal', () => {
  const resolved = record({
    action: 'blocker_already_resolved',
    cause: cause({ entityRef: 'ticket:PLAT-742', causeKind: 'status_dwell' }),
    reason: 'I unblocked this on Friday.',
    severityScoreAtVerdict: 4,
  });
  const blocker = (onset: Instant) =>
    item({
      cause: cause({ entityRef: 'ticket:PLAT-742', causeKind: 'status_dwell' }),
      signalOnsetAt: onset,
    });

  it('omits it from the next report', () => {
    const result = apply([section('blockers', [blocker((NOW - 5 * DAY) as Instant)])], ledger(resolved));

    expect(result.sections[0]?.items).toEqual([]);
    expect(result.suppressed[0]?.statement).toContain('new triggering signal');
  });

  it('keeps omitting it as the age of the condition grows, which is the whole point', () => {
    // The trap this guards. A blocker's age grows every morning, so a rule keyed on severity would
    // resurface it the day after the manager dealt with it. Onset does not grow.
    const stillSuppressed = apply(
      [section('blockers', [blocker((NOW - 5 * DAY) as Instant)])],
      ledger(resolved),
      (NOW + 30 * DAY) as Instant,
    );

    expect(stillSuppressed.sections[0]?.items).toEqual([]);
  });

  it('lets it through when the condition starts again after the verdict', () => {
    const reOnset = apply(
      [section('blockers', [blocker((NOW + DAY) as Instant)])],
      ledger(resolved),
      (NOW + 2 * DAY) as Instant,
    );

    expect(reOnset.sections[0]?.items).toHaveLength(1);
    expect(reOnset.suppressed).toEqual([]);
  });
});

describe('a snooze expires against the injected clock', () => {
  const snoozeUntil = (NOW + 7 * DAY) as Instant;
  const snoozed = record({ action: 'snooze', reason: null, snoozeUntil, submittedAt: NOW });

  it('suppresses the item before the snooze ends', () => {
    const before = apply([section('risks', [item()])], ledger(snoozed), (NOW + 6 * DAY) as Instant);

    expect(before.sections[0]?.items).toEqual([]);
    expect(before.suppressed[0]?.action).toBe('snooze');
  });

  it('renders it again at the instant the snooze ends, and after', () => {
    // Half-open: the item returns *at* the end instant, so a snooze of N days suppresses exactly N.
    for (const at of [snoozeUntil, (snoozeUntil + DAY) as Instant]) {
      expect(apply([section('risks', [item()])], ledger(snoozed), at).sections[0]?.items).toHaveLength(1);
    }
  });

  it('defaults to a documented number of days', () => {
    expect(DEFAULT_SNOOZE_DAYS).toBe(7);
  });

  it('falls back to the dismissal underneath it once it lapses', () => {
    // Newest-first, first-with-something-to-say. A manager who dismissed and then snoozed gets the
    // snooze; when it lapses the dismissal still holds, rather than the item silently returning.
    const dismissed = record({ submittedAt: (NOW - 2 * DAY) as Instant });
    const result = apply([section('risks', [item()])], ledger(snoozed, dismissed), (snoozeUntil + DAY) as Instant);

    expect(result.sections[0]?.items).toEqual([]);
    expect(result.suppressed[0]?.action).toBe('dismiss_risk');
  });
});

describe('a dismissed risk resurfaces only on material worsening', () => {
  it('documents the threshold as one whole severity band', () => {
    // The same rule stated twice rather than two rules that happen to agree: one band *is* the
    // threshold, so "crosses a severity band" and "rises 100 points" cannot drift apart.
    expect(MATERIAL_WORSENING_DELTA).toBe(100);
    expect(SEVERITY_BAND_POINTS.medium - SEVERITY_BAND_POINTS.low).toBe(MATERIAL_WORSENING_DELTA);
    expect(SEVERITY_BAND_POINTS.high - SEVERITY_BAND_POINTS.medium).toBe(MATERIAL_WORSENING_DELTA);
  });

  it('keeps it suppressed indefinitely when the evidence has not materially worsened', () => {
    const dismissed = record({ severityScoreAtVerdict: 210 });

    // One point short of the threshold, thirty days later. Still nothing to say.
    const result = apply(
      [section('risks', [item({ severityScore: 210 + MATERIAL_WORSENING_DELTA - 1 })])],
      ledger(dismissed),
      (NOW + 30 * DAY) as Instant,
    );

    expect(result.sections[0]?.items).toEqual([]);
    expect(result.suppressed[0]?.statement).toContain(`of the ${MATERIAL_WORSENING_DELTA} points a return requires`);
  });

  it('resurfaces it at exactly the threshold, naming what worsened and by how much', () => {
    const dismissed = record({ severityScoreAtVerdict: 210 });
    const result = apply(
      [section('risks', [item({ severityScore: 210 + MATERIAL_WORSENING_DELTA })])],
      ledger(dismissed),
    );

    const returned = result.sections[0]?.items[0];
    expect(returned).toBeDefined();
    expect(returned?.feedback?.state).toBe('resurfaced');
    // The sentence is arguable: two numbers and the rule they were compared against.
    expect(returned?.changeClause).toContain('210');
    expect(returned?.changeClause).toContain('310');
    expect(returned?.changeClause).toContain(`${MATERIAL_WORSENING_DELTA}`);
    expect(returned?.changeClause).toContain('you dismissed it');
    expect(result.suppressed).toEqual([]);
  });

  it('stays suppressed for good when no baseline was recorded', () => {
    // Guessing a baseline of zero would make every such dismissal last exactly one day.
    const noBaseline = record({ severityScoreAtVerdict: null });
    const result = apply([section('risks', [item({ severityScore: 399 })])], ledger(noBaseline));

    expect(result.sections[0]?.items).toEqual([]);
    expect(result.suppressed[0]?.statement).toContain('no severity baseline');
  });

  it('scores a risk as its band plus how far past its own threshold it sits', () => {
    const risk = (severity: 'low' | 'medium' | 'high', value: number) =>
      riskSeverityScore({
        stableId: 'v1:1',
        cause: 'review_bottleneck',
        severity,
        trend: 'unchanged',
        subject: { kind: 'developer', key: 'priya', label: 'Priya' },
        measured: { value, unit: 'count' },
        priorValue: null,
        priorAt: null,
        priorBasis: 'no_prior_observation',
        threshold: thresholdRef('T5'),
        ageDays: 3,
        headline: 'h',
        detail: 'd',
        evidence: [],
      } as never);

    const limit = thresholdRef('T5').value;
    // At the threshold exactly: the band and nothing more.
    expect(risk('medium', limit)).toBe(SEVERITY_BAND_POINTS.medium);
    // Twice the threshold: the band plus the capped excess, and one band up outranks it.
    expect(risk('medium', limit * 2)).toBe(SEVERITY_BAND_POINTS.medium + 99);
    expect(risk('high', limit)).toBeGreaterThan(risk('medium', limit * 40));
  });
});

describe('a corrected off-goal flag is suppressed on every future report', () => {
  const corrected = record({
    action: 'off_goal_flag_wrong',
    cause: offGoalFlagCause('OBJ-Q2-BILL'),
    reason: 'The PM asked for this in the Q2 replan.',
  });
  const flag = () => item({ cause: offGoalFlagCause('OBJ-Q2-BILL') });

  it('names the same coordinates the detector emits', () => {
    expect(offGoalFlagCause('OBJ-Q2-BILL')).toEqual({
      entityRef: 'objective:OBJ-Q2-BILL',
      causeKind: OFF_GOAL_CAUSE_KIND,
      causeDiscriminator: '',
    });
  });

  it('suppresses that entity and cause for good', () => {
    for (const at of [NOW, (NOW + 90 * DAY) as Instant, (NOW + 900 * DAY) as Instant]) {
      const result = apply([section('risks', [flag()])], ledger(corrected), at);
      expect(result.sections[0]?.items, String(at)).toEqual([]);
      expect(result.suppressed[0]?.statement).toContain('recorded as a correction');
    }
  });

  it('leaves another objective’s flag alone', () => {
    const other = item({ cause: offGoalFlagCause('OBJ-Q2-LATENCY') });
    expect(apply([section('risks', [other])], ledger(corrected)).sections[0]?.items).toHaveLength(1);
  });
});

describe('an empty ledger changes nothing', () => {
  it('returns the sections it was given', () => {
    const sections = [section('risks', [item()])];
    const result = applyFeedback(sections, EMPTY_FEEDBACK_LEDGER, {
      instant: NOW,
      priorInstant: YESTERDAY,
      priorStableIds: new Set(['v1:0000000000000001']),
    });

    expect(result.sections).toBe(sections);
    expect(result.suppressed).toEqual([]);
  });

  it('renders an item with no record against it', () => {
    const verdict = feedbackVerdictFor(ledger(record({ cause: cause({ entityRef: 'developer:someone-else' }) })), subject(), NOW, YESTERDAY);
    expect(verdict.kind).toBe('render');
  });
});
