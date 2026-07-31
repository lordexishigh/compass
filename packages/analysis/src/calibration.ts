import { orderedEvidence, sprintEvidence, ticketEvidence, type EvidenceRef } from './evidence.js';
import {
  MILLIS_PER_HOUR,
  basisPoints,
  compareNumbers,
  compareStable,
  medianOf,
  trailingDays,
  windowContains,
  workingDaysBetween,
  type Instant,
  type TimeWindow,
} from './instant.js';
import { completedSprints } from './progress.js';
import {
  DONE_STATUS_CATEGORY,
  TODO_STATUS_CATEGORY,
  instantField,
  isInFlight,
  numberField,
  scopedCommits,
  scopedPullRequests,
  scopedSprints,
  scopedTickets,
  statusCategoryAt,
  textField,
  textListField,
  transitionsByTicket,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type AnalysisTicketTransition,
  type ResolvedScope,
} from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdId, type ThresholdRef } from './thresholds.js';

/**
 * The Process Calibration Audit.
 *
 * Every other module in this package answers a question about the *work*. This
 * one answers a question about the *data*: before Compass tells a manager their
 * sprint is 62% complete, it asks whether the numbers behind that figure carry
 * any information at all.
 *
 * Nobody audits this. A tracker will happily compute a velocity from estimates
 * that have never predicted anything, a burn-down from a scope that was rewritten
 * three times, and a cycle time from statuses nobody moves. Each of those numbers
 * is arithmetically correct and epistemically worthless, and the tool that
 * produced it says nothing about the difference. Compass says it out loud, in the
 * prose, above the number.
 *
 * ### Seven statistics
 *
 * Each is computed from the snapshot alone, takes the instant it should reason
 * about as a parameter, and carries **its own sample size** into the output:
 *
 *  1. **Point-to-elapsed correlation** — do story points track measured elapsed
 *     working days? Emitted as a coefficient that is never alone: `sampleSize`
 *     and `spread` ride in the same object, always, because a correlation of
 *     0.82 over four tickets with a two-day spread is noise wearing a
 *     statistic's clothes and a reader shown only `0.82` cannot tell.
 *  2. **Estimate coverage** — the share of work items in the trailing window
 *     carrying an estimate, with both counts.
 *  3. **Carryover** — per trailing sprint, the share of the committed baseline
 *     still unfinished when the sprint closed, naming the carried keys.
 *  4. **Status-dwell consistency** — per workflow status, the spread of how long
 *     items actually sit in it.
 *  5. **Scope churn** — items added and removed after the sprint started, over
 *     the committed baseline, naming both sets.
 *  6. **Sub-task double count** — parent items whose sub-tasks also carry points,
 *     which inflates every points total that includes both.
 *  7. **Stale-status incidence** — items sitting in an in-progress status with no
 *     commit and no pull-request activity behind them.
 *
 * ### Six verdicts, and nothing else
 *
 * The verdict vocabulary is closed. A statistic either crosses a numbered
 * threshold and produces one of these six, or it is reported as a measurement
 * and produces nothing. There is no seventh verdict, no free-text finding, and
 * no severity assigned by hand.
 *
 * `insufficient_history` is computed **first** and suppresses the two verdicts
 * that are meaningless without trailing sprints. A new team told both "scope is
 * fiction" and "Compass has no history for you" would be reading two sentences
 * that contradict each other, and the second one is the true one.
 */
export const PROCESS_VERDICTS = [
  'points_uninformative',
  'estimates_sparse',
  'scope_is_fiction',
  'workflow_inconsistent',
  'statuses_stale',
  'insufficient_history',
] as const;

export type ProcessVerdictName = (typeof PROCESS_VERDICTS)[number];

/**
 * How many completed sprints the trailing statistics look back over.
 *
 * Five, matching `VELOCITY_TRAILING_SPRINTS`: a carryover rate and a velocity
 * measured over different histories would let the two sections disagree about
 * the same quarter.
 */
export const CALIBRATION_TRAILING_SPRINTS = 5;

/**
 * The trailing window estimate coverage is measured over, in days.
 *
 * Twenty-eight, so the figure spans two sprints of the seeded fourteen-day
 * cadence and is not decided by whichever sprint happens to be in flight today.
 */
export const ESTIMATE_COVERAGE_TRAILING_DAYS = 28;

/**
 * The rule behind each verdict, as data.
 *
 * `thresholdIds` is the whole point: a verdict must name the numbered constants
 * it was compared against, and `tests/calibration.test.ts` enumerates this record
 * and fails if any entry points at a threshold `thresholds.ts` does not declare.
 * That is what makes "every threshold is documented as a number" checkable rather
 * than a claim in a comment.
 */
export interface ProcessVerdictRule {
  readonly statistic: string;
  readonly thresholdIds: readonly ThresholdId[];
  /** Whether the verdict is meaningless without trailing sprints to look back over. */
  readonly needsTrailingSprints: boolean;
}

export const PROCESS_VERDICT_RULES = Object.freeze({
  points_uninformative: Object.freeze({
    statistic: 'point_to_elapsed_working_days',
    thresholdIds: Object.freeze(['T12', 'T13'] as const),
    needsTrailingSprints: false,
  }),
  estimates_sparse: Object.freeze({
    statistic: 'estimate_coverage',
    thresholdIds: Object.freeze(['T18'] as const),
    needsTrailingSprints: false,
  }),
  scope_is_fiction: Object.freeze({
    statistic: 'carryover_rate_and_scope_churn',
    thresholdIds: Object.freeze(['T19', 'T20', 'T21'] as const),
    needsTrailingSprints: true,
  }),
  workflow_inconsistent: Object.freeze({
    statistic: 'status_dwell_consistency',
    thresholdIds: Object.freeze(['T13', 'T22'] as const),
    needsTrailingSprints: true,
  }),
  statuses_stale: Object.freeze({
    statistic: 'stale_status_incidence',
    thresholdIds: Object.freeze(['T23', 'T24'] as const),
    needsTrailingSprints: false,
  }),
  insufficient_history: Object.freeze({
    statistic: 'completed_sprint_count',
    thresholdIds: Object.freeze(['T7'] as const),
    needsTrailingSprints: false,
  }),
} as const satisfies Record<ProcessVerdictName, ProcessVerdictRule>);

// ---------------------------------------------------------------------------
// Statistic shapes
// ---------------------------------------------------------------------------

/**
 * A spread, in whatever unit the statistic measured.
 *
 * Four numbers rather than a standard deviation, deliberately: a manager can
 * check `minimum`, `maximum` and `median` against three rows of their own board,
 * and cannot check a variance against anything.
 */
export interface CalibrationSpread {
  readonly minimum: number;
  readonly maximum: number;
  /** `maximum − minimum`. Zero for a sample of one, and for a constant sample. */
  readonly spread: number;
  readonly median: number;
  readonly unit: 'working_days' | 'story_points' | 'hours';
}

export interface PointElapsedSample {
  readonly ticketKey: string;
  readonly estimatePoints: number;
  readonly elapsedWorkingDays: number;
}

/**
 * The correlation, and everything needed to disbelieve it.
 *
 * There is deliberately no field on this object — or anywhere else in the
 * package — called `r`. A coefficient is only interpretable beside its sample
 * size and the spread of the thing it was measured over, so those three travel
 * together as one value and cannot be destructured apart by a renderer.
 */
export interface PointToElapsedCorrelation {
  readonly statistic: 'point_to_elapsed_working_days';
  readonly sampleSize: number;
  /** Pearson's, in basis points. `null` when either column has no variance. */
  readonly coefficientBasisPoints: number | null;
  /** `|coefficient|`, which is what T12 is compared against. */
  readonly absoluteCoefficientBasisPoints: number | null;
  readonly spread: {
    readonly elapsedWorkingDays: CalibrationSpread;
    readonly estimatePoints: CalibrationSpread;
  };
  readonly ticketKeys: readonly string[];
  readonly samples: readonly PointElapsedSample[];
  readonly sampleThreshold: ThresholdRef;
  readonly coefficientThreshold: ThresholdRef;
  readonly statement: string;
}

export interface EstimateCoverage {
  readonly statistic: 'estimate_coverage';
  readonly trailingDays: number;
  readonly window: TimeWindow;
  readonly estimatedTickets: number;
  readonly totalTickets: number;
  readonly coverageBasisPoints: number;
  readonly unestimatedTicketKeys: readonly string[];
  readonly threshold: ThresholdRef;
  readonly statement: string;
}

export interface SprintCarryover {
  readonly sprintKey: string;
  readonly sprintName: string;
  readonly closedAt: number;
  readonly committedTickets: number;
  readonly carriedTickets: number;
  readonly carriedTicketKeys: readonly string[];
  readonly rateBasisPoints: number;
  readonly breachedThreshold: boolean;
}

export interface CarryoverStatistic {
  readonly statistic: 'carryover_rate';
  readonly trailingSprints: number;
  readonly perSprint: readonly SprintCarryover[];
  /** The mean of the per-sprint rates, in basis points. Zero with no sprints. */
  readonly meanRateBasisPoints: number;
  readonly breachedSprintCount: number;
  readonly rateThreshold: ThresholdRef;
  readonly breachCountThreshold: ThresholdRef;
  readonly statement: string;
}

export interface StatusDwell {
  readonly status: string;
  readonly sampleSize: number;
  readonly spread: CalibrationSpread;
  /** `spread ÷ median`, in basis points. Zero when the median is zero. */
  readonly spreadOverMedianBasisPoints: number;
  readonly inconsistent: boolean;
  readonly ticketKeys: readonly string[];
}

export interface StatusDwellStatistic {
  readonly statistic: 'status_dwell_consistency';
  readonly trailingSprints: number;
  readonly perStatus: readonly StatusDwell[];
  readonly inconsistentStatuses: readonly string[];
  readonly sampleThreshold: ThresholdRef;
  readonly spreadThreshold: ThresholdRef;
  readonly statement: string;
}

export interface SprintScopeChurn {
  readonly sprintKey: string;
  readonly sprintName: string;
  readonly committedBaseline: number;
  readonly addedTicketKeys: readonly string[];
  readonly removedTicketKeys: readonly string[];
  readonly churnBasisPoints: number;
  readonly breachedThreshold: boolean;
}

export interface ScopeChurnStatistic {
  readonly statistic: 'scope_churn';
  readonly perSprint: readonly SprintScopeChurn[];
  readonly worstChurnBasisPoints: number;
  readonly breachedSprintKeys: readonly string[];
  readonly threshold: ThresholdRef;
  readonly statement: string;
}

export interface SubTaskDoubleCount {
  readonly statistic: 'sub_task_double_count';
  readonly parentTickets: number;
  readonly doubleCountedParents: number;
  readonly shareBasisPoints: number;
  readonly doubleCountedParentKeys: readonly string[];
  readonly statement: string;
}

export interface StaleTicket {
  readonly ticketKey: string;
  readonly status: string;
  readonly inProgressWorkingDays: number;
  /** Working days since the last commit or pull-request event. Null when none. */
  readonly workingDaysSinceActivity: number | null;
}

export interface StaleStatusStatistic {
  readonly statistic: 'stale_status_incidence';
  readonly inProgressTickets: number;
  readonly staleTickets: number;
  readonly incidenceBasisPoints: number;
  readonly stale: readonly StaleTicket[];
  readonly staleTicketKeys: readonly string[];
  readonly dwellThreshold: ThresholdRef;
  readonly incidenceThreshold: ThresholdRef;
  readonly statement: string;
}

export interface CalibrationStatistics {
  readonly pointToElapsed: PointToElapsedCorrelation;
  readonly estimateCoverage: EstimateCoverage;
  readonly carryover: CarryoverStatistic;
  readonly statusDwell: StatusDwellStatistic;
  readonly scopeChurn: ScopeChurnStatistic;
  readonly subTaskDoubleCount: SubTaskDoubleCount;
  readonly staleStatus: StaleStatusStatistic;
}

/** One verdict: the statistic, its value, and the number it was compared against. */
export interface ProcessVerdict {
  readonly name: ProcessVerdictName;
  readonly statistic: string;
  readonly value: number;
  readonly valueUnit: 'basis_points' | 'count' | 'working_days' | 'sample_size';
  /** How much data the verdict rests on. Never omitted, never inferred. */
  readonly sampleSize: number;
  /** The numbered rule the value crossed. */
  readonly threshold: ThresholdRef;
  /** The other constants the rule cites — a sample floor, a breach count. */
  readonly supportingThresholds: readonly ThresholdRef[];
  /** The tickets, sprints or statuses the verdict is about, sorted. */
  readonly subjects: readonly string[];
  readonly statement: string;
  readonly evidence: readonly EvidenceRef[];
}

export interface CalibrationAudit {
  readonly completedSprintCount: number;
  readonly trailingSprints: number;
  readonly statistics: CalibrationStatistics;
  readonly verdicts: readonly ProcessVerdict[];
  readonly verdictNames: readonly ProcessVerdictName[];
  /** Verdicts a lack of trailing sprints refused to state, and why. */
  readonly suppressed: readonly ProcessVerdictName[];
  readonly statement: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ticketKeyOf = (ticket: AnalysisEntity): string => textField(ticket, 'itemKey') ?? ticket.naturalKey;

const emptySpread = (unit: CalibrationSpread['unit']): CalibrationSpread => ({
  minimum: 0,
  maximum: 0,
  spread: 0,
  median: 0,
  unit,
});

function spreadOf(values: readonly number[], unit: CalibrationSpread['unit']): CalibrationSpread {
  if (values.length === 0) return emptySpread(unit);
  const sorted = [...values].sort(compareNumbers);
  const minimum = sorted[0] as number;
  const maximum = sorted[sorted.length - 1] as number;
  return { minimum, maximum, spread: maximum - minimum, median: medianOf(sorted) ?? 0, unit };
}

/**
 * Pearson's, over integer samples, in basis points.
 *
 * Declared here rather than taken from `instant.ts` so the accumulation order is
 * fixed by the sorted sample this module builds: floating-point addition is not
 * associative, and a correlation that changed in the fourth decimal because two
 * collections were walked in a different order would break the byte-identical
 * report guarantee.
 */
function correlationBasisPoints(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;

  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;

  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = (left[index] as number) - leftMean;
    const rightDelta = (right[index] as number) - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }

  if (leftVariance === 0 || rightVariance === 0) return null;
  return Math.round((covariance / Math.sqrt(leftVariance * rightVariance)) * 10_000);
}

const decimal = (basisPointValue: number): string => (basisPointValue / 10_000).toFixed(2);

const share = (basisPointValue: number): string => `${Math.round(basisPointValue / 100)}%`;

/** The sprints the trailing statistics are measured over, oldest first. */
function trailingSprints(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly AnalysisEntity[] {
  return completedSprints(scopedSprints(snapshot, scope), instant).slice(-CALIBRATION_TRAILING_SPRINTS);
}

/**
 * The committed baseline of one sprint: the items it held that were not added
 * after it started.
 *
 * Read from both directions — the sprint's own `committedItemKeys` and each
 * ticket's `sprintKey` — exactly as `progress.ts` does, because either may be
 * the field the provider actually filled in. A baseline computed one way here and
 * the other way there would make the carryover rate and the completion
 * percentage disagree about the same sprint.
 */
function committedBaseline(
  snapshot: AnalysisSnapshot,
  sprint: AnalysisEntity,
  tickets: readonly AnalysisEntity[],
): readonly AnalysisEntity[] {
  const declared = new Set(textListField(sprint, 'committedItemKeys'));
  const addedAfterStart = new Set(
    snapshot.collections.sprintScopeChanges
      .filter((change) => change.sprintKey === sprint.naturalKey && change.change === 'added' && change.afterSprintStart)
      .map((change) => change.ticketKey),
  );

  return tickets.filter(
    (ticket) =>
      (textField(ticket, 'sprintKey') === sprint.naturalKey || declared.has(ticketKeyOf(ticket))) &&
      !addedAfterStart.has(ticketKeyOf(ticket)),
  );
}

// ---------------------------------------------------------------------------
// 1. Point-to-elapsed-working-days correlation
// ---------------------------------------------------------------------------

/**
 * Do this team's story points track how long work actually takes?
 *
 * Elapsed time is measured in **working days over the team's calendar**, from the
 * first move into an in-progress status to the last move into done — not from
 * creation, which would count the weeks a ticket sat in a backlog nobody was
 * working. Calendar days would make a Friday-to-Monday ticket look like a
 * three-day one, and a threshold that drifts with the day of the week is not a
 * threshold.
 */
export function pointToElapsedCorrelation(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): PointToElapsedCorrelation {
  const transitions = transitionsByTicket(snapshot);
  const samples: PointElapsedSample[] = [];

  for (const ticket of scopedTickets(snapshot, scope)) {
    const points = numberField(ticket, 'estimatePoints');
    if (points === null || points <= 0) continue;

    const key = ticketKeyOf(ticket);
    const history = transitions.get(key) ?? [];
    const startedAt = history.find((transition) => transition.toStatusCategory === 'in_progress')?.transitionedAt;
    const finishedAt = [...history]
      .reverse()
      .find((transition) => transition.toStatusCategory === DONE_STATUS_CATEGORY)?.transitionedAt;
    if (startedAt === undefined || finishedAt === undefined || finishedAt <= startedAt) continue;
    if (finishedAt > instant) continue;

    samples.push({
      ticketKey: key,
      estimatePoints: points,
      elapsedWorkingDays: workingDaysBetween(startedAt as Instant, finishedAt as Instant),
    });
  }

  samples.sort((left, right) => compareStable(left.ticketKey, right.ticketKey));

  const coefficient = correlationBasisPoints(
    samples.map((sample) => sample.estimatePoints),
    samples.map((sample) => sample.elapsedWorkingDays),
  );
  const absolute = coefficient === null ? null : Math.abs(coefficient);
  const spread = {
    elapsedWorkingDays: spreadOf(
      samples.map((sample) => sample.elapsedWorkingDays),
      'working_days',
    ),
    estimatePoints: spreadOf(
      samples.map((sample) => sample.estimatePoints),
      'story_points',
    ),
  };

  return {
    statistic: 'point_to_elapsed_working_days',
    sampleSize: samples.length,
    coefficientBasisPoints: coefficient,
    absoluteCoefficientBasisPoints: absolute,
    spread,
    ticketKeys: samples.map((sample) => sample.ticketKey),
    samples,
    sampleThreshold: thresholdRef('T13'),
    coefficientThreshold: thresholdRef('T12'),
    statement: correlationStatement(samples.length, absolute, spread.elapsedWorkingDays),
  };
}

function correlationStatement(
  sampleSize: number,
  absolute: number | null,
  elapsed: CalibrationSpread,
): string {
  if (sampleSize < THRESHOLDS.T13.value) {
    return `Only ${sampleSize} completed ${sampleSize === 1 ? 'item carries' : 'items carry'} both an estimate and a measurable duration, and T13 needs ${THRESHOLDS.T13.value}, so Compass will not tell you whether your points mean anything yet.`;
  }
  if (absolute === null) {
    return `Across ${sampleSize} completed items one of the two columns never varied, so there is no correlation to compute — the estimates carry no information about duration.`;
  }
  return `Across ${sampleSize} completed items your points correlate with elapsed working days at ${decimal(absolute)}, over durations spanning ${elapsed.minimum} to ${elapsed.maximum} working days with a median of ${elapsed.median}.`;
}

// ---------------------------------------------------------------------------
// 2. Estimate coverage
// ---------------------------------------------------------------------------

/**
 * The share of work items in the trailing window that carry an estimate.
 *
 * "In the trailing window" is the item's own creation instant, which is the one
 * moment in a ticket's life at which somebody could have estimated it. Using the
 * sprint's membership instead would make the figure jump every fortnight as
 * sprints roll over, and using "touched in the window" would count a two-month-old
 * backlog item as a fresh estimating decision.
 */
export function estimateCoverage(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): EstimateCoverage {
  const window = trailingDays(instant, ESTIMATE_COVERAGE_TRAILING_DAYS);
  const inWindow = scopedTickets(snapshot, scope).filter((ticket) => {
    const createdAt = instantField(ticket, 'createdAt') ?? (ticket.firstSeenAt as Instant);
    return windowContains(window, createdAt);
  });

  const unestimated = inWindow.filter((ticket) => {
    const points = numberField(ticket, 'estimatePoints');
    return points === null || points <= 0;
  });
  const estimated = inWindow.length - unestimated.length;
  const coverage = basisPoints(estimated, inWindow.length);

  return {
    statistic: 'estimate_coverage',
    trailingDays: ESTIMATE_COVERAGE_TRAILING_DAYS,
    window,
    estimatedTickets: estimated,
    totalTickets: inWindow.length,
    coverageBasisPoints: coverage,
    unestimatedTicketKeys: unestimated.map(ticketKeyOf).sort(compareStable),
    threshold: thresholdRef('T18'),
    statement:
      inWindow.length === 0
        ? `No work item was raised in the last ${ESTIMATE_COVERAGE_TRAILING_DAYS} days, so there is no estimating discipline to measure.`
        : `${estimated} of ${inWindow.length} items raised in the last ${ESTIMATE_COVERAGE_TRAILING_DAYS} days carry a point estimate — ${share(coverage)}, against the ${share(THRESHOLDS.T18.value)} T18 asks for.`,
  };
}

// ---------------------------------------------------------------------------
// 3. Carryover
// ---------------------------------------------------------------------------

/**
 * The share of each trailing sprint's committed baseline that was still
 * unfinished when the sprint closed.
 *
 * Decided by replaying each item's transition history to the sprint's own
 * `completedAt`, not by reading its status today: half of a sprint's carryover
 * finishes the following week, and a rate computed from current belief would
 * report a team that habitually overcommits as one that never does.
 */
export function carryoverRate(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): CarryoverStatistic {
  const tickets = scopedTickets(snapshot, scope);
  const transitions = transitionsByTicket(snapshot);
  const sprints = trailingSprints(snapshot, instant, scope);

  const perSprint: SprintCarryover[] = sprints.map((sprint) => {
    const closedAt = (instantField(sprint, 'completedAt') ?? instantField(sprint, 'endAt') ?? instant) as Instant;
    const committed = committedBaseline(snapshot, sprint, tickets);
    const carried = committed.filter((ticket) => {
      const category = statusCategoryAt(transitions.get(ticketKeyOf(ticket)) ?? [], closedAt);
      return category !== DONE_STATUS_CATEGORY;
    });
    const rate = basisPoints(carried.length, committed.length);

    return {
      sprintKey: sprint.naturalKey,
      sprintName: textField(sprint, 'name') ?? sprint.naturalKey,
      closedAt,
      committedTickets: committed.length,
      carriedTickets: carried.length,
      carriedTicketKeys: carried.map(ticketKeyOf).sort(compareStable),
      rateBasisPoints: rate,
      breachedThreshold: committed.length > 0 && rate >= THRESHOLDS.T19.value,
    };
  });

  const breached = perSprint.filter((row) => row.breachedThreshold);
  const measured = perSprint.filter((row) => row.committedTickets > 0);
  const meanRate =
    measured.length === 0
      ? 0
      : Math.round(measured.reduce((sum, row) => sum + row.rateBasisPoints, 0) / measured.length);

  return {
    statistic: 'carryover_rate',
    trailingSprints: CALIBRATION_TRAILING_SPRINTS,
    perSprint,
    meanRateBasisPoints: meanRate,
    breachedSprintCount: breached.length,
    rateThreshold: thresholdRef('T19'),
    breachCountThreshold: thresholdRef('T20'),
    statement:
      measured.length === 0
        ? 'No completed sprint has a committed baseline Compass can measure, so there is no carryover rate.'
        : `Across the last ${measured.length} completed sprints a mean of ${share(meanRate)} of the committed baseline rolled into the next sprint, and ${breached.length} of them passed the ${share(THRESHOLDS.T19.value)} T19 sets.`,
  };
}

// ---------------------------------------------------------------------------
// 4. Status-dwell consistency
// ---------------------------------------------------------------------------

/**
 * How long items actually sit in each workflow status, and how much that varies.
 *
 * Only **closed** dwell intervals count — a status entered and later left — so
 * the sample is what the board actually did rather than what it is mid-way
 * through doing. Measured in whole hours: a status whose dwell is a fraction of a
 * working day is exactly the case a day-granular measure would flatten to zero,
 * and the spread is the whole point of the statistic.
 *
 * A status whose dwell times vary by more than `T22` of their own median is a
 * status that means something different every time it is used. That is what makes
 * a cycle-time estimate drawn from it unusable, and it is invisible on every
 * board Compass has ever been pointed at.
 */
export function statusDwellConsistency(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): StatusDwellStatistic {
  const sprints = trailingSprints(snapshot, instant, scope);
  const earliest = sprints
    .map((sprint) => instantField(sprint, 'startAt'))
    .filter((value): value is Instant => value !== null)
    .sort(compareNumbers)[0];
  // With no trailing sprint to bound the sample, the whole observed history is
  // the honest window: `insufficient_history` is what states the limitation, and
  // reporting an empty dwell table alongside it would say nothing twice.
  const from = earliest ?? (snapshot.window.start as Instant);

  const inScope = new Set(scopedTickets(snapshot, scope).map(ticketKeyOf));
  const dwellHours = new Map<string, number[]>();
  const ticketsByStatus = new Map<string, Set<string>>();

  const record = (status: string, ticketKey: string, hours: number): void => {
    const bucket = dwellHours.get(status);
    if (bucket === undefined) dwellHours.set(status, [hours]);
    else bucket.push(hours);
    const seen = ticketsByStatus.get(status);
    if (seen === undefined) ticketsByStatus.set(status, new Set([ticketKey]));
    else seen.add(ticketKey);
  };

  for (const [ticketKey, history] of transitionsByTicket(snapshot)) {
    if (!inScope.has(ticketKey)) continue;
    const ordered = [...history].sort(
      (left, right) =>
        compareNumbers(left.transitionedAt, right.transitionedAt) ||
        compareStable(left.sourceRecordId, right.sourceRecordId),
    );
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const entered = ordered[index] as AnalysisTicketTransition;
      const left = ordered[index + 1] as AnalysisTicketTransition;
      if (entered.transitionedAt < from || left.transitionedAt > instant) continue;
      record(entered.toStatus, ticketKey, Math.round((left.transitionedAt - entered.transitionedAt) / MILLIS_PER_HOUR));
    }
  }

  const perStatus: StatusDwell[] = [...dwellHours.entries()]
    .sort(([left], [right]) => compareStable(left, right))
    .map(([status, hours]) => {
      const spread = spreadOf(hours, 'hours');
      const ratio = spread.median === 0 ? 0 : basisPoints(spread.spread, spread.median);
      return {
        status,
        sampleSize: hours.length,
        spread,
        spreadOverMedianBasisPoints: ratio,
        inconsistent: hours.length >= THRESHOLDS.T13.value && ratio >= THRESHOLDS.T22.value,
        ticketKeys: [...(ticketsByStatus.get(status) ?? new Set<string>())].sort(compareStable),
      };
    });

  const inconsistent = perStatus.filter((row) => row.inconsistent).map((row) => row.status);

  return {
    statistic: 'status_dwell_consistency',
    trailingSprints: CALIBRATION_TRAILING_SPRINTS,
    perStatus,
    inconsistentStatuses: inconsistent,
    sampleThreshold: thresholdRef('T13'),
    spreadThreshold: thresholdRef('T22'),
    statement:
      perStatus.length === 0
        ? 'No status has been entered and left inside the trailing sprints, so there is no dwell time to compare.'
        : inconsistent.length === 0
          ? `Every one of the ${perStatus.length} workflow statuses Compass measured holds its items for a consistent length of time.`
          : `${inconsistent.join(', ')} ${inconsistent.length === 1 ? 'holds items' : 'hold items'} for wildly different lengths of time, so the status does not mean the same thing twice.`,
  };
}

// ---------------------------------------------------------------------------
// 5. Scope churn
// ---------------------------------------------------------------------------

/**
 * Items added and removed after the sprint started, over its committed baseline.
 *
 * Both directions count. A sprint that swapped six items for six others has a
 * churn of twelve over its baseline and a scope creep of six, and only the first
 * number describes what the team actually experienced.
 */
export function scopeChurn(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): ScopeChurnStatistic {
  const tickets = scopedTickets(snapshot, scope);
  const sprints = [...trailingSprints(snapshot, instant, scope)];

  // The sprint in flight churns too, and it is the one a manager can still act
  // on — so it is measured alongside the closed ones rather than only after it
  // ends.
  for (const sprint of scopedSprints(snapshot, scope)) {
    const startAt = instantField(sprint, 'startAt');
    const endAt = instantField(sprint, 'endAt');
    if (startAt === null || endAt === null) continue;
    if (instant >= startAt && instant < endAt && !sprints.some((known) => known.naturalKey === sprint.naturalKey)) {
      sprints.push(sprint);
    }
  }

  const perSprint: SprintScopeChurn[] = sprints
    .map((sprint) => {
      const baseline = committedBaseline(snapshot, sprint, tickets).length;
      const changes = snapshot.collections.sprintScopeChanges.filter(
        (change) => change.sprintKey === sprint.naturalKey && change.afterSprintStart,
      );
      const added = [...new Set(changes.filter((change) => change.change === 'added').map((change) => change.ticketKey))]
        .sort(compareStable);
      const removed = [
        ...new Set(changes.filter((change) => change.change === 'removed').map((change) => change.ticketKey)),
      ].sort(compareStable);
      const churn = basisPoints(added.length + removed.length, baseline);

      return {
        sprintKey: sprint.naturalKey,
        sprintName: textField(sprint, 'name') ?? sprint.naturalKey,
        committedBaseline: baseline,
        addedTicketKeys: added,
        removedTicketKeys: removed,
        churnBasisPoints: churn,
        breachedThreshold: baseline > 0 && churn >= THRESHOLDS.T21.value,
      };
    })
    .sort((left, right) => compareStable(left.sprintKey, right.sprintKey));

  const breached = perSprint.filter((row) => row.breachedThreshold);
  const worst = perSprint.reduce((highest, row) => Math.max(highest, row.churnBasisPoints), 0);

  return {
    statistic: 'scope_churn',
    perSprint,
    worstChurnBasisPoints: worst,
    breachedSprintKeys: breached.map((row) => row.sprintKey),
    threshold: thresholdRef('T21'),
    statement:
      perSprint.length === 0
        ? 'No sprint has a committed baseline to measure churn against.'
        : breached.length === 0
          ? `The worst churn across ${perSprint.length} sprints was ${share(worst)} of the committed baseline, inside the ${share(THRESHOLDS.T21.value)} T21 allows.`
          : `${breached.map((row) => `${row.sprintName} churned ${share(row.churnBasisPoints)} of its baseline`).join('; ')}, past the ${share(THRESHOLDS.T21.value)} T21 sets.`,
  };
}

// ---------------------------------------------------------------------------
// 6. Sub-task double count
// ---------------------------------------------------------------------------

/**
 * Parents whose sub-tasks also carry points.
 *
 * When both a parent and its children are estimated, every points total that
 * includes both counts the same work twice — so the sprint looks larger than it
 * is, the velocity looks higher than it is, and the two errors cancel just well
 * enough that nobody notices. This is reported as a measurement rather than a
 * verdict: it is a modelling choice some teams make deliberately, and Compass
 * states the consequence without deciding it is wrong.
 */
export function subTaskDoubleCount(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): SubTaskDoubleCount {
  const tickets = scopedTickets(snapshot, scope);
  const byKey = new Map(tickets.map((ticket) => [ticketKeyOf(ticket), ticket]));
  const childrenByParent = new Map<string, AnalysisEntity[]>();

  for (const ticket of tickets) {
    const parentKey = textField(ticket, 'featureKey');
    if (parentKey === null || !byKey.has(parentKey)) continue;
    const bucket = childrenByParent.get(parentKey);
    if (bucket === undefined) childrenByParent.set(parentKey, [ticket]);
    else bucket.push(ticket);
  }

  const estimated = (ticket: AnalysisEntity): boolean => (numberField(ticket, 'estimatePoints') ?? 0) > 0;

  const doubleCounted = [...childrenByParent.entries()]
    .filter(([parentKey, children]) => {
      const parent = byKey.get(parentKey);
      return parent !== undefined && estimated(parent) && children.some(estimated);
    })
    .map(([parentKey]) => parentKey)
    .sort(compareStable);

  const parentCount = childrenByParent.size;
  const shareBasisPoints = basisPoints(doubleCounted.length, parentCount);
  // `instant` is not read: a parent-child estimating relationship is a fact about
  // the board's shape rather than about a moment. It stays in the signature so
  // every audit statistic is called the same way and the purity gate can hold one
  // rule for all of them.
  void instant;

  return {
    statistic: 'sub_task_double_count',
    parentTickets: parentCount,
    doubleCountedParents: doubleCounted.length,
    shareBasisPoints,
    doubleCountedParentKeys: doubleCounted,
    statement:
      parentCount === 0
        ? 'No work item in scope has sub-tasks, so no points total can be double-counting one.'
        : doubleCounted.length === 0
          ? `${parentCount} ${parentCount === 1 ? 'item has' : 'items have'} sub-tasks and none of them carries points on both levels, so no total counts the same work twice.`
          : `${doubleCounted.join(', ')} ${doubleCounted.length === 1 ? 'carries points' : 'carry points'} while ${doubleCounted.length === 1 ? 'its' : 'their'} sub-tasks do too — ${share(shareBasisPoints)} of the ${parentCount} parent items — so every points total spanning both levels counts that work twice.`,
  };
}

// ---------------------------------------------------------------------------
// 7. Stale-status incidence
// ---------------------------------------------------------------------------

/**
 * Items sitting in an in-progress status with nothing happening behind them.
 *
 * Two limbs, both required. The item must have been in its current in-progress
 * status for `T23` working days **and** have had no commit and no pull-request
 * event for `T23` working days. One limb alone would name a long-running item
 * that somebody is actively pushing to, which is not a data-quality problem — it
 * is just work.
 *
 * Activity is read from the artifacts the *source* linked to the item: a commit
 * whose message named the key, a pull request whose `linkedItemKeys` declared it.
 * Compass never treats a commit as activity on a ticket because the author or the
 * timing lines up.
 */
export function staleStatusIncidence(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): StaleStatusStatistic {
  const transitions = transitionsByTicket(snapshot);
  const lastActivity = new Map<string, number>();

  const noteActivity = (ticketKey: string | null, at: Instant | null): void => {
    if (ticketKey === null || at === null || at > instant) return;
    const known = lastActivity.get(ticketKey);
    if (known === undefined || at > known) lastActivity.set(ticketKey, at);
  };

  for (const commit of scopedCommits(snapshot, scope)) {
    noteActivity(textField(commit, 'ticketKey'), instantField(commit, 'authoredAt'));
  }
  for (const pullRequest of scopedPullRequests(snapshot, scope)) {
    for (const ticketKey of textListField(pullRequest, 'linkedItemKeys')) {
      noteActivity(ticketKey, instantField(pullRequest, 'createdAt'));
      noteActivity(ticketKey, instantField(pullRequest, 'mergedAt'));
      noteActivity(ticketKey, instantField(pullRequest, 'closedAt'));
    }
  }

  const inProgress = scopedTickets(snapshot, scope).filter((ticket) => isInFlight(ticket));
  const stale: StaleTicket[] = [];

  for (const ticket of inProgress) {
    const key = ticketKeyOf(ticket);
    const history = transitions.get(key) ?? [];
    // The moment it entered the status it is in now: the last transition into a
    // category that is neither done nor waiting to start.
    const enteredAt = [...history]
      .sort((left, right) => compareNumbers(left.transitionedAt, right.transitionedAt))
      .filter(
        (transition) =>
          transition.transitionedAt <= instant &&
          transition.toStatusCategory !== DONE_STATUS_CATEGORY &&
          transition.toStatusCategory !== TODO_STATUS_CATEGORY,
      )
      .map((transition) => transition.transitionedAt as Instant)
      .pop();
    if (enteredAt === undefined) continue;

    const dwellWorkingDays = workingDaysBetween(enteredAt, instant);
    if (dwellWorkingDays < THRESHOLDS.T23.value) continue;

    const activityAt = lastActivity.get(key) ?? null;
    const sinceActivity = activityAt === null ? null : workingDaysBetween(activityAt as Instant, instant);
    if (sinceActivity !== null && sinceActivity < THRESHOLDS.T23.value) continue;

    stale.push({
      ticketKey: key,
      status: textField(ticket, 'status') ?? '',
      inProgressWorkingDays: dwellWorkingDays,
      workingDaysSinceActivity: sinceActivity,
    });
  }

  stale.sort(
    (left, right) =>
      compareNumbers(right.inProgressWorkingDays, left.inProgressWorkingDays) ||
      compareStable(left.ticketKey, right.ticketKey),
  );

  const incidence = basisPoints(stale.length, inProgress.length);

  return {
    statistic: 'stale_status_incidence',
    inProgressTickets: inProgress.length,
    staleTickets: stale.length,
    incidenceBasisPoints: incidence,
    stale,
    staleTicketKeys: stale.map((entry) => entry.ticketKey).sort(compareStable),
    dwellThreshold: thresholdRef('T23'),
    incidenceThreshold: thresholdRef('T24'),
    statement:
      inProgress.length === 0
        ? 'Nothing is in an in-progress status, so no status can be stale.'
        : stale.length === 0
          ? `All ${inProgress.length} in-progress items have moved or been pushed to inside the last ${THRESHOLDS.T23.value} working days.`
          : `${stale.length} of ${inProgress.length} in-progress items — ${share(incidence)} — have sat still for ${THRESHOLDS.T23.value} working days or more with no commit and no pull request: ${stale.map((entry) => entry.ticketKey).join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Runs all seven statistics and maps them onto the closed verdict set.
 *
 * Pure and total. Nothing here reads a clock, and the verdicts come out in the
 * fixed order `PROCESS_VERDICTS` declares, so two runs over one snapshot produce
 * byte-identical output.
 */
export function auditProcessCalibration(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): CalibrationAudit {
  const statistics: CalibrationStatistics = {
    pointToElapsed: pointToElapsedCorrelation(snapshot, instant, scope),
    estimateCoverage: estimateCoverage(snapshot, instant, scope),
    carryover: carryoverRate(snapshot, instant, scope),
    statusDwell: statusDwellConsistency(snapshot, instant, scope),
    scopeChurn: scopeChurn(snapshot, instant, scope),
    subTaskDoubleCount: subTaskDoubleCount(snapshot, instant, scope),
    staleStatus: staleStatusIncidence(snapshot, instant, scope),
  };

  const sprints = completedSprints(scopedSprints(snapshot, scope), instant);
  const sprintIndex = new Map(scopedSprints(snapshot, scope).map((sprint) => [sprint.naturalKey, sprint]));
  const ticketIndex = new Map(scopedTickets(snapshot, scope).map((ticket) => [ticketKeyOf(ticket), ticket]));

  const ticketRefs = (keys: readonly string[]): readonly EvidenceRef[] =>
    orderedEvidence(
      keys
        .map((key) => ticketIndex.get(key))
        .filter((ticket): ticket is AnalysisEntity => ticket !== undefined)
        .map(ticketEvidence),
    ).slice(0, MAX_VERDICT_EVIDENCE);

  const sprintRefs = (keys: readonly string[]): readonly EvidenceRef[] =>
    orderedEvidence(
      keys
        .map((key) => sprintIndex.get(key))
        .filter((sprint): sprint is AnalysisEntity => sprint !== undefined)
        .map(sprintEvidence),
    ).slice(0, MAX_VERDICT_EVIDENCE);

  const verdicts: ProcessVerdict[] = [];

  // `insufficient_history` first, so the suppression below is decided before any
  // trailing-sprint verdict has been built rather than filtered out afterwards.
  const enoughHistory = sprints.length >= THRESHOLDS.T7.value;
  const suppressed: ProcessVerdictName[] = enoughHistory
    ? []
    : PROCESS_VERDICTS.filter((name) => PROCESS_VERDICT_RULES[name].needsTrailingSprints);

  const correlation = statistics.pointToElapsed;
  if (
    correlation.sampleSize >= THRESHOLDS.T13.value &&
    (correlation.absoluteCoefficientBasisPoints === null ||
      correlation.absoluteCoefficientBasisPoints < THRESHOLDS.T12.value)
  ) {
    verdicts.push({
      name: 'points_uninformative',
      statistic: PROCESS_VERDICT_RULES.points_uninformative.statistic,
      value: correlation.absoluteCoefficientBasisPoints ?? 0,
      valueUnit: 'basis_points',
      sampleSize: correlation.sampleSize,
      threshold: thresholdRef('T12'),
      supportingThresholds: [thresholdRef('T13')],
      subjects: correlation.ticketKeys,
      statement: `${correlation.statement} T12 needs ${decimal(THRESHOLDS.T12.value)}, so your points are not telling you how long work takes and any date below is a cycle-time guess.`,
      evidence: ticketRefs(correlation.ticketKeys),
    });
  }

  const coverage = statistics.estimateCoverage;
  if (coverage.totalTickets > 0 && coverage.coverageBasisPoints < THRESHOLDS.T18.value) {
    verdicts.push({
      name: 'estimates_sparse',
      statistic: PROCESS_VERDICT_RULES.estimates_sparse.statistic,
      value: coverage.coverageBasisPoints,
      valueUnit: 'basis_points',
      sampleSize: coverage.totalTickets,
      threshold: thresholdRef('T18'),
      supportingThresholds: [],
      subjects: coverage.unestimatedTicketKeys,
      statement: `${coverage.statement} Below T18 a points-based projection rests on a minority of the work, so Compass measures this team in items.`,
      evidence: ticketRefs(coverage.unestimatedTicketKeys),
    });
  }

  if (!suppressed.includes('scope_is_fiction')) {
    const carryover = statistics.carryover;
    const churn = statistics.scopeChurn;
    const carryoverBreach = carryover.breachedSprintCount >= THRESHOLDS.T20.value;
    const churnBreach = churn.breachedSprintKeys.length > 0;

    if (carryoverBreach || churnBreach) {
      verdicts.push({
        name: 'scope_is_fiction',
        statistic: PROCESS_VERDICT_RULES.scope_is_fiction.statistic,
        value: carryoverBreach ? carryover.breachedSprintCount : churn.worstChurnBasisPoints,
        valueUnit: carryoverBreach ? 'count' : 'basis_points',
        sampleSize: carryoverBreach ? carryover.perSprint.length : churn.perSprint.length,
        threshold: carryoverBreach ? thresholdRef('T20') : thresholdRef('T21'),
        supportingThresholds: carryoverBreach ? [thresholdRef('T19')] : [],
        subjects: carryoverBreach
          ? carryover.perSprint.filter((row) => row.breachedThreshold).map((row) => row.sprintKey)
          : churn.breachedSprintKeys,
        statement: carryoverBreach
          ? `${carryover.statement} T20 fires at ${THRESHOLDS.T20.value} breached sprints out of the trailing ${CALIBRATION_TRAILING_SPRINTS}, so what this team commits to at the start of a sprint is not what it works on.`
          : `${churn.statement} A commitment that is rewritten this much mid-sprint is a plan the burn-down cannot describe.`,
        evidence: sprintRefs(
          carryoverBreach
            ? carryover.perSprint.filter((row) => row.breachedThreshold).map((row) => row.sprintKey)
            : churn.breachedSprintKeys,
        ),
      });
    }
  }

  if (!suppressed.includes('workflow_inconsistent')) {
    const dwell = statistics.statusDwell;
    const worst = [...dwell.perStatus]
      .filter((row) => row.inconsistent)
      .sort(
        (left, right) =>
          compareNumbers(right.spreadOverMedianBasisPoints, left.spreadOverMedianBasisPoints) ||
          compareStable(left.status, right.status),
      )[0];

    if (worst !== undefined) {
      verdicts.push({
        name: 'workflow_inconsistent',
        statistic: PROCESS_VERDICT_RULES.workflow_inconsistent.statistic,
        value: worst.spreadOverMedianBasisPoints,
        valueUnit: 'basis_points',
        sampleSize: worst.sampleSize,
        threshold: thresholdRef('T22'),
        supportingThresholds: [thresholdRef('T13')],
        subjects: dwell.inconsistentStatuses,
        statement: `${dwell.statement} \`${worst.status}\` spans ${worst.spread.minimum} to ${worst.spread.maximum} hours across ${worst.sampleSize} observations against a median of ${worst.spread.median}, which is ${decimal(worst.spreadOverMedianBasisPoints)} times that median where T22 fires at ${decimal(THRESHOLDS.T22.value)}.`,
        evidence: ticketRefs(worst.ticketKeys),
      });
    }
  }

  const staleStatus = statistics.staleStatus;
  if (staleStatus.inProgressTickets > 0 && staleStatus.incidenceBasisPoints >= THRESHOLDS.T24.value) {
    verdicts.push({
      name: 'statuses_stale',
      statistic: PROCESS_VERDICT_RULES.statuses_stale.statistic,
      value: staleStatus.incidenceBasisPoints,
      valueUnit: 'basis_points',
      sampleSize: staleStatus.inProgressTickets,
      threshold: thresholdRef('T24'),
      supportingThresholds: [thresholdRef('T23')],
      subjects: staleStatus.staleTicketKeys,
      statement: `${staleStatus.statement} T24 fires at ${share(THRESHOLDS.T24.value)}, so the board is not describing where the work actually is.`,
      evidence: ticketRefs(staleStatus.staleTicketKeys),
    });
  }

  if (!enoughHistory) {
    verdicts.push({
      name: 'insufficient_history',
      statistic: PROCESS_VERDICT_RULES.insufficient_history.statistic,
      value: sprints.length,
      valueUnit: 'sample_size',
      sampleSize: sprints.length,
      threshold: thresholdRef('T7'),
      supportingThresholds: [],
      subjects: sprints.map((sprint) => sprint.naturalKey),
      statement: `${sprints.length === 0 ? 'No sprint has completed' : `Only ${sprints.length} sprint has completed`}, and T7 needs ${THRESHOLDS.T7.value} before Compass will judge this team's process or project a date. ${
        suppressed.length === 0
          ? ''
          : `It is therefore withholding ${suppressed.join(' and ')}, which cannot be measured without trailing sprints.`
      }`.trim(),
      evidence: sprintRefs(sprints.map((sprint) => sprint.naturalKey)),
    });
  }

  const ordered = PROCESS_VERDICTS.flatMap((name) => verdicts.filter((verdict) => verdict.name === name));

  return {
    completedSprintCount: sprints.length,
    trailingSprints: CALIBRATION_TRAILING_SPRINTS,
    statistics,
    verdicts: ordered,
    verdictNames: ordered.map((verdict) => verdict.name),
    suppressed,
    statement: auditStatement(ordered, suppressed),
  };
}

/** Evidence markers on one statistical verdict: enough to check, few enough to read. */
const MAX_VERDICT_EVIDENCE = 5;

function auditStatement(
  verdicts: readonly ProcessVerdict[],
  suppressed: readonly ProcessVerdictName[],
): string {
  if (verdicts.length === 0) {
    return 'Compass audited this team’s estimates, sprint scope, workflow statuses and board hygiene, and found nothing that would stop you trusting the numbers above.';
  }
  const names = verdicts.map((verdict) => verdict.name).join(', ');
  const withheld =
    suppressed.length === 0 ? '' : ` It is withholding ${suppressed.join(' and ')} for want of trailing sprints.`;
  return `Compass audited the data behind this report and reached ${verdicts.length} ${verdicts.length === 1 ? 'verdict' : 'verdicts'}: ${names}.${withheld}`;
}

/** Whether a named verdict is active in an audit. The one lookup callers need. */
export const hasProcessVerdict = (audit: CalibrationAudit, name: ProcessVerdictName): boolean =>
  audit.verdictNames.includes(name);

/** The empty audit — the honest shape before anything has been ingested. */
export function emptyCalibrationAudit(): CalibrationAudit {
  const spread = emptySpread('working_days');
  return {
    completedSprintCount: 0,
    trailingSprints: CALIBRATION_TRAILING_SPRINTS,
    statistics: {
      pointToElapsed: {
        statistic: 'point_to_elapsed_working_days',
        sampleSize: 0,
        coefficientBasisPoints: null,
        absoluteCoefficientBasisPoints: null,
        spread: { elapsedWorkingDays: spread, estimatePoints: emptySpread('story_points') },
        ticketKeys: [],
        samples: [],
        sampleThreshold: thresholdRef('T13'),
        coefficientThreshold: thresholdRef('T12'),
        statement:
          'Nothing has been completed with both an estimate and a measurable duration, so there is nothing to calibrate against.',
      },
      estimateCoverage: {
        statistic: 'estimate_coverage',
        trailingDays: ESTIMATE_COVERAGE_TRAILING_DAYS,
        window: { start: 0 as Instant, end: 0 as Instant },
        estimatedTickets: 0,
        totalTickets: 0,
        coverageBasisPoints: 0,
        unestimatedTicketKeys: [],
        threshold: thresholdRef('T18'),
        statement: 'No work item has been ingested, so there is no estimating discipline to measure.',
      },
      carryover: {
        statistic: 'carryover_rate',
        trailingSprints: CALIBRATION_TRAILING_SPRINTS,
        perSprint: [],
        meanRateBasisPoints: 0,
        breachedSprintCount: 0,
        rateThreshold: thresholdRef('T19'),
        breachCountThreshold: thresholdRef('T20'),
        statement: 'No sprint has completed, so there is no carryover rate.',
      },
      statusDwell: {
        statistic: 'status_dwell_consistency',
        trailingSprints: CALIBRATION_TRAILING_SPRINTS,
        perStatus: [],
        inconsistentStatuses: [],
        sampleThreshold: thresholdRef('T13'),
        spreadThreshold: thresholdRef('T22'),
        statement: 'No status has been entered and left, so there is no dwell time to compare.',
      },
      scopeChurn: {
        statistic: 'scope_churn',
        perSprint: [],
        worstChurnBasisPoints: 0,
        breachedSprintKeys: [],
        threshold: thresholdRef('T21'),
        statement: 'No sprint has a committed baseline to measure churn against.',
      },
      subTaskDoubleCount: {
        statistic: 'sub_task_double_count',
        parentTickets: 0,
        doubleCountedParents: 0,
        shareBasisPoints: 0,
        doubleCountedParentKeys: [],
        statement: 'No work item in scope has sub-tasks, so no points total can be double-counting one.',
      },
      staleStatus: {
        statistic: 'stale_status_incidence',
        inProgressTickets: 0,
        staleTickets: 0,
        incidenceBasisPoints: 0,
        stale: [],
        staleTicketKeys: [],
        dwellThreshold: thresholdRef('T23'),
        incidenceThreshold: thresholdRef('T24'),
        statement: 'Nothing is in an in-progress status, so no status can be stale.',
      },
    },
    verdicts: [],
    verdictNames: [],
    suppressed: [],
    statement:
      'Nothing has been ingested for this team yet, so Compass has no data to audit and will not pretend the absence is a clean bill of health.',
  };
}
