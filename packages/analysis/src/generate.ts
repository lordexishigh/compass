import { detectBlockers, type DetectedBlocker } from './blockers.js';
import { computeElapsedFacts, type ElapsedFactStatement } from './elapsed.js';
import { orderedEvidence } from './evidence.js';
import { compareStable, wholeDaysBetween, windowContains, type Instant } from './instant.js';
import { PROGRESS_ITEM_IDS, assessProgress, type ProgressAssessment } from './progress.js';
import { assessCalibration, projectCompletion } from './projection.js';
import { assertNoIndividualRanking } from './ranking-guard.js';
import { generateRecommendations, type Recommendation } from './recommendations.js';
import { aggregateReviewQueue, type ReviewQueue } from './review-queue.js';
import { detectRisks, type DetectedRisk } from './risks.js';
import { SECTIONS, type SectionKey } from './sections.js';
import { resolveScope, type AnalysisSnapshot, type ResolvedScope } from './snapshot.js';
import {
  REPORT_SCHEMA_VERSION,
  assertEveryClaimHasEvidence,
  assertSixSectionsInOrder,
  assertWholeDayAges,
  type AnalysisFindings,
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
  const calibration = assessCalibration(snapshot, instant, scope);
  const projection = projectCompletion(snapshot, instant, scope, progress);

  const yesterday = detectYesterdayItems(snapshot, instant, scope, {
    deploySignalAvailable: config.deploySignalAvailable,
  });
  const blockers = detectBlockers(snapshot, instant, scope);
  const risks = detectRisks(snapshot, instant, scope, {
    progress,
    reviewQueue,
    workload,
    technicalDebt,
    calibration,
  });
  const wins = detectWins(snapshot, instant, yesterday);
  const elapsedFacts = computeElapsedFacts(snapshot, instant, scope);
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
    reviewQueue,
    workload,
    technicalDebt,
    yesterday,
    blockers,
    risks,
    wins,
    recommendations,
    elapsedFacts,
  };

  const report: StructuredReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    organizationId: snapshot.organizationId,
    scope: snapshot.scope,
    instant,
    timezone: snapshot.timezone,
    window: snapshot.window,
    sections: buildSections(instant, scope, findings, config),
    coverage: [...config.coverage],
    findings,
  };

  assertSixSectionsInOrder(report);
  assertWholeDayAges(report);
  assertEveryClaimHasEvidence(report);
  assertNoIndividualRanking(report);
  return report;
}

// ---------------------------------------------------------------------------
// The prose spine
// ---------------------------------------------------------------------------

function buildSections(
  instant: Instant,
  scope: ResolvedScope,
  findings: AnalysisFindings,
  config: AnalysisConfig,
): readonly ReportSection[] {
  const factsByEntity = indexElapsedFacts(findings.elapsedFacts);

  const items: Readonly<Record<SectionKey, readonly ReportItem[]>> = {
    yesterday: findings.yesterday.map((item) => yesterdayItem(instant, item)),
    progress: progressItems(findings),
    blockers: findings.blockers.map((blocker) => blockerItem(blocker, factsByEntity)),
    risks: findings.risks.map(riskItem),
    recommendations: findings.recommendations.map(recommendationItem),
    wins: findings.wins.map(winItem),
  };

  const summaries: Readonly<Record<SectionKey, string | undefined>> = {
    yesterday:
      findings.yesterday.length === 0
        ? undefined
        : `${findings.yesterday.length} unit${findings.yesterday.length === 1 ? '' : 's'} of work crossed a completion threshold in this window.`,
    progress: progressSummary(findings.progress),
    blockers: findings.blockers.length === 0 ? undefined : findings.reviewQueue.statement,
    risks: findings.risks.length === 0 ? undefined : riskSummary(findings.risks),
    recommendations: findings.recommendations.length === 0 ? undefined : 'One step each, all of them finishable today.',
    wins: findings.wins.length === 0 ? undefined : `${findings.wins.length} piece${findings.wins.length === 1 ? '' : 's'} of substantial work landed.`,
  };

  return SECTIONS.map((definition) => {
    const sectionItems = items[definition.key].slice(0, config.maxItemsPerSection);
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
  return {
    stableId: item.stableId,
    headline: yesterdayHeadline(item),
    detail: `Reached ${item.ladder.highestCrossed} ${item.ladder.highestCrossedLabel ?? ''} — evidence: ${artifacts}.`.replace(
      /\s+—/,
      ' —',
    ),
    changeTag: 'resolved',
    ageDays: wholeDaysBetween(item.completedAt as Instant, instant),
    evidence: item.artifacts,
    ladder: item.ladder,
  };
}

function progressItems(findings: AnalysisFindings): readonly ReportItem[] {
  const progress = findings.progress;

  if (progress.mode === 'no_signal') return [];

  if (progress.mode === 'kanban') {
    const flow = progress.flow;
    return [
      {
        stableId: PROGRESS_ITEM_IDS.kanbanFlow,
        headline: flow.statement,
        detail: progress.statement,
        changeTag: 'unchanged',
        ageDays: 0,
        evidence: flow.evidence,
      },
    ];
  }

  const sprint = progress.sprint;
  const unit = sprint.basis === 'story_points' ? 'points' : 'items';
  const done = sprint.basis === 'story_points' ? sprint.completed.points : sprint.completed.tickets;
  const total = sprint.basis === 'story_points' ? sprint.currentScope.points : sprint.currentScope.tickets;

  const items: ReportItem[] = [
    {
      stableId: PROGRESS_ITEM_IDS.sprint(sprint.sprintKey),
      headline: `${sprint.sprintName} is ${sprint.completionPercent}% complete — ${done} of ${total} ${unit}${sprint.goal === null ? '' : `, against "${sprint.goal}"`}`,
      detail: `${sprint.committed.tickets} items were committed at the start and ${sprint.addedMidSprint.tickets} were added since, so the denominator is ${sprint.currentScope.tickets}. Measured in ${unit} because ${
        sprint.basis === 'story_points'
          ? 'the scope is estimated'
          : `${sprint.unestimatedTicketKeys.length} of ${sprint.currentScope.tickets} items carry no estimate`
      }. Completed: ${sprint.completed.ticketKeys.join(', ') || 'nothing yet'}. Remaining: ${sprint.remaining.ticketKeys.join(', ') || 'nothing'}.`,
      changeTag: 'unchanged',
      ageDays: sprint.elapsedWorkingDays,
      evidence: sprint.evidence,
    },
  ];

  // The projection is computed from this sprint's remaining scope, so the sprint
  // is what a reader following the marker should land on. A date with no way back
  // to the board behind it is exactly the kind of unfalsifiable claim the
  // evidence rule exists to forbid.
  if (findings.projection.kind === 'projected') {
    items.push({
      stableId: PROGRESS_ITEM_IDS.projection,
      headline: `Projected completion ${findings.projection.utcDate}`,
      detail: `${findings.projection.statement} ${findings.projection.calibration.statement}`,
      changeTag: 'unchanged',
      ageDays: 0,
      evidence: sprint.evidence,
    });
  } else {
    items.push({
      stableId: PROGRESS_ITEM_IDS.projection,
      headline: 'No completion date',
      detail: findings.projection.statement,
      changeTag: 'unchanged',
      ageDays: 0,
      evidence: sprint.evidence,
    });
  }

  if (progress.velocity.kind === 'measured') {
    items.push({
      stableId: PROGRESS_ITEM_IDS.velocity,
      headline: progress.velocity.statement,
      detail: progress.velocity.samples
        .map((sample) => `${sample.sprintName}: ${sample.points} points across ${sample.tickets} items`)
        .join('; '),
      changeTag: progress.velocity.trend === 'falling' ? 'worsened' : progress.velocity.trend === 'rising' ? 'improved' : 'unchanged',
      ageDays: 0,
      // The sprints the mean was taken over, not the one in flight: a reader
      // checking a pace claim needs the sprints that produced it.
      evidence: orderedEvidence(progress.velocity.samples.flatMap((sample) => sample.evidence)),
    });
  }

  return items;
}

function progressSummary(progress: ProgressAssessment): string | undefined {
  if (progress.mode === 'sprint') {
    return `${progress.sprint.sprintName}, day ${progress.sprint.elapsedWorkingDays}.`;
  }
  if (progress.mode === 'kanban') return progress.statement;
  return undefined;
}

function blockerItem(
  blocker: DetectedBlocker,
  factsByEntity: ReadonlyMap<string, readonly ElapsedFactStatement[]>,
): ReportItem {
  const facts = factsByEntity.get(blocker.subject.key) ?? [];
  const clause = facts.map((fact) => fact.statement).join(', ');

  return {
    stableId: blocker.stableId,
    headline: blocker.headline,
    detail: blocker.detail,
    changeTag: blocker.ageDays === 0 ? 'new' : 'unchanged',
    ageDays: blocker.ageDays,
    evidence: blocker.evidence,
    ...(clause.length === 0 ? {} : { changeClause: clause }),
  };
}

function riskItem(risk: DetectedRisk): ReportItem {
  const prior =
    risk.priorValue === null
      ? 'no comparable prior measurement'
      : `${risk.priorValue} at the start of this window`;

  return {
    stableId: risk.stableId,
    headline: risk.headline,
    detail: risk.detail,
    changeTag: risk.trend === 'improving' ? 'improved' : risk.trend === 'worsened' ? 'worsened' : risk.trend === 'new' ? 'new' : 'unchanged',
    ageDays: risk.ageDays,
    evidence: risk.evidence,
    changeClause: `${risk.severity} severity, ${risk.trend} — against ${prior}`,
  };
}

function recommendationItem(recommendation: Recommendation): ReportItem {
  return {
    stableId: recommendation.stableId,
    headline: `${recommendation.actor.displayName} — ${recommendation.step}`,
    detail: recommendation.rationale,
    changeTag: 'new',
    ageDays: 0,
    evidence: recommendation.evidence,
    changeClause: recommendation.urgency === 'today' ? 'today' : 'this week',
  };
}

function winItem(win: DetectedWin): ReportItem {
  return {
    stableId: win.stableId,
    headline: win.headline,
    detail: win.detail,
    changeTag: 'resolved',
    ageDays: win.ageWorkingDays,
    evidence: win.evidence,
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
