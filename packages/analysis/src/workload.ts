import { basisPoints, compareNumbers, compareStable, type Instant } from './instant.js';
import { isOpenPullRequest } from './review-queue.js';
import {
  developerName,
  instantField,
  isInFlight,
  scopedPullRequests,
  scopedTickets,
  textField,
  textListField,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';

/**
 * Workload distribution.
 *
 * This is the one part of the analysis core that names individuals and counts
 * things, so it is also the part most at risk of quietly becoming a performance
 * dashboard. Three rules keep it from turning into one, and all three are
 * enforced rather than intended:
 *
 *  1. **It measures load, not output.** Open assigned items and reviews waiting
 *     on someone are questions about capacity — "who has too much on" — and they
 *     go *up* when someone is overloaded. Commits, lines changed, tickets closed
 *     and points delivered are questions about productivity, and none of them
 *     appear anywhere in this file or anywhere else in the package.
 *  2. **The list is ordered by name.** Alphabetically by developer key, always.
 *     Ordering people by a number is what makes a leaderboard a leaderboard, and
 *     `ranking-guard.ts` fails the build if any per-person array in the output is
 *     ordered any other way.
 *  3. **There is no best and no worst.** `concentration` names at most one person
 *     and only when they hold `T14` or more of the team's in-flight work — a
 *     stated risk to that person, not a ranking of everyone else beneath them.
 *
 * Unassigned work is counted and named separately. It is the most commonly
 * missed load in a team, precisely because it belongs to nobody.
 */
export const WORKLOAD_BASIS = 'open_assigned_items_and_pending_reviews' as const;

export interface DeveloperLoad {
  readonly developerKey: string;
  readonly displayName: string | null;
  /** In-flight items assigned to this person. Load, not throughput. */
  readonly openItems: number;
  readonly openItemKeys: readonly string[];
  /** Open pull requests this person is expected to review. */
  readonly pendingReviews: number;
  readonly pendingReviewNumbers: readonly string[];
  /** Open pull requests this person wrote and is waiting on. */
  readonly openAuthoredPullRequests: number;
  /** True when an Absence covers the report instant. */
  readonly absent: boolean;
}

export interface WorkloadDistribution {
  readonly basis: typeof WORKLOAD_BASIS;
  /** Ordered by developer key. Never by magnitude. */
  readonly perDeveloper: readonly DeveloperLoad[];
  readonly unassignedOpenItems: number;
  readonly unassignedItemKeys: readonly string[];
  readonly totalOpenItems: number;
  readonly peopleCarryingWork: number;
  /** At most one named person, and only above `T14`. */
  readonly concentration: {
    readonly developerKey: string;
    readonly displayName: string | null;
    readonly openItems: number;
    readonly shareBasisPoints: number;
    readonly threshold: ThresholdRef;
    readonly statement: string;
  } | null;
  readonly statement: string;
}

export function assessWorkload(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): WorkloadDistribution {
  const tickets = scopedTickets(snapshot, scope).filter((ticket) => isInFlight(ticket));
  const openPullRequests = scopedPullRequests(snapshot, scope).filter(isOpenPullRequest);
  const absent = absentDeveloperKeys(snapshot, instant);

  // Everyone the report should account for: the team roster plus anyone actually
  // holding work. A person carrying items who is not on the roster is a real
  // condition (a loan from another team, a stale roster) and hiding them would
  // understate the load.
  const people = new Set<string>(scope.developerKeys);
  const loads = new Map<string, { items: string[]; reviews: string[]; authored: number }>();

  const bucket = (developerKey: string) => {
    people.add(developerKey);
    const existing = loads.get(developerKey);
    if (existing !== undefined) return existing;
    const created = { items: [] as string[], reviews: [] as string[], authored: 0 };
    loads.set(developerKey, created);
    return created;
  };

  const unassigned: string[] = [];
  for (const ticket of tickets) {
    const key = textField(ticket, 'itemKey') ?? ticket.naturalKey;
    const assignee = textField(ticket, 'assigneeDeveloperKey');
    if (assignee === null) {
      unassigned.push(key);
      continue;
    }
    bucket(assignee).items.push(key);
  }

  for (const pullRequest of openPullRequests) {
    const displayNumber = pullRequest.fields['displayNumber'];
    const label = typeof displayNumber === 'number' ? `#${displayNumber}` : pullRequest.naturalKey;
    for (const reviewerKey of new Set(textListField(pullRequest, 'requestedReviewerKeys'))) {
      bucket(reviewerKey).reviews.push(label);
    }
    const author = textField(pullRequest, 'authorDeveloperKey');
    if (author !== null) bucket(author).authored += 1;
  }

  const perDeveloper: readonly DeveloperLoad[] = [...people]
    .map((developerKey) => {
      const load = loads.get(developerKey) ?? { items: [], reviews: [], authored: 0 };
      return {
        developerKey,
        displayName: developerName(snapshot, developerKey),
        openItems: load.items.length,
        openItemKeys: [...load.items].sort(compareStable),
        pendingReviews: load.reviews.length,
        pendingReviewNumbers: [...new Set(load.reviews)].sort(compareStable),
        openAuthoredPullRequests: load.authored,
        absent: absent.has(developerKey),
      };
    })
    // Alphabetical by key. See rule 2 above — this ordering is load-bearing.
    .sort((left, right) => compareStable(left.developerKey, right.developerKey));

  const assignedTotal = perDeveloper.reduce((sum, load) => sum + load.openItems, 0);
  const totalOpenItems = assignedTotal + unassigned.length;

  const heaviest = [...perDeveloper].sort(
    (left, right) => compareNumbers(right.openItems, left.openItems) || compareStable(left.developerKey, right.developerKey),
  )[0];
  const share = heaviest === undefined ? 0 : basisPoints(heaviest.openItems, Math.max(1, totalOpenItems));

  const concentration =
    heaviest !== undefined && heaviest.openItems > 0 && share >= THRESHOLDS.T14.value && perDeveloper.length > 1
      ? {
          developerKey: heaviest.developerKey,
          displayName: heaviest.displayName,
          openItems: heaviest.openItems,
          shareBasisPoints: share,
          threshold: thresholdRef('T14'),
          statement: `${heaviest.displayName ?? heaviest.developerKey} is carrying ${heaviest.openItems} of the ${totalOpenItems} items in flight — ${Math.round(share / 100)}% of the team's open work. That crosses T14 at ${Math.round(THRESHOLDS.T14.value / 100)}%.`,
        }
      : null;

  return {
    basis: WORKLOAD_BASIS,
    perDeveloper,
    unassignedOpenItems: unassigned.length,
    unassignedItemKeys: [...unassigned].sort(compareStable),
    totalOpenItems,
    peopleCarryingWork: perDeveloper.filter((load) => load.openItems > 0).length,
    concentration,
    statement:
      totalOpenItems === 0
        ? 'Nothing is in flight, so there is no load to distribute.'
        : `${totalOpenItems} item${totalOpenItems === 1 ? '' : 's'} in flight across ${perDeveloper.filter((load) => load.openItems > 0).length} ${perDeveloper.filter((load) => load.openItems > 0).length === 1 ? 'person' : 'people'}${unassigned.length > 0 ? `, and ${unassigned.length} assigned to nobody` : ''}.`,
  };
}

/**
 * Developer keys whose Absence covers `instant`.
 *
 * Half-open, matching every other span in the product: an absence ending at
 * 09:00 does not cover 09:00. A null `endAt` is an open-ended absence and covers
 * everything from its start.
 */
export function absentDeveloperKeys(snapshot: AnalysisSnapshot, instant: Instant): ReadonlySet<string> {
  const absent = new Set<string>();
  for (const absence of snapshot.collections.entities) {
    if (absence.kind !== 'absence') continue;
    const developerKey = textField(absence, 'developerKey');
    if (developerKey === null) continue;
    const startAt = instantField(absence, 'startAt');
    const endAt = instantField(absence, 'endAt');
    if (startAt === null || instant < startAt) continue;
    if (endAt !== null && instant >= endAt) continue;
    absent.add(developerKey);
  }
  return absent;
}

/** An unordered helper for the recommendation engine: who has the least on. */
export function leastLoadedDeveloper(distribution: WorkloadDistribution): DeveloperLoad | null {
  const available = distribution.perDeveloper.filter((load) => !load.absent);
  if (available.length === 0) return null;
  // A total order so the suggestion is reproducible, tie-broken by key. This is
  // a single suggestion, not a published ordering — nothing about it reaches the
  // output as a list.
  return [...available].sort(
    (left, right) =>
      compareNumbers(left.openItems + left.pendingReviews, right.openItems + right.pendingReviews) ||
      compareStable(left.developerKey, right.developerKey),
  )[0];
}
