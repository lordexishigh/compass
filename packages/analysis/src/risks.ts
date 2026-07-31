import {
  orderedEvidence,
  pullRequestEvidence,
  pullRequestLabel,
  releaseEvidence,
  sprintEvidence,
  ticketEvidence,
  type EvidenceRef,
} from './evidence.js';
import {
  MILLIS_PER_DAY,
  basisPoints,
  compareNumbers,
  compareStable,
  wholeDaysBetween,
  type Instant,
  type TimeWindow,
} from './instant.js';
import type { ProgressAssessment } from './progress.js';
import type { CalibrationVerdict } from './projection.js';
import { isOpenPullRequest } from './review-queue.js';
import type { ReviewQueue } from './review-queue.js';
import {
  entitiesOfKind,
  instantField,
  isInFlight,
  scopedPullRequests,
  scopedReleaseTags,
  scopedTickets,
  statusCategoryAt,
  textField,
  textListField,
  transitionsByTicket,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';
import { netTechnicalDebtChange, type TechnicalDebtSignal } from './technical-debt.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';
import type { WorkloadDistribution } from './workload.js';
import type { YesterdayItem } from './yesterday.js';

/**
 * Risk detection, with severity and a trend that names what it compared against.
 *
 * "Risk: scope creep" is a mood. What a manager can act on is "four items entered
 * Sprint 46 after it started, up from one when yesterday's report ran" — a
 * measurement, a direction, and the number the direction was measured from. So
 * every risk here carries:
 *
 *  - a **measured value** and the numbered threshold it crossed;
 *  - a **severity**, derived from how far past the threshold it is rather than
 *    assigned by hand: at the threshold is `medium`, twice it is `high`;
 *  - a **trend** — one of `new`, `worsened`, `unchanged`, `improving` — and the
 *    **prior value** it was compared against, so the trend can be checked.
 *
 * The prior is computed by re-measuring the same statistic one window earlier —
 * as of `window.start` for point-in-time statistics, or over the immediately
 * preceding span for statistics that are themselves measured over a span — rather
 * than by reading yesterday's report. That matters for three reasons: it works on
 * the first ever run, it survives a missed day, and it makes the trend a property
 * of the data rather than a property of Compass's own delivery history.
 *
 * One invariant holds across every detector below, and `tests/signals.test.ts`
 * enforces it: `trend` must equal `trendFor(measured.value, priorValue)`. The
 * trend and the two numbers printed beside it always describe the same quantity,
 * so a manager can check the arrow against the figures without trusting Compass.
 *
 * Where a statistic genuinely cannot be re-measured in the past — because the
 * snapshot holds current belief for that field and no event history to replay —
 * the prior is `null`, `priorBasis` says `no_prior_observation`, and the trend is
 * `new`. Compass states the gap rather than filling it with today's number and
 * calling it flat.
 */
export const RISK_CAUSES = [
  'scope_added_after_start',
  'review_bottleneck',
  'unreleased_merged_work',
  'work_concentration',
  'estimation_noise',
  'technical_debt_growth',
  'done_without_pull_request',
] as const;

export type RiskCause = (typeof RISK_CAUSES)[number];

export type RiskSeverity = 'low' | 'medium' | 'high';

export type RiskTrend = 'new' | 'worsened' | 'unchanged' | 'improving';

export interface DetectedRisk {
  /** Subject plus cause. Stable across days, so a trend has something to attach to. */
  readonly stableId: string;
  readonly cause: RiskCause;
  readonly severity: RiskSeverity;
  readonly trend: RiskTrend;
  readonly subject: { readonly kind: string; readonly key: string; readonly label: string };
  readonly measured: { readonly value: number; readonly unit: ThresholdRef['unit'] };
  /** The number the trend was computed against. `null` is stated, not hidden. */
  readonly priorValue: number | null;
  readonly priorAt: number | null;
  readonly priorBasis: 'measured_at_window_start' | 'no_prior_observation';
  readonly threshold: ThresholdRef;
  readonly ageDays: number;
  readonly headline: string;
  readonly detail: string;
  readonly evidence: readonly EvidenceRef[];
}

export interface RiskInputs {
  readonly progress: ProgressAssessment;
  readonly reviewQueue: ReviewQueue;
  readonly workload: WorkloadDistribution;
  readonly technicalDebt: TechnicalDebtSignal;
  readonly calibration: CalibrationVerdict;
  /**
   * The Yesterday items, already laddered.
   *
   * Risks reads them rather than recomputing, because a ladder mismatch is a
   * finding *about a line the manager just read* — "DEV-402 is accepted with no
   * pull request behind it" has to name the same unit of work, with the same
   * artifacts, as the Yesterday line two sections above it. Recomputing the
   * completion here would eventually let the two disagree about what happened.
   */
  readonly yesterday: readonly YesterdayItem[];
}

/**
 * Detects every risk in scope, most severe first.
 *
 * Ordering is severity descending, then measured value descending, then
 * `stableId` — a total order, so the section is byte-identical across runs.
 */
export function detectRisks(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  inputs: RiskInputs,
): readonly DetectedRisk[] {
  const risks: (DetectedRisk | null)[] = [
    scopeCreepRisk(snapshot, instant, inputs.progress),
    reviewBottleneckRisk(snapshot, instant, scope, inputs.reviewQueue),
    unreleasedWorkRisk(snapshot, instant, scope),
    workConcentrationRisk(snapshot, instant, scope, inputs.workload),
    estimationNoiseRisk(snapshot, scope, inputs.calibration),
    technicalDebtRisk(snapshot, instant, scope, inputs.technicalDebt),
    ...hygieneRisks(instant, inputs.yesterday),
  ];

  const severityRank: Readonly<Record<RiskSeverity, number>> = { high: 0, medium: 1, low: 2 };

  return risks
    .filter((risk): risk is DetectedRisk => risk !== null)
    .sort(
      (left, right) =>
        compareNumbers(severityRank[left.severity], severityRank[right.severity]) ||
        compareNumbers(right.measured.value, left.measured.value) ||
        compareStable(left.stableId, right.stableId),
    );
}

/**
 * Severity from distance past the threshold.
 *
 * Derived rather than assigned, so two risks with the same shape cannot end up
 * with different severities because different code paths guessed differently.
 */
export function severityFor(value: number, threshold: number): RiskSeverity {
  if (threshold <= 0) return value > 0 ? 'medium' : 'low';
  if (value >= threshold * 2) return 'high';
  if (value >= threshold) return 'medium';
  return 'low';
}

/** Trend from a measured value and its prior. `null` prior means `new`. */
export function trendFor(value: number, prior: number | null): RiskTrend {
  if (prior === null) return 'new';
  if (value > prior) return 'worsened';
  if (value < prior) return 'improving';
  return 'unchanged';
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Scope added after the sprint started.
 *
 * The prior is exact: sprint scope changes are append-only event history with
 * their own `changedAt`, so "how many had been added as of yesterday" is a filter,
 * not an estimate.
 */
function scopeCreepRisk(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  progress: ProgressAssessment,
): DetectedRisk | null {
  if (progress.mode !== 'sprint') return null;
  const sprintKey = progress.sprint.sprintKey;

  const changes = snapshot.collections.sprintScopeChanges.filter(
    (change) => change.sprintKey === sprintKey && change.change === 'added' && change.afterSprintStart,
  );
  if (changes.length === 0) return null;

  const value = new Set(changes.map((change) => change.ticketKey)).size;
  const prior = new Set(
    changes.filter((change) => change.changedAt < snapshot.window.start).map((change) => change.ticketKey),
  ).size;
  const firstAt = changes.map((change) => change.changedAt).sort(compareNumbers)[0] as Instant;
  // Every scope change happened inside this window, so there is nothing earlier
  // to compare against — distinct from "nothing had been added yet".
  const priorValue = prior === 0 && firstAt >= snapshot.window.start ? null : prior;

  const sprint = entitiesOfKind(snapshot, 'sprint').find((entity) => entity.naturalKey === sprintKey);
  const addedKeys = [...new Set(changes.map((change) => change.ticketKey))].sort(compareStable);

  return {
    stableId: `risk:sprint:${sprintKey}:scope_added_after_start`,
    cause: 'scope_added_after_start',
    severity: severityFor(value, THRESHOLDS.T6.value),
    trend: trendFor(value, priorValue),
    subject: { kind: 'sprint', key: sprintKey, label: progress.sprint.sprintName },
    measured: { value, unit: 'count' },
    priorValue,
    priorAt: priorValue === null ? null : snapshot.window.start,
    priorBasis: priorValue === null ? 'no_prior_observation' : 'measured_at_window_start',
    threshold: thresholdRef('T6'),
    ageDays: wholeDaysBetween(firstAt, instant),
    headline: `${value} item${value === 1 ? '' : 's'} entered ${progress.sprint.sprintName} after it started`,
    detail: `${addedKeys.join(', ')} ${addedKeys.length === 1 ? 'was' : 'were'} added after ${progress.sprint.sprintName} began, against ${prior} at the start of this window. T6 fires at ${THRESHOLDS.T6.value}. The completion percentage above already counts the larger denominator, so this shows up as slower progress rather than as a missed commitment.`,
    evidence: orderedEvidence(sprint === undefined ? [] : [sprintEvidence(sprint)]),
  };
}

/**
 * Every open review queued behind one person.
 *
 * The prior re-measures the same queue as of `window.start`: a pull request was
 * in the queue then if it was created before the window and had not merged or
 * closed by then. Both instants are event times, so this is exact.
 */
function reviewBottleneckRisk(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  queue: ReviewQueue,
): DetectedRisk | null {
  if (queue.concentration === null) return null;
  const reviewerKey = queue.concentration.developerKey;
  const value = queue.concentration.openCount;

  const start = snapshot.window.start;
  const priorCount = scopedPullRequests(snapshot, scope).filter((pullRequest) => {
    const createdAt = instantField(pullRequest, 'createdAt') ?? (pullRequest.firstSeenAt as Instant);
    if (createdAt >= start) return false;
    const mergedAt = instantField(pullRequest, 'mergedAt');
    const closedAt = instantField(pullRequest, 'closedAt');
    if (mergedAt !== null && mergedAt < start) return false;
    if (closedAt !== null && closedAt < start) return false;
    return textListField(pullRequest, 'requestedReviewerKeys').includes(reviewerKey);
  }).length;

  // Nothing queued on this person before the window means the whole backlog
  // formed inside it: there is no earlier depth to compare against.
  const priorValue = priorCount === 0 ? null : priorCount;

  const oldest = queue.entries
    .filter((entry) => entry.reviewerDeveloperKeys.includes(reviewerKey))
    .sort((left, right) => compareNumbers(right.ageDays, left.ageDays) || compareStable(left.pullRequestKey, right.pullRequestKey))[0];

  const pullRequests = scopedPullRequests(snapshot, scope).filter(
    (pullRequest) =>
      isOpenPullRequest(pullRequest) && textListField(pullRequest, 'requestedReviewerKeys').includes(reviewerKey),
  );

  return {
    stableId: `risk:developer:${reviewerKey}:review_bottleneck`,
    cause: 'review_bottleneck',
    severity: severityFor(value, THRESHOLDS.T5.value),
    trend: trendFor(value, priorValue),
    subject: { kind: 'developer', key: reviewerKey, label: queue.concentration.displayName ?? reviewerKey },
    measured: { value, unit: 'count' },
    priorValue,
    priorAt: priorValue === null ? null : start,
    priorBasis: priorValue === null ? 'no_prior_observation' : 'measured_at_window_start',
    threshold: thresholdRef('T5'),
    ageDays: oldest?.ageDays ?? 0,
    headline: `${value} open reviews are waiting on ${queue.concentration.displayName ?? reviewerKey}`,
    detail: `${queue.concentration.statement} That was ${priorCount} at the start of this window, and T5 fires at ${THRESHOLDS.T5.value}. The oldest is ${oldest?.pullRequestNumber ?? 'unknown'} at ${oldest?.ageDays ?? 0} days.`,
    evidence: orderedEvidence(pullRequests.map(pullRequestEvidence)),
  };
}

/**
 * Merged work sitting ahead of the newest release tag.
 *
 * Everything here is an event time — merge instants and tag instants — so both
 * the value and the prior are exact.
 */
function unreleasedWorkRisk(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): DetectedRisk | null {
  const tags = scopedReleaseTags(snapshot, scope)
    .map((tag) => ({ tag, releasedAt: instantField(tag, 'releasedAt') }))
    .filter((entry): entry is { tag: AnalysisEntity; releasedAt: Instant } => entry.releasedAt !== null)
    .sort((left, right) => compareNumbers(right.releasedAt, left.releasedAt) || compareStable(left.tag.naturalKey, right.tag.naturalKey));

  const newest = tags[0];
  if (newest === undefined) return null;

  const repositoryKey = textField(newest.tag, 'repositoryKey');
  const merged = scopedPullRequests(snapshot, scope)
    .map((pullRequest) => ({ pullRequest, mergedAt: instantField(pullRequest, 'mergedAt') }))
    .filter(
      (entry): entry is { pullRequest: AnalysisEntity; mergedAt: Instant } =>
        entry.mergedAt !== null && textField(entry.pullRequest, 'repositoryKey') === repositoryKey,
    );

  const unreleased = merged.filter((entry) => entry.mergedAt > newest.releasedAt);
  if (unreleased.length === 0) return null;

  const prior = unreleased.filter((entry) => entry.mergedAt < snapshot.window.start).length;
  // Everything ahead of the tag merged inside this window: the backlog is new,
  // rather than having been measured at zero yesterday.
  const priorValue = prior === 0 ? null : prior;
  const oldest = [...unreleased].sort(
    (left, right) =>
      compareNumbers(left.mergedAt, right.mergedAt) ||
      compareStable(left.pullRequest.naturalKey, right.pullRequest.naturalKey),
  )[0] as { pullRequest: AnalysisEntity; mergedAt: Instant };
  const oldestItemKeys = [...textListField(oldest.pullRequest, 'linkedItemKeys')].sort(compareStable);

  return {
    stableId: `risk:repository:${repositoryKey ?? 'unknown'}:unreleased_merged_work`,
    cause: 'unreleased_merged_work',
    severity: severityFor(unreleased.length, THRESHOLDS.T16.value),
    trend: trendFor(unreleased.length, priorValue),
    subject: { kind: 'repository', key: repositoryKey ?? 'unknown', label: repositoryKey ?? 'unknown' },
    measured: { value: unreleased.length, unit: 'count' },
    priorValue,
    priorAt: priorValue === null ? null : snapshot.window.start,
    priorBasis: priorValue === null ? 'no_prior_observation' : 'measured_at_window_start',
    threshold: thresholdRef('T16'),
    ageDays: wholeDaysBetween(oldest.mergedAt, instant),
    headline: `${unreleased.length} merged pull request${unreleased.length === 1 ? '' : 's'} ${unreleased.length === 1 ? 'sits' : 'sit'} ahead of ${textField(newest.tag, 'name') ?? newest.tag.naturalKey}`,
    // The oldest item is *named*, not merely counted. "Three merges are
    // unreleased" is a number a manager can do nothing with; "#8042 has been
    // sitting on trunk for nine days" is the one they can go and cut a tag for.
    detail: `${textField(newest.tag, 'name') ?? 'The newest tag'} was cut ${wholeDaysBetween(newest.releasedAt, instant)} days ago and ${unreleased.length} pull request${unreleased.length === 1 ? ' has' : 's have'} merged into ${repositoryKey ?? 'the repository'} since — ${prior} of them before this window. T16 fires at ${THRESHOLDS.T16.value}. The oldest is ${pullRequestLabel(oldest.pullRequest)}${
      oldestItemKeys.length === 0 ? '' : ` (${oldestItemKeys.join(', ')})`
    }, which has been waiting ${wholeDaysBetween(oldest.mergedAt, instant)} days.`,
    evidence: orderedEvidence([
      releaseEvidence(newest.tag),
      ...unreleased.map((entry) => pullRequestEvidence(entry.pullRequest)),
    ]),
  };
}

/**
 * One person carrying most of the in-flight work.
 *
 * The prior replays the transition history to recover which items were in flight
 * at `window.start`. Assignment history is *not* replayable — the knowledge model
 * versions the assignee but the snapshot hands analysis current belief — so the
 * prior uses today's assignee against yesterday's in-flight set, and
 * `priorBasis` records that this is a re-measurement rather than a stored
 * observation.
 *
 * The measured statistic is the *share*, in basis points, because that is what
 * T14 fires on — so the prior is the share too. Comparing today's share against
 * yesterday's raw item count would produce a trend nobody could check against the
 * two numbers printed beside it.
 */
function workConcentrationRisk(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  workload: WorkloadDistribution,
): DetectedRisk | null {
  if (workload.concentration === null) return null;
  const developerKey = workload.concentration.developerKey;
  const value = workload.concentration.shareBasisPoints;

  const transitions = transitionsByTicket(snapshot);
  const inFlightAtStart = scopedTickets(snapshot, scope).filter((ticket) => {
    const key = textField(ticket, 'itemKey') ?? ticket.naturalKey;
    const category = statusCategoryAt(transitions.get(key) ?? [], snapshot.window.start);
    // No observed history before the window means Compass cannot say what state
    // the item was in; falling back to the current state would manufacture a
    // prior. It is excluded from the prior count instead.
    return category !== null && category !== 'done' && category !== 'todo';
  });
  const priorItems = inFlightAtStart.filter(
    (ticket) => textField(ticket, 'assigneeDeveloperKey') === developerKey,
  ).length;
  // A denominator of zero means the window start predates every observation
  // Compass holds, so there is no share to compare against — not a share of nil.
  const prior = inFlightAtStart.length === 0 ? null : basisPoints(priorItems, inFlightAtStart.length);

  const tickets = scopedTickets(snapshot, scope).filter(
    (ticket) => isInFlight(ticket) && textField(ticket, 'assigneeDeveloperKey') === developerKey,
  );

  return {
    stableId: `risk:developer:${developerKey}:work_concentration`,
    cause: 'work_concentration',
    severity: severityFor(value, THRESHOLDS.T14.value),
    trend: trendFor(value, prior),
    subject: { kind: 'developer', key: developerKey, label: workload.concentration.displayName ?? developerKey },
    measured: { value, unit: 'basis_points' },
    priorValue: prior,
    priorAt: prior === null ? null : snapshot.window.start,
    priorBasis: prior === null ? 'no_prior_observation' : 'measured_at_window_start',
    threshold: thresholdRef('T14'),
    ageDays: 0,
    headline: `${workload.concentration.displayName ?? developerKey} is holding ${Math.round(value / 100)}% of the work in flight`,
    detail: `${workload.concentration.statement} At the start of this window Compass could account for ${priorItems} of ${inFlightAtStart.length} in-flight item${inFlightAtStart.length === 1 ? '' : 's'} against the same person${
      prior === null ? ', which is too little history to compare against' : ` — ${Math.round(prior / 100)}%`
    }.`,
    evidence: orderedEvidence(tickets.map(ticketEvidence)),
  };
}

/**
 * Estimates that do not predict duration.
 *
 * The value is the correlation itself, so "risk worsened" means the correlation
 * fell. There is no prior for a statistic computed over all history at once, so
 * the trend is `new` with the basis stated — a rolling-window correlation would
 * give a real trend and is a deliberate later refinement, not an omission.
 *
 * The evidence is the sample: the completed items whose points were compared
 * against their measured duration. A statistical verdict is exactly the kind of
 * claim a manager is entitled to disbelieve, so it has to be the kind they can
 * open — "your points don't predict duration" with nothing to click is an
 * assertion, and this product does not make assertions.
 */
function estimationNoiseRisk(
  snapshot: AnalysisSnapshot,
  scope: ResolvedScope,
  calibration: CalibrationVerdict,
): DetectedRisk | null {
  if (calibration.verdict !== 'points_uninformative') return null;

  const value = calibration.correlation.absoluteCoefficientBasisPoints ?? 0;
  const sampled = new Set(calibration.ticketKeys);
  const tickets = scopedTickets(snapshot, scope).filter((ticket) => {
    const itemKey = textField(ticket, 'itemKey');
    return itemKey !== null && sampled.has(itemKey);
  });

  return {
    stableId: 'risk:team:estimation_noise',
    cause: 'estimation_noise',
    severity: value <= 0 ? 'high' : 'medium',
    trend: 'new',
    subject: { kind: 'team', key: 'calibration', label: 'estimation calibration' },
    measured: { value, unit: 'basis_points' },
    priorValue: null,
    priorAt: null,
    priorBasis: 'no_prior_observation',
    threshold: thresholdRef('T12'),
    ageDays: 0,
    headline: 'Story points are not predicting how long work takes',
    detail: `${calibration.statement} Compass compares points against measured start-to-finish duration for ${calibration.sampleSize} completed items; T12 needs a correlation of ${(THRESHOLDS.T12.value / 10_000).toFixed(2)}. Every projected date in this report is therefore a cycle-time guess, and it is set in a lighter weight for that reason.`,
    // The sample, capped: the point of the markers is that a reader can check the
    // claim, and forty superscripts on one sentence is not a check, it is a wall.
    // `sampleSize` in the detail above states the true count, so the cap hides
    // nothing — it only stops the evidence chain from swallowing the paragraph.
    evidence: orderedEvidence(tickets.map(ticketEvidence)).slice(0, MAX_SAMPLE_EVIDENCE),
  };
}

/** Evidence markers on one statistical claim. Enough to check, few enough to read. */
const MAX_SAMPLE_EVIDENCE = 5;

/**
 * Debt growth, promoted from the debt signal set to a risk with a trend.
 *
 * The prior re-measures the *same* statistic — net tech-debt change over the same
 * trailing span — one window earlier, exactly as the other detectors do. An
 * earlier version compared the last two per-sprint buckets while reporting the
 * trailing net change as `measured`, which meant the trend and the number beside
 * it described different quantities and the reader could not check one against
 * the other. It also compared a sprint still running against a finished one, so
 * debt appeared to improve every time a sprint rolled over.
 */
function technicalDebtRisk(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  debt: TechnicalDebtSignal,
): DetectedRisk | null {
  if (debt.growth !== 'growing') return null;

  const netChange = debt.signals.netChangeOverTrailingWindow;
  const value = netChange.value;

  // The equal-length span immediately before the one the signal measured.
  const earlierEnd = (instant - netChange.trailingDays * MILLIS_PER_DAY) as Instant;
  const earlierWindow: TimeWindow = {
    start: (earlierEnd - netChange.trailingDays * MILLIS_PER_DAY) as Instant,
    end: earlierEnd,
  };
  const priorChange = netTechnicalDebtChange(snapshot, scope, earlierWindow);
  // Nothing observed at all in the earlier span is an absence of history, not a
  // measurement of zero — the ingest window may simply not reach that far back.
  const observedPrior = priorChange.openedTicketKeys.length + priorChange.closedTicketKeys.length > 0;
  const prior = observedPrior ? priorChange.value : null;

  const complete = debt.openedPerSprint.filter((point) => point.complete);
  const series = (complete.length >= 2 ? complete : debt.openedPerSprint).slice(-4);

  return {
    stableId: 'risk:team:technical_debt_growth',
    cause: 'technical_debt_growth',
    severity: severityFor(value, THRESHOLDS.T9.value),
    trend: trendFor(value, prior),
    subject: { kind: 'team', key: 'technical_debt', label: 'technical debt' },
    measured: { value, unit: 'count' },
    priorValue: prior,
    priorAt: observedPrior ? earlierWindow.end : null,
    priorBasis: observedPrior ? 'measured_at_window_start' : 'no_prior_observation',
    threshold: thresholdRef('T9'),
    // Zero, not `meanOpenAgeDays`. `ageDays` is the elapsed fact behind the "day
    // 6" sigil — how long *this item* has been continuously present — and the mean
    // open age of a set of debt tickets is a different measurement that merely
    // shares a unit. It is also a mean, so it is fractional, and the elapsed
    // interpretation template only recognises whole days: writing it here made the
    // renderer emit "day 17.6" and then reject its own sentence, which took the
    // whole page down. The measurement itself is not lost — `debt.reasons` carries
    // it into `detail` — and this is a computed team-level condition with no
    // first-sighting in the pure layer, exactly like the other team risks above.
    ageDays: 0,
    headline: `Tech debt is growing: ${value >= 0 ? '+' : ''}${value} open items over ${netChange.trailingDays} days`,
    detail: `${debt.reasons.join(' ')} The ${netChange.trailingDays} days before that ran ${
      prior === null ? 'with no observed tech-debt activity' : `${prior >= 0 ? '+' : ''}${prior}`
    }. Opened per sprint: ${series
      .map((point) => `${point.sprintName} ${point.opened}${point.complete ? '' : ' so far'}`)
      .join(', ')}.`,
    evidence: debt.evidence,
  };
}

/**
 * Ladder mismatches, as hygiene findings.
 *
 * A completion that crossed R1 — the tracker accepted it — with R2 uncrossed is a
 * work item somebody marked Done with nothing in version control behind it. That
 * is not a slow team or a risky release; it is the board describing work that
 * cannot be found, and every number computed from that board inherits the error.
 *
 * It carries `T0`: the rule applies no threshold because the sources state the
 * condition outright. One is emitted per item so the finding *names the ticket* —
 * an aggregate count is something a manager can read and do nothing about, and the
 * fix here is always "go and ask about this specific item".
 */
function hygieneRisks(instant: Instant, yesterday: readonly YesterdayItem[]): readonly DetectedRisk[] {
  const mismatched = yesterday.filter((item) => {
    const accepted = item.ladder.notches.find((notch) => notch.rung === 'R1')?.crossed === true;
    const merged = item.ladder.notches.find((notch) => notch.rung === 'R2')?.crossed === true;
    return accepted && !merged;
  });

  return mismatched
    .map((item): DetectedRisk => {
      const subject = item.ticketKey ?? item.unitOfWork;
      const ageDays = wholeDaysBetween(item.completedAt as Instant, instant);
      return {
        stableId: `risk:ticket:${subject}:done_without_pull_request`,
        cause: 'done_without_pull_request',
        // Every mismatch is the same size: one item that cannot be traced. There
        // is nothing to be twice as far past, so the severity is not derived from a
        // distance the way the measured risks are.
        severity: 'medium',
        trend: 'new',
        subject: { kind: 'ticket', key: subject, label: subject },
        measured: { value: 1, unit: 'count' },
        priorValue: null,
        priorAt: null,
        priorBasis: 'no_prior_observation',
        threshold: thresholdRef('T0'),
        ageDays,
        headline: `${subject} is accepted with no pull request behind it`,
        detail: `The tracker moved ${subject} into a done status${
          item.title.length > 0 ? ` — "${item.title}"` : ''
        }, and Compass can find no pull request the forge linked to it. The completion ladder therefore stops at R1 ${
          item.ladder.notches[0]?.label ?? 'accepted'
        } with nothing above it. Either the work landed under a branch that never named the key, or the status was moved ahead of the work; both make every points total and every velocity that counts this item wrong.`,
        evidence: orderedEvidence(item.artifacts),
      };
    })
    .sort((left, right) => compareStable(left.stableId, right.stableId));
}

/**
 * Re-exported from `snapshot.ts`, where the one implementation lives.
 *
 * It was declared here first, then a second caller appeared — the carryover rate,
 * which reconstructs each sprint's unfinished set at the instant the sprint
 * closed. Two copies of "what state was this in then" is exactly the kind of
 * duplication that lets a trend and a rate computed from the same history
 * disagree, so it moved down a layer rather than being copied.
 */
export { statusCategoryAt } from './snapshot.js';
