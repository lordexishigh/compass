import type {
  AlignmentAssessment,
  AlignmentClass,
  AlignmentEvidence,
  AlignmentVerdictKind,
} from './alignment.js';
import type { DetectedBlocker } from './blockers.js';
import { emptyCalibrationAudit, type CalibrationAudit } from './calibration.js';
import type { ElapsedFactStatement } from './elapsed.js';
// The vocabulary only, from a leaf that imports nothing. `feedback.ts` names `ReportItem` and this
// module has to name a feedback action, which together would be a cycle — so the closed set of
// verdicts lives on its own, below both.
import type { FeedbackAction } from './feedback-actions.js';
import { stableItemId, type ItemCause } from './identity.js';
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

/**
 * The three coordinates a report item's identity is derived from.
 *
 * Declared in `identity.ts` beside the derivation itself and re-exported here, because the
 * item carrying them is what makes a feedback record keyable on the *condition* rather than
 * on the digest. `stableId` and `cause` are therefore not two facts but one, stated twice for
 * two different readers: the id is what a row, a URL and a lookup use, and the cause is what a
 * verdict is recorded against. `assertItemIdsMatchTheirCause` proves they cannot disagree.
 */
export type { ItemCause };

/** A manager's verdict, as it reaches the page. Never a badge. */
export interface ReportItemFeedback {
  /**
   * `accepted` — the manager took this step and Compass is not re-suggesting it.
   * `resurfaced` — a dismissed risk whose evidence materially worsened.
   */
  readonly state: 'accepted' | 'resurfaced';
  readonly action: string;
  /** When the verdict was recorded. */
  readonly at: Instant;
  /** The run-in clause the renderer prints. */
  readonly clause: string;
}

export interface ReportItem {
  /**
   * Derived from the underlying entity and cause — never from the report or the
   * run — so the same condition on consecutive days is one item with a history.
   */
  readonly stableId: string;
  /** The coordinates `stableId` was derived from, and feedback is recorded against. */
  readonly cause: ItemCause;
  readonly headline: string;
  readonly detail: string;
  readonly changeTag: ChangeTag;
  /**
   * The age of the *condition*, in whole days, from the knowledge model's own
   * history. A ticket that had already been stalled for six days when Compass was
   * installed was stalled for six days, and this is that number.
   */
  readonly ageDays: number;
  /**
   * The first report that carried this item id.
   *
   * A different fact from `ageDays`, and the product states both: this is what
   * "unchanged since Compass first reported it — day 6 of it" is counted from, and
   * what a manager's sense of "you keep telling me this" is actually about. On a
   * `new` item it is the report's own instant.
   */
  readonly firstSeenAt: Instant;
  /**
   * The one ordered quantity this item is compared against its own prior self on.
   *
   * **Higher is always worse**, for every family, which is why a sprint at 62%
   * scores 38 rather than 62. The alternative — a per-family direction flag — is a
   * rule every consumer has to honour and one of them eventually will not, at which
   * point the page reports an improving sprint as worsening. `generate.ts`
   * documents the mapping family by family.
   */
  readonly severityScore: number;
  /**
   * When the underlying condition began.
   *
   * This is what makes "already resolved" a durable verdict rather than a one-day
   * reprieve: a blocker's age grows every morning, so a suppression keyed on
   * severity would lapse immediately, while one keyed on onset holds for as long as
   * it is the same episode and lets a genuinely new one through.
   */
  readonly signalOnsetAt: Instant;
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
  /**
   * The resolution path behind an alignment claim, attached to the claim itself.
   *
   * Present only on alignment items. It is carried *on the item* rather than left
   * in `findings` so that every render path gets the evidence for free: the web
   * view and the static HTML report each read the item they are already rendering,
   * and neither can ship an alignment verdict with no way to check it. That is the
   * failure mode the one-click criterion exists to prevent, and a shared field is
   * the only arrangement in which the two renderers cannot diverge.
   */
  readonly alignment?: ReportItemAlignment;
  /**
   * The manager's own verdict on this item, when there is one.
   *
   * Absent is the common case. Present means the item is not a fresh finding: it is
   * a step they already accepted, or a risk they dismissed which has come back
   * because its evidence materially worsened.
   */
  readonly feedback?: ReportItemFeedback;
}

/**
 * Everything the evidence panel prints, in one place.
 *
 * `evidence` is the tier-specific payload — a chain of node ids, a matched
 * substring with its offset, or two compared texts with a score. `confidence` and
 * `threshold` are stated separately and always, because "0.62 against a threshold
 * of 0.30" is the sentence that makes a verdict arguable, and an item that showed
 * one without the other would invite the reader to guess the comparison.
 */
export interface ReportItemAlignment {
  readonly kind: AlignmentVerdictKind;
  /** `OFF-GOAL`, or null for an unattributed item. */
  readonly label: string | null;
  readonly resolvedTier: AlignmentClass;
  readonly confidence: number;
  readonly threshold: number;
  /** The numbered rule the confidence was compared against. */
  readonly thresholdId: string;
  readonly objectiveNodeId: string | null;
  readonly objectiveTitle: string | null;
  /** The question an unattributed item asks. Null on an off-goal verdict. */
  readonly question: string | null;
  readonly evidence: AlignmentEvidence;
  /** The artifacts the verdict is about: `PLAT-742`, `4f5a6b7`. */
  readonly subjectLabels: readonly string[];
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
  /**
   * The Process Calibration Audit: seven statistics about whether the data behind
   * this report means anything, and the closed set of verdicts they produced.
   *
   * It sits in `findings` rather than in a seventh section because the Six Spine
   * never grows. Its verdicts reach the reader in two places instead: the
   * confidence collar under the projected date, which states them in the product's
   * own voice, and the Risks section, which carries the ones that are risks.
   */
  readonly calibrationAudit: CalibrationAudit;
  readonly reviewQueue: ReviewQueue;
  readonly workload: WorkloadDistribution;
  readonly technicalDebt: TechnicalDebtSignal;
  readonly yesterday: readonly YesterdayItem[];
  readonly blockers: readonly DetectedBlocker[];
  readonly risks: readonly DetectedRisk[];
  readonly wins: readonly DetectedWin[];
  readonly recommendations: readonly Recommendation[];
  readonly elapsedFacts: readonly ElapsedFactStatement[];
  /**
   * Every alignment resolution behind the section, not only the ones that became
   * verdicts. A manager arguing with an OFF-GOAL flag needs to see what the other
   * twenty commits resolved to as well, and the coverage rows are what "Compass
   * placed 20 of 25 commits" is read from.
   */
  readonly alignment: AlignmentAssessment;
}

/**
 * What the change-awareness pass concluded about the report as a whole.
 *
 * Declared here, with the contract it is a field of, rather than beside the pass that computes it:
 * every renderer reads it, and `applyChangeAwareness` is one of several things that could
 * legitimately produce it (a time-travel replay produces one too).
 */
export interface ReportChangeSummary {
  readonly hasPriorReport: boolean;
  /** The prior report's instant, so the page can say what "since yesterday" means. */
  readonly priorInstant: Instant | null;
  /**
   * True only when every item present is `unchanged` *and* nothing departed.
   *
   * The second half matters as much as the first: a blocker resolved overnight leaves the report
   * entirely, and a summary that looked only at the items still present would call that morning
   * quiet.
   */
  readonly nothingMaterialChanged: boolean;
  readonly statement: string;
  readonly counts: Readonly<Record<ChangeTag, number>>;
  /** Ids present in the prior report and absent now — conditions that stopped holding. */
  readonly departedStableIds: readonly string[];
}

/**
 * One item a manager's feedback removed from this report, and why.
 *
 * Carried on the report rather than dropped, because a suppression a manager cannot find is
 * indistinguishable from a detector that broke.
 */
export interface SuppressedItemNote {
  readonly sectionKey: SectionKey;
  readonly stableId: string;
  readonly cause: ItemCause;
  readonly action: FeedbackAction;
  readonly headline: string;
  /** One sentence, in the product's voice, for the corrections screen and the audit. */
  readonly statement: string;
  /** When the manager's verdict was recorded. */
  readonly at: Instant;
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
  /**
   * What moved since the previous report for this scope, and the plain statement
   * that nothing did.
   *
   * Required, never optional. A report with no prior to compare against says so in
   * its own sentence, which is a different fact from "nothing changed" and must not
   * be rendered as one.
   */
  readonly changeSummary: ReportChangeSummary;
  /**
   * Everything a manager's feedback removed from this report, and why.
   *
   * Carried on the report rather than dropped, because a suppression a manager
   * cannot find is indistinguishable from a detector that broke. The corrections
   * screen lists these; the six sections do not.
   */
  readonly suppressed: readonly SuppressedItemNote[];
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
      selectedByVerdicts: ['insufficient_history'],
      statement: 'There is no history behind this team yet, so Compass will not give you a date.',
    },
    calibration: emptyCalibration(),
    calibrationAudit: emptyCalibrationAudit(),
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
    alignment: {
      threshold: thresholdRef('T17'),
      hierarchyResolvedAt: 0,
      goalNodeCount: 0,
      resolutions: [],
      coverage: [],
      verdicts: [],
      statement:
        'No goal hierarchy has been configured, so Compass has nothing to align this work against and will not guess.',
    },
  };
}

function emptyCalibration(): CalibrationVerdict {
  return {
    verdict: 'not_enough_data',
    sampleSize: 0,
    correlation: emptyCalibrationAudit().statistics.pointToElapsed,
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
    // An organization Compass knows nothing about has no prior report and no items, so
    // neither "nothing changed" nor a count of movement would be true. It says what it is.
    changeSummary: {
      hasPriorReport: false,
      priorInstant: null,
      nothingMaterialChanged: false,
      statement:
        'Compass has generated no earlier report for this scope, so there is nothing to compare this one against yet.',
      counts: { new: 0, unchanged: 0, worsened: 0, improved: 0, resolved: 0 },
      departedStableIds: [],
    },
    suppressed: [],
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

export class ItemCauseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemCauseMismatchError';
  }
}

/**
 * Every item's id is the derivation of the cause printed beside it.
 *
 * This is the assertion that makes carrying both fields safe. A feedback record is keyed on the
 * cause and matched against the item by id; if a detector's id came from one set of coordinates
 * and the cause it advertises came from another, a manager's dismissal would be recorded against
 * a condition that no item will ever match. Nothing would throw, nothing would look wrong, and
 * every button on the page would silently do nothing — which is precisely the "feedback that
 * visibly doesn't stick" failure this task exists to prevent.
 *
 * So the report fails to generate instead, in the pure layer, naming the item.
 */
export function assertItemIdsMatchTheirCause(report: StructuredReport): void {
  for (const section of report.sections) {
    for (const item of section.items) {
      const derived = stableItemId({ organizationId: report.organizationId, ...item.cause });
      if (derived !== item.stableId) {
        throw new ItemCauseMismatchError(
          `\`${section.key}\` carries an item with id \`${item.stableId}\` whose advertised cause ` +
            `(${item.cause.entityRef} / ${item.cause.causeKind} / "${item.cause.causeDiscriminator}") derives to ` +
            `\`${derived}\`. Feedback is recorded against the cause and matched by the id, so a mismatch means ` +
            'every dismissal, snooze and correction for this item would be written and then never found again.',
        );
      }
    }
  }
}

export class ChangeTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeTagError';
  }
}

/**
 * Every item carries exactly one change tag from the closed set, and a `firstSeenAt`
 * that is not in the future.
 *
 * "Exactly one" is structural — the field is singular — so what this actually proves
 * is that the value is one of the five and that the tagging pass ran at all. An item
 * that reached a page with a producer's provisional tag and a `firstSeenAt` of zero
 * would render as day 20,000 of a blocker, and the number would be interpreted by
 * the renderer as a grounded fact.
 *
 * It throws in the pure layer, naming the item, rather than letting either reach a
 * reader — the same posture as the age and evidence assertions beside it.
 */
export function assertOneChangeTagPerItem(report: StructuredReport): void {
  const permitted: readonly ChangeTag[] = ['new', 'unchanged', 'worsened', 'improved', 'resolved'];

  for (const section of report.sections) {
    for (const item of section.items) {
      if (!permitted.includes(item.changeTag)) {
        throw new ChangeTagError(
          `\`${section.key}/${item.stableId}\` carries the change tag \`${item.changeTag}\`, which is not one of ` +
            `${permitted.join(', ')}. Every item carries exactly one, computed against the prior report for this scope.`,
        );
      }
      if (!Number.isFinite(item.firstSeenAt) || item.firstSeenAt > report.instant) {
        throw new ChangeTagError(
          `\`${section.key}/${item.stableId}\` was first seen at ${item.firstSeenAt}, which is after this report's ` +
            `instant ${report.instant}. An item cannot have been reported before Compass generated the report ` +
            'reporting it, and the age the page prints is counted from this field.',
        );
      }
      if (!Number.isInteger(item.severityScore)) {
        throw new ChangeTagError(
          `\`${section.key}/${item.stableId}\` has a severity score of ${item.severityScore}. The score is the one ` +
            'ordered quantity an item is compared against its own prior self on, and a fractional one would make ' +
            'the same condition read as worsened on a rounding difference.',
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
