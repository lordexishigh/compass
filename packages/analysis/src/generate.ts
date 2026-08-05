import {
  assertOffGoalGate,
  assertUnattributedNamesNobody,
  assessAlignment,
  developerDisplayNames,
  type AlignmentVerdict,
} from './alignment.js';
import { detectBlockers, type DetectedBlocker } from './blockers.js';
import { auditProcessCalibration } from './calibration.js';
import { applyChangeAwareness, type PriorReportState } from './change-awareness.js';
import { computeElapsedFacts, type ElapsedFactStatement } from './elapsed.js';
import { orderedEvidence, type EvidenceRef } from './evidence.js';
import { EMPTY_FEEDBACK_LEDGER, applyFeedback, type FeedbackLedger } from './feedback.js';
import type { GoalHierarchy } from './goal-hierarchy.js';
import { entityRef, identifyItem, stableItemId, type IdentifiedItem } from './identity.js';
import { MILLIS_PER_DAY, compareStable, wholeDaysBetween, windowContains, type Instant } from './instant.js';
import { indexCommitGraph } from './ladder.js';
import {
  PROGRESS_CAUSE_KINDS,
  PROGRESS_ENTITY_KEY,
  assessProgress,
  type ProgressAssessment,
} from './progress.js';
import { calibrationVerdictFrom, projectCompletion } from './projection.js';
import { assertNoIndividualRanking } from './ranking-guard.js';
import { generateRecommendations, type Recommendation } from './recommendations.js';
import { aggregateReviewQueue, type ReviewQueue } from './review-queue.js';
import { detectRisks, riskSeverityScore, type DetectedRisk } from './risks.js';
import { SECTIONS, type SectionKey } from './sections.js';
import { resolveScope, type AnalysisSnapshot, type ResolvedScope } from './snapshot.js';
import {
  REPORT_SCHEMA_VERSION,
  assertEveryClaimHasEvidence,
  assertItemIdsMatchTheirCause,
  assertOneChangeTagPerItem,
  assertSixSectionsInOrder,
  assertWholeDayAges,
  type AnalysisFindings,
  type ItemCause,
  type ReportCoverageNote,
  type ReportItem,
  type ReportSection,
  type StructuredReport,
} from './structured-report.js';
import { assessTechnicalDebt } from './technical-debt.js';
import { detectWins, type DetectedWin } from './wins.js';
import { assessWorkload } from './workload.js';
import { detectYesterdayItems, yesterdayHeadline, type YesterdayItem } from './yesterday.js';

/**
 * `generateStructuredReport(snapshot, instant, config)` — the analysis core's one
 * entry point.
 *
 * Pure, total and deterministic. It reads no clock, touches no I/O, generates no
 * id and draws no random number; every judgement it makes comes from the snapshot
 * it was handed and the instant it was told about. Two calls with the same
 * arguments produce byte-identical canonical JSON, which `tests/determinism.test.ts`
 * asserts by running it twice and diffing.
 *
 * It also fails closed. Before returning, it runs the section-order assertion and
 * the no-individual-ranking guard over the whole object. A report that ranked
 * people or dropped a section would be a defect the product could not recover
 * from, so it becomes a thrown error at the boundary instead of a page somebody
 * reads.
 */
export interface AnalysisConfig {
  /**
   * Whether any configured connector reports a deploy signal. Supplied by the
   * caller from the connector's declared capabilities — analysis cannot ask, and
   * must never assume: inventing a deploy from a merge is the single most
   * damaging claim this product could make.
   */
  readonly deploySignalAvailable: boolean;
  /** Coverage notes from the ingest run, passed through to the masthead. */
  readonly coverage: readonly ReportCoverageNote[];
  /** Cap on items rendered per section. The detail stays in `findings`. */
  readonly maxItemsPerSection: number;
  /**
   * The goal hierarchy, already resolved for this instant by the caller that owns
   * the store. Omitted only where there is no store — the analysis core then
   * derives the chain from the objectives and sprint goals already in the
   * snapshot, which is strictly better than calling every commit unattributed.
   * `packages/analysis/src/goal-hierarchy.ts` documents the effective-dating rule
   * both paths obey.
   */
  readonly goalHierarchy?: GoalHierarchy;
  /** Overrides T17, so a manager can tune their own tolerance for a verdict. */
  readonly alignmentThreshold?: number;
  /**
   * The previous report for this scope, reduced to the three fields the comparison
   * needs.
   *
   * Absent means "no earlier report", which the change summary states as its own
   * fact — not as "nothing changed". The caller that owns persistence loads it;
   * analysis stays pure and is simply told.
   */
  readonly priorReport?: PriorReportState;
  /**
   * The manager's feedback, already loaded.
   *
   * Applied once, over the assembled sections, rather than inside each detector. Data
   * in, no lookup: the ledger is a value, so the ten-day simulation in
   * `tests/feedback.test.ts` can chain reports with no database at all.
   */
  readonly feedback?: FeedbackLedger;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = Object.freeze({
  deploySignalAvailable: false,
  coverage: [],
  maxItemsPerSection: 12,
});

export function generateStructuredReport(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
): StructuredReport {
  const scope = resolveScope(snapshot);

  // Order matters here only because later stages consume earlier results — never
  // because a stage mutates shared state. Each of these is a pure function of
  // (snapshot, instant, scope) plus already-computed findings.
  const progress = assessProgress(snapshot, instant, scope);
  const reviewQueue = aggregateReviewQueue(snapshot, instant, scope);
  const workload = assessWorkload(snapshot, instant, scope);
  const technicalDebt = assessTechnicalDebt(snapshot, instant, scope);

  // The Process Calibration Audit runs before the projection, because its verdicts
  // are what choose the projection's method and cap its confidence band. The
  // collar's own verdict is derived from the audit's correlation rather than
  // recomputed, so the two cannot state different numbers for the same statistic.
  const calibrationAudit = auditProcessCalibration(snapshot, instant, scope);
  const calibration = calibrationVerdictFrom(calibrationAudit.statistics.pointToElapsed);
  const projection = projectCompletion(snapshot, instant, scope, progress, calibrationAudit);

  // One parent-edge graph for the whole report. R3 and R4 walk it once per item;
  // building it per item turned a millisecond into a second on the seeded org.
  const commitGraph = indexCommitGraph(snapshot);

  const yesterday = detectYesterdayItems(snapshot, instant, scope, {
    deploySignalAvailable: config.deploySignalAvailable,
    graph: commitGraph,
  });
  const blockers = detectBlockers(snapshot, instant, scope);
  const risks = detectRisks(snapshot, instant, scope, {
    progress,
    reviewQueue,
    workload,
    technicalDebt,
    calibration,
    yesterday,
  });
  const wins = detectWins(snapshot, instant, yesterday);
  const elapsedFacts = computeElapsedFacts(snapshot, instant, scope);
  const alignment = assessAlignment(snapshot, instant, scope, {
    ...(config.goalHierarchy === undefined ? {} : { hierarchy: config.goalHierarchy }),
    ...(config.alignmentThreshold === undefined ? {} : { threshold: config.alignmentThreshold }),
  });
  const recommendations = generateRecommendations(snapshot, instant, scope, {
    blockers,
    reviewQueue,
    risks,
    workload,
    progress,
  });

  const findings: AnalysisFindings = {
    progress,
    projection,
    calibration,
    calibrationAudit,
    reviewQueue,
    workload,
    technicalDebt,
    yesterday,
    blockers,
    risks,
    wins,
    recommendations,
    elapsedFacts,
    alignment,
  };

  // ---- the three passes over the assembled sections ------------------------
  //
  // Order is load-bearing and each step depends on the one before it.
  //
  //  1. **Suppression.** A dismissed, rejected or snoozed item leaves before anything
  //     else looks at it, so it cannot be tagged, cannot lead the section and — the
  //     point — cannot consume one of the section's slots. `findings` keeps it: the
  //     audit trail a manager argues with must contain the thing they dismissed.
  //  2. **Change awareness.** Every survivor is tagged against its own prior self and
  //     the movement is led with. Running this *after* suppression is what makes a
  //     resurfaced risk read as movement rather than as an item that was there all
  //     along.
  //  3. **The cap.** Last, so truncation drops the least interesting items rather
  //     than whichever ones a detector happened to emit first.
  const priorReport = config.priorReport ?? null;
  const priorStableIds = new Set((priorReport?.items ?? []).map((item) => item.stableId));

  const suppression = applyFeedback(
    buildSections(snapshot.organizationId, instant, scope, findings),
    config.feedback ?? EMPTY_FEEDBACK_LEDGER,
    { instant, priorInstant: priorReport?.instant ?? null, priorStableIds },
  );
  const changes = applyChangeAwareness(suppression.sections, priorReport, instant);

  const report: StructuredReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    organizationId: snapshot.organizationId,
    scope: snapshot.scope,
    instant,
    timezone: snapshot.timezone,
    window: snapshot.window,
    sections: changes.sections.map((section) => ({
      ...section,
      items: section.items.slice(0, config.maxItemsPerSection),
    })),
    coverage: [...config.coverage],
    findings,
    changeSummary: changes.summary,
    suppressed: suppression.suppressed,
  };

  assertSixSectionsInOrder(report);
  assertWholeDayAges(report);
  assertOneChangeTagPerItem(report);
  assertItemIdsMatchTheirCause(report);
  assertEveryClaimHasEvidence(report);
  assertNoIndividualRanking(report);
  // The two alignment guards. The first refuses an OFF-GOAL label the gate would
  // not have produced; the second refuses an unattributed item that names a person
  // or states a verdict. Both throw here, in the pure layer, rather than letting a
  // wrong accusation reach a page somebody screenshots.
  assertOffGoalGate(alignment);
  assertUnattributedNamesNobody(alignment.verdicts, developerDisplayNames(snapshot));
  return report;
}

// ---------------------------------------------------------------------------
// The prose spine
// ---------------------------------------------------------------------------

/**
 * The severity score, family by family — the one ordered quantity an item is compared
 * against its own prior self on.
 *
 * **Higher is always worse**, for every family. That is why a sprint at 62% scores 38: a
 * per-family direction flag is a rule every consumer would have to honour, and the first one
 * that did not would report an improving sprint as worsening.
 *
 * Terminal families score zero. A Yesterday completion and a Win are facts about work that
 * already happened; there is nothing for them to be twice as bad as, and they are never
 * compared because their tag is intrinsic.
 */
const SEVERITY_SCORE = Object.freeze({
  terminal: 0,
  /** Working or whole days the condition has held. One day worse per day stuck. */
  blocker: (blocker: DetectedBlocker): number => Math.max(0, Math.round(blocker.measured.value)),
  /** Ten points per subject: more work serving a dead objective is a bigger problem. */
  alignment: (subjects: number): number => subjects * 10,
  /** Urgency, and nothing else. A step for today outranks one for this week. */
  recommendation: (urgency: string): number => (urgency === 'today' ? 200 : 100),
  /** The distance still to go, so a sprint that advances improves. */
  sprint: (completionPercent: number): number => Math.min(100, Math.max(0, 100 - Math.round(completionPercent))),
  velocity: (trend: string): number => (trend === 'falling' ? 200 : trend === 'rising' ? 0 : 100),
});

/** `instant` minus a whole number of days, for a family that carries an age but no onset. */
const onsetFromAge = (instant: Instant, ageDays: number): Instant =>
  (instant - Math.max(0, Math.round(ageDays)) * MILLIS_PER_DAY) as Instant;

/**
 * The Progress section's items are about a team's own process, not an artifact.
 *
 * The entity key is therefore the **scope** — the team, or `merged` for an org-wide report — and not a
 * literal. A literal `process` key gave every team in one organization the same projection, velocity and
 * flow ids, which broke three things at once: a manager dismissing platform's velocity item dismissed
 * every team's, the merged report could not attribute an item to the team whose process it described, and
 * its link down was ambiguous. The sprint item already keyed on its sprint and was never affected.
 */
const progressCause = (scope: ResolvedScope, causeKind: string, entityKey?: string): ItemCause => ({
  entityRef: entityRef('progress', entityKey ?? scope.teamKey ?? PROGRESS_ENTITY_KEY),
  causeKind,
  causeDiscriminator: '',
});

function buildSections(
  organizationId: string,
  instant: Instant,
  scope: ResolvedScope,
  findings: AnalysisFindings,
): readonly ReportSection[] {
  const factsByEntity = indexElapsedFacts(findings.elapsedFacts);

  const items: Readonly<Record<SectionKey, readonly ReportItem[]>> = {
    yesterday: findings.yesterday.map((item) => yesterdayItem(instant, item)),
    progress: progressItems(organizationId, instant, scope, findings),
    blockers: findings.blockers.map((blocker) => blockerItem(instant, blocker, factsByEntity)),
    // Alignment lives in Risks, and after the measured risks rather than before
    // them: work serving an objective the organization stopped funding is a risk to
    // the sprint goal, and the unattributed question is a risk to the alignment
    // claim itself. The Six Spine never grows a seventh section for a new finding.
    risks: [
      ...findings.risks.map((risk) => riskItem(instant, risk)),
      ...findings.alignment.verdicts.map((verdict) => alignmentItem(instant, scope, verdict)),
    ],
    recommendations: findings.recommendations.map((recommendation) => recommendationItem(instant, recommendation)),
    wins: findings.wins.map((win) => winItem(instant, win)),
  };

  const summaries: Readonly<Record<SectionKey, string | undefined>> = {
    yesterday:
      findings.yesterday.length === 0
        ? undefined
        : `${findings.yesterday.length} unit${findings.yesterday.length === 1 ? '' : 's'} of work crossed a completion threshold in this window.`,
    progress: progressSummary(findings.progress),
    blockers: findings.blockers.length === 0 ? undefined : findings.reviewQueue.statement,
    risks: riskSectionSummary(findings),
    recommendations: findings.recommendations.length === 0 ? undefined : 'One step each, all of them finishable today.',
    wins: findings.wins.length === 0 ? undefined : `${findings.wins.length} piece${findings.wins.length === 1 ? '' : 's'} of substantial work landed.`,
  };

  // Uncapped: `generateStructuredReport` applies the cap after suppression and tagging, so a
  // dismissed item does not consume a slot and the movement leads before anything is dropped.
  return SECTIONS.map((definition) => {
    const sectionItems = items[definition.key];
    const summary = summaries[definition.key];
    return {
      key: definition.key,
      index: definition.index,
      title: definition.title,
      items: sectionItems,
      emptyStatement: emptyStatementFor(definition.key, definition.emptyStatement, scope, findings),
      ...(summary === undefined ? {} : { summary }),
    };
  });
}

/**
 * The empty statement, specialised where Compass knows *why* a section is empty.
 *
 * "Nothing is blocked" and "no tracker has been connected" are different facts
 * and a manager must be able to tell them apart. Falling back to the generic
 * sentence is correct only when the section is genuinely, informatively empty.
 */
function emptyStatementFor(
  key: SectionKey,
  fallback: string,
  scope: ResolvedScope,
  findings: AnalysisFindings,
): string {
  if (scope.kind === 'team' && scope.projectKeys.length === 0) {
    return `No project is linked to this team yet, so Compass has nothing to read for ${key}.`;
  }
  if (key === 'progress' && findings.progress.mode === 'no_signal') return findings.progress.statement;
  if (key === 'wins' && findings.yesterday.length > 0) {
    return 'Work landed in this window, but none of it met rule W1 — merged or beyond, and either three points or five working days old.';
  }
  return fallback;
}

function yesterdayItem(instant: Instant, item: YesterdayItem): ReportItem {
  const artifacts = item.artifacts.map((reference) => reference.label).join(', ');
  const ladder = item.ladder;
  // A gap below the highest rung is the interesting half of a completion, so the
  // detail says so rather than leaving the reader to count notches.
  const gap =
    ladder.highestCrossed === ladder.highestContiguous
      ? ''
      : ` A rung below it was never crossed, so this is a claim of completion rather than a chain of one — contiguous to ${ladder.highestContiguous}.`;

  return {
    stableId: item.stableId,
    cause: { entityRef: entityRef('unit_of_work', item.unitOfWork), causeKind: 'completed', causeDiscriminator: '' },
    headline: yesterdayHeadline(item),
    detail: `Reached ${ladder.highestCrossed} ${ladder.highestCrossedLabel ?? ''} — evidence: ${artifacts}.${gap}`.replace(
      /\s+—/,
      ' —',
    ),
    // Intrinsic, and the tagging pass leaves it alone: a completion is resolved whatever
    // yesterday's report said about it.
    changeTag: 'resolved',
    ageDays: wholeDaysBetween(item.completedAt as Instant, instant),
    firstSeenAt: instant,
    severityScore: SEVERITY_SCORE.terminal,
    signalOnsetAt: item.completedAt as Instant,
    evidence: item.artifacts,
    ladder,
  };
}

function progressItems(
  organizationId: string,
  instant: Instant,
  scope: ResolvedScope,
  findings: AnalysisFindings,
): readonly ReportItem[] {
  const progress = findings.progress;
  const identified = (cause: ItemCause): IdentifiedItem => identifyItem(organizationId, cause);

  if (progress.mode === 'no_signal') return [];

  if (progress.mode === 'kanban') return kanbanProgressItems(organizationId, instant, scope, findings, progress);

  const sprint = progress.sprint;
  const unit = sprint.basis === 'story_points' ? 'points' : 'items';
  const done = sprint.basis === 'story_points' ? sprint.completed.points : sprint.completed.tickets;
  const total = sprint.basis === 'story_points' ? sprint.currentScope.points : sprint.currentScope.tickets;

  const items: ReportItem[] = [
    {
      ...identified(progressCause(scope, PROGRESS_CAUSE_KINDS.sprint, sprint.sprintKey)),
      headline: `${sprint.sprintName} is ${sprint.completionPercent}% complete — ${done} of ${total} ${unit}${sprint.goal === null ? '' : `, against "${sprint.goal}"`}`,
      detail: `${sprint.committed.tickets} items were committed at the start and ${sprint.addedMidSprint.tickets} were added since, so the denominator is ${sprint.currentScope.tickets}. Measured in ${unit} because ${
        sprint.basis === 'story_points'
          ? 'the scope is estimated'
          : `${sprint.unestimatedTicketKeys.length} of ${sprint.currentScope.tickets} items carry no estimate`
      }. Completed: ${sprint.completed.ticketKeys.join(', ') || 'nothing yet'}. Remaining: ${sprint.remaining.ticketKeys.join(', ') || 'nothing'}.`,
      changeTag: 'unchanged',
      ageDays: sprint.elapsedWorkingDays,
      firstSeenAt: instant,
      // The distance still to go. A sprint that advances therefore *improves* against
      // yesterday, which is the only reading of a completion percentage that is not backwards.
      severityScore: SEVERITY_SCORE.sprint(sprint.completionPercent),
      signalOnsetAt: sprint.startAt as Instant,
      evidence: sprint.evidence,
    },
  ];

  // The projection is computed from this sprint's remaining scope, so the sprint
  // is what a reader following the marker should land on. A date with no way back
  // to the board behind it is exactly the kind of unfalsifiable claim the
  // evidence rule exists to forbid.
  items.push(projectionItem(organizationId, instant, scope, findings, sprint.evidence));

  if (progress.velocity.kind === 'measured') {
    items.push({
      ...identified(progressCause(scope, PROGRESS_CAUSE_KINDS.velocity)),
      headline: progress.velocity.statement,
      detail: progress.velocity.samples
        .map((sample) => `${sample.sprintName}: ${sample.points} points across ${sample.tickets} items`)
        .join('; '),
      // Provisional: the trend is measured against trailing sprints, not against yesterday's
      // report, and the tagging pass replaces it with the comparison that is.
      changeTag: 'unchanged',
      ageDays: 0,
      firstSeenAt: instant,
      severityScore: SEVERITY_SCORE.velocity(progress.velocity.trend),
      signalOnsetAt: instant,
      // The sprints the mean was taken over, not the one in flight: a reader
      // checking a pace claim needs the sprints that produced it.
      evidence: orderedEvidence(progress.velocity.samples.flatMap((sample) => sample.evidence)),
    });
  }

  return items;
}

/**
 * The Progress section for a team that runs no sprints.
 *
 * Four claims and the projection, where a Scrum team gets the sprint, the projection and
 * its velocity. Each flow figure is its own item rather than a clause inside one, because
 * each is separately dismissable, separately ages, and carries different evidence: the WIP
 * distribution cites what is on the board now, cycle time cites what finished, and the
 * aging list cites only the items that are actually late. One merged item would have to
 * cite all of them at once, which is exactly the undifferentiated evidence chain the
 * design brief rules out.
 *
 * A shape that does not apply is still absent rather than zero. When cycle time could not
 * be measured there is no cycle-time item and no aging item — their refusal sentences say
 * so in `findings.progress`, and the section states one honest absence instead of two
 * claims with nothing behind them.
 */
function kanbanProgressItems(
  organizationId: string,
  instant: Instant,
  scope: ResolvedScope,
  findings: AnalysisFindings,
  progress: Extract<ProgressAssessment, { readonly mode: 'kanban' }>,
): readonly ReportItem[] {
  const flow = progress.flow;
  const identified = (cause: ItemCause): IdentifiedItem => identifyItem(organizationId, cause);
  // Every flow claim is terminal and reads as unchanged while it persists, for the same
  // reason the projection does: a throughput that moved is not a condition that worsened,
  // and the tagging pass has the day counter for saying how long it has been true.
  const common = {
    changeTag: 'unchanged' as const,
    ageDays: 0,
    firstSeenAt: instant,
    severityScore: SEVERITY_SCORE.terminal,
    signalOnsetAt: instant,
  };

  const items: ReportItem[] = [
    {
      ...identified(progressCause(scope, PROGRESS_CAUSE_KINDS.kanbanFlow)),
      ...common,
      headline: flow.statement,
      detail: progress.statement,
      evidence: flow.evidence,
    },
    {
      ...identified(progressCause(scope, PROGRESS_CAUSE_KINDS.kanbanWip)),
      ...common,
      headline: flow.workInProgress.statement,
      detail:
        flow.workInProgress.byColumn.length === 0
          ? 'No column on this board is holding work, so there is nothing to distribute.'
          : `${flow.workInProgress.byColumn
              .map((load) => `${load.column}: ${load.ticketKeys.join(', ')}`)
              .join('. ')}.`,
      evidence: flow.workInProgress.evidence,
    },
  ];

  if (flow.cycleTime.kind === 'measured') {
    const cycleTime = flow.cycleTime;
    items.push({
      ...identified(progressCause(scope, PROGRESS_CAUSE_KINDS.kanbanCycleTime)),
      ...common,
      // The trend belongs in the headline and not in the detail. The template renderer
      // emits an item's headline, its change clause and its evidence — `detail` reaches the
      // structured payload and the narrator, but never the page in the deterministic voice.
      // A trend written into `detail` would therefore be a flow metric that exists in the
      // report object and is invisible in the report, which is the failure mode this whole
      // feature was half-built with.
      headline: `${cycleTime.statement} ${cycleTime.trend.statement}`,
      detail: `Measured over the trailing ${cycleTime.trailingDays} days from ${cycleTime.ticketKeys.join(', ')}.`,
      evidence: cycleTime.evidence,
    });
  }

  if (flow.aging.kind === 'measured') {
    const aging = flow.aging;
    items.push({
      ...identified(progressCause(scope, PROGRESS_CAUSE_KINDS.kanbanAging)),
      ...common,
      headline: aging.statement,
      detail:
        aging.items.length === 0
          ? `Every item in flight is inside the ${aging.p85Days}-day P85 this board's own finished work sets.`
          : aging.items
              .map((item) => `${item.ticketKey} "${item.title}" has been in ${item.column} for ${item.ageDays} days`)
              .join('; ') + '.',
      // Only the late items, so following the marker lands on the work in question and
      // not on the whole board.
      evidence: aging.evidence,
    });
  }

  // A team with no sprints still gets the projection line, and on this path it
  // is almost always the refusal. That is the point: "no completion date,
  // because fewer than two sprints have completed" is the honest answer for a
  // Kanban or brand-new team, and omitting the line entirely would leave the
  // reader to assume Compass simply had not got round to it.
  items.push(projectionItem(organizationId, instant, scope, findings, flow.evidence));

  return items;
}

/**
 * The projected date, or the stated refusal to give one.
 *
 * Either way it carries the *whole* reasoning: the method, the audit verdicts that
 * selected it, and the confidence band. That is the difference between a date a
 * manager can argue with and a date they either believe or ignore — and it is why
 * the refusal arm is built here too rather than being a shorter, quieter branch.
 * "No completion date" with no reason attached reads as a bug in Compass; "no
 * completion date, because two sprints have not completed" reads as an answer.
 */
function projectionItem(
  organizationId: string,
  instant: Instant,
  scope: ResolvedScope,
  findings: AnalysisFindings,
  evidence: readonly EvidenceRef[],
): ReportItem {
  const projection = findings.projection;
  const audit = findings.calibrationAudit;
  const verdicts = projection.selectedByVerdicts;
  const cause = progressCause(scope, PROGRESS_CAUSE_KINDS.projection);
  // The projected date is not a severity: a date moving out is not the same kind of fact as a
  // blocker deepening, and scoring it would make the change tag say something the collar
  // underneath it says better. So it is terminal, and it reads as unchanged while it persists.
  const common = {
    stableId: stableItemId({ organizationId, ...cause }),
    cause,
    changeTag: 'unchanged' as const,
    ageDays: 0,
    firstSeenAt: instant,
    severityScore: SEVERITY_SCORE.terminal,
    signalOnsetAt: instant,
    evidence,
  };
  const because =
    verdicts.length === 0
      ? ''
      : ` Method selected by the calibration audit: ${verdicts.join(', ')}.`;

  if (projection.kind === 'projected') {
    return {
      ...common,
      headline: `Projected completion ${projection.utcDate}`,
      detail: `${projection.statement} ${projection.calibration.statement} Computed by ${projection.reasoning.method === 'cycle_time' ? 'measured cycle time' : 'trailing velocity'} at ${projection.band.confidence} confidence — ${projection.reasoning.formula}.${because} ${audit.statement}`,
    };
  }

  return {
    ...common,
    headline: 'No completion date',
    detail: `${projection.statement}${because} ${audit.statement}`,
  };
}

function progressSummary(progress: ProgressAssessment): string | undefined {
  if (progress.mode === 'sprint') {
    return `${progress.sprint.sprintName}, day ${progress.sprint.elapsedWorkingDays}.`;
  }
  if (progress.mode === 'kanban') return progress.statement;
  return undefined;
}

function blockerItem(
  instant: Instant,
  blocker: DetectedBlocker,
  factsByEntity: ReadonlyMap<string, readonly ElapsedFactStatement[]>,
): ReportItem {
  const facts = factsByEntity.get(blocker.subject.key) ?? [];
  const clause = facts.map((fact) => fact.statement).join(', ');

  return {
    stableId: blocker.stableId,
    // The signal *is* the cause kind, which is what the detector derived the id from. Spelling
    // it again here rather than re-deriving keeps one source: `assertItemIdsMatchTheirCause`
    // would fail the report if the two ever disagreed.
    cause: {
      entityRef: entityRef(blocker.subject.kind, blocker.subject.key),
      causeKind: blocker.signal,
      causeDiscriminator: '',
    },
    headline: blocker.headline,
    detail: blocker.detail,
    // Provisional. `blocker.ageDays === 0` means "detected today", which is a fact about the
    // condition and not about the report — a blocker Compass has been listing for a week is
    // not new because its clock happened to restart. The tagging pass decides.
    changeTag: 'unchanged',
    ageDays: blocker.ageDays,
    firstSeenAt: instant,
    severityScore: SEVERITY_SCORE.blocker(blocker),
    signalOnsetAt: blocker.detectedAt as Instant,
    evidence: blocker.evidence,
    ...(clause.length === 0 ? {} : { changeClause: clause }),
  };
}

function riskItem(instant: Instant, risk: DetectedRisk): ReportItem {
  const prior =
    risk.priorValue === null
      ? 'no comparable prior measurement'
      : `${risk.priorValue} at the start of this window`;

  return {
    stableId: risk.stableId,
    cause: {
      entityRef: entityRef(risk.subject.kind, risk.subject.key),
      causeKind: risk.cause,
      causeDiscriminator: '',
    },
    headline: risk.headline,
    detail: risk.detail,
    // Provisional: `risk.trend` is measured against the start of *this window*, which is a
    // different comparison from "against the report you read yesterday". The tagging pass
    // overwrites it, and the window trend survives in the clause below where it belongs.
    changeTag: 'unchanged',
    ageDays: risk.ageDays,
    firstSeenAt: instant,
    severityScore: riskSeverityScore(risk),
    signalOnsetAt: onsetFromAge(instant, risk.ageDays),
    evidence: risk.evidence,
    changeClause: `${risk.severity} severity, ${risk.trend} — against ${prior}`,
  };
}

function recommendationItem(instant: Instant, recommendation: Recommendation): ReportItem {
  return {
    stableId: recommendation.stableId,
    // From the detector, never rebuilt here: a blocker-derived recommendation's discriminator is
    // the blocker signal, which this item has no other way of knowing.
    cause: recommendation.cause,
    headline: `${recommendation.actor.displayName} — ${recommendation.step}`,
    detail: recommendation.rationale,
    changeTag: 'unchanged',
    ageDays: 0,
    firstSeenAt: instant,
    severityScore: SEVERITY_SCORE.recommendation(recommendation.urgency),
    signalOnsetAt: instant,
    evidence: recommendation.evidence,
    changeClause: recommendation.urgency === 'today' ? 'today' : 'this week',
  };
}

function winItem(instant: Instant, win: DetectedWin): ReportItem {
  return {
    stableId: win.stableId,
    cause: { entityRef: entityRef('unit_of_work', win.unitOfWork), causeKind: 'win', causeDiscriminator: '' },
    headline: win.headline,
    detail: win.detail,
    changeTag: 'resolved',
    ageDays: win.ageWorkingDays,
    firstSeenAt: instant,
    severityScore: SEVERITY_SCORE.terminal,
    signalOnsetAt: instant,
    evidence: win.evidence,
  };
}

/**
 * The Risks lead sentence, which now covers two families.
 *
 * A section carrying only alignment findings must not open with "0 risks crossed a
 * threshold": that is a true sentence about the wrong subject, and it would make
 * the OFF-GOAL verdict underneath it look like an afterthought.
 */
function riskSectionSummary(findings: AnalysisFindings): string | undefined {
  const hasRisks = findings.risks.length > 0;
  const hasAlignment = findings.alignment.verdicts.length > 0;

  if (!hasRisks && !hasAlignment) return undefined;
  if (!hasRisks) return findings.alignment.statement;
  if (!hasAlignment) return riskSummary(findings.risks);
  return `${riskSummary(findings.risks)} ${findings.alignment.statement}`;
}

/**
 * One alignment verdict as a report item.
 *
 * The evidence payload rides on the item, so the web view and the static HTML
 * report both get the resolution path without either having to reach back into
 * `findings` — which is what makes the one-click affordance impossible to ship in
 * only one of the two renderers.
 */
function alignmentItem(instant: Instant, scope: ResolvedScope, verdict: AlignmentVerdict): ReportItem {
  // `off_goal` is keyed on the objective the work serves — an artifact, so two teams both serving that
  // objective legitimately share the id. The unattributed question has no objective and is about *this
  // team's* unplaced work, so it is keyed on the scope: a literal key gave every team one id, and a
  // dismissal of one team's question suppressed the others'.
  //
  // Both spellings match what `alignment.ts` derived its id from, and `assertItemIdsMatchTheirCause` is
  // what proves that rather than this comment — it caught this exact drift when the scope key was added
  // to one side and not the other.
  const cause: ItemCause =
    verdict.kind === 'off_goal'
      ? {
          entityRef: entityRef('objective', verdict.objectiveNodeId ?? ''),
          causeKind: 'off_goal',
          causeDiscriminator: '',
        }
      : {
          entityRef: entityRef('commit', `unattributed:${scope.teamKey ?? 'merged'}`),
          causeKind: 'unattributed',
          causeDiscriminator: '',
        };

  return {
    stableId: verdict.stableId,
    cause,
    headline: verdict.headline,
    detail: verdict.detail,
    changeTag: 'unchanged',
    ageDays: verdict.ageDays,
    firstSeenAt: instant,
    // Ten points per subject: more work serving an objective the organization stopped funding is
    // a bigger problem than one commit, and that is the only direction this can be read in.
    severityScore: SEVERITY_SCORE.alignment(verdict.subjects.length),
    signalOnsetAt: onsetFromAge(instant, verdict.ageDays),
    evidence: verdict.evidenceRefs,
    alignment: {
      kind: verdict.kind,
      label: verdict.label,
      resolvedTier: verdict.resolvedTier,
      confidence: verdict.confidence,
      threshold: verdict.threshold.value / 10_000,
      thresholdId: verdict.threshold.id,
      objectiveNodeId: verdict.objectiveNodeId,
      objectiveTitle: verdict.objectiveTitle,
      question: verdict.question,
      evidence: verdict.evidence,
      subjectLabels: verdict.subjects.map((subject) => subject.label),
    },
  };
}

function riskSummary(risks: readonly DetectedRisk[]): string {
  const high = risks.filter((risk) => risk.severity === 'high').length;
  const worsening = risks.filter((risk) => risk.trend === 'worsened' || risk.trend === 'new').length;
  return `${risks.length} risk${risks.length === 1 ? '' : 's'} crossed a threshold${high > 0 ? `, ${high} at high severity` : ''}${worsening > 0 ? `, ${worsening} moving the wrong way` : ''}.`;
}

function indexElapsedFacts(
  facts: readonly ElapsedFactStatement[],
): ReadonlyMap<string, readonly ElapsedFactStatement[]> {
  const index = new Map<string, ElapsedFactStatement[]>();
  for (const fact of facts) {
    const bucket = index.get(fact.entityId);
    if (bucket === undefined) index.set(fact.entityId, [fact]);
    else bucket.push(fact);
  }
  for (const bucket of index.values()) bucket.sort((left, right) => compareStable(left.stableId, right.stableId));
  return index;
}

/** Whether an instant falls inside the report window. Re-exported for callers. */
export const insideReportWindow = (snapshot: AnalysisSnapshot, instant: Instant): boolean =>
  windowContains(snapshot.window, instant);

export type { DetectedBlocker, DetectedRisk, DetectedWin, ReviewQueue, YesterdayItem };
