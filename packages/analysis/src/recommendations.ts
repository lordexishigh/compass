import type { DetectedBlocker } from './blockers.js';
import { blockerTicket } from './blockers.js';
import { orderedEvidence, ticketEvidence, type EvidenceRef } from './evidence.js';
import { compareNumbers, compareStable, type Instant } from './instant.js';
import type { ProgressAssessment } from './progress.js';
import type { ReviewQueue } from './review-queue.js';
import type { DetectedRisk } from './risks.js';
import { developerName, type AnalysisSnapshot, type ResolvedScope } from './snapshot.js';
import { leastLoadedDeveloper, type WorkloadDistribution } from './workload.js';

/**
 * The recommendation engine.
 *
 * A recommendation that does not name who should do what is not advice, it is
 * commentary. "Consider addressing the review backlog" costs a manager more time
 * than it saves: they still have to work out who, which pull request, and what
 * "addressing" means. So every recommendation Compass emits has exactly three
 * parts, and the shape is enforced rather than encouraged:
 *
 *  - an **actor** — a person, named. Not "the team", not "someone".
 *  - an **object** — one artifact, named. A pull request number or a ticket key.
 *  - a **step** — one concrete action, phrased as an instruction that can be
 *    finished today. Not a direction of travel.
 *
 * `assertRecommendationWellFormed` throws when any of the three is missing, and
 * `generateStructuredReport` runs it over every recommendation before returning,
 * so an underspecified recommendation is a crash in a test rather than a vague
 * line in somebody's email.
 *
 * When Compass cannot resolve a person, the actor is the report's reader — the
 * manager — rather than an empty field. That is honest: "you" is a real person
 * who can act, and the alternative is either silence or a recommendation
 * addressed to nobody.
 */
export const RECOMMENDATION_SOURCES = [
  'blocker',
  'review_bottleneck',
  'stalled_review',
  'unreleased_work',
  'scope_creep',
  'unassigned_work',
] as const;

export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];

export interface RecommendationActor {
  readonly kind: 'developer' | 'manager';
  readonly key: string;
  readonly displayName: string;
}

export interface RecommendationObject {
  readonly kind: 'pull_request' | 'ticket' | 'sprint';
  readonly key: string;
  /** `#9101`, `PLAT-746` — what the actor would search for. */
  readonly label: string;
}

export interface Recommendation {
  readonly stableId: string;
  readonly source: RecommendationSource;
  readonly actor: RecommendationActor;
  readonly object: RecommendationObject;
  /** One step. One sentence. Finishable today. */
  readonly step: string;
  /** Why this is being suggested — the finding it came from. */
  readonly rationale: string;
  readonly evidence: readonly EvidenceRef[];
  /** Higher acts first. Derived from the severity of the finding behind it. */
  readonly urgency: 'today' | 'this_week';
}

/** The manager reading the report. A real person, addressed as such. */
export const REPORT_READER: RecommendationActor = Object.freeze({
  kind: 'manager',
  key: 'report_reader',
  displayName: 'You',
});

export class RecommendationShapeError extends Error {
  readonly missing: readonly string[];

  constructor(stableId: string, missing: readonly string[]) {
    super(
      `Recommendation \`${stableId}\` is missing ${missing.join(' and ')}. Every recommendation needs an actor, an object and one concrete step — anything less is commentary.`,
    );
    this.name = 'RecommendationShapeError';
    this.missing = missing;
  }
}

/** Fails closed on any recommendation missing one of the three required parts. */
export function assertRecommendationWellFormed(recommendation: Recommendation): void {
  const missing: string[] = [];
  if (recommendation.actor.key.trim().length === 0 || recommendation.actor.displayName.trim().length === 0) {
    missing.push('an actor');
  }
  if (recommendation.object.key.trim().length === 0 || recommendation.object.label.trim().length === 0) {
    missing.push('an object');
  }
  if (recommendation.step.trim().length === 0) missing.push('a step');
  if (missing.length > 0) throw new RecommendationShapeError(recommendation.stableId, missing);
}

export interface RecommendationInputs {
  readonly blockers: readonly DetectedBlocker[];
  readonly reviewQueue: ReviewQueue;
  readonly risks: readonly DetectedRisk[];
  readonly workload: WorkloadDistribution;
  readonly progress: ProgressAssessment;
}

/** How many recommendations one report may carry. A list nobody finishes is a list nobody starts. */
export const MAX_RECOMMENDATIONS = 5;

/**
 * Generates the day's recommendations, most urgent first.
 *
 * Bounded at `MAX_RECOMMENDATIONS`: this is the section that asks a manager to
 * spend their morning differently, and a list of fifteen asks them to spend it
 * triaging Compass instead.
 */
export function generateRecommendations(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  inputs: RecommendationInputs,
): readonly Recommendation[] {
  const candidates: Recommendation[] = [
    ...fromReviewBottleneck(snapshot, inputs),
    ...fromBlockers(snapshot, inputs),
    ...fromUnassignedWork(snapshot, inputs),
    ...fromUnreleasedWork(inputs),
  ];

  // One recommendation per object. Two suggestions about the same pull request
  // read as noise, and the manager only has to act once.
  const byObject = new Map<string, Recommendation>();
  for (const candidate of candidates) {
    if (!byObject.has(candidate.object.key)) byObject.set(candidate.object.key, candidate);
  }

  const ordered = [...byObject.values()].sort(
    (left, right) =>
      compareNumbers(left.urgency === 'today' ? 0 : 1, right.urgency === 'today' ? 0 : 1) ||
      compareStable(left.stableId, right.stableId),
  );

  for (const recommendation of ordered) assertRecommendationWellFormed(recommendation);
  return ordered.slice(0, MAX_RECOMMENDATIONS);
}

/**
 * "Ask Marcus to review #9101 today, or move it to Aisha."
 *
 * Names the oldest pull request rather than the queue, because the queue is not
 * a thing anyone can pick up. The alternate reviewer comes from the least-loaded
 * person available — a single suggestion, never a published ordering of who is
 * busiest.
 */
function fromReviewBottleneck(snapshot: AnalysisSnapshot, inputs: RecommendationInputs): readonly Recommendation[] {
  const concentration = inputs.reviewQueue.concentration;
  if (concentration === null) return [];

  const oldest = inputs.reviewQueue.entries
    .filter((entry) => entry.reviewerDeveloperKeys.includes(concentration.developerKey))
    .sort(
      (left, right) => compareNumbers(right.ageDays, left.ageDays) || compareStable(left.pullRequestKey, right.pullRequestKey),
    )[0];
  if (oldest === undefined) return [];

  const alternate = leastLoadedDeveloper({
    ...inputs.workload,
    perDeveloper: inputs.workload.perDeveloper.filter(
      (load) => load.developerKey !== concentration.developerKey && load.developerKey !== oldest.authorDeveloperKey,
    ),
  });

  const reviewerName = concentration.displayName ?? concentration.developerKey;
  const reassign =
    alternate === null
      ? ' or reassign it to someone with capacity'
      : ` or reassign it to ${alternate.displayName ?? alternate.developerKey}`;

  return [
    {
      stableId: `recommendation:review_bottleneck:${oldest.pullRequestKey}`,
      source: 'review_bottleneck',
      actor: { kind: 'developer', key: concentration.developerKey, displayName: reviewerName },
      object: { kind: 'pull_request', key: oldest.pullRequestKey, label: oldest.pullRequestNumber },
      step: `Review ${oldest.pullRequestNumber} today${reassign}.`,
      rationale: `${reviewerName} is the requested reviewer on ${concentration.openCount} open pull requests and ${oldest.pullRequestNumber} is the oldest at ${oldest.ageDays} days.`,
      evidence: oldest.evidence,
      urgency: 'today',
    },
  ];
}

/**
 * One recommendation per blocker, addressed to whoever holds the work.
 *
 * The step differs by signal, because "unblock it" is not an action: a pull
 * request with no reviewer needs a reviewer named, a stalled changes-requested
 * needs a push or a conversation, and a tracker-flagged blocker needs the
 * dependency chased.
 */
function fromBlockers(snapshot: AnalysisSnapshot, inputs: RecommendationInputs): readonly Recommendation[] {
  return inputs.blockers.slice(0, MAX_RECOMMENDATIONS).map((blocker) => {
    const ticket = blockerTicket(snapshot, blocker);
    const ownerName = blocker.ownerName ?? developerName(snapshot, blocker.ownerDeveloperKey);
    const actor: RecommendationActor =
      blocker.ownerDeveloperKey === null || ownerName === null
        ? REPORT_READER
        : { kind: 'developer', key: blocker.ownerDeveloperKey, displayName: ownerName };

    const object: RecommendationObject =
      blocker.subject.kind === 'pull_request'
        ? { kind: 'pull_request', key: blocker.subject.key, label: blocker.subject.label }
        : { kind: 'ticket', key: blocker.subject.key, label: blocker.subject.label };

    return {
      stableId: `recommendation:${blocker.signal}:${blocker.subject.key}`,
      source: 'blocker' as const,
      actor,
      object,
      step: stepForBlocker(blocker, actor),
      rationale: blocker.detail,
      evidence: orderedEvidence([...blocker.evidence, ...(ticket === null ? [] : [ticketEvidence(ticket)])]),
      urgency: blocker.ageDays >= 3 ? ('today' as const) : ('this_week' as const),
    };
  });
}

function stepForBlocker(blocker: DetectedBlocker, actor: RecommendationActor): string {
  const subject = blocker.subject.label;
  const addressee = actor.kind === 'manager' ? 'Find out' : '';

  switch (blocker.signal) {
    case 'no_reviewer':
      return `Name a reviewer on ${subject} today.`;
    case 'changes_requested_stalled':
      return `Push the requested changes to ${subject}, or say in one line why they are not happening.`;
    case 'status_dwell':
      return `Ask what ${subject} is waiting on and write the answer on the ticket.`;
    case 'tracker_flag':
    case 'blocked_status':
    default:
      return addressee.length > 0
        ? `Find out what ${subject} is blocked on and who owns removing it.`
        : `Chase the dependency ${subject} is blocked on, or hand it back to the board.`;
  }
}

/** Work nobody owns is work nobody does. Addressed to the manager, always. */
function fromUnassignedWork(snapshot: AnalysisSnapshot, inputs: RecommendationInputs): readonly Recommendation[] {
  const unassigned = inputs.workload.unassignedItemKeys;
  if (unassigned.length === 0) return [];

  const first = unassigned[0];
  const suggested = leastLoadedDeveloper(inputs.workload);

  return [
    {
      stableId: `recommendation:unassigned_work:${first}`,
      source: 'unassigned_work',
      actor: REPORT_READER,
      object: { kind: 'ticket', key: first, label: first },
      step:
        suggested === null
          ? `Assign ${first} to someone, or take it off the board.`
          : `Assign ${first} to ${suggested.displayName ?? suggested.developerKey}, or take it off the board.`,
      rationale: `${unassigned.length} in-flight item${unassigned.length === 1 ? ' has' : 's have'} no assignee: ${unassigned.slice(0, 5).join(', ')}${unassigned.length > 5 ? ', …' : ''}.`,
      evidence: [],
      urgency: 'this_week',
    },
  ];
}

/** Merged work that nobody has shipped. Addressed to the manager. */
function fromUnreleasedWork(inputs: RecommendationInputs): readonly Recommendation[] {
  const risk = inputs.risks.find((candidate) => candidate.cause === 'unreleased_merged_work');
  if (risk === undefined) return [];

  const pullRequest = risk.evidence.find((reference) => reference.kind === 'pull_request');
  if (pullRequest === undefined) return [];

  return [
    {
      stableId: `recommendation:unreleased_work:${pullRequest.sourceRecordId}`,
      source: 'unreleased_work',
      actor: REPORT_READER,
      object: { kind: 'pull_request', key: pullRequest.sourceRecordId, label: pullRequest.label },
      step: `Decide today whether ${pullRequest.label} and the merges behind it go out in the next release or wait.`,
      rationale: risk.detail,
      evidence: risk.evidence,
      urgency: risk.severity === 'high' ? 'today' : 'this_week',
    },
  ];
}
