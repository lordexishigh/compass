import {
  DEFAULT_SNOOZE_DAYS,
  FEEDBACK_ACTIONS,
  MATERIAL_WORSENING_DELTA,
  OFF_GOAL_CAUSE_KIND,
  TERMINAL_FEEDBACK_ACTIONS,
  UNATTRIBUTED_CAUSE_KIND,
  isFeedbackAction,
  type FeedbackAction,
} from './feedback-actions.js';
import { entityRef, itemCauseKey, stableItemId } from './identity.js';
import { compareStable, type Instant } from './instant.js';
import type { SectionKey } from './sections.js';
import type { ItemCause, ReportItem, ReportSection, SuppressedItemNote } from './structured-report.js';

// Re-exported so a caller reaching for the vocabulary does not have to know it lives one module
// lower. The split is a dependency-cycle concern, not an API one.
export {
  DEFAULT_SNOOZE_DAYS,
  FEEDBACK_ACTIONS,
  MATERIAL_WORSENING_DELTA,
  OFF_GOAL_CAUSE_KIND,
  TERMINAL_FEEDBACK_ACTIONS,
  UNATTRIBUTED_CAUSE_KIND,
  isFeedbackAction,
  type FeedbackAction,
};

/**
 * Feedback, and the one place it is applied.
 *
 * ## Why feedback lives here and not in the five producers
 *
 * "Feedback that visibly doesn't stick" is the second documented way this product dies. A
 * manager who dismisses a risk and reads it again the next morning has learned that the
 * buttons are decoration, and nothing after that recovers their trust.
 *
 * The tempting implementation is a filter inside each detector: `risks.ts` skips dismissed
 * risks, `blockers.ts` skips resolved blockers, `recommendations.ts` skips rejected ones.
 * That produces five rules that agree today and diverge on the first change, and it puts
 * suppression *before* detection so `findings` — the audit trail a manager argues with —
 * would no longer contain the thing they dismissed. So suppression is applied once, over
 * the assembled sections, and `findings` keeps everything the analysis computed.
 *
 * ## Keyed on the coordinates, never on the id string
 *
 * A `FeedbackRecord` stores `entityRef`, `causeKind` and `causeDiscriminator` — the
 * derivation's own inputs — and derives the id from them at load time. Storing the rendered
 * `v1:8f2c…` string instead would orphan every dismissal the day `STABLE_ID_VERSION` moved,
 * which is exactly the deliberate, visible reset that version tag exists to permit. The
 * coordinates survive it; a digest would not.
 *
 * ## The six actions, and what each one does to tomorrow's report
 *
 * | action | effect |
 * | --- | --- |
 * | `reject_recommendation` | never suggested again for that entity and cause. Terminal. |
 * | `accept_recommendation` | rendered as accepted with its date, not re-suggested — until the condition lapses and returns. |
 * | `blocker_already_resolved` | omitted until the condition *re-onsets*, which is a new triggering signal. |
 * | `dismiss_risk` | suppressed indefinitely unless severity worsens by `MATERIAL_WORSENING_DELTA`. |
 * | `off_goal_flag_wrong` | suppressed permanently, and a Correction row records the manager's verdict. |
 * | `snooze` | suppressed until the injected clock passes `snoozeUntil`, then rendered again. |
 *
 * Records are evaluated **newest first, and the first one that has something to say wins**.
 * So a manager who dismisses a risk and later snoozes it gets the snooze, and when the snooze
 * lapses the dismissal underneath it still holds. Any other precedence rule requires ranking
 * six actions against each other, which is a table nobody can predict the behaviour of.
 */

export interface FeedbackRecord {
  readonly action: FeedbackAction;
  /** The derivation's own coordinates. Never the rendered id. */
  readonly cause: ItemCause;
  /** The manager's own words. Required for a dismissal; optional elsewhere. */
  readonly reason: string | null;
  readonly submittedAt: Instant;
  /** Non-null only for `snooze`. Half-open: the item returns at this instant. */
  readonly snoozeUntil: Instant | null;
  /**
   * The severity score at the moment of the verdict.
   *
   * Null when the channel could not supply it, which is treated as "no baseline" — a
   * dismissal with no baseline suppresses indefinitely rather than resurfacing on the first
   * measurement, because guessing a baseline of zero would make every dismissal last a day.
   */
  readonly severityScoreAtVerdict: number | null;
  /** `web` | `email` | `slack`. Recorded so an audit can say where a verdict came from. */
  readonly sourceChannel: string;
  readonly authorUserId: string | null;
}

export interface FeedbackLedger {
  readonly records: readonly FeedbackRecord[];
}

export const EMPTY_FEEDBACK_LEDGER: FeedbackLedger = Object.freeze({ records: [] });

/** The key a record and an item are matched on. Three coordinates, never the tenant. */
export const feedbackKey = (cause: ItemCause): string =>
  itemCauseKey({
    organizationId: 'unused',
    entityRef: cause.entityRef,
    causeKind: cause.causeKind,
    causeDiscriminator: cause.causeDiscriminator,
  });

export type FeedbackVerdict =
  | { readonly kind: 'render' }
  | {
      readonly kind: 'suppressed';
      readonly action: FeedbackAction;
      readonly at: Instant;
      /** One sentence, in the product's voice, for the admin view and the audit log. */
      readonly statement: string;
    }
  | {
      readonly kind: 'accepted';
      readonly action: 'accept_recommendation';
      readonly at: Instant;
      readonly clause: string;
    }
  | {
      readonly kind: 'resurfaced';
      readonly action: 'dismiss_risk';
      readonly at: Instant;
      readonly clause: string;
      readonly scoreAtVerdict: number;
      readonly scoreNow: number;
      readonly delta: number;
    };

/** What the verdict needs to know about the item in front of it. */
export interface FeedbackSubject {
  readonly cause: ItemCause;
  readonly severityScore: number;
  /**
   * When the underlying condition began.
   *
   * This is what makes `blocker_already_resolved` a durable verdict rather than a one-day
   * reprieve. A blocker's age grows every morning, so a rule keyed on severity would resurface
   * it the next day; a rule keyed on *onset* keeps it suppressed for as long as it is the same
   * episode and lets a genuinely new one through.
   */
  readonly signalOnsetAt: Instant;
  /** Whether the prior report carried this id — how an acceptance learns the condition lapsed. */
  readonly presentInPriorReport: boolean;
}

/** The prior report's instant, or null on the first report. */
export type PriorInstant = Instant | null;

const dayLabel = (instant: Instant): string => new Date(instant).toISOString().slice(0, 10);

/**
 * Whether an acceptance has been spent — the condition lapsed and has now come back.
 *
 * The criterion is precise: an accepted recommendation is not re-suggested "unless the
 * triggering condition recurs *after* the accepted item resolves". So the acceptance holds
 * while the condition keeps holding, and is spent once a report went out without it. The prior
 * report is the evidence: if that report post-dates the acceptance and did not carry the item,
 * the condition lapsed, and today's appearance is a recurrence rather than the same one.
 */
function acceptanceIsSpent(record: FeedbackRecord, subject: FeedbackSubject, priorInstant: PriorInstant): boolean {
  if (priorInstant === null) return false;
  if (priorInstant <= record.submittedAt) return false;
  return !subject.presentInPriorReport;
}

/**
 * What one record says about one item, or `render` when it has nothing to say any more.
 *
 * Total and pure: every action is handled, and an action that has expired returns `render` so
 * the caller can fall through to the next-newest record.
 */
export function verdictFromRecord(
  record: FeedbackRecord,
  subject: FeedbackSubject,
  instant: Instant,
  priorInstant: PriorInstant,
): FeedbackVerdict {
  const because = record.reason === null || record.reason.length === 0 ? '' : ` — "${record.reason}"`;

  switch (record.action) {
    case 'snooze': {
      if (record.snoozeUntil === null || instant >= record.snoozeUntil) return { kind: 'render' };
      return {
        kind: 'suppressed',
        action: 'snooze',
        at: record.submittedAt,
        statement: `Snoozed on ${dayLabel(record.submittedAt)} until ${dayLabel(record.snoozeUntil)}${because}.`,
      };
    }

    case 'reject_recommendation':
      return {
        kind: 'suppressed',
        action: 'reject_recommendation',
        at: record.submittedAt,
        statement: `Rejected on ${dayLabel(record.submittedAt)}, so Compass will not suggest it again${because}.`,
      };

    case 'off_goal_flag_wrong':
      return {
        kind: 'suppressed',
        action: 'off_goal_flag_wrong',
        at: record.submittedAt,
        statement: `You marked this off-goal flag wrong on ${dayLabel(record.submittedAt)}, so it is suppressed and recorded as a correction${because}.`,
      };

    case 'blocker_already_resolved': {
      // A later onset is a different episode: the same ticket blocked again next week is a new
      // triggering signal, not the one that was already dealt with.
      if (subject.signalOnsetAt > record.submittedAt) return { kind: 'render' };
      return {
        kind: 'suppressed',
        action: 'blocker_already_resolved',
        at: record.submittedAt,
        statement: `You marked this already resolved on ${dayLabel(record.submittedAt)}; it returns only on a new triggering signal${because}.`,
      };
    }

    case 'accept_recommendation': {
      if (acceptanceIsSpent(record, subject, priorInstant)) return { kind: 'render' };
      return {
        kind: 'accepted',
        action: 'accept_recommendation',
        at: record.submittedAt,
        clause: `accepted on ${dayLabel(record.submittedAt)}`,
      };
    }

    case 'dismiss_risk': {
      const baseline = record.severityScoreAtVerdict;
      if (baseline === null) {
        return {
          kind: 'suppressed',
          action: 'dismiss_risk',
          at: record.submittedAt,
          statement: `Dismissed on ${dayLabel(record.submittedAt)} with no severity baseline recorded, so it stays suppressed${because}.`,
        };
      }

      const delta = subject.severityScore - baseline;
      if (delta < MATERIAL_WORSENING_DELTA) {
        return {
          kind: 'suppressed',
          action: 'dismiss_risk',
          at: record.submittedAt,
          statement: `Dismissed on ${dayLabel(record.submittedAt)} at ${baseline} severity points; now ${subject.severityScore}, which is ${delta} of the ${MATERIAL_WORSENING_DELTA} points a return requires${because}.`,
        };
      }

      return {
        kind: 'resurfaced',
        action: 'dismiss_risk',
        at: record.submittedAt,
        scoreAtVerdict: baseline,
        scoreNow: subject.severityScore,
        delta,
        clause: resurfacingClause(baseline, subject.severityScore, delta, record.submittedAt),
      };
    }
  }
}

/**
 * The sentence a resurfaced risk carries: what worsened, and by how much.
 *
 * Named quantities rather than an adjective. "Back because it got worse" is the sentence a
 * manager cannot argue with, and every claim in Compass has to be arguable.
 */
export function resurfacingClause(
  scoreAtVerdict: number,
  scoreNow: number,
  delta: number,
  dismissedAt: Instant,
): string {
  return (
    `back after you dismissed it on ${dayLabel(dismissedAt)}: its severity has risen from ` +
    `${scoreAtVerdict} to ${scoreNow} points, ${delta} more, against the ${MATERIAL_WORSENING_DELTA} ` +
    'a return requires'
  );
}

/**
 * Every record for one item, newest first.
 *
 * Sorted by `(submittedAt desc, action)` — a total order, so two records written in the same
 * millisecond do not make the verdict depend on row order.
 */
export function recordsFor(ledger: FeedbackLedger, cause: ItemCause): readonly FeedbackRecord[] {
  const key = feedbackKey(cause);
  return ledger.records
    .filter((record) => feedbackKey(record.cause) === key)
    .sort((left, right) => right.submittedAt - left.submittedAt || compareStable(left.action, right.action));
}

/** The verdict for one item: the newest record that still has something to say. */
export function feedbackVerdictFor(
  ledger: FeedbackLedger,
  subject: FeedbackSubject,
  instant: Instant,
  priorInstant: PriorInstant,
): FeedbackVerdict {
  for (const record of recordsFor(ledger, subject.cause)) {
    const verdict = verdictFromRecord(record, subject, instant, priorInstant);
    if (verdict.kind !== 'render') return verdict;
  }
  return { kind: 'render' };
}

/** One action a manager may take on one item, with the words the button carries. */
export interface FeedbackOffer {
  readonly action: FeedbackAction;
  /** Imperative and specific. Never "OK" or a thumbs-up: a verdict has to be legible. */
  readonly label: string;
}

const OFFER: Readonly<Record<FeedbackAction, string>> = Object.freeze({
  dismiss_risk: 'Dismiss this risk',
  off_goal_flag_wrong: 'This off-goal flag is wrong',
  accept_recommendation: 'Accept this step',
  reject_recommendation: 'Reject this step',
  blocker_already_resolved: 'Already resolved',
  snooze: 'Snooze 7 days',
});

const offer = (action: FeedbackAction): FeedbackOffer => ({ action, label: OFFER[action] });

/**
 * Which actions one item offers — the same answer in the web view, the email and Slack.
 *
 * Decided here, in the pure layer, so the three channels cannot disagree about what a manager may
 * say about a given finding. A button that exists in the email and not on the page is a manager
 * discovering that the product's affordances depend on where they happened to read it.
 *
 * Three families offer nothing, and the omission is deliberate. A Yesterday completion, a Win and a
 * Progress figure are statements of fact about work that already happened or about the shape of the
 * sprint; there is no verdict to give, and a "dismiss" under them would invite a manager to argue
 * with their own team's merge history.
 *
 * The unattributed alignment question offers only a snooze. It is a *question* — "what were these 3
 * commits for?" — and neither "wrong" nor "dismiss" is an answer to one: Compass has stated no
 * verdict to be wrong about, so the only sensible instruction is "not now".
 */
export function feedbackOffersFor(sectionKey: SectionKey, cause: ItemCause): readonly FeedbackOffer[] {
  switch (sectionKey) {
    case 'blockers':
      return [offer('blocker_already_resolved'), offer('snooze')];
    case 'risks':
      if (cause.causeKind === OFF_GOAL_CAUSE_KIND) return [offer('off_goal_flag_wrong'), offer('snooze')];
      if (cause.causeKind === UNATTRIBUTED_CAUSE_KIND) return [offer('snooze')];
      return [offer('dismiss_risk'), offer('snooze')];
    case 'recommendations':
      return [offer('accept_recommendation'), offer('reject_recommendation'), offer('snooze')];
    case 'yesterday':
    case 'progress':
    case 'wins':
      return [];
  }
}

/** Whether one action is offered on one item — the check a mutation must make before applying. */
export const feedbackActionIsOffered = (
  sectionKey: SectionKey,
  cause: ItemCause,
  action: FeedbackAction,
): boolean => feedbackOffersFor(sectionKey, cause).some((candidate) => candidate.action === action);

export interface FeedbackApplication {
  readonly sections: readonly ReportSection[];
  /** Everything the ledger removed, so nothing is silently missing from the page. */
  readonly suppressed: readonly SuppressedItemNote[];
}

/**
 * Applies the ledger to the assembled sections: drops what is suppressed, annotates the rest.
 *
 * Nothing is removed silently. Every suppression becomes a `SuppressedItemNote`, which the
 * report carries and the corrections screen lists, because a manager has to be able to see
 * what they told Compass to stop saying — a suppression they cannot find is indistinguishable
 * from a detector that broke.
 */
export function applyFeedback(
  sections: readonly ReportSection[],
  ledger: FeedbackLedger,
  input: {
    readonly instant: Instant;
    readonly priorInstant: PriorInstant;
    readonly priorStableIds: ReadonlySet<string>;
  },
): FeedbackApplication {
  if (ledger.records.length === 0) return { sections, suppressed: [] };

  const suppressed: SuppressedItemNote[] = [];

  const sectionsOut = sections.map((section) => {
    const kept: ReportItem[] = [];

    for (const item of section.items) {
      const verdict = feedbackVerdictFor(
        ledger,
        {
          cause: item.cause,
          severityScore: item.severityScore,
          signalOnsetAt: item.signalOnsetAt,
          presentInPriorReport: input.priorStableIds.has(item.stableId),
        },
        input.instant,
        input.priorInstant,
      );

      if (verdict.kind === 'suppressed') {
        suppressed.push({
          sectionKey: section.key,
          stableId: item.stableId,
          cause: item.cause,
          action: verdict.action,
          headline: item.headline,
          statement: verdict.statement,
          at: verdict.at,
        });
        continue;
      }

      if (verdict.kind === 'accepted') {
        kept.push({
          ...item,
          // An accepted step is not a fresh suggestion, and it must not read as one.
          changeClause: verdict.clause,
          feedback: { state: 'accepted', action: verdict.action, at: verdict.at, clause: verdict.clause },
        });
        continue;
      }

      if (verdict.kind === 'resurfaced') {
        kept.push({
          ...item,
          changeClause: verdict.clause,
          feedback: { state: 'resurfaced', action: verdict.action, at: verdict.at, clause: verdict.clause },
        });
        continue;
      }

      kept.push(item);
    }

    return { ...section, items: kept };
  });

  return {
    sections: sectionsOut,
    suppressed: suppressed.sort(
      (left, right) => compareStable(left.sectionKey, right.sectionKey) || compareStable(left.stableId, right.stableId),
    ),
  };
}

/** The suppressed off-goal flags, newest first — the corrections screen's own list. */
export const correctedOffGoalFlags = (ledger: FeedbackLedger): readonly FeedbackRecord[] =>
  ledger.records
    .filter((record) => record.action === 'off_goal_flag_wrong')
    .sort((left, right) => right.submittedAt - left.submittedAt || compareStable(left.cause.entityRef, right.cause.entityRef));

/**
 * The cause of an off-goal flag for one objective — what a correction is recorded against.
 *
 * Exported so the web route recording the Correction and the detector emitting the verdict
 * cannot disagree about the coordinates, which is the one way a correction that "worked"
 * suppresses nothing.
 */
export const offGoalFlagCause = (objectiveNodeId: string): ItemCause => ({
  entityRef: entityRef('objective', objectiveNodeId),
  causeKind: OFF_GOAL_CAUSE_KIND,
  causeDiscriminator: '',
});

/** The id that cause derives to, in one tenant. A convenience for callers holding both. */
export const feedbackTargetId = (organizationId: string, cause: ItemCause): string =>
  stableItemId({
    organizationId,
    entityRef: cause.entityRef,
    causeKind: cause.causeKind,
    causeDiscriminator: cause.causeDiscriminator,
  });
