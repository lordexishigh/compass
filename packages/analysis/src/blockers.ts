import {
  orderedEvidence,
  pullRequestEvidence,
  pullRequestLabel,
  ticketEvidence,
  type EvidenceRef,
} from './evidence.js';
import {
  absenceIndex,
  describeSuppression,
  type SuppressionNote,
} from './absence-suppression.js';
import { compareNumbers, compareStable, wholeDaysBetween, workingDaysBetween, type Instant } from './instant.js';
import { changesRequestedCycles, isOpenPullRequest, latestReview } from './review-queue.js';
import {
  booleanField,
  developerName,
  instantField,
  isDone,
  isInFlight,
  looksBlocked,
  reviewsByPullRequest,
  scopedPullRequests,
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
 * Blocker detection.
 *
 * Nothing here is a mood. Every blocker comes from a concrete signal that a
 * manager can go and look at, and it says which signal, which numbered threshold
 * it crossed, and which artifact is the evidence. "PLAT-746 looks stuck" is
 * useless; "PLAT-746 has not changed status for 4 working days, which crosses T1
 * at 3" can be argued with, and being arguable is the point.
 *
 * Five signals, in descending order of how much Compass is inferring:
 *
 *  - `tracker_flag` — the tracker's own blocked flag is set. No threshold: the
 *    source said so.
 *  - `blocked_status` — the status name itself contains "blocked".
 *  - `status_dwell` (T1) — in flight, and nothing has moved for three working
 *    days. This is the only detector that infers blockage from silence, which is
 *    why its threshold is the loosest and its wording the most cautious.
 *  - `no_reviewer` (T2) — an open pull request nobody was asked to review. A
 *    review that was never requested will never happen.
 *  - `changes_requested_stalled` (T3) — a reviewer asked for changes and nothing
 *    has happened since. The work is not waiting on a decision, it is waiting on
 *    someone to notice.
 *  - `awaiting_first_review` (T4) — reviewers *were* requested and none of them
 *    has looked. Distinct from `no_reviewer` because the fix is different: one
 *    needs somebody assigned, the other needs somebody nudged. It is the weakest
 *    of the review signals and so is ranked last, which means a pull request that
 *    also has no reviewer at all reports as `no_reviewer` instead.
 *
 * Weekend-aware by design: a pull request opened on Friday afternoon is not
 * "blocked for 3 days" on Monday morning. Thresholds measured in working days go
 * through `workingDaysBetween`, whose documented simplifications live in
 * `instant.ts`.
 */
export const BLOCKER_SIGNALS = [
  'tracker_flag',
  'blocked_status',
  'status_dwell',
  'no_reviewer',
  'changes_requested_stalled',
  'awaiting_first_review',
] as const;

export type BlockerSignal = (typeof BLOCKER_SIGNALS)[number];

export interface DetectedBlocker {
  /** Subject plus cause — never the report or the run, so "day 6" can be counted. */
  readonly stableId: string;
  readonly signal: BlockerSignal;
  /** The numbered rule applied. `T0` when the source stated it outright. */
  readonly threshold: ThresholdRef;
  /** The value that was compared against the threshold. */
  readonly measured: { readonly value: number; readonly unit: ThresholdRef['unit'] };
  readonly subject: { readonly kind: 'ticket' | 'pull_request'; readonly key: string; readonly label: string };
  readonly ownerDeveloperKey: string | null;
  readonly ownerName: string | null;
  readonly headline: string;
  readonly detail: string;
  /** Whole days since the blocking condition was first true. */
  readonly ageDays: number;
  readonly detectedAt: number;
  /** At least one artifact: a tracker key or a pull request number. */
  readonly evidence: readonly EvidenceRef[];
}

/**
 * Detects every blocker in scope, ordered oldest first.
 *
 * Ordering is `ageDays` descending then `stableId` ascending, a total order, so
 * the sequence does not depend on which detector ran first.
 */
/**
 * Signals that are *inferred from silence*, and are therefore the ones an absence
 * suppresses.
 *
 * `tracker_flag` and `blocked_status` are deliberately absent from this list. A ticket the
 * tracker has flagged as blocked is blocked whether or not its assignee is at their desk —
 * that is a stated fact about the work, not an inference about a person, and suppressing it
 * would hide a real impediment behind somebody's holiday. The four below all say some
 * version of "nothing has happened", and "nothing has happened because they are on leave"
 * is arithmetic rather than news.
 */
const SILENCE_INFERRED_SIGNALS: readonly BlockerSignal[] = [
  'status_dwell',
  'no_reviewer',
  'awaiting_first_review',
  'changes_requested_stalled',
];

export interface BlockerDetection {
  /** The findings to report. Suppressed ones are not here. */
  readonly blockers: readonly DetectedBlocker[];
  /**
   * Findings withheld because the person named is absent, each with its reason.
   *
   * Returned rather than dropped: a section that quietly loses three items looks like a
   * section with nothing to say, and the whole point of the rule is that Compass is seen
   * to have known.
   */
  readonly suppressed: readonly SuppressedBlocker[];
}

export interface SuppressedBlocker {
  readonly blocker: DetectedBlocker;
  readonly note: SuppressionNote;
}

/**
 * Every blocker signal, with absences applied.
 *
 * The suppression predicate is not implemented here — it is imported from
 * `absence-suppression.ts`, which is its only implementation in the workspace, asserted by
 * `tools/quality-gates`. This function decides *which signals* are eligible; that module
 * decides *whether the person is out*.
 */
export function detectBlockersWithSuppression(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): BlockerDetection {
  const found: DetectedBlocker[] = [
    ...detectTrackerBlockers(snapshot, instant, scope),
    ...detectStatusDwell(snapshot, instant, scope),
    ...detectReviewBlockers(snapshot, instant, scope),
  ];

  // One subject can trip several signals. The strongest evidence wins: a ticket
  // the tracker has flagged does not also need to be reported as "quiet for three
  // days", and saying both would double-count one problem in the count the spine
  // shows.
  const bySubject = new Map<string, DetectedBlocker>();
  for (const blocker of found) {
    const existing = bySubject.get(blocker.subject.key);
    if (existing === undefined || signalRank(blocker.signal) < signalRank(existing.signal)) {
      bySubject.set(blocker.subject.key, blocker);
    }
  }

  const ordered = [...bySubject.values()].sort(
    (left, right) => compareNumbers(right.ageDays, left.ageDays) || compareStable(left.stableId, right.stableId),
  );

  const absences = absenceIndex(snapshot, instant);
  if (!absences.any) return { blockers: ordered, suppressed: [] };

  const blockers: DetectedBlocker[] = [];
  const suppressed: SuppressedBlocker[] = [];

  for (const blocker of ordered) {
    const eligible = SILENCE_INFERRED_SIGNALS.includes(blocker.signal);
    const absence = eligible ? absences.suppressing(blocker.ownerDeveloperKey) : null;

    if (absence === null) {
      blockers.push(blocker);
      continue;
    }
    suppressed.push({
      blocker,
      note: describeSuppression(absence, blocker.ownerName),
    });
  }

  return { blockers, suppressed };
}

/**
 * The blockers a report states.
 *
 * Signature unchanged from before absences existed, so every caller and every existing
 * test keeps working; a deployment with no absences gets byte-identical output.
 */
export function detectBlockers(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly DetectedBlocker[] {
  return detectBlockersWithSuppression(snapshot, instant, scope).blockers;
}

const signalRank = (signal: BlockerSignal): number => BLOCKER_SIGNALS.indexOf(signal);

function detectTrackerBlockers(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly DetectedBlocker[] {
  const transitions = transitionsByTicket(snapshot);

  return scopedTickets(snapshot, scope)
    .filter((ticket) => looksBlocked(ticket))
    .map((ticket) => {
      const key = textField(ticket, 'itemKey') ?? ticket.naturalKey;
      const flagged = booleanField(ticket, 'flaggedBlocked');
      const signal: BlockerSignal = flagged ? 'tracker_flag' : 'blocked_status';

      // Counted from the earliest evidence Compass has: the first transition into
      // a blocked status if one was observed, otherwise the first sighting. It
      // only ever moves earlier, so a later ingest cannot make an old blocker
      // look new.
      const firstBlockedTransition = (transitions.get(key) ?? [])
        .filter((transition) => /blocked/i.test(transition.toStatus))
        .map((transition) => transition.transitionedAt)
        .sort(compareNumbers)[0];
      const detectedAt = (firstBlockedTransition ?? ticket.firstSeenAt) as Instant;
      const ageDays = wholeDaysBetween(detectedAt, instant);
      const owner = textField(ticket, 'assigneeDeveloperKey');

      return {
        stableId: `blocker:ticket:${key}:${signal}`,
        signal,
        threshold: thresholdRef('T0'),
        measured: { value: ageDays, unit: 'days' as const },
        subject: { kind: 'ticket' as const, key, label: key },
        ownerDeveloperKey: owner,
        ownerName: developerName(snapshot, owner),
        headline: `${key} is blocked${ageDays > 0 ? `, day ${ageDays}` : ''}`,
        detail: flagged
          ? `The tracker carries the blocked flag on ${key} — ${textField(ticket, 'title') ?? 'no title'}. Compass is reporting what the tracker states, not inferring it.`
          : `${key} sits in status "${textField(ticket, 'status') ?? ''}" — ${textField(ticket, 'title') ?? 'no title'}.`,
        ageDays,
        detectedAt,
        evidence: orderedEvidence([ticketEvidence(ticket)]),
      };
    });
}

/**
 * Silence, measured.
 *
 * A ticket that is in flight and has had no status transition for `T1` working
 * days. Only tickets with an observed transition history are considered — an item
 * Compass has never seen move might simply have been created before ingest
 * started, and calling that "stalled" would be an artefact of when Compass was
 * switched on.
 */
function detectStatusDwell(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly DetectedBlocker[] {
  const transitions = transitionsByTicket(snapshot);
  const found: DetectedBlocker[] = [];

  for (const ticket of scopedTickets(snapshot, scope)) {
    if (!isInFlight(ticket) || looksBlocked(ticket)) continue;

    const key = textField(ticket, 'itemKey') ?? ticket.naturalKey;
    const history = transitions.get(key) ?? [];
    if (history.length === 0) continue;

    const lastMoved = history.reduce(
      (latest, transition) => (transition.transitionedAt > latest ? transition.transitionedAt : latest),
      history[0].transitionedAt,
    ) as Instant;
    const dwellWorkingDays = workingDaysBetween(lastMoved, instant);
    if (dwellWorkingDays < THRESHOLDS.T1.value) continue;

    const owner = textField(ticket, 'assigneeDeveloperKey');
    found.push({
      stableId: `blocker:ticket:${key}:status_dwell`,
      signal: 'status_dwell',
      threshold: thresholdRef('T1'),
      measured: { value: dwellWorkingDays, unit: 'working_days' },
      subject: { kind: 'ticket', key, label: key },
      ownerDeveloperKey: owner,
      ownerName: developerName(snapshot, owner),
      headline: `${key} has not moved for ${dwellWorkingDays} working days`,
      detail: `${key} is in "${textField(ticket, 'status') ?? ''}" and its last status change was ${wholeDaysBetween(lastMoved, instant)} days ago. That crosses T1 at ${THRESHOLDS.T1.value} working days. Compass is inferring this from silence, so it may simply be work that does not show up on the board.`,
      ageDays: wholeDaysBetween(lastMoved, instant),
      detectedAt: lastMoved,
      evidence: orderedEvidence([ticketEvidence(ticket)]),
    });
  }

  return found;
}

/** Pull requests that cannot progress: nobody asked, or nobody followed up. */
function detectReviewBlockers(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly DetectedBlocker[] {
  const reviews = reviewsByPullRequest(snapshot);
  const found: DetectedBlocker[] = [];

  for (const pullRequest of scopedPullRequests(snapshot, scope)) {
    if (!isOpenPullRequest(pullRequest)) continue;

    const number = pullRequestLabel(pullRequest);
    const createdAt = instantField(pullRequest, 'createdAt') ?? (pullRequest.firstSeenAt as Instant);
    const submitted = reviews.get(pullRequest.naturalKey) ?? [];
    const last = latestReview(submitted);
    const author = textField(pullRequest, 'authorDeveloperKey');
    const requested = pullRequest.fields['requestedReviewerKeys'];
    const reviewerCount = Array.isArray(requested) ? requested.length : 0;

    if (reviewerCount === 0 && submitted.length === 0) {
      const waiting = workingDaysBetween(createdAt, instant);
      if (waiting >= THRESHOLDS.T2.value) {
        found.push({
          stableId: `blocker:pull_request:${pullRequest.naturalKey}:no_reviewer`,
          signal: 'no_reviewer',
          threshold: thresholdRef('T2'),
          measured: { value: waiting, unit: 'working_days' },
          subject: { kind: 'pull_request', key: pullRequest.naturalKey, label: number },
          ownerDeveloperKey: author,
          ownerName: developerName(snapshot, author),
          headline: `${number} has no reviewer after ${waiting} working days`,
          detail: `${number} — ${textField(pullRequest, 'title') ?? ''} — has been open for ${waiting} working days with nobody requested and no review submitted. That crosses T2 at ${THRESHOLDS.T2.value}. A review that was never asked for will not happen on its own.`,
          ageDays: wholeDaysBetween(createdAt, instant),
          detectedAt: createdAt,
          evidence: orderedEvidence([pullRequestEvidence(pullRequest)]),
        });
      }
      continue;
    }

    if (last === null) {
      // Reviewers were requested — `reviewerCount === 0 && submitted.length === 0`
      // was handled above — and not one of them has submitted anything.
      const waiting = workingDaysBetween(createdAt, instant);
      if (waiting >= THRESHOLDS.T4.value) {
        const names = textListField(pullRequest, 'requestedReviewerKeys')
          .map((key) => developerName(snapshot, key) ?? key)
          .join(', ');
        found.push({
          stableId: `blocker:pull_request:${pullRequest.naturalKey}:awaiting_first_review`,
          signal: 'awaiting_first_review',
          threshold: thresholdRef('T4'),
          measured: { value: waiting, unit: 'working_days' },
          subject: { kind: 'pull_request', key: pullRequest.naturalKey, label: number },
          ownerDeveloperKey: author,
          ownerName: developerName(snapshot, author),
          headline: `${number} has been waiting ${waiting} working days for its first review`,
          detail: `${number} — ${textField(pullRequest, 'title') ?? ''} — was sent to ${names || 'its requested reviewers'} and none of them has submitted a review. That crosses T4 at ${THRESHOLDS.T4.value} working days. Somebody has been asked; nobody has answered.`,
          ageDays: wholeDaysBetween(createdAt, instant),
          detectedAt: createdAt,
          evidence: orderedEvidence([pullRequestEvidence(pullRequest)]),
        });
      }
      continue;
    }

    if (last.verdict.toLowerCase() === 'changes_requested') {
      const stalled = workingDaysBetween(last.at, instant);
      if (stalled >= THRESHOLDS.T3.value) {
        found.push({
          stableId: `blocker:pull_request:${pullRequest.naturalKey}:changes_requested_stalled`,
          signal: 'changes_requested_stalled',
          threshold: thresholdRef('T3'),
          measured: { value: stalled, unit: 'working_days' },
          subject: { kind: 'pull_request', key: pullRequest.naturalKey, label: number },
          ownerDeveloperKey: author,
          ownerName: developerName(snapshot, author),
          headline: `${number} was sent back for changes ${stalled} working days ago and has not moved`,
          detail: `${developerName(snapshot, last.reviewerDeveloperKey) ?? 'A reviewer'} asked for changes on ${number} and nothing has happened since — ${changesRequestedCycles(submitted)} changes-requested cycle${changesRequestedCycles(submitted) === 1 ? '' : 's'} so far. That crosses T3 at ${THRESHOLDS.T3.value} working days.`,
          ageDays: wholeDaysBetween(last.at, instant),
          detectedAt: last.at,
          evidence: orderedEvidence([pullRequestEvidence(pullRequest)]),
        });
      }
    }
  }

  return found;
}

/**
 * A blocker's subject as a ticket entity, when it has one.
 *
 * Used by the recommendation engine, which needs the assignee to name an actor.
 *
 * @snapshotAccessor resolves a subject key back to its entity; the blocker it was handed already carries the ages.
 */
export function blockerTicket(snapshot: AnalysisSnapshot, blocker: DetectedBlocker): AnalysisEntity | null {
  if (blocker.subject.kind !== 'ticket') return null;
  return (
    snapshot.collections.entities.find(
      (entity) =>
        entity.kind === 'ticket' &&
        (textField(entity, 'itemKey') === blocker.subject.key || entity.naturalKey === blocker.subject.key),
    ) ?? null
  );
}

/**
 * True when the blocker's subject has since finished — used for `resolved`.
 *
 * @snapshotAccessor reads the tracker's current verdict on one ticket; "is it done" needs no instant.
 */
export function blockerIsResolved(snapshot: AnalysisSnapshot, blocker: DetectedBlocker): boolean {
  const ticket = blockerTicket(snapshot, blocker);
  return ticket !== null && isDone(ticket);
}
