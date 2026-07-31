import { orderedEvidence, ticketEvidence, type EvidenceRef } from './evidence.js';
import {
  basisPoints,
  compareNumbers,
  compareStable,
  meanOf,
  trailingDays,
  wholeDaysBetween,
  windowContains,
  type Instant,
  type TimeWindow,
} from './instant.js';
import { changesRequestedCycles } from './review-queue.js';
import {
  instantField,
  isDone,
  reviewsByPullRequest,
  scopedPullRequests,
  scopedSprints,
  scopedTickets,
  textField,
  textListField,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';

/**
 * The technical-debt-growth signal.
 *
 * Technical debt is the topic managers most often feel and least often have
 * evidence for, so this is the one place in the product where a *composite*
 * signal is computed — and the composition is named, so the composite never
 * becomes a score nobody can decompose.
 *
 * Four named inputs, each independently checkable:
 *
 *  1. `openTechDebtItems` — how many labelled items are open right now, with
 *     their keys.
 *  2. `netChangeOverTrailingWindow` — opened minus closed over the trailing four
 *     weeks, with both key lists. This is the input the growth verdict is decided
 *     on, because a stock tells you nothing about direction.
 *  3. `meanOpenAgeDays` — how long the open ones have been sitting. Debt that is
 *     stable but ancient is a different problem from debt that is growing.
 *  4. `reworkedMergedPullRequestShare` — the share of merged pull requests that
 *     needed three or more changes-requested cycles. Rework is the symptom debt
 *     produces before anybody writes a ticket for it.
 *
 * A stated limitation, because it changes what input 4 means: the design calls
 * for the share of merged pull requests *touching files* with three or more
 * changes-requested cycles, which needs per-file review data. The connector port
 * carries a commit's `changedFileCount` but not its paths, so the share here is
 * computed per pull request instead. That is a strictly coarser signal — it
 * cannot point at the hot file — and it is labelled `perPullRequest` in the
 * output so nobody mistakes it for the file-level answer. Sharpening it needs a
 * port capability, not a formula change.
 *
 * The per-sprint series is emitted whether or not the growth threshold is
 * crossed: it is the producer the weekly digest's debt topic reads, and a digest
 * that only sees crossings cannot show a trend.
 */
export const TECH_DEBT_LABELS = ['tech-debt', 'techdebt', 'tech_debt', 'debt'] as const;

/** The trailing span the net-change input is measured over. */
export const DEBT_TRAILING_DAYS = 28;

/** The changes-requested cycles that make a merged pull request "rework". */
export const REWORK_CYCLE_COUNT = 3;

export const isTechDebt = (ticket: AnalysisEntity): boolean => {
  const labels = textListField(ticket, 'labels').map((label) => label.toLowerCase());
  return TECH_DEBT_LABELS.some((candidate) => labels.includes(candidate));
};

export interface DebtCountSignal {
  readonly name: 'openTechDebtItems';
  readonly value: number;
  readonly ticketKeys: readonly string[];
}

export interface DebtNetChangeSignal {
  readonly name: 'netChangeOverTrailingWindow';
  readonly value: number;
  readonly trailingDays: number;
  readonly openedTicketKeys: readonly string[];
  readonly closedTicketKeys: readonly string[];
}

export interface DebtAgeSignal {
  readonly name: 'meanOpenAgeDays';
  readonly value: number;
  readonly sampleSize: number;
  readonly oldestTicketKey: string | null;
  readonly oldestAgeDays: number;
}

export interface DebtReworkSignal {
  readonly name: 'reworkedMergedPullRequestShare';
  readonly granularity: 'perPullRequest';
  readonly valueBasisPoints: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly cycleCount: number;
  readonly pullRequestNumbers: readonly string[];
}

export interface DebtPerSprintPoint {
  readonly sprintKey: string;
  readonly sprintName: string;
  readonly startAt: number;
  readonly endAt: number;
  /**
   * Whether the sprint had finished by the reporting instant.
   *
   * The final point is almost always a sprint still running, and its count will
   * keep climbing until the sprint closes. Comparing that partial bucket against
   * a full one reads as "debt is falling" on the first morning of every sprint,
   * which is the opposite of the truth. The flag is on the point rather than
   * handled by dropping it, because a digest showing "so far this sprint" is
   * useful — it just must not be treated as a completed observation.
   */
  readonly complete: boolean;
  readonly opened: number;
  readonly ticketKeys: readonly string[];
}

export type DebtGrowth = 'growing' | 'flat' | 'shrinking';

/** Net tech-debt change over an arbitrary window, with both key lists. */
export interface DebtNetChange {
  readonly value: number;
  readonly openedTicketKeys: readonly string[];
  readonly closedTicketKeys: readonly string[];
}

export interface TechnicalDebtSignal {
  readonly signals: {
    readonly openTechDebtItems: DebtCountSignal;
    readonly netChangeOverTrailingWindow: DebtNetChangeSignal;
    readonly meanOpenAgeDays: DebtAgeSignal;
    readonly reworkedMergedPullRequestShare: DebtReworkSignal;
  };
  /** Opened per sprint, oldest sprint first — the digest's trend producer. */
  readonly openedPerSprint: readonly DebtPerSprintPoint[];
  readonly growth: DebtGrowth;
  /** Which numbered thresholds decided the verdict. */
  readonly thresholdsApplied: readonly ThresholdRef[];
  /** Named reasons the verdict is what it is, so the composite decomposes. */
  readonly reasons: readonly string[];
  readonly statement: string;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * Computes the debt signal set as of `instant`.
 *
 * Non-empty by construction: the four inputs are always present with their real
 * values, even when nothing crosses a threshold. "No debt signal" and "a debt
 * signal reading zero" are different claims, and only the second one is
 * verifiable.
 */
export function assessTechnicalDebt(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
): TechnicalDebtSignal {
  const tickets = scopedTickets(snapshot, scope).filter(isTechDebt);
  const open = tickets.filter((ticket) => !isDone(ticket));

  const key = (ticket: AnalysisEntity): string => textField(ticket, 'itemKey') ?? ticket.naturalKey;

  const trailingChange = netTechnicalDebtChange(snapshot, scope, trailingDays(instant, DEBT_TRAILING_DAYS));

  const ages = open.map((ticket) =>
    wholeDaysBetween(instantField(ticket, 'createdAt') ?? (ticket.firstSeenAt as Instant), instant),
  );
  const oldest = [...open]
    .map((ticket) => ({
      ticket,
      age: wholeDaysBetween(instantField(ticket, 'createdAt') ?? (ticket.firstSeenAt as Instant), instant),
    }))
    .sort((left, right) => compareNumbers(right.age, left.age) || compareStable(key(left.ticket), key(right.ticket)))[0];

  const rework = assessRework(snapshot, scope);

  const netChange = trailingChange.value;
  const openedCount = trailingChange.openedTicketKeys.length;
  const closedCount = trailingChange.closedTicketKeys.length;
  const meanAge = meanOf(ages) ?? 0;

  const reasons: string[] = [];
  const thresholdsApplied: ThresholdRef[] = [thresholdRef('T9')];

  let growth: DebtGrowth = 'flat';
  if (netChange >= THRESHOLDS.T9.value) {
    growth = 'growing';
    reasons.push(
      `Open tech-debt items rose by ${netChange} over the last ${DEBT_TRAILING_DAYS} days (${openedCount} opened, ${closedCount} closed), which crosses T9 at ${THRESHOLDS.T9.value}.`,
    );
  } else if (netChange < 0) {
    growth = 'shrinking';
    reasons.push(
      `${closedCount} tech-debt items closed against ${openedCount} opened over the last ${DEBT_TRAILING_DAYS} days.`,
    );
  } else {
    reasons.push(
      `Open tech-debt items changed by ${netChange >= 0 ? '+' : ''}${netChange} over the last ${DEBT_TRAILING_DAYS} days, which does not cross T9 at ${THRESHOLDS.T9.value}.`,
    );
  }

  if (meanAge >= THRESHOLDS.T11.value && open.length > 0) {
    thresholdsApplied.push(thresholdRef('T11'));
    reasons.push(
      `The ${open.length} open tech-debt items have a mean age of ${meanAge} days, past T11 at ${THRESHOLDS.T11.value}.`,
    );
  }
  if (rework.valueBasisPoints >= THRESHOLDS.T10.value && rework.denominator > 0) {
    thresholdsApplied.push(thresholdRef('T10'));
    reasons.push(
      `${rework.numerator} of ${rework.denominator} merged pull requests needed ${REWORK_CYCLE_COUNT} or more changes-requested cycles — ${Math.round(rework.valueBasisPoints / 100)}%, past T10 at ${Math.round(THRESHOLDS.T10.value / 100)}%.`,
    );
  }

  return {
    signals: {
      openTechDebtItems: {
        name: 'openTechDebtItems',
        value: open.length,
        ticketKeys: open.map(key).sort(compareStable),
      },
      netChangeOverTrailingWindow: {
        name: 'netChangeOverTrailingWindow',
        value: netChange,
        trailingDays: DEBT_TRAILING_DAYS,
        openedTicketKeys: trailingChange.openedTicketKeys,
        closedTicketKeys: trailingChange.closedTicketKeys,
      },
      meanOpenAgeDays: {
        name: 'meanOpenAgeDays',
        value: meanAge,
        sampleSize: open.length,
        oldestTicketKey: oldest === undefined ? null : key(oldest.ticket),
        oldestAgeDays: oldest?.age ?? 0,
      },
      reworkedMergedPullRequestShare: rework,
    },
    openedPerSprint: openedPerSprint(snapshot, instant, scope, tickets),
    growth,
    thresholdsApplied,
    reasons,
    statement:
      open.length === 0
        ? 'No open work is labelled tech debt, so there is no debt signal to report beyond that fact.'
        : `${open.length} open tech-debt item${open.length === 1 ? '' : 's'}, ${netChange >= 0 ? 'up' : 'down'} ${Math.abs(netChange)} over ${DEBT_TRAILING_DAYS} days, mean age ${meanAge} days. Debt is ${growth}.`,
    evidence: orderedEvidence(open.slice(0, 6).map(ticketEvidence)),
  };
}

/**
 * Tech-debt items opened minus closed inside a half-open window.
 *
 * Extracted and exported because the growth *risk* has to re-measure exactly this
 * statistic over the preceding window to state a prior. A risk whose trend is
 * computed from one statistic while its `measured` value reports another is
 * unarguable in the worst way — the reader cannot check it — so both sides of the
 * comparison come from this one function.
 */
export function netTechnicalDebtChange(
  snapshot: AnalysisSnapshot,
  scope: ResolvedScope,
  window: TimeWindow,
): DebtNetChange {
  const tickets = scopedTickets(snapshot, scope).filter(isTechDebt);
  const key = (ticket: AnalysisEntity): string => textField(ticket, 'itemKey') ?? ticket.naturalKey;

  const opened = tickets.filter((ticket) => {
    const createdAt = instantField(ticket, 'createdAt') ?? (ticket.firstSeenAt as Instant);
    return windowContains(window, createdAt);
  });
  const closed = tickets.filter((ticket) => {
    const resolvedAt = instantField(ticket, 'resolvedAt');
    return resolvedAt !== null && windowContains(window, resolvedAt);
  });

  return {
    value: opened.length - closed.length,
    openedTicketKeys: opened.map(key).sort(compareStable),
    closedTicketKeys: closed.map(key).sort(compareStable),
  };
}

function assessRework(snapshot: AnalysisSnapshot, scope: ResolvedScope): DebtReworkSignal {
  const reviews = reviewsByPullRequest(snapshot);
  const merged = scopedPullRequests(snapshot, scope).filter(
    (pullRequest) => instantField(pullRequest, 'mergedAt') !== null,
  );

  const reworked = merged.filter(
    (pullRequest) => changesRequestedCycles(reviews.get(pullRequest.naturalKey) ?? []) >= REWORK_CYCLE_COUNT,
  );

  return {
    name: 'reworkedMergedPullRequestShare',
    granularity: 'perPullRequest',
    valueBasisPoints: basisPoints(reworked.length, merged.length),
    numerator: reworked.length,
    denominator: merged.length,
    cycleCount: REWORK_CYCLE_COUNT,
    pullRequestNumbers: reworked
      .map((pullRequest) => {
        const displayNumber = pullRequest.fields['displayNumber'];
        return typeof displayNumber === 'number' ? `#${displayNumber}` : pullRequest.naturalKey;
      })
      .sort(compareStable),
  };
}

/**
 * Tech-debt items opened per sprint, oldest sprint first.
 *
 * A sprint "contains" an item when the item was created inside the sprint's own
 * span, not when it was assigned to that sprint — debt is usually filed while
 * working on something else, and attributing it to the board it landed on would
 * hide where it came from.
 */
function openedPerSprint(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  debtTickets: readonly AnalysisEntity[],
): readonly DebtPerSprintPoint[] {
  return scopedSprints(snapshot, scope)
    .map((sprint) => ({ sprint, startAt: instantField(sprint, 'startAt'), endAt: instantField(sprint, 'endAt') }))
    .filter(
      (entry): entry is { sprint: AnalysisEntity; startAt: Instant; endAt: Instant } =>
        entry.startAt !== null && entry.endAt !== null,
    )
    .sort(
      (left, right) =>
        compareNumbers(left.startAt, right.startAt) || compareStable(left.sprint.naturalKey, right.sprint.naturalKey),
    )
    .map((entry) => {
      const opened = debtTickets.filter((ticket) => {
        const createdAt = instantField(ticket, 'createdAt') ?? (ticket.firstSeenAt as Instant);
        return createdAt >= entry.startAt && createdAt < entry.endAt;
      });
      return {
        sprintKey: entry.sprint.naturalKey,
        sprintName: textField(entry.sprint, 'name') ?? entry.sprint.naturalKey,
        startAt: entry.startAt,
        endAt: entry.endAt,
        complete: entry.endAt <= instant,
        opened: opened.length,
        ticketKeys: opened.map((ticket) => textField(ticket, 'itemKey') ?? ticket.naturalKey).sort(compareStable),
      };
    });
}
