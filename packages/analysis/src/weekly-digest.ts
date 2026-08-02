import { compareStable, type Instant, type TimeWindow } from './instant.js';
import type { StructuredReport } from './structured-report.js';

/**
 * The weekly digest: six topics, prose only, and honest about what it cannot compute.
 *
 * ## Why it reads the daily report's findings rather than the model
 *
 * Every number here already exists. `assessVelocity`, `assessWorkload`, `aggregateReviewQueue`,
 * `assessTechnicalDebt`, `detectRisks` and `generateRecommendations` produced them for the daily, and
 * the daily is the unit of record. Re-deriving them for the weekly would create a second opinion about
 * the same week — a digest saying velocity is 31 while Monday's report said 28 is worse than no digest
 * at all, because the manager cannot tell which one to quote.
 *
 * It also makes the determinism criterion structural rather than aspirational: the digest is a pure
 * function of one already-deterministic structured report, so the same `(organization, team, instant)`
 * produces byte-identical output by construction. Nothing here reads a clock, and the narrator — which
 * cannot be deterministic, because it is a model — is only ever allowed to *phrase* what this computed.
 *
 * ## The six topics, and the named producer of each
 *
 * The acceptance criterion asks that each topic name its producer in the payload, and that is worth
 * more than provenance for its own sake: it is what lets a manager who disputes a sentence find the
 * function that wrote it. So `producer` is a required field on every topic, carrying the analysis
 * function's own name.
 *
 * ## Undefined is a state, not a zero
 *
 * A team in its first fortnight has no velocity trend, and Compass says so — "two completed sprints
 * are needed and one has completed" — rather than printing `0` or a bare `—`. That is the honest
 * degradation rule the whole product runs on: a fabricated number is worse than an absent one because
 * a manager acts on it. Each topic is therefore either `stated` with a sentence and its evidence, or
 * `undefined` with the reason it could not be computed; there is no third arm and no null-shaped
 * middle ground for a renderer to guess at.
 */

export const WEEKLY_DIGEST_SCHEMA_VERSION = 1;

/**
 * The six topics, in the order they are read.
 *
 * Fixed like the Six Spine, and for the same reason: a weekly whose topics reordered between two weeks
 * would have to be re-learned every week. The order runs from *what happened* through *what is
 * accumulating* to *what to do*, so the reader arrives at the priorities having already been given the
 * evidence for them.
 */
export const WEEKLY_TOPIC_KEYS = [
  'velocityTrend',
  'workloadDistribution',
  'reviewBottlenecks',
  'technicalDebtGrowth',
  'upcomingRisks',
  'suggestedPriorities',
] as const;

export type WeeklyTopicKey = (typeof WEEKLY_TOPIC_KEYS)[number];

/** The analysis function behind each topic. Named in the payload so a claim can be traced to code. */
export const WEEKLY_TOPIC_PRODUCER: Readonly<Record<WeeklyTopicKey, string>> = Object.freeze({
  velocityTrend: 'assessVelocity',
  workloadDistribution: 'assessWorkload',
  reviewBottlenecks: 'aggregateReviewQueue',
  technicalDebtGrowth: 'assessTechnicalDebt',
  upcomingRisks: 'detectRisks',
  suggestedPriorities: 'generateRecommendations',
});

/** The heading each topic reads under. Prose, not a metric label. */
export const WEEKLY_TOPIC_TITLE: Readonly<Record<WeeklyTopicKey, string>> = Object.freeze({
  velocityTrend: 'Velocity trend',
  workloadDistribution: 'Workload distribution',
  reviewBottlenecks: 'Review bottlenecks',
  technicalDebtGrowth: 'Technical debt growth',
  upcomingRisks: 'Upcoming risks',
  suggestedPriorities: 'Suggested priorities',
});

export type WeeklyTopic =
  | {
      readonly key: WeeklyTopicKey;
      readonly title: string;
      readonly producer: string;
      readonly state: 'stated';
      /** The topic's sentences, already written by the producer that computed them. */
      readonly statement: string;
      /** Supporting lines: the samples, the named people, the tickets. Never a chart. */
      readonly detail: readonly string[];
    }
  | {
      readonly key: WeeklyTopicKey;
      readonly title: string;
      readonly producer: string;
      readonly state: 'undefined';
      /**
       * Why there is no figure, in the product's voice.
       *
       * Always a sentence naming what is missing and what would fix it. "Insufficient history" is a
       * status code; "two completed sprints are needed and one has completed" is an answer.
       */
      readonly statement: string;
    };

export interface WeeklyDigest {
  readonly schemaVersion: number;
  readonly organizationId: string;
  readonly teamKey: string;
  /** The instant the digest was generated *for*. Never read from a clock. */
  readonly instant: Instant;
  readonly timezone: string;
  /** The trailing week the digest covers. */
  readonly window: TimeWindow;
  readonly topics: readonly WeeklyTopic[];
  /** The topics that could not be computed, named so the reader is told rather than left counting. */
  readonly undefinedTopicKeys: readonly WeeklyTopicKey[];
  /** One sentence opening the digest, and the whole digest on a week with no history. */
  readonly summary: string;
}

/** The trailing days a weekly digest covers. Seven, so "the week" means the week. */
export const WEEKLY_DIGEST_TRAILING_DAYS = 7;

export interface WeeklyDigestInput {
  readonly teamKey: string;
  /** The daily report the digest is built from — already generated, already the unit of record. */
  readonly report: StructuredReport;
}

/**
 * Builds the digest from one already-generated daily report.
 *
 * The window is the trailing seven days ending at the report's own instant, computed from the report
 * rather than from a clock: a digest generated for a past instant covers that instant's week, which is
 * what makes it replayable under the time-travel control.
 */
export function buildWeeklyDigest(input: WeeklyDigestInput): WeeklyDigest {
  const { report } = input;
  const findings = report.findings;

  const topics: WeeklyTopic[] = [
    velocityTopic(findings.progress),
    workloadTopic(findings.workload),
    reviewTopic(findings.reviewQueue),
    debtTopic(findings.technicalDebt),
    risksTopic(findings.risks),
    prioritiesTopic(findings.recommendations),
  ];

  const undefinedTopicKeys = topics
    .filter((topic) => topic.state === 'undefined')
    .map((topic) => topic.key);

  return {
    schemaVersion: WEEKLY_DIGEST_SCHEMA_VERSION,
    organizationId: report.organizationId,
    teamKey: input.teamKey,
    instant: report.instant,
    timezone: report.timezone,
    window: {
      start: (report.instant - WEEKLY_DIGEST_TRAILING_DAYS * 86_400_000) as Instant,
      end: report.instant,
    },
    topics,
    undefinedTopicKeys,
    summary: digestSummary(undefinedTopicKeys),
  };
}

/**
 * The digest's opening sentence, which names what it could not compute.
 *
 * Stated at the top rather than left for the reader to discover four topics down. A weekly that
 * silently omitted its undefined topics would read as a complete picture of a week Compass does not
 * actually have the history for.
 */
export function digestSummary(undefinedTopicKeys: readonly WeeklyTopicKey[]): string {
  if (undefinedTopicKeys.length === 0) {
    return `All ${WEEKLY_TOPIC_KEYS.length} weekly topics have enough history behind them to state a figure.`;
  }
  if (undefinedTopicKeys.length === WEEKLY_TOPIC_KEYS.length) {
    return 'Compass has too little history behind this team to state any of the six weekly topics yet, and each one below says what it is waiting for.';
  }

  const named = undefinedTopicKeys.map((key) => WEEKLY_TOPIC_TITLE[key].toLowerCase()).join(', ');
  return `${WEEKLY_TOPIC_KEYS.length - undefinedTopicKeys.length} of the ${WEEKLY_TOPIC_KEYS.length} weekly topics have enough history to state a figure; ${named} do not, and say what they are waiting for.`;
}

const stated = (
  key: WeeklyTopicKey,
  statement: string,
  detail: readonly string[] = [],
): WeeklyTopic => ({
  key,
  title: WEEKLY_TOPIC_TITLE[key],
  producer: WEEKLY_TOPIC_PRODUCER[key],
  state: 'stated',
  statement,
  detail,
});

const undefinedTopic = (key: WeeklyTopicKey, statement: string): WeeklyTopic => ({
  key,
  title: WEEKLY_TOPIC_TITLE[key],
  producer: WEEKLY_TOPIC_PRODUCER[key],
  state: 'undefined',
  statement,
});

// ---------------------------------------------------------------------------
// The six topics
// ---------------------------------------------------------------------------

function velocityTopic(progress: StructuredReport['findings']['progress']): WeeklyTopic {
  if (progress.mode === 'no_signal') {
    return undefinedTopic('velocityTrend', progress.statement);
  }
  if (progress.mode === 'kanban') {
    // A team with no sprints has no velocity, and saying so is more useful than converting its flow
    // figure into a pace it never committed to. The producer's own sentence already explains why.
    return undefinedTopic('velocityTrend', progress.statement);
  }

  const velocity = progress.velocity;
  if (velocity.kind !== 'measured') {
    // The producer's own refusal sentence, which already names the threshold and what was found.
    return undefinedTopic('velocityTrend', velocity.statement);
  }

  return stated(
    'velocityTrend',
    velocity.statement,
    velocity.samples.map((sample) => `${sample.sprintName}: ${sample.points} points across ${sample.tickets} items`),
  );
}

function workloadTopic(workload: StructuredReport['findings']['workload']): WeeklyTopic {
  if (workload.totalOpenItems === 0) {
    return undefinedTopic(
      'workloadDistribution',
      'Nothing is in flight for this team, so there is no load to distribute and no distribution to report.',
    );
  }

  const detail: string[] = [];
  if (workload.concentration !== null) detail.push(workload.concentration.statement);
  if (workload.unassignedOpenItems > 0) {
    detail.push(
      `${workload.unassignedOpenItems} open item${workload.unassignedOpenItems === 1 ? '' : 's'} carry no assignee: ${workload.unassignedItemKeys.join(', ')}.`,
    );
  }

  return stated('workloadDistribution', workload.statement, detail);
}

function reviewTopic(reviewQueue: StructuredReport['findings']['reviewQueue']): WeeklyTopic {
  if (reviewQueue.totalOpen === 0) {
    return undefinedTopic(
      'reviewBottlenecks',
      'No pull request was open for review in this window, so there is no queue to find a bottleneck in.',
    );
  }

  const detail: string[] = [];
  if (reviewQueue.concentration !== null) detail.push(reviewQueue.concentration.statement);
  detail.push(
    `${reviewQueue.awaitingFirstReview} of ${reviewQueue.totalOpen} awaiting a first review; the oldest has waited ${reviewQueue.oldestAgeDays} days.`,
  );

  return stated('reviewBottlenecks', reviewQueue.statement, detail);
}

function debtTopic(debt: StructuredReport['findings']['technicalDebt']): WeeklyTopic {
  const open = debt.signals.openTechDebtItems.value;
  if (open === 0) {
    // Not a zero dressed as a trend: no labelled debt means there is no growth to measure, which is a
    // different fact from "growth is flat".
    return undefinedTopic(
      'technicalDebtGrowth',
      'No open work is labelled tech debt, so there is no debt trend to measure beyond that fact.',
    );
  }

  return stated('technicalDebtGrowth', debt.statement, [...debt.reasons]);
}

function risksTopic(risks: StructuredReport['findings']['risks']): WeeklyTopic {
  if (risks.length === 0) {
    return undefinedTopic(
      'upcomingRisks',
      'No risk crossed its threshold this week, so Compass is naming none rather than listing what it is watching.',
    );
  }

  // Severity order, then the item id — the same total order the daily's Risks section uses, so the
  // weekly cannot list them in a different sequence from the report it was built from.
  const rank: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };
  const ordered = [...risks].sort(
    (left, right) => (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3) || compareStable(left.stableId, right.stableId),
  );

  return stated(
    'upcomingRisks',
    `${risks.length} risk${risks.length === 1 ? '' : 's'} crossed a threshold this week and ${ordered.filter((risk) => risk.trend === 'worsened' || risk.trend === 'new').length} of them are moving the wrong way.`,
    ordered.map((risk) => `${risk.severity} severity, ${risk.trend}: ${risk.headline}`),
  );
}

function prioritiesTopic(recommendations: StructuredReport['findings']['recommendations']): WeeklyTopic {
  if (recommendations.length === 0) {
    return undefinedTopic(
      'suggestedPriorities',
      'Nothing this week produced a step Compass would put in front of you, so it is suggesting no priorities rather than inventing some.',
    );
  }

  // Today before this week, then the item id. A weekly whose priorities reordered between two reads of
  // the same week would not be a list anybody could act on.
  const ordered = [...recommendations].sort(
    (left, right) =>
      Number(right.urgency === 'today') - Number(left.urgency === 'today') ||
      compareStable(left.stableId, right.stableId),
  );

  return stated(
    'suggestedPriorities',
    `${recommendations.length} step${recommendations.length === 1 ? '' : 's'} would move this team furthest next week, and ${ordered.filter((entry) => entry.urgency === 'today').length} of them are finishable today.`,
    ordered.map((entry) => `${entry.actor.displayName} — ${entry.step}`),
  );
}
