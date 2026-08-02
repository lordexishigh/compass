import { orderedEvidence, pullRequestEvidence, ticketEvidence, type EvidenceRef } from './evidence.js';
import { compareNumbers, compareStable, wholeDaysBetween, windowContains, type Instant } from './instant.js';
import { entityRef, stableItemId } from './identity.js';
import { isOpenPullRequest } from './review-queue.js';
import {
  instantField,
  isDone,
  isInFlight,
  looksBlocked,
  scopedPullRequests,
  scopedTickets,
  textField,
  transitionsByTicket,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';

/**
 * Elapsed facts.
 *
 * These are the sentences that make Compass a memory rather than a status page:
 * "still blocked on the same dependency, day 6", "resequenced twice", "reviewer
 * added, age unchanged". Every one of them is a claim about *duration*, and none
 * of them can be computed from today's data alone — they come off the knowledge
 * model's persisted `first_seen_at` and its append-only history, which is why that
 * layer is a store and not a projection.
 *
 * Two invariants, both asserted by `tests/elapsed.test.ts`:
 *
 *  - **Every fact carries the entity id it is about and the day count it
 *    asserts.** That is what lets the UI render the mono `day 6` pill next to the
 *    right entity, and what lets a manager check the claim against the ticket.
 *  - **Day counts come from stored history, never from a diff of two reports.**
 *    A count derived from yesterday's report would be wrong the first time a
 *    report was missed, and would silently reset rather than saying so.
 *
 * The counting rule is the knowledge model's: exact 24-hour periods, floored. An
 * item first seen at 08:15 on the 24th is day 6 at 08:15 on the 30th and stays
 * day 6 until 08:15 on the 31st, so the number does not jump at local midnight
 * under a manager who read it an hour earlier.
 */
export const ELAPSED_FACT_KINDS = [
  'still_blocked',
  'still_in_flight',
  'awaiting_review',
  'resequenced',
  'reopened',
  'contradicted',
] as const;

export type ElapsedFactKind = (typeof ELAPSED_FACT_KINDS)[number];

/** Only recurrences worth stating: below this, "day 1" is just "today". */
export const ELAPSED_FACT_MINIMUM_DAYS = 2;

export interface ElapsedFactStatement {
  readonly stableId: string;
  readonly kind: ElapsedFactKind;
  /** The entity this fact is about — a ticket key or a pull request key. */
  readonly entityId: string;
  readonly entityKind: 'ticket' | 'pull_request';
  /** The label a human reads: `CHK-701`, `#9201`. */
  readonly entityLabel: string;
  /** The day count the fact asserts. Rendered as the `day 6` pill. */
  readonly dayCount: number;
  /** How many times the thing happened, for countable facts like resequencing. */
  readonly occurrences: number;
  readonly since: number;
  /** The run-in italic clause: "still blocked on the same dependency, day 6". */
  readonly statement: string;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * Every elapsed fact in scope, ordered by day count descending then entity id.
 *
 * The oldest thing is the most interesting thing — that is the entire argument
 * for this section existing — so it leads. Ties break on the entity id so two
 * runs agree.
 */
export function computeElapsedFacts(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly ElapsedFactStatement[] {
  const facts: ElapsedFactStatement[] = [
    ...blockedFacts(snapshot, instant, scope),
    ...inFlightFacts(snapshot, instant, scope),
    ...reviewFacts(snapshot, instant, scope),
    ...resequencingFacts(snapshot, instant, scope),
    ...reopenedFacts(snapshot, instant, scope),
    ...contradictionFacts(snapshot, instant),
  ];

  return facts
    .filter((fact) => fact.dayCount >= ELAPSED_FACT_MINIMUM_DAYS || fact.occurrences > 1)
    .sort(
      (left, right) => compareNumbers(right.dayCount, left.dayCount) || compareStable(left.stableId, right.stableId),
    );
}

const ticketKeyOf = (ticket: AnalysisEntity): string => textField(ticket, 'itemKey') ?? ticket.naturalKey;

/**
 * "Still blocked on the same dependency, day 6."
 *
 * Counted from the earliest evidence of blockage: the first observed transition
 * into a blocked status, or the entity's first sighting when the transition
 * predates ingest. Never from the current belief's timestamp, which moves every
 * time anything about the ticket is touched.
 */
function blockedFacts(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly ElapsedFactStatement[] {
  const transitions = transitionsByTicket(snapshot);

  return scopedTickets(snapshot, scope)
    .filter((ticket) => looksBlocked(ticket))
    .map((ticket) => {
      const key = ticketKeyOf(ticket);
      const history = transitions.get(key) ?? [];
      const blockedTransitions = history.filter((transition) => /blocked/i.test(transition.toStatus));
      const since = (blockedTransitions.map((transition) => transition.transitionedAt).sort(compareNumbers)[0] ??
        ticket.firstSeenAt) as Instant;
      const dayCount = wholeDaysBetween(since, instant);

      return {
        stableId: stableItemId({
        organizationId: snapshot.organizationId,
        entityRef: entityRef('ticket', key),
        causeKind: 'still_blocked',
      }),
        kind: 'still_blocked' as const,
        entityId: key,
        entityKind: 'ticket' as const,
        entityLabel: key,
        dayCount,
        occurrences: Math.max(1, blockedTransitions.length),
        since,
        statement:
          blockedTransitions.length > 1
            ? `still blocked, day ${dayCount} — and blocked ${blockedTransitions.length} separate times`
            : `still blocked, day ${dayCount}`,
        evidence: orderedEvidence([ticketEvidence(ticket)]),
      };
    });
}

/** "In progress since day 9" — in flight, unblocked, and not moving quickly. */
function inFlightFacts(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly ElapsedFactStatement[] {
  const transitions = transitionsByTicket(snapshot);

  return scopedTickets(snapshot, scope)
    .filter((ticket) => isInFlight(ticket) && !looksBlocked(ticket))
    .map((ticket) => {
      const key = ticketKeyOf(ticket);
      const history = transitions.get(key) ?? [];
      const startedAt = (history.find((transition) => transition.toStatusCategory === 'in_progress')
        ?.transitionedAt ?? ticket.firstSeenAt) as Instant;
      const dayCount = wholeDaysBetween(startedAt, instant);

      return {
        stableId: stableItemId({
        organizationId: snapshot.organizationId,
        entityRef: entityRef('ticket', key),
        causeKind: 'still_in_flight',
      }),
        kind: 'still_in_flight' as const,
        entityId: key,
        entityKind: 'ticket' as const,
        entityLabel: key,
        dayCount,
        occurrences: 1,
        since: startedAt,
        statement: `in progress since day ${dayCount}`,
        evidence: orderedEvidence([ticketEvidence(ticket)]),
      };
    });
}

/** "Waiting on review, day 4." */
function reviewFacts(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly ElapsedFactStatement[] {
  return scopedPullRequests(snapshot, scope)
    .filter(isOpenPullRequest)
    .map((pullRequest) => {
      const createdAt = instantField(pullRequest, 'createdAt') ?? (pullRequest.firstSeenAt as Instant);
      const dayCount = wholeDaysBetween(createdAt, instant);
      const displayNumber = pullRequest.fields['displayNumber'];
      const label = typeof displayNumber === 'number' ? `#${displayNumber}` : pullRequest.naturalKey;

      return {
        stableId: stableItemId({
        organizationId: snapshot.organizationId,
        entityRef: entityRef('pull_request', pullRequest.naturalKey),
        causeKind: 'awaiting_review',
      }),
        kind: 'awaiting_review' as const,
        entityId: pullRequest.naturalKey,
        entityKind: 'pull_request' as const,
        entityLabel: label,
        dayCount,
        occurrences: 1,
        since: createdAt,
        statement: `open for review, day ${dayCount}`,
        evidence: orderedEvidence([pullRequestEvidence(pullRequest)]),
      };
    });
}

/**
 * "Resequenced twice."
 *
 * Counted from the append-only sprint scope-change history: every time an item
 * was added to or removed from a sprint. The count is the interesting number
 * here, not the age — an item moved between three sprints is being deferred, and
 * that is a decision somebody made rather than a delay that happened.
 */
function resequencingFacts(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly ElapsedFactStatement[] {
  const inScope = new Set(scopedTickets(snapshot, scope).map(ticketKeyOf));
  const byTicket = new Map<string, { count: number; since: number }>();

  for (const change of snapshot.collections.sprintScopeChanges) {
    if (!inScope.has(change.ticketKey)) continue;
    const existing = byTicket.get(change.ticketKey);
    if (existing === undefined) {
      byTicket.set(change.ticketKey, { count: 1, since: change.changedAt });
      continue;
    }
    existing.count += 1;
    if (change.changedAt < existing.since) existing.since = change.changedAt;
  }

  const tickets = new Map(scopedTickets(snapshot, scope).map((ticket) => [ticketKeyOf(ticket), ticket]));

  return [...byTicket.entries()]
    .filter(([, value]) => value.count > 1)
    .map(([ticketKey, value]) => {
      const ticket = tickets.get(ticketKey);
      return {
        stableId: stableItemId({
        organizationId: snapshot.organizationId,
        entityRef: entityRef('ticket', ticketKey),
        causeKind: 'resequenced',
      }),
        kind: 'resequenced' as const,
        entityId: ticketKey,
        entityKind: 'ticket' as const,
        entityLabel: ticketKey,
        dayCount: wholeDaysBetween(value.since as Instant, instant),
        occurrences: value.count,
        since: value.since,
        statement: `resequenced ${countWord(value.count)}`,
        evidence: orderedEvidence(ticket === undefined ? [] : [ticketEvidence(ticket)]),
      };
    });
}

/** "Reopened twice since it was first marked done." */
function reopenedFacts(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): readonly ElapsedFactStatement[] {
  const transitions = transitionsByTicket(snapshot);

  return scopedTickets(snapshot, scope)
    .map((ticket): ElapsedFactStatement | null => {
      const key = ticketKeyOf(ticket);
      const history = transitions.get(key) ?? [];
      const reopenings = history.filter(
        (transition) => transition.fromStatusCategory === 'done' && transition.toStatusCategory !== 'done',
      );
      if (reopenings.length === 0) return null;

      const since = reopenings[0].transitionedAt as Instant;
      return {
        stableId: stableItemId({
        organizationId: snapshot.organizationId,
        entityRef: entityRef('ticket', key),
        causeKind: 'reopened',
      }),
        kind: 'reopened' as const,
        entityId: key,
        entityKind: 'ticket' as const,
        entityLabel: key,
        dayCount: wholeDaysBetween(since, instant),
        occurrences: reopenings.length,
        since,
        statement: `reopened ${countWord(reopenings.length)} after being marked done`,
        evidence: orderedEvidence([ticketEvidence(ticket)]),
      };
    })
    .filter((fact): fact is ElapsedFactStatement => fact !== null);
}

/**
 * "Reported blocked yesterday, actually merged."
 *
 * Read off the Correction rows the reconciliation layer wrote. The prior belief
 * is not erased and is not quietly replaced: the report states that it changed,
 * because a manager who acted on yesterday's claim deserves to know it was wrong.
 */
function contradictionFacts(snapshot: AnalysisSnapshot, instant: Instant): readonly ElapsedFactStatement[] {
  return snapshot.collections.corrections
    .filter((correction) => correction.subjectKind === 'ticket')
    .map((correction) => ({
      stableId: stableItemId({
        organizationId: snapshot.organizationId,
        entityRef: entityRef('ticket', correction.subjectKey),
        causeKind: 'contradicted',
        causeDiscriminator: correction.contradiction,
      }),
      kind: 'contradicted' as const,
      entityId: correction.subjectKey,
      entityKind: 'ticket' as const,
      entityLabel: correction.subjectKey,
      dayCount: wholeDaysBetween(correction.detectedAt as Instant, instant),
      occurrences: 1,
      since: correction.detectedAt,
      statement: `${correction.priorBelief} — ${correction.newBelief}`,
      evidence: orderedEvidence([
        {
          kind: correction.evidenceKind === 'pull_request' ? 'pull_request' : 'issue',
          label: correction.evidenceLabel,
          sourceKey: correction.evidenceSourceKey,
          sourceRecordId: correction.evidenceSourceRecordId,
        },
      ]),
    }));
}

const COUNT_WORDS = ['zero times', 'once', 'twice', 'three times', 'four times', 'five times'] as const;

/** "twice" reads better than "2 times", up to the point where it stops. */
export function countWord(count: number): string {
  return COUNT_WORDS[count] ?? `${count} times`;
}

/**
 * How an item changed since the previous report, as the run-in italic clause.
 *
 * Never a badge saying NEW. The clause is the product's voice: "reviewer added,
 * age unchanged" tells a manager what to re-read; a coloured pill tells them
 * nothing they did not already know from the item being there.
 */
export type ChangeSinceYesterday = 'new' | 'unchanged' | 'worsened' | 'improved' | 'resolved';

export function changeSinceYesterday(input: {
  readonly firstSeenAt: Instant;
  readonly window: { readonly start: Instant; readonly end: Instant };
  readonly resolved: boolean;
  readonly measured: number;
  readonly prior: number | null;
}): ChangeSinceYesterday {
  if (input.resolved) return 'resolved';
  if (windowContains(input.window, input.firstSeenAt) || input.firstSeenAt >= input.window.start) return 'new';
  if (input.prior === null) return 'new';
  if (input.measured > input.prior) return 'worsened';
  if (input.measured < input.prior) return 'improved';
  return 'unchanged';
}

/** Whether a ticket has finished — used to mark an elapsed fact resolved. */
export const factSubjectResolved = (snapshot: AnalysisSnapshot, entityId: string): boolean => {
  const ticket = snapshot.collections.entities.find(
    (entity) => entity.kind === 'ticket' && (textField(entity, 'itemKey') === entityId || entity.naturalKey === entityId),
  );
  return ticket !== undefined && isDone(ticket);
};
