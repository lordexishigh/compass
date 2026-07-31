import {
  auditProcessCalibration,
  hasProcessVerdict,
  pointToElapsedCorrelation,
  type CalibrationAudit,
  type PointToElapsedCorrelation,
  type ProcessVerdictName,
} from './calibration.js';
import {
  addDays,
  compareNumbers,
  MILLIS_PER_DAY,
  medianOf,
  percentileOf,
  scaled,
  utcCivilDate,
  wholeDaysBetween,
  type Instant,
} from './instant.js';
import { completedSprints, type CompletionBasis, type ProgressAssessment } from './progress.js';
import {
  DONE_STATUS_CATEGORY,
  instantField,
  isDone,
  scopedSprints,
  scopedTickets,
  textField,
  transitionsByTicket,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';

/**
 * The projected completion date, and the calibration verdict that qualifies it.
 *
 * This appears once per report, in square brackets, in mono, at 22px — the single
 * most authoritative-looking object on the page. That is exactly why it carries a
 * two-line collar underneath it, and why the collar is computed rather than
 * written by a copywriter.
 *
 * The honest position is that a projection is a *guess with a stated method*.
 * So the output carries:
 *
 *  - a **band**, not a point. `earliest` and `latest` bracket the date, taken
 *    from the same sample the median came from.
 *  - a **method**, named: trailing velocity when the team's estimates have
 *    actually tracked reality, cycle time when they have not.
 *  - a **machine-readable reasoning structure**: every input that went into the
 *    arithmetic, with its name, value and unit, plus the formula. A renderer can
 *    print it; a test can assert on it; nobody has to trust it.
 *  - a **calibration verdict** in the product's own plain voice: "your points
 *    haven't tracked elapsed days for four sprints, so this date is a cycle-time
 *    guess". When calibration is poor the UI sets the date in a lighter weight —
 *    the typography itself loses conviction, because the number deserves less of
 *    it.
 *
 * And when there is not enough history, it refuses. The `undefined` arm carries
 * `reason: 'insufficient_history'` and no date at all, because a date with a
 * shrug next to it is still a date somebody will put in a plan.
 */
export const CALIBRATION_VERDICTS = ['points_track_elapsed', 'points_uninformative', 'not_enough_data'] as const;

export type CalibrationVerdictName = (typeof CALIBRATION_VERDICTS)[number];

export interface CalibrationVerdict {
  readonly verdict: CalibrationVerdictName;
  readonly sampleSize: number;
  /**
   * The correlation, with its sample size and spread attached.
   *
   * A whole value rather than a bare coefficient, and that is deliberate: this
   * object is what the collar prints and what the estimation-noise risk quotes,
   * and both need to be unable to state a number like `0.12` without the `n` and
   * the spread it came from. `packages/analysis/src/calibration.ts` documents the
   * shape; `tests/calibration.test.ts` asserts nothing anywhere in the report
   * emits a coefficient on its own.
   */
  readonly correlation: PointToElapsedCorrelation;
  readonly correlationThreshold: ThresholdRef;
  readonly sampleThreshold: ThresholdRef;
  readonly ticketKeys: readonly string[];
  /** The second collar line, in the product's own voice. */
  readonly statement: string;
}

export type ProjectionMethod = 'trailing_velocity' | 'cycle_time';

export interface ProjectionInput {
  readonly name: string;
  readonly value: number;
  readonly unit: 'points' | 'items' | 'days' | 'points_per_sprint' | 'items_per_sprint' | 'sprints' | 'basis_points';
}

/** The reasoning, in a shape a machine can check and a human can read. */
export interface ProjectionReasoning {
  readonly method: ProjectionMethod;
  readonly formula: string;
  readonly inputs: readonly ProjectionInput[];
  /** Named assumptions the arithmetic makes, so they can be argued with. */
  readonly assumptions: readonly string[];
  /**
   * The Process Calibration Audit verdicts that chose this method.
   *
   * Empty when nothing was wrong with the data and the team's own estimates were
   * used. Non-empty means the method was a *fallback*, and the reader is entitled
   * to know which finding pushed it there — "cycle time because
   * points_uninformative" is arguable; "cycle time" alone is not.
   */
  readonly selectedByVerdicts: readonly ProcessVerdictName[];
  /** The confidence band this reasoning produced, restated where the method is. */
  readonly confidence: ConfidenceLevel;
}

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export type ProjectedCompletion =
  | {
      readonly kind: 'projected';
      readonly instant: number;
      /** The UTC civil date, for logs and fixtures. Renderers format in-zone. */
      readonly utcDate: string;
      readonly band: {
        readonly earliestInstant: number;
        readonly latestInstant: number;
        readonly earliestUtcDate: string;
        readonly latestUtcDate: string;
        readonly spanDays: number;
        readonly confidence: ConfidenceLevel;
      };
      readonly method: ProjectionMethod;
      readonly reasoning: ProjectionReasoning;
      readonly calibration: CalibrationVerdict;
      /**
       * The audit verdicts that chose this method, restated at the top level.
       *
       * Duplicated from `reasoning.selectedByVerdicts` so that both arms of this
       * union carry the field: a renderer asking "what did the audit have to do
       * with this date" must not have to narrow the union first, because the
       * renderer that forgets to is the one that silently drops the caveat.
       */
      readonly selectedByVerdicts: readonly ProcessVerdictName[];
      /** The first collar line: the band and the method, as a sentence. */
      readonly statement: string;
    }
  | {
      readonly kind: 'undefined';
      readonly reason: 'insufficient_history' | 'no_remaining_scope' | 'no_flow_history';
      readonly threshold: ThresholdRef;
      readonly calibration: CalibrationVerdict;
      /**
       * The audit verdicts behind the refusal, so "no date" is as arguable as a
       * date would have been. `insufficient_history` appears here whenever it is
       * the reason nothing was projected.
       */
      readonly selectedByVerdicts: readonly ProcessVerdictName[];
      readonly statement: string;
    };

/**
 * The Process Calibration Audit, reduced to the one verdict the collar needs.
 *
 * Correlates story-point estimates against *measured* elapsed days for completed
 * items. Below `T13` completed-and-estimated items there is no verdict —
 * `not_enough_data` — because a correlation over four points is noise wearing a
 * statistic's clothes.
 */
export function assessCalibration(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): CalibrationVerdict {
  return calibrationVerdictFrom(pointToElapsedCorrelation(snapshot, instant, scope));
}

/**
 * The collar's verdict, from an already-computed correlation.
 *
 * Separate from `assessCalibration` so the report can compute the correlation
 * once — the audit needs it too — and both read the same numbers. Two independent
 * correlations over the same tickets would eventually disagree in the second
 * decimal, and the collar and the audit would then contradict each other on the
 * same page.
 *
 * `T12` is compared against the **absolute** coefficient. A correlation of −0.7
 * is a strong relationship pointing the wrong way — bigger estimates finishing
 * faster — which is a real finding about the team's estimating, not an
 * uninformative one, and an unsigned comparison would file it under "your points
 * mean nothing" and lose it.
 */
export function calibrationVerdictFrom(correlation: PointToElapsedCorrelation): CalibrationVerdict {
  const absolute = correlation.absoluteCoefficientBasisPoints;
  const base = {
    sampleSize: correlation.sampleSize,
    correlation,
    correlationThreshold: thresholdRef('T12'),
    sampleThreshold: thresholdRef('T13'),
    ticketKeys: correlation.ticketKeys,
  } as const;

  if (correlation.sampleSize < THRESHOLDS.T13.value) {
    return {
      ...base,
      verdict: 'not_enough_data',
      statement: `Only ${correlation.sampleSize} completed item${correlation.sampleSize === 1 ? '' : 's'} carried both an estimate and a measurable duration, so Compass cannot yet tell you whether your points mean anything.`,
    };
  }

  if (absolute === null || absolute < THRESHOLDS.T12.value) {
    return {
      ...base,
      verdict: 'points_uninformative',
      statement:
        absolute === null
          ? `Across ${correlation.sampleSize} completed items one of the two columns never varied, so your estimates carry no information about how long work takes. Any date below is a cycle-time guess.`
          : `Your points have not tracked elapsed working days across ${correlation.sampleSize} completed items — correlation ${(absolute / 10_000).toFixed(2)} over durations spanning ${correlation.spread.elapsedWorkingDays.minimum} to ${correlation.spread.elapsedWorkingDays.maximum} working days, below the ${(THRESHOLDS.T12.value / 10_000).toFixed(2)} Compass needs — so any date below is a cycle-time guess, not a plan.`,
    };
  }

  return {
    ...base,
    verdict: 'points_track_elapsed',
    statement: `Your points have tracked elapsed working days across ${correlation.sampleSize} completed items — correlation ${(absolute / 10_000).toFixed(2)} — so the date below rests on your own estimates.`,
  };
}

/**
 * Projects a completion date for the remaining scope, or states why it will not.
 *
 * The method is chosen by the calibration verdict, not by preference: points are
 * only used to forecast when they have demonstrably predicted duration before.
 * Otherwise the projection falls back to measured cycle time, which needs no
 * estimates at all and says so.
 */
export function projectCompletion(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  progress: ProgressAssessment,
  audit: CalibrationAudit = auditProcessCalibration(snapshot, instant, scope),
): ProjectedCompletion {
  const calibration = calibrationVerdictFrom(audit.statistics.pointToElapsed);
  const finished = completedSprints(scopedSprints(snapshot, scope), instant);

  /**
   * `insufficient_history` refuses a date outright, wherever it appears.
   *
   * Checked before the sprint arm rather than inside it, because the Kanban and
   * new-team cases reach this function through the cycle-time path, and a cycle
   * time computed from two finished items would happily produce a confident date
   * for a team Compass has no history for at all. A date with a shrug next to it
   * is still a date somebody will put in a plan.
   */
  if (hasProcessVerdict(audit, 'insufficient_history')) {
    return {
      kind: 'undefined',
      reason: 'insufficient_history',
      threshold: thresholdRef('T7'),
      calibration,
      selectedByVerdicts: ['insufficient_history'],
      statement: `Compass needs ${THRESHOLDS.T7.value} completed sprints before it will give you a date, and it has ${finished.length}. It will not project one from a history this thin, and it will not dress a guess up as a forecast.`,
    };
  }

  if (progress.mode === 'sprint') {
    if (progress.velocity.kind === 'undefined') {
      return {
        kind: 'undefined',
        reason: 'insufficient_history',
        threshold: thresholdRef('T7'),
        calibration,
        selectedByVerdicts: ['insufficient_history'],
        statement: `Compass needs ${THRESHOLDS.T7.value} completed sprints before it will give you a date, and it has ${finished.length}. ${progress.velocity.statement}`,
      };
    }

    // Emptiness is counted in items, never in points. A sprint whose remaining
    // work is real but unestimated has `remaining.points === 0`, and reporting
    // that as "everything is finished" would be a false statement about the board.
    if (progress.sprint.remaining.tickets === 0) {
      return {
        kind: 'undefined',
        reason: 'no_remaining_scope',
        threshold: thresholdRef('T7'),
        calibration,
        selectedByVerdicts: [],
        statement: 'Everything in the current sprint is finished, so there is nothing left to project.',
      };
    }

    /**
     * `points_uninformative` selects cycle time, and it overrides everything.
     *
     * The subtle case is a sprint measured in *items* rather than points. Trailing
     * item-count velocity does not touch an estimate, so it is tempting to argue
     * the verdict is irrelevant to it — and an earlier version of this function did
     * argue that, which meant the seeded team's report carried a velocity forecast
     * under a collar saying its estimates predict nothing. Two problems with that.
     * The reader cannot tell an item-count velocity from a points one on the page,
     * so the caveat reads as applying to the number above it either way. And a team
     * whose estimates carry no information about duration is a team whose *items*
     * are of wildly varying size — which is the same finding, and the reason
     * counting them per sprint is no more predictive than adding them up.
     *
     * So the rule is the documented one: uninformative points mean the date comes
     * from measured cycle time and says so, in those words.
     */
    const pointsUninformative = hasProcessVerdict(audit, 'points_uninformative');

    // `estimates_sparse` is the second switch away from a points forecast: one
    // drawn from two fifths of the scope is a forecast about a different sprint
    // than the one on the board.
    const pointsAreUsable =
      calibration.verdict === 'points_track_elapsed' &&
      !pointsUninformative &&
      !hasProcessVerdict(audit, 'estimates_sparse');

    if (!pointsUninformative && (pointsAreUsable || progress.sprint.basis === 'ticket_count')) {
      return velocityProjection(instant, progress, calibration, audit);
    }
  }

  // Cycle time: the fallback that needs no estimates, and the primary method for
  // a Kanban team, which has no sprint to burn down.
  return cycleTimeProjection(snapshot, instant, scope, progress, calibration, audit);
}

/**
 * The audit verdicts that pushed the projection off the team's own estimates.
 *
 * Only the ones that actually bear on a forecast. `statuses_stale` is a real
 * finding and it is stated in the Risks section, but it did not choose the method,
 * and listing it here would make the reasoning structure unfalsifiable — every
 * verdict would appear behind every method.
 */
const METHOD_SELECTING_VERDICTS: readonly ProcessVerdictName[] = [
  'points_uninformative',
  'estimates_sparse',
  'insufficient_history',
];

const selectingVerdicts = (audit: CalibrationAudit): readonly ProcessVerdictName[] =>
  METHOD_SELECTING_VERDICTS.filter((name) => audit.verdictNames.includes(name));

function velocityProjection(
  instant: Instant,
  progress: Extract<ProgressAssessment, { mode: 'sprint' }>,
  calibration: CalibrationVerdict,
  audit: CalibrationAudit,
): ProjectedCompletion {
  const velocity = progress.velocity;
  if (velocity.kind === 'undefined') {
    return {
      kind: 'undefined',
      reason: 'insufficient_history',
      threshold: thresholdRef('T7'),
      calibration,
      selectedByVerdicts: ['insufficient_history'],
      statement: velocity.statement,
    };
  }

  /**
   * The remaining scope and the trailing pace must be measured in the *same*
   * unit, and nothing upstream guarantees that they are.
   *
   * `progress.sprint.basis` is chosen by T15 — points only when four fifths of
   * the sprint scope carries an estimate — while `velocity.basis` is chosen by
   * whether the trailing sprints happened to total any points at all. The two are
   * decided independently and routinely disagree: a sprint counted in items
   * because half its scope is unestimated, sitting behind trailing sprints that
   * did carry points. Reading `remaining` from one and `perSprint` from the other
   * divides items by points-per-sprint, which is not a number of sprints — it
   * produces a confident date out of a meaningless quotient and then labels the
   * item count `points` in the reasoning a manager is invited to check.
   *
   * So the basis is resolved once, here, and both sides are read from it. Points
   * are used only when the sprint is measured in points *and* the trailing sample
   * actually contains some; otherwise both fall back to items, which every sprint
   * can always express.
   *
   * The remaining points are checked too: a sprint can be measured in points and
   * still have every *remaining* item unestimated, which would divide zero by the
   * pace and project today. Items are the basis that always has a numerator.
   */
  const basis: CompletionBasis =
    progress.sprint.basis === 'story_points' &&
    progress.sprint.remaining.points > 0 &&
    velocity.samples.some((sample) => sample.points > 0)
      ? 'story_points'
      : 'ticket_count';

  const remaining = basis === 'story_points' ? progress.sprint.remaining.points : progress.sprint.remaining.tickets;
  const unit = basis === 'story_points' ? ('points' as const) : ('items' as const);
  const series = velocity.samples.map((sample) => (basis === 'story_points' ? sample.points : sample.tickets));
  const perSprint = basis === 'story_points' ? velocity.meanPoints : velocity.meanTickets;
  const slowest = Math.max(1, Math.min(...series));
  const fastest = Math.max(1, Math.max(...series));

  const sprintLengthDays = Math.max(1, wholeDaysBetween(progress.sprint.startAt as Instant, progress.sprint.endAt as Instant));
  const sprintsNeeded = remaining / Math.max(1, perSprint);
  const daysNeeded = Math.ceil(sprintsNeeded * sprintLengthDays);
  const slowestDays = Math.ceil((remaining / slowest) * sprintLengthDays);
  const fastestDays = Math.ceil((remaining / fastest) * sprintLengthDays);

  const projected = addDays(instant, daysNeeded);
  const earliestInstant = addDays(instant, Math.min(fastestDays, daysNeeded));
  const latestInstant = addDays(instant, Math.max(slowestDays, daysNeeded));
  const spanDays = wholeDaysBetween(earliestInstant, latestInstant);
  const confidence = confidenceFor(spanDays, velocity.samples.length, calibration, audit);

  return {
    kind: 'projected',
    instant: projected,
    utcDate: utcCivilDate(projected),
    band: {
      earliestInstant,
      latestInstant,
      earliestUtcDate: utcCivilDate(earliestInstant),
      latestUtcDate: utcCivilDate(latestInstant),
      spanDays,
      confidence,
    },
    method: 'trailing_velocity',
    selectedByVerdicts: selectingVerdicts(audit),
    reasoning: {
      method: 'trailing_velocity',
      formula: 'remaining ÷ mean(trailing sprint completion) × sprint length, banded by the slowest and fastest sprint in the sample',
      selectedByVerdicts: selectingVerdicts(audit),
      confidence,
      inputs: [
        { name: 'remaining', value: remaining, unit },
        {
          name: 'meanPerSprint',
          value: perSprint,
          unit: basis === 'story_points' ? 'points_per_sprint' : 'items_per_sprint',
        },
        { name: 'slowestSprint', value: slowest, unit },
        { name: 'fastestSprint', value: fastest, unit },
        { name: 'sprintLengthDays', value: sprintLengthDays, unit: 'days' },
        { name: 'sprintsSampled', value: velocity.samples.length, unit: 'sprints' },
      ],
      assumptions: [
        'The team keeps working at the pace of its last completed sprints.',
        'No scope is added to the remaining work.',
        'Sprint length stays as it is today.',
      ],
    },
    calibration,
    statement: `${utcCivilDate(earliestInstant)} to ${utcCivilDate(latestInstant)} — a ${spanDays}-day band from trailing velocity over ${velocity.samples.length} sprints.`,
  };
}

function cycleTimeProjection(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  progress: ProgressAssessment,
  calibration: CalibrationVerdict,
  audit: CalibrationAudit,
): ProjectedCompletion {
  const durations = cycleTimeSample(snapshot, instant, scope);
  const remainingItems = remainingItemCount(progress);
  const selectedBy = selectingVerdicts(audit);

  if (durations.length === 0) {
    return {
      kind: 'undefined',
      reason: 'no_flow_history',
      threshold: thresholdRef('T13'),
      calibration,
      selectedByVerdicts: selectedBy,
      statement:
        'Nothing has been observed moving from start to finish yet, so Compass has no cycle time to project from and will not guess one.',
    };
  }
  if (remainingItems === 0) {
    return {
      kind: 'undefined',
      reason: 'no_remaining_scope',
      threshold: thresholdRef('T13'),
      calibration,
      selectedByVerdicts: selectedBy,
      statement: 'There is no work in flight or waiting, so there is nothing left to project.',
    };
  }

  const median = medianOf(durations) ?? 0;
  const p85 = percentileOf(durations, 0.85) ?? median;
  const p50Days = Math.ceil(median * remainingItems);
  const p85Days = Math.ceil(p85 * remainingItems);

  const projected = addDays(instant, p50Days);
  const latestInstant = addDays(instant, Math.max(p85Days, p50Days));
  const spanDays = wholeDaysBetween(projected, latestInstant);
  const confidence = confidenceFor(spanDays, durations.length, calibration, audit);
  const uninformative = audit.verdictNames.includes('points_uninformative');

  return {
    kind: 'projected',
    instant: projected,
    utcDate: utcCivilDate(projected),
    band: {
      earliestInstant: projected,
      latestInstant,
      earliestUtcDate: utcCivilDate(projected),
      latestUtcDate: utcCivilDate(latestInstant),
      spanDays,
      confidence,
    },
    method: 'cycle_time',
    selectedByVerdicts: selectedBy,
    reasoning: {
      method: 'cycle_time',
      formula: 'remaining items × median measured cycle time, banded to the 85th percentile',
      selectedByVerdicts: selectedBy,
      confidence,
      inputs: [
        { name: 'remainingItems', value: remainingItems, unit: 'items' },
        { name: 'medianCycleTimeDays', value: median, unit: 'days' },
        { name: 'p85CycleTimeDays', value: p85, unit: 'days' },
        { name: 'sampleSize', value: durations.length, unit: 'items' },
      ],
      assumptions: [
        'Items are worked one flow at a time at the observed rate.',
        'The remaining items are no harder than the ones already measured.',
        uninformative
          ? 'Story points are ignored entirely, because the audit found they have not predicted duration here.'
          : 'Story points are not used by this method.',
      ],
    },
    calibration,
    // The literal words the acceptance rule asks for, whenever the audit reached
    // `points_uninformative`: a cycle-time date and a velocity forecast are
    // different kinds of claim, and a reader who cannot tell them apart will plan
    // against the wrong one.
    statement: `${utcCivilDate(projected)} to ${utcCivilDate(latestInstant)} — a ${spanDays}-day band from measured cycle time over ${durations.length} finished items.${
      uninformative ? ' This is a cycle-time guess, not a velocity forecast.' : ''
    }`,
  };
}

/**
 * Confidence is a function of how wide the band is relative to the horizon, how
 * big the sample was, and what the Process Calibration Audit found.
 *
 * The audit is load-bearing rather than decorative here. A band can be narrow and
 * a sample large while the scope it was measured over was rewritten twice — so
 * every active verdict costs a level, and `points_uninformative` alone is enough
 * to make `high` unreachable whatever the arithmetic says. The typography reads the
 * result: at low confidence the web view sets the date in a lighter weight, so the
 * number itself loses conviction.
 */
function confidenceFor(
  spanDays: number,
  sampleSize: number,
  calibration: CalibrationVerdict,
  audit: CalibrationAudit,
): ConfidenceLevel {
  const base: ConfidenceLevel =
    calibration.verdict !== 'points_track_elapsed'
      ? spanDays <= 7 && sampleSize >= 20
        ? 'medium'
        : 'low'
      : spanDays <= 7 && sampleSize >= 4
        ? 'high'
        : spanDays <= 21
          ? 'medium'
          : 'low';

  const levels: readonly ConfidenceLevel[] = ['low', 'medium', 'high'];
  const demoted = Math.max(0, levels.indexOf(base) - audit.verdicts.length);
  return levels[demoted] ?? 'low';
}

function remainingItemCount(progress: ProgressAssessment): number {
  if (progress.mode === 'sprint') return progress.sprint.remaining.tickets;
  if (progress.mode === 'kanban') return progress.flow.workInProgress.items;
  return 0;
}

/** Measured start-to-finish durations in days, for completed in-scope items. */
function cycleTimeSample(snapshot: AnalysisSnapshot, instant: Instant, scope: ResolvedScope): readonly number[] {
  const transitions = transitionsByTicket(snapshot);
  const durations: number[] = [];

  for (const ticket of scopedTickets(snapshot, scope)) {
    if (!isDone(ticket)) continue;
    const key = textField(ticket, 'itemKey') ?? ticket.naturalKey;
    const history = transitions.get(key) ?? [];
    const startedAt = history.find((transition) => transition.toStatusCategory === 'in_progress')?.transitionedAt;
    const finishedAt = [...history]
      .reverse()
      .find((transition) => transition.toStatusCategory === DONE_STATUS_CATEGORY)?.transitionedAt;
    if (startedAt === undefined || finishedAt === undefined || finishedAt <= startedAt || finishedAt > instant) continue;
    durations.push(scaled((finishedAt - startedAt) / MILLIS_PER_DAY, 2));
  }

  return durations.sort(compareNumbers);
}

/** Whether a ticket resolved inside the report window — used by the win rule. */
export const resolvedInsideWindow = (ticket: AnalysisEntity, window: { start: Instant; end: Instant }): boolean => {
  const resolvedAt = instantField(ticket, 'resolvedAt');
  return resolvedAt !== null && resolvedAt >= window.start && resolvedAt < window.end;
};

