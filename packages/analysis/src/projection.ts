import {
  addDays,
  compareNumbers,
  compareStable,
  MILLIS_PER_DAY,
  medianOf,
  pearsonBasisPoints,
  percentileOf,
  scaled,
  utcCivilDate,
  wholeDaysBetween,
  type Instant,
} from './instant.js';
import { completedSprints, type CompletionBasis, type ProgressAssessment } from './progress.js';
import {
  instantField,
  isDone,
  numberField,
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
  /** Pearson's r between story points and measured elapsed days, in basis points. */
  readonly correlationBasisPoints: number | null;
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
      /** The first collar line: the band and the method, as a sentence. */
      readonly statement: string;
    }
  | {
      readonly kind: 'undefined';
      readonly reason: 'insufficient_history' | 'no_remaining_scope' | 'no_flow_history';
      readonly threshold: ThresholdRef;
      readonly calibration: CalibrationVerdict;
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
  const transitions = transitionsByTicket(snapshot);
  const samples: { ticketKey: string; points: number; days: number }[] = [];

  for (const ticket of scopedTickets(snapshot, scope)) {
    if (!isDone(ticket)) continue;
    const points = numberField(ticket, 'estimatePoints');
    if (points === null || points <= 0) continue;

    const key = textField(ticket, 'itemKey') ?? ticket.naturalKey;
    const history = transitions.get(key) ?? [];
    const startedAt = history.find((transition) => transition.toStatusCategory === 'in_progress')?.transitionedAt;
    const finishedAt = [...history].reverse().find((transition) => transition.toStatusCategory === 'done')
      ?.transitionedAt;
    if (startedAt === undefined || finishedAt === undefined || finishedAt <= startedAt) continue;
    if (finishedAt > instant) continue;

    samples.push({
      ticketKey: key,
      points,
      // Measured duration in hours, kept as a fraction of a day: flooring to whole
      // days would collapse most of the variance the correlation is looking for.
      days: scaled((finishedAt - startedAt) / MILLIS_PER_DAY, 2),
    });
  }

  samples.sort((left, right) => compareStable(left.ticketKey, right.ticketKey));
  const ticketKeys = samples.map((sample) => sample.ticketKey);

  if (samples.length < THRESHOLDS.T13.value) {
    return {
      verdict: 'not_enough_data',
      sampleSize: samples.length,
      correlationBasisPoints: null,
      correlationThreshold: thresholdRef('T12'),
      sampleThreshold: thresholdRef('T13'),
      ticketKeys,
      statement: `Only ${samples.length} completed item${samples.length === 1 ? '' : 's'} carried both an estimate and a measurable duration, so Compass cannot yet tell you whether your points mean anything.`,
    };
  }

  const correlation = pearsonBasisPoints(
    samples.map((sample) => sample.points),
    samples.map((sample) => sample.days),
  );

  if (correlation === null || correlation < THRESHOLDS.T12.value) {
    return {
      verdict: 'points_uninformative',
      sampleSize: samples.length,
      correlationBasisPoints: correlation,
      correlationThreshold: thresholdRef('T12'),
      sampleThreshold: thresholdRef('T13'),
      ticketKeys,
      statement:
        correlation === null
          ? `Across ${samples.length} completed items your estimates never varied, so they carry no information about how long work takes. Any date below is a cycle-time guess.`
          : `Your points have not tracked elapsed days across ${samples.length} completed items — correlation ${(correlation / 10_000).toFixed(2)}, below the ${(THRESHOLDS.T12.value / 10_000).toFixed(2)} Compass needs — so any date below is a cycle-time guess, not a plan.`,
    };
  }

  return {
    verdict: 'points_track_elapsed',
    sampleSize: samples.length,
    correlationBasisPoints: correlation,
    correlationThreshold: thresholdRef('T12'),
    sampleThreshold: thresholdRef('T13'),
    ticketKeys,
    statement: `Your points have tracked elapsed days across ${samples.length} completed items — correlation ${(correlation / 10_000).toFixed(2)} — so the date below rests on your own estimates.`,
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
): ProjectedCompletion {
  const calibration = assessCalibration(snapshot, instant, scope);
  const finished = completedSprints(scopedSprints(snapshot, scope), instant);

  if (progress.mode === 'sprint') {
    if (progress.velocity.kind === 'undefined') {
      return {
        kind: 'undefined',
        reason: 'insufficient_history',
        threshold: thresholdRef('T7'),
        calibration,
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
        statement: 'Everything in the current sprint is finished, so there is nothing left to project.',
      };
    }

    if (calibration.verdict === 'points_track_elapsed' || progress.sprint.basis === 'ticket_count') {
      return velocityProjection(instant, progress, calibration);
    }
  }

  // Cycle time: the fallback that needs no estimates, and the primary method for
  // a Kanban team, which has no sprint to burn down.
  return cycleTimeProjection(snapshot, instant, scope, progress, calibration);
}

function velocityProjection(
  instant: Instant,
  progress: Extract<ProgressAssessment, { mode: 'sprint' }>,
  calibration: CalibrationVerdict,
): ProjectedCompletion {
  const velocity = progress.velocity;
  if (velocity.kind === 'undefined') {
    return {
      kind: 'undefined',
      reason: 'insufficient_history',
      threshold: thresholdRef('T7'),
      calibration,
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
      confidence: confidenceFor(spanDays, velocity.samples.length, calibration),
    },
    method: 'trailing_velocity',
    reasoning: {
      method: 'trailing_velocity',
      formula: 'remaining ÷ mean(trailing sprint completion) × sprint length, banded by the slowest and fastest sprint in the sample',
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
): ProjectedCompletion {
  const durations = cycleTimeSample(snapshot, instant, scope);
  const remainingItems = remainingItemCount(progress);

  if (durations.length === 0) {
    return {
      kind: 'undefined',
      reason: 'no_flow_history',
      threshold: thresholdRef('T13'),
      calibration,
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
      confidence: confidenceFor(spanDays, durations.length, calibration),
    },
    method: 'cycle_time',
    reasoning: {
      method: 'cycle_time',
      formula: 'remaining items × median measured cycle time, banded to the 85th percentile',
      inputs: [
        { name: 'remainingItems', value: remainingItems, unit: 'items' },
        { name: 'medianCycleTimeDays', value: median, unit: 'days' },
        { name: 'p85CycleTimeDays', value: p85, unit: 'days' },
        { name: 'sampleSize', value: durations.length, unit: 'items' },
      ],
      assumptions: [
        'Items are worked one flow at a time at the observed rate.',
        'The remaining items are no harder than the ones already measured.',
        calibration.verdict === 'points_uninformative'
          ? 'Story points are ignored entirely, because they have not predicted duration here.'
          : 'Story points are not used by this method.',
      ],
    },
    calibration,
    statement: `${utcCivilDate(projected)} to ${utcCivilDate(latestInstant)} — a ${spanDays}-day band from measured cycle time over ${durations.length} finished items.`,
  };
}

/**
 * Confidence is a function of how wide the band is relative to the horizon, how
 * big the sample was, and whether the team's own estimates have ever been
 * predictive. It is never `high` on an uncalibrated projection, whatever the
 * arithmetic says.
 */
function confidenceFor(spanDays: number, sampleSize: number, calibration: CalibrationVerdict): ConfidenceLevel {
  if (calibration.verdict !== 'points_track_elapsed') return spanDays <= 7 && sampleSize >= 20 ? 'medium' : 'low';
  if (spanDays <= 7 && sampleSize >= 4) return 'high';
  if (spanDays <= 21) return 'medium';
  return 'low';
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
    const finishedAt = [...history].reverse().find((transition) => transition.toStatusCategory === 'done')
      ?.transitionedAt;
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
