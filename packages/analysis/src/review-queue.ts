import { orderedEvidence, pullRequestEvidence, pullRequestLabel, type EvidenceRef } from './evidence.js';
import { compareNumbers, compareStable, wholeDaysBetween, workingDaysBetween, type Instant } from './instant.js';
import {
  developerName,
  instantField,
  reviewsByPullRequest,
  scopedPullRequests,
  textField,
  textListField,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';

/**
 * The review queue.
 *
 * A single average is the least useful thing that can be said about a review
 * backlog. "Mean time in review: 2.4 days" is unactionable — nobody can go and
 * fix a mean. So this section is a *list*, always: every open pull request by
 * number and title, who wrote it, who is expected to look at it, how old it is
 * and how long it has been sitting since anyone touched it. The aggregate is
 * offered alongside, never instead.
 *
 * The per-reviewer depths exist because "every open review is queued behind one
 * person" is a real and common failure, and it cannot be seen from a total. They
 * are ordered by developer key, alphabetically — deliberately *not* by depth. An
 * ordering by magnitude is a leaderboard, and this product does not produce
 * leaderboards; `ranking-guard.ts` enforces that mechanically.
 */

/** A pull request is open when the forge has neither merged nor closed it. */
export const isOpenPullRequest = (pullRequest: AnalysisEntity): boolean =>
  instantField(pullRequest, 'mergedAt') === null && instantField(pullRequest, 'closedAt') === null;

export type ReviewVerdict = string;

export interface ReviewQueueEntry {
  readonly stableId: string;
  readonly pullRequestKey: string;
  /** `#9101` — the number a human would paste into chat. */
  readonly pullRequestNumber: string;
  readonly title: string;
  readonly repositoryKey: string;
  readonly authorDeveloperKey: string | null;
  readonly authorName: string | null;
  /** Requested reviewers, ordered by key. Empty is a finding, not a blank. */
  readonly reviewerDeveloperKeys: readonly string[];
  readonly reviewerNames: readonly string[];
  /** Whole days since the pull request was opened. */
  readonly ageDays: number;
  /**
   * Whole days since a reviewer last did anything — the last submitted review,
   * or the moment it opened if nobody has looked yet. This is the number that
   * says "nothing is happening here", which age alone does not.
   */
  readonly timeInReviewDays: number;
  readonly workingDaysWaiting: number;
  readonly reviewCount: number;
  readonly lastReviewVerdict: ReviewVerdict | null;
  readonly lastReviewAt: number | null;
  readonly awaitingFirstReview: boolean;
  readonly linkedTicketKeys: readonly string[];
  readonly evidence: readonly EvidenceRef[];
}

/** Queue depth for one named reviewer. Ordered by key, never by depth. */
export interface ReviewerLoad {
  readonly developerKey: string;
  readonly displayName: string | null;
  readonly openCount: number;
  readonly pullRequestNumbers: readonly string[];
  readonly oldestAgeDays: number;
}

export interface ReviewQueue {
  readonly totalOpen: number;
  /** Every open pull request, listed. Never replaced by an aggregate. */
  readonly entries: readonly ReviewQueueEntry[];
  readonly awaitingFirstReview: number;
  readonly withNoReviewer: number;
  readonly oldestAgeDays: number;
  readonly medianTimeInReviewDays: number;
  /** Per-reviewer depth, ordered by developer key. */
  readonly openByReviewer: readonly ReviewerLoad[];
  /** Set when one reviewer holds `T5` or more of the queue. */
  readonly concentration: {
    readonly developerKey: string;
    readonly displayName: string | null;
    readonly openCount: number;
    readonly threshold: ThresholdRef;
    readonly statement: string;
  } | null;
  readonly statement: string;
}

/**
 * Aggregates the open review queue as of `instant`.
 *
 * The instant is explicit because every number here is an age. A queue is not a
 * state, it is a state *plus how long it has been that way*, and the second half
 * is the half that makes a manager act.
 */
export function aggregateReviewQueue(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): ReviewQueue {
  const reviews = reviewsByPullRequest(snapshot);
  const open = scopedPullRequests(snapshot, scope).filter(isOpenPullRequest);

  const entries: readonly ReviewQueueEntry[] = open
    .map((pullRequest) => buildEntry(snapshot, instant, pullRequest, reviews.get(pullRequest.naturalKey) ?? []))
    .sort(
      (left, right) =>
        compareNumbers(right.timeInReviewDays, left.timeInReviewDays) ||
        compareNumbers(right.ageDays, left.ageDays) ||
        compareStable(left.pullRequestKey, right.pullRequestKey),
    );

  const byReviewer = new Map<string, { pullRequestNumbers: string[]; oldestAgeDays: number }>();
  for (const entry of entries) {
    for (const reviewerKey of entry.reviewerDeveloperKeys) {
      const bucket = byReviewer.get(reviewerKey);
      if (bucket === undefined) {
        byReviewer.set(reviewerKey, { pullRequestNumbers: [entry.pullRequestNumber], oldestAgeDays: entry.ageDays });
        continue;
      }
      bucket.pullRequestNumbers.push(entry.pullRequestNumber);
      bucket.oldestAgeDays = Math.max(bucket.oldestAgeDays, entry.ageDays);
    }
  }

  const openByReviewer: readonly ReviewerLoad[] = [...byReviewer.entries()]
    .map(([developerKey, bucket]) => ({
      developerKey,
      displayName: developerName(snapshot, developerKey),
      openCount: bucket.pullRequestNumbers.length,
      pullRequestNumbers: [...bucket.pullRequestNumbers].sort(compareStable),
      oldestAgeDays: bucket.oldestAgeDays,
    }))
    // Alphabetical by key. This is a capacity signal, not a ranking.
    .sort((left, right) => compareStable(left.developerKey, right.developerKey));

  // The concentration finding names one person, so it is chosen by a total order
  // (depth, then key) rather than by "whoever came first in the map".
  const deepest = [...openByReviewer].sort(
    (left, right) => compareNumbers(right.openCount, left.openCount) || compareStable(left.developerKey, right.developerKey),
  )[0];

  const concentration =
    deepest !== undefined && deepest.openCount >= THRESHOLDS.T5.value
      ? {
          developerKey: deepest.developerKey,
          displayName: deepest.displayName,
          openCount: deepest.openCount,
          threshold: thresholdRef('T5'),
          statement: `${deepest.displayName ?? deepest.developerKey} is the requested reviewer on ${deepest.openCount} of the ${entries.length} open pull requests, the oldest ${deepest.oldestAgeDays} days old.`,
        }
      : null;

  const waiting = entries.map((entry) => entry.timeInReviewDays);
  const oldest = entries.reduce((max, entry) => Math.max(max, entry.ageDays), 0);

  return {
    totalOpen: entries.length,
    entries,
    awaitingFirstReview: entries.filter((entry) => entry.awaitingFirstReview).length,
    withNoReviewer: entries.filter((entry) => entry.reviewerDeveloperKeys.length === 0).length,
    oldestAgeDays: oldest,
    medianTimeInReviewDays: median(waiting),
    openByReviewer,
    concentration,
    statement:
      entries.length === 0
        ? 'Nothing is waiting for review.'
        : `${entries.length} pull request${entries.length === 1 ? '' : 's'} ${entries.length === 1 ? 'is' : 'are'} open for review, the oldest ${oldest} days old.`,
  };
}

function buildEntry(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  pullRequest: AnalysisEntity,
  reviews: readonly AnalysisEntity[],
): ReviewQueueEntry {
  const createdAt = instantField(pullRequest, 'createdAt') ?? (pullRequest.firstSeenAt as Instant);
  const submitted = reviews
    .map((review) => ({ review, at: instantField(review, 'submittedAt') }))
    .filter((entry): entry is { review: AnalysisEntity; at: Instant } => entry.at !== null)
    .sort((left, right) => compareNumbers(left.at, right.at) || compareStable(left.review.naturalKey, right.review.naturalKey));

  const last = submitted[submitted.length - 1] ?? null;
  const waitingSince = last?.at ?? createdAt;
  const reviewerKeys = [...new Set(textListField(pullRequest, 'requestedReviewerKeys'))].sort(compareStable);

  return {
    stableId: `review_queue:${pullRequest.naturalKey}`,
    pullRequestKey: pullRequest.naturalKey,
    pullRequestNumber: pullRequestLabel(pullRequest),
    title: textField(pullRequest, 'title') ?? '',
    repositoryKey: textField(pullRequest, 'repositoryKey') ?? '',
    authorDeveloperKey: textField(pullRequest, 'authorDeveloperKey'),
    authorName: developerName(snapshot, textField(pullRequest, 'authorDeveloperKey')),
    reviewerDeveloperKeys: reviewerKeys,
    reviewerNames: reviewerKeys
      .map((key) => developerName(snapshot, key))
      .filter((name): name is string => name !== null),
    ageDays: wholeDaysBetween(createdAt, instant),
    timeInReviewDays: wholeDaysBetween(waitingSince, instant),
    workingDaysWaiting: workingDaysBetween(waitingSince, instant),
    reviewCount: submitted.length,
    lastReviewVerdict: last === null ? null : textField(last.review, 'verdict'),
    lastReviewAt: last?.at ?? null,
    awaitingFirstReview: submitted.length === 0,
    linkedTicketKeys: [...textListField(pullRequest, 'linkedItemKeys')].sort(compareStable),
    evidence: orderedEvidence([pullRequestEvidence(pullRequest)]),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort(compareNumbers);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

/**
 * The latest review verdict on a pull request, and when it landed.
 *
 * Shared with the blocker detectors, which need the same answer — a single
 * definition means "changes requested" cannot mean one thing in Blockers and
 * another in the review queue.
 */
export function latestReview(
  reviews: readonly AnalysisEntity[],
): { readonly verdict: string; readonly at: Instant; readonly reviewerDeveloperKey: string | null } | null {
  const submitted = reviews
    .map((review) => ({ review, at: instantField(review, 'submittedAt') }))
    .filter((entry): entry is { review: AnalysisEntity; at: Instant } => entry.at !== null)
    .sort((left, right) => compareNumbers(left.at, right.at) || compareStable(left.review.naturalKey, right.review.naturalKey));

  const last = submitted[submitted.length - 1];
  if (last === undefined) return null;
  return {
    verdict: textField(last.review, 'verdict') ?? '',
    at: last.at,
    reviewerDeveloperKey: textField(last.review, 'reviewerDeveloperKey'),
  };
}

/** How many times a pull request has been sent back for changes. */
export function changesRequestedCycles(reviews: readonly AnalysisEntity[]): number {
  return reviews.filter((review) => (textField(review, 'verdict') ?? '').toLowerCase() === 'changes_requested').length;
}
