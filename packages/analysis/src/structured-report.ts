import type { DetectedBlocker } from './blockers.js';
import type { ElapsedFactStatement } from './elapsed.js';
import type { EvidenceRef } from './evidence.js';
import type { Instant, TimeWindow } from './instant.js';
import type { LadderResult } from './ladder.js';
import { noProgressSignal, type ProgressAssessment } from './progress.js';
import { type CalibrationVerdict, type ProjectedCompletion } from './projection.js';
import type { ReviewQueue } from './review-queue.js';
import type { Recommendation } from './recommendations.js';
import type { DetectedRisk } from './risks.js';
import { SECTIONS, type SectionKey } from './sections.js';
import { thresholdRef } from './thresholds.js';
import type { TechnicalDebtSignal } from './technical-debt.js';
import type { DetectedWin } from './wins.js';
import type { YesterdayItem } from './yesterday.js';
import { WORKLOAD_BASIS, type WorkloadDistribution } from './workload.js';

export type { EvidenceRef } from './evidence.js';

/**
 * The structured report: the versioned contract every renderer reads, and the
 * only thing narration is ever shown.
 *
 * It has two halves, and the split is deliberate.
 *
 * `sections` is the **prose spine** — six sections, fixed order, forever, each a
 * list of items with a headline, a detail and evidence. It is what a renderer
 * walks to produce text, and it is intentionally uniform: a renderer must not
 * need to know that Blockers are shaped differently from Wins.
 *
 * `findings` is the **computed detail** behind those items — the sprint
 * reconciliation table, the review queue rows, the calibration verdict, the
 * projection's reasoning. It is what the web view expands into the evidence
 * gutter, what the weekly digest aggregates, and what a manager reconciles
 * against their board. Every section item is derived from something in
 * `findings`; nothing in `findings` is invented for display.
 *
 * `schemaVersion` is stored on every persisted report row so a consumer can
 * always tell which shape it is holding.
 */
export const REPORT_SCHEMA_VERSION = 2;

export type ReportScope = { readonly kind: 'team'; readonly teamKey: string } | { readonly kind: 'merged' };

export type ChangeTag = 'new' | 'unchanged' | 'worsened' | 'improved' | 'resolved';

export interface ReportItem {
  /**
   * Derived from the underlying entity and cause — never from the report or the
   * run — so the same condition on consecutive days is one item with a history.
   */
  readonly stableId: string;
  readonly headline: string;
  readonly detail: string;
  readonly changeTag: ChangeTag;
  /** Days this item has been continuously present, from its first sighting. */
  readonly ageDays: number;
  readonly evidence: readonly EvidenceRef[];
  /**
   * The five-notch completion meter. Present on Yesterday and Wins items, absent
   * everywhere else — a blocker has not "completed" anything, and rendering an
   * all-empty ladder next to one would suggest otherwise.
   */
  readonly ladder?: LadderResult;
  /**
   * The run-in italic clause: "reviewer added, age unchanged". Never a badge
   * saying NEW.
   */
  readonly changeClause?: string;
}

export interface ReportSection {
  readonly key: SectionKey;
  readonly index: number;
  readonly title: string;
  readonly items: readonly ReportItem[];
  /** Shown in place of the items when there are none. Never a blank space. */
  readonly emptyStatement: string;
  /**
   * The section's one-line summary, in the product's own voice. Present when the
   * section has something to summarise beyond its items — the Progress section's
   * completion sentence, the review queue's depth.
   */
  readonly summary?: string;
}

/** What was and was not ingested, stated plainly under the masthead. */
export interface ReportCoverageNote {
  readonly sourceKey: string;
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly detail: string;
}

/**
 * The computed detail behind the six sections.
 *
 * Every field here is required. An absent finding is represented by its own
 * type's honest empty value — `progress.mode === 'no_signal'`,
 * `projection.kind === 'undefined'` — rather than by the key being missing,
 * because an optional key means every consumer has to decide what its absence
 * means and they will not all decide the same thing.
 */
export interface AnalysisFindings {
  readonly progress: ProgressAssessment;
  readonly projection: ProjectedCompletion;
  readonly calibration: CalibrationVerdict;
  readonly reviewQueue: ReviewQueue;
  readonly workload: WorkloadDistribution;
  readonly technicalDebt: TechnicalDebtSignal;
  readonly yesterday: readonly YesterdayItem[];
  readonly blockers: readonly DetectedBlocker[];
  readonly risks: readonly DetectedRisk[];
  readonly wins: readonly DetectedWin[];
  readonly recommendations: readonly Recommendation[];
  readonly elapsedFacts: readonly ElapsedFactStatement[];
}

export interface StructuredReport {
  readonly schemaVersion: number;
  readonly organizationId: string;
  readonly scope: ReportScope;
  /** The instant the report was generated *for* — not when it was generated. */
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly sections: readonly ReportSection[];
  readonly coverage: readonly ReportCoverageNote[];
  readonly findings: AnalysisFindings;
}

export interface EmptyReportInput {
  readonly organizationId: string;
  readonly scope: ReportScope;
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly coverage?: readonly ReportCoverageNote[];
}

/**
 * The findings of an organization Compass knows nothing about yet.
 *
 * Every field is populated with its type's honest "nothing to say" value, and
 * each one says so in a sentence. This is what the page renders on a fresh
 * install, and it must read as a considered answer rather than as a form that
 * failed to load.
 */
export function emptyFindings(): AnalysisFindings {
  return {
    progress: noProgressSignal(),
    projection: {
      kind: 'undefined',
      reason: 'insufficient_history',
      threshold: thresholdRef('T7'),
      calibration: emptyCalibration(),
      statement: 'There is no history behind this team yet, so Compass will not give you a date.',
    },
    calibration: emptyCalibration(),
    reviewQueue: {
      totalOpen: 0,
      entries: [],
      awaitingFirstReview: 0,
      withNoReviewer: 0,
      oldestAgeDays: 0,
      medianTimeInReviewDays: 0,
      openByReviewer: [],
      concentration: null,
      statement: 'Nothing is waiting for review.',
    },
    workload: {
      basis: WORKLOAD_BASIS,
      perDeveloper: [],
      unassignedOpenItems: 0,
      unassignedItemKeys: [],
      totalOpenItems: 0,
      peopleCarryingWork: 0,
      concentration: null,
      statement: 'Nothing is in flight, so there is no load to distribute.',
    },
    technicalDebt: {
      signals: {
        openTechDebtItems: { name: 'openTechDebtItems', value: 0, ticketKeys: [] },
        netChangeOverTrailingWindow: {
          name: 'netChangeOverTrailingWindow',
          value: 0,
          trailingDays: 28,
          openedTicketKeys: [],
          closedTicketKeys: [],
        },
        meanOpenAgeDays: { name: 'meanOpenAgeDays', value: 0, sampleSize: 0, oldestTicketKey: null, oldestAgeDays: 0 },
        reworkedMergedPullRequestShare: {
          name: 'reworkedMergedPullRequestShare',
          granularity: 'perPullRequest',
          valueBasisPoints: 0,
          numerator: 0,
          denominator: 0,
          cycleCount: 3,
          pullRequestNumbers: [],
        },
      },
      openedPerSprint: [],
      growth: 'flat',
      thresholdsApplied: [thresholdRef('T9')],
      reasons: ['No work has been ingested, so there is nothing labelled tech debt to count.'],
      statement: 'No open work is labelled tech debt, so there is no debt signal to report beyond that fact.',
      evidence: [],
    },
    yesterday: [],
    blockers: [],
    risks: [],
    wins: [],
    recommendations: [],
    elapsedFacts: [],
  };
}

function emptyCalibration(): CalibrationVerdict {
  return {
    verdict: 'not_enough_data',
    sampleSize: 0,
    correlationBasisPoints: null,
    correlationThreshold: thresholdRef('T12'),
    sampleThreshold: thresholdRef('T13'),
    ticketKeys: [],
    statement: 'Nothing has been completed with both an estimate and a measurable duration, so there is nothing to calibrate against.',
  };
}

/**
 * A well-formed report with all six sections and no items — the honest shape for
 * an organization with no signal yet. Pure: the instant is supplied, never read.
 */
export function createEmptyStructuredReport(input: EmptyReportInput): StructuredReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    organizationId: input.organizationId,
    scope: input.scope,
    instant: input.instant,
    timezone: input.timezone,
    window: input.window,
    sections: SECTIONS.map((section) => ({
      key: section.key,
      index: section.index,
      title: section.title,
      items: [],
      emptyStatement: section.emptyStatement,
    })),
    coverage: input.coverage ?? [],
    findings: emptyFindings(),
  };
}

export class SectionOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionOrderError';
  }
}

export class ItemAgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemAgeError';
  }
}

/**
 * `ageDays` is a whole number of days, on every item, always.
 *
 * This is a contract rather than a preference. `ageDays` is the elapsed fact the
 * "day 6" sigil states, the renderer's `elapsed` interpretation template writes it
 * into a clause, and that template's pattern recognises whole days only. So a
 * fractional age does not produce a slightly odd sentence — the renderer emits
 * "day 17.6 of it", fails to recognise its own clause, and throws
 * `UngroundedNumberError` for the *entire report*, taking the page down.
 *
 * That happened: a risk was built from a mean, which is fractional by nature. The
 * fix belongs at the source, and this exists so the next one fails here — in the
 * pure layer, naming the item — instead of three packages away as an
 * ungrounded-number error nobody can trace back.
 */
export function assertWholeDayAges(report: StructuredReport): void {
  for (const section of report.sections) {
    for (const item of section.items) {
      if (!Number.isInteger(item.ageDays) || item.ageDays < 0) {
        throw new ItemAgeError(
          `\`${section.key}/${item.stableId}\` has ageDays ${item.ageDays}. ` +
            'An item age is a whole non-negative number of days: it is the elapsed fact the day sigil states, ' +
            'and the renderer can only interpret whole days. A measurement that happens to be in days — a mean, ' +
            'an average duration — is not this field.',
        );
      }
    }
  }
}

export class UnevidencedClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnevidencedClaimError';
  }
}

/**
 * Every claim carries at least one artifact a reader can open.
 *
 * This is the product's central promise, not a nicety: the web view turns each
 * reference into a superscript marker resolving to the commit SHA, pull request
 * number or tracker key behind the claim, and a claim with no references renders
 * as a confident sentence with nothing to check. That is precisely the "trust the
 * dashboard" posture Compass exists to replace.
 *
 * It is asserted here rather than only in the view because the view can only show
 * what the analysis core put in the payload. An `estimation_noise` risk once
 * shipped with `evidence: []` — a statistical verdict about the team's own
 * estimates, unfalsifiable on the page — and nothing failed, because no test ran
 * the core over a dataset that produced that risk.
 */
export function assertEveryClaimHasEvidence(report: StructuredReport): void {
  for (const section of report.sections) {
    for (const item of section.items) {
      if (item.evidence.length === 0) {
        throw new UnevidencedClaimError(
          `\`${section.key}/${item.stableId}\` carries no evidence: "${item.headline}". ` +
            'Every claim in a Compass report resolves to an artifact a reader can open — a commit SHA, a pull ' +
            'request number or a tracker key. A claim that cannot be checked must not be made.',
        );
      }
    }
  }
}

/** Fails loudly if a report ever grows, loses or reorders a section. */
export function assertSixSectionsInOrder(report: StructuredReport): void {
  if (report.sections.length !== SECTIONS.length) {
    throw new SectionOrderError(
      `A report has exactly ${SECTIONS.length} sections; this one has ${report.sections.length}.`,
    );
  }
  SECTIONS.forEach((expected, position) => {
    const actual = report.sections[position];
    if (!actual || actual.key !== expected.key || actual.index !== expected.index) {
      throw new SectionOrderError(
        `Section ${position + 1} must be \`${expected.key}\`; found \`${actual?.key ?? 'nothing'}\`.`,
      );
    }
  });
}

export function sectionOf(report: StructuredReport, key: SectionKey): ReportSection {
  const section = report.sections.find((candidate) => candidate.key === key);
  if (!section) {
    throw new SectionOrderError(`This report has no \`${key}\` section.`);
  }
  return section;
}

/** Item counts per section, in fixed order — what the spine displays in mono. */
export function sectionCounts(report: StructuredReport): readonly { key: SectionKey; count: number }[] {
  return report.sections.map((section) => ({ key: section.key, count: section.items.length }));
}
