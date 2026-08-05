import { orderedEvidence, sprintEvidence, ticketEvidence, type EvidenceRef } from './evidence.js';
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

/**
 * How a team's configured cadence spells Kanban.
 *
 * A pattern rather than an equality test because `methodology` is a free-text tracked
 * field on the team row — the roster screen writes `kanban`, and a connector or an
 * imported roster may well write `Kanban` or `kanban (flow)`. Matching loosely is right
 * for reading configuration somebody else wrote; the report's own vocabulary stays
 * exact.
 */
export const KANBAN_METHODOLOGY = /kanban/i;

/** The trailing span cycle time is sampled from, for a Kanban team. */
export const CYCLE_TIME_TRAILING_DAYS = 28;

/**
 * The percentile the aging rule is measured against.
 *
 * P85 rather than a configured number of days, because "too long" is a fact about
 * *this* team's own distribution: a five-day item is aging on a board whose P85 is
 * three days and unremarkable on one whose P85 is nine. A fixed threshold would be
 * Compass importing an opinion it has no evidence for.
 */
export const CYCLE_TIME_PERCENTILE = 0.85;

/** Half the trailing span, so a cycle-time trend compares two equal halves. */
export const CYCLE_TIME_TREND_HALF_DAYS = CYCLE_TIME_TRAILING_DAYS / 2;

/**
 * How far the median has to move before the trend is named rather than called steady.
 *
 * Ten percent, in basis points, and the same band `assessVelocity` uses. One shared
 * number means a Kanban team and a Scrum team are held to the same idea of "that
 * moved", which is what makes the two Progress variants comparable on the merged page.
 */
export const CYCLE_TIME_TREND_BAND_BASIS_POINTS = 1_000;

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
  /**
   * The sprint this sample was measured over.
   *
   * Every computed claim in a report is openable, and a velocity is a claim: the
   * reader has to be able to reach the sprint the figure came from rather than
   * take the mean on trust.
   */
  readonly evidence: readonly EvidenceRef[];
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

/**
 * One board column, and the work standing in it.
 *
 * A count and its keys, never a percentage and never a limit: Compass does not know
 * what WIP limit the team agreed, so it states the load and lets the manager compare
 * it against the number on their own board.
 */
export interface KanbanColumnLoad {
  /** The column as the tracker spells it — `In Progress`, `In Review`. */
  readonly column: string;
  readonly items: number;
  readonly ticketKeys: readonly string[];
}

/**
 * Which way cycle time moved, named plainly rather than as good or bad.
 *
 * `rising`/`falling` would need the reader to remember whether a rising cycle time is
 * the desirable direction. `lengthening` and `shortening` say what happened, and the
 * manager supplies the judgement — the same reason nothing in this product colour-codes
 * bad news.
 */
export type CycleTimeDirection = 'lengthening' | 'steady' | 'shortening';

/**
 * The cycle-time trend, or a stated refusal to state one.
 *
 * The trailing span is split in half and the two medians are compared. A first-to-last
 * comparison would let one unusually slow item decide the verdict, which is the same
 * reason `assessVelocity` compares half against half rather than sprint against sprint.
 *
 * The `undefined` arm carries no direction and no medians — a half with nothing in it
 * supports no trend at all, and printing `steady` for it would be a claim about a team
 * from an empty sample.
 */
export type CycleTimeTrend =
  | {
      readonly kind: 'measured';
      readonly direction: CycleTimeDirection;
      readonly halfDays: number;
      readonly earlierMedianDays: number;
      readonly earlierSampleSize: number;
      readonly laterMedianDays: number;
      readonly laterSampleSize: number;
      /** The move from the earlier half to the later one, in basis points. */
      readonly changeBasisPoints: number;
      readonly statement: string;
    }
  | {
      readonly kind: 'undefined';
      readonly reason: 'insufficient_history';
      readonly halfDays: number;
      readonly earlierSampleSize: number;
      readonly laterSampleSize: number;
      readonly statement: string;
    };

/** One item that has been in flight longer than the team's own P85. */
export interface KanbanAgingItem {
  readonly ticketKey: string;
  readonly title: string;
  /** The column it is aging in, which is usually the interesting half. */
  readonly column: string;
  /** Days since it first entered a working column. */
  readonly ageDays: number;
}

/**
 * The aging items, or a stated refusal because there is no baseline to age against.
 *
 * Aging is defined relative to the measured P85, so it exists only when cycle time
 * does. A board with nothing finished in the trailing span has no distribution, and
 * Compass will not fall back to a number somebody once read in a book.
 */
export type KanbanAging =
  | {
      readonly kind: 'measured';
      readonly p85Days: number;
      readonly percentile: number;
      /** Oldest first, then by key, so two runs list them in one order. */
      readonly items: readonly KanbanAgingItem[];
      /**
       * In-flight items whose board history records no entry into a working column,
       * so their age cannot be stated. Named rather than dropped: an item missing
       * from an aging list because nobody moved it on the board is exactly the item a
       * manager most needs to hear about.
       */
      readonly unmeasurableTicketKeys: readonly string[];
      readonly statement: string;
      readonly evidence: readonly EvidenceRef[];
    }
  | {
      readonly kind: 'undefined';
      readonly reason: 'no_cycle_time_baseline';
      readonly trailingDays: number;
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
    /**
     * WIP by column — the question a Kanban manager actually asks of their board.
     *
     * Ordered by load, heaviest first, then by column name. There is no board-column
     * order in the knowledge model to sort by, and inventing a left-to-right guess
     * would put a made-up workflow on the page; ordering by load says something true
     * and is a total order, so two runs emit the same list.
     */
    readonly byColumn: readonly KanbanColumnLoad[];
    readonly statement: string;
    readonly evidence: readonly EvidenceRef[];
  };
  readonly cycleTime:
    | {
        readonly kind: 'measured';
        readonly sampleSize: number;
        readonly medianDays: number;
        readonly p85Days: number;
        readonly percentile: number;
        readonly trailingDays: number;
        readonly ticketKeys: readonly string[];
        readonly trend: CycleTimeTrend;
        readonly statement: string;
        readonly evidence: readonly EvidenceRef[];
      }
    | {
        readonly kind: 'undefined';
        readonly reason: 'no_completed_items';
        readonly trailingDays: number;
        readonly statement: string;
      };
  readonly aging: KanbanAging;
  readonly statement: string;
  /**
   * The tickets behind throughput and work in progress, so a flow figure is as
   * openable as a sprint figure. A team without sprints must not end up with the
   * one section of the report whose numbers cannot be checked.
   */
  readonly evidence: readonly EvidenceRef[];
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
      /**
       * Why sprint semantics were not used. Always stated, never implied.
       *
       * Three distinct facts, and a manager can act on the difference. `team_runs_kanban`
       * is the team's own configuration; `no_sprints_observed` means the tracker returned
       * no sprint at all, which on a team configured for Scrum is a connector or board
       * problem worth knowing about; `no_current_sprint` means sprints exist but none
       * covers this window, which is usually the gap between two of them.
       */
      readonly reason: 'team_runs_kanban' | 'no_sprints_observed' | 'no_current_sprint';
      readonly statement: string;
    }
  | {
      readonly mode: 'no_signal';
      readonly reason: 'no_work_items' | 'no_project_in_scope';
      readonly statement: string;
    };

/**
 * The cause kinds of the Progress section's items.
 *
 * Declared here rather than spelled out at each use site because two layers need
 * to agree about them: `generate.ts` writes them onto the items, and the
 * deterministic renderer reads them back to decide which interpretation clause a
 * figure gets — a completion percentage is read against the schedule, a velocity
 * is not. A literal in both places would be a coupling nothing checked.
 *
 * ## Why these are cause kinds and no longer ids
 *
 * They used to be `PROGRESS_ITEM_IDS` — a frozen map of `progress:velocity`-shaped
 * strings written straight onto `stableId`. That was the last identity scheme in the
 * analysis core that did not go through `stableItemId`, and it carried no tenant, so
 * two organizations' velocity items shared one id and a dismissal of one would have
 * suppressed the other's. Now the strings name the *cause*, the tenant comes from
 * the snapshot, and the id is derived like every other item's.
 *
 * The renderer matches on `item.cause.causeKind` rather than on a magic id, which is
 * also the more honest join: it is asking "what kind of figure is this", and that is
 * exactly what a cause kind answers.
 */
export const PROGRESS_CAUSE_KINDS = Object.freeze({
  sprint: 'sprint_completion',
  projection: 'projected_completion',
  velocity: 'velocity',
  kanbanFlow: 'kanban_flow',
  /**
   * The three flow figures a Kanban team's Progress section is *about*.
   *
   * Separate causes rather than three clauses inside `kanban_flow`, for the same reason
   * a Scrum team's velocity is not a clause inside its sprint item: each is a claim a
   * manager can dismiss, act on or argue with on its own, and an id per claim is what
   * makes the feedback ledger and the day counter able to tell them apart. Folding them
   * together would mean dismissing "cycle time is lengthening" also dismissed the WIP
   * distribution, which is a different fact about a different part of the board.
   */
  kanbanWip: 'kanban_wip',
  kanbanCycleTime: 'kanban_cycle_time',
  kanbanAging: 'kanban_aging',
} as const);

export type ProgressCauseKind = (typeof PROGRESS_CAUSE_KINDS)[keyof typeof PROGRESS_CAUSE_KINDS];

/**
 * The entity a Progress item is about.
 *
 * The sprint item names its sprint; the other three are about the team's own process
 * and have no artifact to point at, so they name the scope itself. `progress` is a
 * deliberate pseudo-kind: it keeps the four ids distinct from any ticket, sprint or
 * repository, and it reads correctly in a log line.
 */
export const PROGRESS_ENTITY_KEY = 'process';

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

  // The team's own declared cadence comes first, and it is the only limb here that is
  // configuration rather than inference. A team that says it runs Kanban gets flow
  // semantics even when its tracker hands back sprint rows — a shared Jira project, a
  // board somebody left a sprint switched on in — because scoring a Kanban team against a
  // sprint it never committed to is worse than having no percentage at all.
  if (KANBAN_METHODOLOGY.test(scope.methodology ?? '')) {
    return {
      mode: 'kanban',
      flow: assessKanbanFlow(snapshot, instant, tickets),
      reason: 'team_runs_kanban',
      statement:
        'This team runs Kanban, so this section reports flow — work in progress by column, cycle time and the items aging past it. There is no completion percentage, no story-point total and no sprint goal to report, and Compass will not invent one.',
    };
  }

  // Below the configuration, Kanban is also the absence of sprint rows. A team that
  // declares itself Scrum and has no sprints still gets flow semantics, because flow is
  // what the data can actually support.
  if (sprints.length === 0) {
    return {
      mode: 'kanban',
      flow: assessKanbanFlow(snapshot, instant, tickets),
      reason: 'no_sprints_observed',
      statement:
        'No sprint has been ingested for this team, so this section reports flow — work in progress by column, cycle time and the items aging past it. There is no completion percentage, no story-point total and no sprint goal to report, and Compass will not invent one.',
    };
  }

  const current = currentSprint(sprints, instant);
  if (current === null) {
    return {
      mode: 'kanban',
      flow: assessKanbanFlow(snapshot, instant, tickets),
      reason: 'no_current_sprint',
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
      evidence: orderedEvidence([sprintEvidence(sprint)]),
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

/** The board column an item stands in, as the tracker spells it. */
const columnOf = (ticket: AnalysisEntity): string =>
  textField(ticket, 'status') ?? textField(ticket, 'statusCategory') ?? 'unrecorded';

/**
 * Work in progress grouped by board column.
 *
 * Heaviest column first, then by name. Both limbs matter: the load is the fact worth
 * leading with, and the name is what makes the order total, so the same board produces
 * the same list on every run.
 */
export function columnLoads(tickets: readonly AnalysisEntity[]): readonly KanbanColumnLoad[] {
  const grouped = new Map<string, string[]>();

  for (const ticket of tickets) {
    const column = columnOf(ticket);
    const bucket = grouped.get(column);
    if (bucket === undefined) grouped.set(column, [ticketKeyOf(ticket)]);
    else bucket.push(ticketKeyOf(ticket));
  }

  return [...grouped.entries()]
    .map(([column, keys]) => ({ column, items: keys.length, ticketKeys: [...keys].sort(compareStable) }))
    .sort((left, right) => compareNumbers(right.items, left.items) || compareStable(left.column, right.column));
}

/**
 * One cycle-time observation: how long it took, and when it finished.
 *
 * Exported because `cycleTimeTrend` takes it, and a public function whose parameter type
 * cannot be named is a function nobody outside this module can call.
 */
export interface CycleSample {
  readonly ticketKey: string;
  readonly days: number;
  readonly finishedAt: number;
}

/**
 * The cycle-time trend: the earlier half of the trailing span against the later half.
 *
 * Split by *finish* instant rather than by sample index, so each half is a real span of
 * days. Splitting a sorted list in two would compare "the first six items to finish"
 * with "the last six", which says nothing about time if eleven of the twelve landed in
 * the same week.
 */
export function cycleTimeTrend(samples: readonly CycleSample[], halfBoundary: Instant): CycleTimeTrend {
  const earlier = samples.filter((sample) => sample.finishedAt < halfBoundary).map((sample) => sample.days);
  const later = samples.filter((sample) => sample.finishedAt >= halfBoundary).map((sample) => sample.days);

  if (earlier.length === 0 || later.length === 0) {
    return {
      kind: 'undefined',
      reason: 'insufficient_history',
      halfDays: CYCLE_TIME_TREND_HALF_DAYS,
      earlierSampleSize: earlier.length,
      laterSampleSize: later.length,
      statement: `One half of the last ${CYCLE_TIME_TRAILING_DAYS} days finished nothing, so Compass has no cycle-time trend to state beside the median.`,
    };
  }

  const earlierMedianDays = medianOf(earlier) ?? 0;
  const laterMedianDays = medianOf(later) ?? 0;
  const changeBasisPoints =
    earlierMedianDays === 0 ? 0 : basisPoints(laterMedianDays - earlierMedianDays, earlierMedianDays);
  const direction: CycleTimeDirection =
    changeBasisPoints >= CYCLE_TIME_TREND_BAND_BASIS_POINTS
      ? 'lengthening'
      : changeBasisPoints <= -CYCLE_TIME_TREND_BAND_BASIS_POINTS
        ? 'shortening'
        : 'steady';

  return {
    kind: 'measured',
    direction,
    halfDays: CYCLE_TIME_TREND_HALF_DAYS,
    earlierMedianDays,
    earlierSampleSize: earlier.length,
    laterMedianDays,
    laterSampleSize: later.length,
    changeBasisPoints,
    statement: `Cycle time is ${direction}: a median of ${earlierMedianDays} days over the earlier ${CYCLE_TIME_TREND_HALF_DAYS}-day half, against ${laterMedianDays} days over the later half.`,
  };
}

/** How many aging items the statement names before it stops and says so. */
const AGING_NAMED_IN_STATEMENT = 5;

/**
 * The items in flight longer than the team's own P85, oldest first.
 *
 * `p85Days` is null when cycle time could not be measured, and the refusal arm is what
 * that produces: there is no honest way to age an item against a distribution that does
 * not exist.
 */
export function kanbanAging(
  inFlight: readonly AnalysisEntity[],
  startedByTicket: ReadonlyMap<string, Instant>,
  p85Days: number | null,
  instant: Instant,
): KanbanAging {
  if (p85Days === null) {
    return {
      kind: 'undefined',
      reason: 'no_cycle_time_baseline',
      trailingDays: CYCLE_TIME_TRAILING_DAYS,
      statement: `Nothing finished in the last ${CYCLE_TIME_TRAILING_DAYS} days, so there is no P85 to age anything against and Compass will not pick a number for one.`,
    };
  }

  const items: KanbanAgingItem[] = [];
  const unmeasurable: string[] = [];

  for (const ticket of inFlight) {
    const ticketKey = ticketKeyOf(ticket);
    const startedAt = startedByTicket.get(ticketKey);
    if (startedAt === undefined) {
      unmeasurable.push(ticketKey);
      continue;
    }
    const ageDays = wholeDaysBetween(startedAt, instant);
    if (ageDays <= p85Days) continue;
    items.push({
      ticketKey,
      title: textField(ticket, 'title') ?? '',
      column: columnOf(ticket),
      ageDays,
    });
  }

  items.sort(
    (left, right) => compareNumbers(right.ageDays, left.ageDays) || compareStable(left.ticketKey, right.ticketKey),
  );
  unmeasurable.sort(compareStable);

  const named = items.slice(0, AGING_NAMED_IN_STATEMENT);
  const unstated = items.length - named.length;
  const missing =
    unmeasurable.length === 0
      ? ''
      : ` ${unmeasurable.length} in-flight item${unmeasurable.length === 1 ? '' : 's'} never entered a working column on the board, so ${
          unmeasurable.length === 1 ? 'its age' : 'their ages'
        } cannot be stated: ${unmeasurable.join(', ')}.`;

  const statement =
    items.length === 0
      ? `Nothing in flight has been open longer than the ${p85Days}-day P85, so no item is aging past what this board's own history predicts.${missing}`
      : `${items.length} item${items.length === 1 ? '' : 's'} ${items.length === 1 ? 'has' : 'have'} been in flight longer than the ${p85Days}-day P85: ${named
          .map((item) => `${item.ticketKey} at ${item.ageDays} days in ${item.column}`)
          .join(', ')}${unstated === 0 ? '' : `, and ${unstated} more`}.${missing}`;

  return {
    kind: 'measured',
    p85Days,
    percentile: CYCLE_TIME_PERCENTILE,
    items,
    unmeasurableTicketKeys: unmeasurable,
    statement,
    evidence: orderedEvidence(
      inFlight
        .filter((ticket) => items.some((aging) => aging.ticketKey === ticketKeyOf(ticket)))
        .sort((left, right) => compareStable(ticketKeyOf(left), ticketKeyOf(right)))
        .map(ticketEvidence),
    ),
  };
}

/**
 * Flow metrics for a team that runs no sprints.
 *
 * Contains no completion percentage, no story-point total and no sprint goal —
 * by construction, not by filtering. Throughput is what left the board in the
 * report window; cycle time is sampled over a trailing span because a single
 * day rarely contains enough completions to say anything; work in progress is
 * broken out by column, because "22 in flight" is a number and "12 in In Progress
 * against 10 in In Review" is a diagnosis.
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
  const cycleSamples: CycleSample[] = [];
  const startedByTicket = new Map<string, Instant>();
  const trailingStart = trailingDays(instant, CYCLE_TIME_TRAILING_DAYS).start;
  const halfBoundary = trailingDays(instant, CYCLE_TIME_TREND_HALF_DAYS).start;

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
    // Kept for every item, not only the finished ones: the same instant is what ages an
    // item that has *not* finished, which is the whole aging question.
    if (startedAt !== undefined) startedByTicket.set(key, startedAt as Instant);

    const finishedAt = [...transitions]
      .reverse()
      .find((transition) => transition.toStatusCategory === DONE_STATUS_CATEGORY)?.transitionedAt;
    if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) continue;
    if (finishedAt < trailingStart || finishedAt > instant) continue;
    cycleSamples.push({
      ticketKey: key,
      days: wholeDaysBetween(startedAt as Instant, finishedAt as Instant),
      finishedAt,
    });
  }

  const inFlight = tickets.filter((ticket) => isInFlight(ticket));
  const days = cycleSamples.map((sample) => sample.days);
  const span = Math.max(1, Math.round(windowDays(window)));
  const p85Days = percentileOf(days, CYCLE_TIME_PERCENTILE);
  const sampledTickets = new Set(cycleSamples.map((sample) => sample.ticketKey));

  const cycleTime: KanbanFlow['cycleTime'] =
    cycleSamples.length === 0 || p85Days === null
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
          p85Days,
          percentile: CYCLE_TIME_PERCENTILE,
          trailingDays: CYCLE_TIME_TRAILING_DAYS,
          ticketKeys: cycleSamples.map((sample) => sample.ticketKey).sort(compareStable),
          trend: cycleTimeTrend(cycleSamples, halfBoundary),
          statement: `Over the last ${CYCLE_TIME_TRAILING_DAYS} days the median item took ${medianOf(days) ?? 0} days from start to finish and the slowest sixth took ${p85Days} or more, across ${cycleSamples.length} finished item${cycleSamples.length === 1 ? '' : 's'}.`,
          evidence: orderedEvidence(
            [...tickets]
              .filter((ticket) => sampledTickets.has(ticketKeyOf(ticket)))
              .sort((left, right) => compareStable(ticketKeyOf(left), ticketKeyOf(right)))
              .map(ticketEvidence),
          ),
        };

  const byColumn = columnLoads(inFlight);
  const throughputKeys = [...new Set(completedInWindow)].filter((key) => inScope.has(key)).sort(compareStable);
  const cited = new Set([...throughputKeys, ...inFlight.map(ticketKeyOf)]);

  const wipStatement =
    inFlight.length === 0
      ? 'Nothing is in flight, so there is no work in progress on this board to distribute.'
      : `${inFlight.length} item${inFlight.length === 1 ? '' : 's'} ${inFlight.length === 1 ? 'is' : 'are'} in flight across ${byColumn.length} column${byColumn.length === 1 ? '' : 's'} — ${byColumn
          .map((load) => `${load.column} ${load.items}`)
          .join(', ')}.`;

  return {
    windowDays: span,
    throughput: { completedItems: throughputKeys.length, ticketKeys: throughputKeys },
    workInProgress: {
      items: inFlight.length,
      ticketKeys: inFlight.map(ticketKeyOf).sort(compareStable),
      byColumn,
      statement: wipStatement,
      evidence: orderedEvidence(
        [...inFlight]
          .sort((left, right) => compareStable(ticketKeyOf(left), ticketKeyOf(right)))
          .map(ticketEvidence),
      ),
    },
    cycleTime,
    aging: kanbanAging(inFlight, startedByTicket, p85Days, instant),
    evidence: orderedEvidence(
      [...tickets]
        .filter((ticket) => cited.has(ticketKeyOf(ticket)))
        .sort((left, right) => compareStable(ticketKeyOf(left), ticketKeyOf(right)))
        .map(ticketEvidence),
    ),
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
