import { orderedEvidence, sprintEvidence, type EvidenceRef } from './evidence.js';
import {
  basisPoints,
  compareNumbers,
  compareStable,
  medianOf,
  percent,
  percentileOf,
  trailingDays,
  wholeDaysBetween,
  windowContains,
  windowDays,
  type Instant,
  type TimeWindow,
} from './instant.js';
import {
  DONE_STATUS_CATEGORY,
  instantField,
  isDone,
  isInFlight,
  numberField,
  scopedSprints,
  scopedTickets,
  textField,
  textListField,
  transitionsByTicket,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';

/**
 * Progress: sprint math, trailing velocity, and the Kanban alternative.
 *
 * Two rules govern this whole file.
 *
 * **Every number must reconcile line by line.** A manager who disagrees with
 * "62% complete" must be able to see the exact ticket keys behind the numerator
 * and the denominator and check them against their board. So each figure travels
 * with its contributing keys, and `reconciliation` lists every in-scope item once
 * with the line it was counted on. A total that cannot be walked back to keys is
 * a number nobody can argue with, and a number nobody can argue with is a number
 * nobody should trust.
 *
 * **A shape that does not apply is absent, not zero.** A Kanban team has no
 * completion percentage, no story points and no sprint goal — so `KanbanFlow`
 * does not *have* those properties. Modelling them as `null` would put them in
 * the canonical JSON, hand the renderers something to print, and turn "this team
 * does not work this way" into "this team scored zero". The discriminated unions
 * below are load-bearing, and `tests/progress.test.ts` walks the emitted object
 * asserting the forbidden keys are genuinely missing.
 */

/** How many completed sprints trailing velocity looks back over. */
export const VELOCITY_TRAILING_SPRINTS = 5;

/** The trailing span cycle time is sampled from, for a Kanban team. */
export const CYCLE_TIME_TRAILING_DAYS = 28;

/** One line of a completion table: a total, and the keys that make it up. */
export interface ScopeLine {
  readonly tickets: number;
  readonly points: number;
  readonly ticketKeys: readonly string[];
}

/** One row of the reconciliation table, so every item is accounted for once. */
export interface ReconciliationRow {
  readonly ticketKey: string;
  readonly title: string;
  readonly status: string;
  readonly statusCategory: string;
  readonly points: number | null;
  /** Which completion line this item was counted on. */
  readonly countedIn: 'completed' | 'remaining';
  /** True when the item entered the sprint after it had already started. */
  readonly addedMidSprint: boolean;
}

export type CompletionBasis = 'story_points' | 'ticket_count';

export interface SprintCompletion {
  readonly sprintKey: string;
  readonly sprintName: string;
  readonly goal: string | null;
  readonly state: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly completedAt: number | null;
  /** Working days between the sprint's start and the report instant. */
  readonly elapsedWorkingDays: number;

  /** The scope as it stood when the sprint started. */
  readonly committed: ScopeLine;
  /** Items that entered after the start — scope creep, stated separately. */
  readonly addedMidSprint: ScopeLine;
  /** `committed` plus `addedMidSprint`: what the team is actually carrying. */
  readonly currentScope: ScopeLine;
  readonly completed: ScopeLine;
  readonly remaining: ScopeLine;

  readonly basis: CompletionBasis;
  readonly basisThreshold: ThresholdRef;
  /** Items with no estimate, named — the reason a basis was chosen. */
  readonly unestimatedTicketKeys: readonly string[];

  /**
   * Percent of what the team is carrying now. Scope creep therefore shows up as
   * a *larger denominator*, not as a mysteriously slower burn.
   */
  readonly completionPercent: number;
  /**
   * Percent of the original commitment. Emitted alongside so the two can differ
   * visibly — that difference is the whole story when scope was added.
   */
  readonly completionPercentOfCommitment: number;

  readonly reconciliation: readonly ReconciliationRow[];
  readonly evidence: readonly EvidenceRef[];
}

/** Per-sprint velocity, in whatever unit the sprint could actually be measured in. */
export interface VelocitySample {
  readonly sprintKey: string;
  readonly sprintName: string;
  readonly completedAt: number;
  readonly points: number;
  readonly tickets: number;
  readonly ticketKeys: readonly string[];
}

export type VelocityTrend = 'rising' | 'flat' | 'falling';

/**
 * Velocity, or a stated refusal to compute one.
 *
 * The `undefined` arm carries no `points`, no `mean` and no `trend` — not zero,
 * not null. A team on its first sprint has no velocity; printing `0` would be a
 * claim about their pace, and printing `null` would invite a renderer to format
 * it as one.
 */
export type VelocityAssessment =
  | {
      readonly kind: 'measured';
      readonly basis: CompletionBasis;
      readonly samples: readonly VelocitySample[];
      readonly meanPoints: number;
      readonly medianPoints: number;
      readonly meanTickets: number;
      readonly trend: VelocityTrend;
      /** Change from the first half of the window to the second, in basis points. */
      readonly trendBasisPoints: number;
      readonly statement: string;
    }
  | {
      readonly kind: 'undefined';
      readonly reason: 'insufficient_history';
      readonly completedSprintsFound: number;
      readonly threshold: ThresholdRef;
      readonly statement: string;
    };

/** Flow metrics for a team that does not run sprints. Never a percentage. */
export interface KanbanFlow {
  readonly windowDays: number;
  readonly throughput: {
    readonly completedItems: number;
    readonly ticketKeys: readonly string[];
  };
  readonly workInProgress: {
    readonly items: number;
    readonly ticketKeys: readonly string[];
  };
  readonly cycleTime:
    | {
        readonly kind: 'measured';
        readonly sampleSize: number;
        readonly medianDays: number;
        readonly p85Days: number;
        readonly trailingDays: number;
        readonly ticketKeys: readonly string[];
      }
    | {
        readonly kind: 'undefined';
        readonly reason: 'no_completed_items';
        readonly trailingDays: number;
        readonly statement: string;
      };
  readonly statement: string;
}

/**
 * The Progress section's payload.
 *
 * `mode` is what a renderer switches on. There is no fourth mode where numbers
 * are made up: a team with no board at all gets `no_signal` and a sentence
 * naming what is missing.
 */
export type ProgressAssessment =
  | {
      readonly mode: 'sprint';
      readonly sprint: SprintCompletion;
      readonly velocity: VelocityAssessment;
    }
  | {
      readonly mode: 'kanban';
      readonly flow: KanbanFlow;
      /** Why sprint semantics were not used. Always stated, never implied. */
      readonly reason: 'no_sprints_observed';
      readonly statement: string;
    }
  | {
      readonly mode: 'no_signal';
      readonly reason: 'no_work_items' | 'no_project_in_scope';
      readonly statement: string;
    };

const EMPTY_LINE: ScopeLine = { tickets: 0, points: 0, ticketKeys: [] };

const scopeLine = (tickets: readonly AnalysisEntity[]): ScopeLine => ({
  tickets: tickets.length,
  points: tickets.reduce((sum, ticket) => sum + (numberField(ticket, 'estimatePoints') ?? 0), 0),
  ticketKeys: tickets.map(ticketKeyOf).sort(compareStable),
});

const ticketKeyOf = (ticket: AnalysisEntity): string => textField(ticket, 'itemKey') ?? ticket.naturalKey;

/**
 * Computes the Progress section.
 *
 * `instant` is a parameter, as it is on every exported analysis function: "how
 * many working days into the sprint" is a question about a moment, and reading
 * that moment from the host clock would make yesterday's report change overnight.
 */
export function assessProgress(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): ProgressAssessment {
  const tickets = scopedTickets(snapshot, scope);
  const sprints = scopedSprints(snapshot, scope);

  if (scope.kind === 'team' && scope.projectKeys.length === 0) {
    return {
      mode: 'no_signal',
      reason: 'no_project_in_scope',
      statement:
        scope.teamKey === null
          ? 'This report has no team scope, so no board could be resolved.'
          : `No project is linked to \`${scope.teamKey}\`, so Compass cannot tell which board to read.`,
    };
  }

  if (tickets.length === 0) {
    return {
      mode: 'no_signal',
      reason: 'no_work_items',
      statement: 'No work items have been ingested for this team, so there is no progress to report.',
    };
  }

  // Kanban is not a configuration flag: it is the absence of sprint rows. A team
  // that declares itself Scrum and has no sprints still gets flow semantics,
  // because flow is what the data can actually support.
  if (sprints.length === 0) {
    const flow = assessKanbanFlow(snapshot, instant, tickets);
    return {
      mode: 'kanban',
      flow,
      reason: 'no_sprints_observed',
      statement:
        'This team runs no sprints, so this section reports flow — throughput, work in progress and cycle time. There is no completion percentage, no story-point total and no sprint goal to report, and Compass will not invent one.',
    };
  }

  const current = currentSprint(sprints, instant);
  if (current === null) {
    const flow = assessKanbanFlow(snapshot, instant, tickets);
    return {
      mode: 'kanban',
      flow,
      reason: 'no_sprints_observed',
      statement:
        'No sprint covers this report window, so this section reports flow instead. Compass would rather measure what is happening than score the team against a sprint that had already closed.',
    };
  }

  return {
    mode: 'sprint',
    sprint: computeSprintCompletion(snapshot, instant, current, tickets),
    velocity: assessVelocity(snapshot, instant, scope),
  };
}

/**
 * The sprint a report is about.
 *
 * The one containing `instant`, preferring the latest start when sprints overlap
 * — an overlap is a tracker artefact, and the newer sprint is the one the team is
 * standing in. Falling back to the most recently completed sprint would report
 * on closed work as if it were live, so it deliberately does not.
 */
export function currentSprint(sprints: readonly AnalysisEntity[], instant: Instant): AnalysisEntity | null {
  const containing = sprints
    .map((sprint) => ({ sprint, startAt: instantField(sprint, 'startAt'), endAt: instantField(sprint, 'endAt') }))
    .filter(
      (entry): entry is { sprint: AnalysisEntity; startAt: Instant; endAt: Instant } =>
        entry.startAt !== null && entry.endAt !== null && instant >= entry.startAt && instant < entry.endAt,
    )
    .sort((left, right) => compareNumbers(right.startAt, left.startAt) || compareStable(left.sprint.naturalKey, right.sprint.naturalKey));

  return containing[0]?.sprint ?? null;
}

/** Completed sprints, oldest first: `completedAt` is set and already in the past. */
export function completedSprints(sprints: readonly AnalysisEntity[], instant: Instant): readonly AnalysisEntity[] {
  return sprints
    .map((sprint) => ({ sprint, completedAt: instantField(sprint, 'completedAt') }))
    .filter(
      (entry): entry is { sprint: AnalysisEntity; completedAt: Instant } =>
        entry.completedAt !== null && entry.completedAt <= instant,
    )
    .sort((left, right) => compareNumbers(left.completedAt, right.completedAt) || compareStable(left.sprint.naturalKey, right.sprint.naturalKey))
    .map((entry) => entry.sprint);
}

function computeSprintCompletion(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  sprint: AnalysisEntity,
  tickets: readonly AnalysisEntity[],
): SprintCompletion {
  const startAt = instantField(sprint, 'startAt') ?? (0 as Instant);
  const endAt = instantField(sprint, 'endAt') ?? instant;

  // Items the tracker says are on this sprint, from both directions: the sprint's
  // own committed list and each ticket's `sprintKey`. Either may be the one the
  // provider actually fills in.
  const declared = new Set(textListField(sprint, 'committedItemKeys'));
  const inSprint = tickets.filter(
    (ticket) => textField(ticket, 'sprintKey') === sprint.naturalKey || declared.has(ticketKeyOf(ticket)),
  );

  const addedAfterStart = new Set(
    snapshot.collections.sprintScopeChanges
      .filter((change) => change.sprintKey === sprint.naturalKey && change.change === 'added' && change.afterSprintStart)
      .map((change) => change.ticketKey),
  );

  const addedMidSprint = inSprint.filter((ticket) => addedAfterStart.has(ticketKeyOf(ticket)));
  const committed = inSprint.filter((ticket) => !addedAfterStart.has(ticketKeyOf(ticket)));
  const completed = inSprint.filter((ticket) => isDone(ticket));
  const remaining = inSprint.filter((ticket) => !isDone(ticket));

  const unestimated = inSprint.filter((ticket) => numberField(ticket, 'estimatePoints') === null);
  const estimatedCoverage = basisPoints(inSprint.length - unestimated.length, inSprint.length);
  const basis: CompletionBasis = estimatedCoverage >= THRESHOLDS.T15.value ? 'story_points' : 'ticket_count';

  const currentScope = scopeLine(inSprint);
  const committedLine = scopeLine(committed);
  const completedLine = scopeLine(completed);

  const numerator = basis === 'story_points' ? completedLine.points : completedLine.tickets;
  const currentDenominator = basis === 'story_points' ? currentScope.points : currentScope.tickets;
  const committedDenominator = basis === 'story_points' ? committedLine.points : committedLine.tickets;

  const reconciliation: readonly ReconciliationRow[] = [...inSprint]
    .sort((left, right) => compareStable(ticketKeyOf(left), ticketKeyOf(right)))
    .map((ticket) => ({
      ticketKey: ticketKeyOf(ticket),
      title: textField(ticket, 'title') ?? '',
      status: textField(ticket, 'status') ?? '',
      statusCategory: textField(ticket, 'statusCategory') ?? '',
      points: numberField(ticket, 'estimatePoints'),
      countedIn: isDone(ticket) ? ('completed' as const) : ('remaining' as const),
      addedMidSprint: addedAfterStart.has(ticketKeyOf(ticket)),
    }));

  return {
    sprintKey: sprint.naturalKey,
    sprintName: textField(sprint, 'name') ?? sprint.naturalKey,
    goal: textField(sprint, 'goal'),
    state: textField(sprint, 'state') ?? 'unknown',
    startAt,
    endAt,
    completedAt: instantField(sprint, 'completedAt'),
    elapsedWorkingDays: wholeDaysBetween(startAt, instant),
    committed: committedLine,
    addedMidSprint: scopeLine(addedMidSprint),
    currentScope,
    completed: completedLine,
    remaining: scopeLine(remaining),
    basis,
    basisThreshold: thresholdRef('T15'),
    unestimatedTicketKeys: unestimated.map(ticketKeyOf).sort(compareStable),
    completionPercent: percent(numerator, currentDenominator),
    completionPercentOfCommitment: percent(numerator, committedDenominator),
    reconciliation,
    evidence: orderedEvidence([sprintEvidence(sprint)]),
  };
}

/**
 * Trailing velocity, or `insufficient_history`.
 *
 * The refusal is the point. Two completed sprints is already a thin basis for a
 * pace claim, and one is none — so below `T7` this returns the `undefined` arm,
 * which has no number in it at all for a renderer to reach for.
 */
export function assessVelocity(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): VelocityAssessment {
  const sprints = completedSprints(scopedSprints(snapshot, scope), instant);
  const tickets = scopedTickets(snapshot, scope);

  if (sprints.length < THRESHOLDS.T7.value) {
    return {
      kind: 'undefined',
      reason: 'insufficient_history',
      completedSprintsFound: sprints.length,
      threshold: thresholdRef('T7'),
      statement:
        sprints.length === 0
          ? 'No sprint has completed yet, so Compass has no velocity, no trend and no projection to give you — only the work in front of you.'
          : `Only ${sprints.length} sprint has completed, and a pace needs at least ${THRESHOLDS.T7.value}. Compass will state a velocity once there is history behind it.`,
    };
  }

  const considered = sprints.slice(-VELOCITY_TRAILING_SPRINTS);
  const samples: readonly VelocitySample[] = considered.map((sprint) => {
    const declared = new Set(textListField(sprint, 'committedItemKeys'));
    const done = tickets.filter(
      (ticket) =>
        isDone(ticket) && (textField(ticket, 'sprintKey') === sprint.naturalKey || declared.has(ticketKeyOf(ticket))),
    );
    return {
      sprintKey: sprint.naturalKey,
      sprintName: textField(sprint, 'name') ?? sprint.naturalKey,
      completedAt: instantField(sprint, 'completedAt') ?? instant,
      points: done.reduce((sum, ticket) => sum + (numberField(ticket, 'estimatePoints') ?? 0), 0),
      tickets: done.length,
      ticketKeys: done.map(ticketKeyOf).sort(compareStable),
    };
  });

  const totalPoints = samples.reduce((sum, sample) => sum + sample.points, 0);
  const basis: CompletionBasis = totalPoints > 0 ? 'story_points' : 'ticket_count';
  const series = samples.map((sample) => (basis === 'story_points' ? sample.points : sample.tickets));

  // Trend compares the mean of the older half against the newer half. A
  // first-to-last comparison would let one unusual sprint decide the verdict.
  const split = Math.floor(series.length / 2);
  const older = series.slice(0, split === 0 ? 1 : split);
  const newer = series.slice(split === 0 ? 1 : split);
  const olderMean = older.reduce((sum, value) => sum + value, 0) / Math.max(1, older.length);
  const newerMean = newer.reduce((sum, value) => sum + value, 0) / Math.max(1, newer.length);
  const trendBasisPointsValue = olderMean === 0 ? 0 : basisPoints(newerMean - olderMean, olderMean);
  const trend: VelocityTrend =
    trendBasisPointsValue >= 1_000 ? 'rising' : trendBasisPointsValue <= -1_000 ? 'falling' : 'flat';

  const unit = basis === 'story_points' ? 'points' : 'items';
  const meanPoints = Math.round((totalPoints / samples.length) * 10) / 10;
  const meanTickets = Math.round((samples.reduce((sum, sample) => sum + sample.tickets, 0) / samples.length) * 10) / 10;

  return {
    kind: 'measured',
    basis,
    samples,
    meanPoints,
    medianPoints: medianOf(samples.map((sample) => sample.points)) ?? 0,
    meanTickets,
    trend,
    trendBasisPoints: trendBasisPointsValue,
    statement: `Over the last ${samples.length} completed sprints the team finished a mean of ${
      basis === 'story_points' ? meanPoints : meanTickets
    } ${unit} per sprint, and that pace is ${trend}.`,
  };
}

/**
 * Flow metrics for a team without sprints.
 *
 * Contains no completion percentage, no story-point total and no sprint goal —
 * by construction, not by filtering. Throughput is what left the board in the
 * report window; cycle time is sampled over a trailing span because a single
 * day rarely contains enough completions to say anything.
 */
export function assessKanbanFlow(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  tickets: readonly AnalysisEntity[],
): KanbanFlow {
  const window = snapshot.window;
  const byTicket = transitionsByTicket(snapshot);
  const inScope = new Set(tickets.map(ticketKeyOf));

  const completedInWindow: string[] = [];
  const cycleSamples: { ticketKey: string; days: number }[] = [];
  const trailingStart = trailingDays(instant, CYCLE_TIME_TRAILING_DAYS).start;

  for (const ticket of tickets) {
    const key = ticketKeyOf(ticket);
    const transitions = byTicket.get(key) ?? [];

    const doneTransition = transitions.find(
      (transition) =>
        transition.toStatusCategory === DONE_STATUS_CATEGORY &&
        transition.fromStatusCategory !== DONE_STATUS_CATEGORY &&
        windowContains(window, transition.transitionedAt as Instant),
    );
    if (doneTransition !== undefined) completedInWindow.push(key);

    // Cycle time is measured from the first move out of the backlog to the last
    // move into done — start to finish as the board actually saw it, not from
    // creation, which would count time nobody was working.
    const startedAt = transitions.find((transition) => transition.toStatusCategory === 'in_progress')?.transitionedAt;
    const finishedAt = [...transitions]
      .reverse()
      .find((transition) => transition.toStatusCategory === DONE_STATUS_CATEGORY)?.transitionedAt;
    if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) continue;
    if (finishedAt < trailingStart || finishedAt > instant) continue;
    cycleSamples.push({ ticketKey: key, days: wholeDaysBetween(startedAt as Instant, finishedAt as Instant) });
  }

  const inFlight = tickets.filter((ticket) => isInFlight(ticket));
  const days = cycleSamples.map((sample) => sample.days);
  const span = Math.max(1, Math.round(windowDays(window)));

  const cycleTime: KanbanFlow['cycleTime'] =
    cycleSamples.length === 0
      ? {
          kind: 'undefined',
          reason: 'no_completed_items',
          trailingDays: CYCLE_TIME_TRAILING_DAYS,
          statement: `Nothing finished in the last ${CYCLE_TIME_TRAILING_DAYS} days, so there is no cycle time to report.`,
        }
      : {
          kind: 'measured',
          sampleSize: cycleSamples.length,
          medianDays: medianOf(days) ?? 0,
          p85Days: percentileOf(days, 0.85) ?? 0,
          trailingDays: CYCLE_TIME_TRAILING_DAYS,
          ticketKeys: cycleSamples.map((sample) => sample.ticketKey).sort(compareStable),
        };

  const throughputKeys = [...new Set(completedInWindow)].filter((key) => inScope.has(key)).sort(compareStable);

  return {
    windowDays: span,
    throughput: { completedItems: throughputKeys.length, ticketKeys: throughputKeys },
    workInProgress: { items: inFlight.length, ticketKeys: inFlight.map(ticketKeyOf).sort(compareStable) },
    cycleTime,
    statement:
      cycleTime.kind === 'measured'
        ? `${throughputKeys.length} item${throughputKeys.length === 1 ? '' : 's'} finished in this window, ${inFlight.length} are in flight, and the median item has been taking ${cycleTime.medianDays} days from start to finish.`
        : `${throughputKeys.length} item${throughputKeys.length === 1 ? '' : 's'} finished in this window and ${inFlight.length} are in flight.`,
  };
}

/** The empty progress payload — the honest shape before anything is ingested. */
export function noProgressSignal(): ProgressAssessment {
  return {
    mode: 'no_signal',
    reason: 'no_work_items',
    statement: 'No sprint or flow progress could be computed for this window.',
  };
}

/** Re-exported so callers do not have to reach for the raw scope line shape. */
export const emptyScopeLine = (): ScopeLine => EMPTY_LINE;

/** The report window, restated for the modules that only need the span. */
export const reportWindowOf = (snapshot: AnalysisSnapshot): TimeWindow => snapshot.window;
