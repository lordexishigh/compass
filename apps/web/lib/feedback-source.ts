import {
  DEFAULT_SNOOZE_DAYS,
  FEEDBACK_ACTIONS,
  MATERIAL_WORSENING_DELTA,
  OFF_GOAL_CAUSE_KIND,
  feedbackActionIsOffered,
  isFeedbackAction,
  type FeedbackAction,
  type SectionKey,
} from '@compass/analysis';
import { authorize, type Principal } from '@compass/auth';
import { MILLIS_PER_DAY, type Instant } from '@compass/clock';
import {
  findReportById,
  findReportItemByStableId,
  recordItemFeedback,
  recordManagerCorrection,
  type ScopedDb,
  type StoredFeedbackEntry,
} from '@compass/db';

/**
 * Applying one manager verdict — the single path all three channels go through.
 *
 * The web POST, the signed email link and the Slack button differ only in **how the caller was
 * authorised**. What they do afterwards is identical, and it lives here rather than three times
 * over: a channel that recorded a slightly different row is a channel where a dismissal does not
 * stick, and "feedback that visibly doesn't stick" is one of the two documented ways this product
 * dies.
 *
 * ## What this function refuses, and why each refusal exists
 *
 * - **An item id that matches no persisted item.** Without the row there are no coordinates to key
 *   the verdict on and no severity to use as a dismissal's baseline. Recording it anyway would
 *   write a verdict that can never match anything — the silent-no-op failure mode.
 * - **An action the item does not offer.** `feedbackOffersFor` is the product rule, and it is
 *   checked here rather than trusted from the request: a hand-crafted POST could otherwise mark a
 *   Yesterday completion "already resolved", writing a row nothing will ever read.
 * - **A dismissal with no reason.** The reason is what the corrections screen shows back and what
 *   makes a suppression auditable months later. "Dismissed" with no words is indistinguishable
 *   from a misclick.
 */

export type FeedbackChannel = 'web' | 'email' | 'slack';

export interface ApplyFeedbackRequest {
  readonly stableId: string;
  readonly action: FeedbackAction;
  readonly reason: string | null;
  /** Days, for a snooze. Defaults to the one-click value. */
  readonly snoozeDays?: number;
  readonly channel: FeedbackChannel;
  readonly authorUserId: string | null;
  readonly now: Instant;
}

export type ApplyFeedbackResult =
  | {
      readonly ok: true;
      readonly entry: StoredFeedbackEntry;
      /** One sentence for the reader, in the product's voice. */
      readonly sentence: string;
      /** True when a Correction row was written beside the verdict. */
      readonly correctionWritten: boolean;
    }
  | { readonly ok: false; readonly reason: FeedbackRefusal; readonly detail: string };

export type FeedbackRefusal = 'unknown_item' | 'action_not_offered' | 'reason_required' | 'invalid_snooze';

/** The longest a one-click snooze may run. Beyond this, dismiss it or fix it. */
export const MAX_SNOOZE_DAYS = 90;

export function parseFeedbackAction(value: unknown): FeedbackAction | null {
  return typeof value === 'string' && isFeedbackAction(value) ? value : null;
}

/** Every action name, for a 400 that tells the caller what it could have sent. */
export const FEEDBACK_ACTION_LIST = FEEDBACK_ACTIONS.join(', ');

/** Which report an item belongs to, and therefore which team's report a verdict on it would change. */
export interface ItemReportScope {
  readonly reportId: string;
  readonly scopeKind: string;
  readonly scopeKey: string;
  /** The team the report is about, or null for a merged report about every team. */
  readonly teamKey: string | null;
}

/**
 * The report an item belongs to — the fact every seat-authorised channel has to know *before* it
 * writes anything.
 *
 * ## Why this exists
 *
 * `findReportItemByStableId` is scoped to the organization and to nothing narrower, which is correct
 * for what it is. But a seat is scoped to *teams*, and an item id is not: a manager scoped to
 * `platform` who is handed a `checkout` item's id would otherwise have their verdict applied to the
 * checkout team's report, because every check before that point only ever asked about their own
 * scope. Both seat-authorised channels therefore resolve the item first and check the *report's*
 * team against the caller's scopes.
 *
 * The email channel does not use this, and that is deliberate rather than an omission: a signed link
 * is authorised by the token, which is an HMAC over one organization, one item and one action. It
 * cannot be re-aimed, so there is no scope for it to escalate across — and it carries no seat whose
 * scopes there would be to compare against.
 */
export async function resolveItemReportScope(
  scoped: ScopedDb,
  stableId: string,
): Promise<ItemReportScope | null> {
  const item = await findReportItemByStableId(scoped, stableId);
  if (item === null) return null;

  const report = await findReportById(scoped, item.reportId);
  if (report === null) return null;

  return {
    reportId: report.id,
    scopeKind: report.scopeKind,
    scopeKey: report.scopeKey,
    // A merged report is one report about every team, so it names no single team. The matrix reads a
    // null team on a team-scoped route as "whatever this principal can see", which is the same rule
    // `/api/reports/[teamKey]` has always applied — a scoped manager still needs *some* scope, and an
    // owner is team-unscoped either way.
    teamKey: report.scopeKind === 'team' ? report.scopeKey : null,
  };
}

/**
 * Whether this seat may record a verdict on an item in that report.
 *
 * Asks the same `ROLE_MATRIX` route and action the web POST is admitted under, so a role that cannot
 * give feedback on the page cannot give it from Slack either. What changed is the `teamKey`: it is
 * the team of the report *containing the item*, never the caller's own first scope. Passing the
 * caller's own team made `teamScopeAllows` compare a scope against itself, so the check could not
 * fail and could not have denied anything.
 */
export function seatMayActOnItem(input: {
  readonly principal: Principal;
  readonly teamScopes: readonly string[];
  readonly itemTeamKey: string | null;
  readonly demoOrganization: boolean;
}): boolean {
  return authorize({
    route: '/api/feedback',
    action: 'POST',
    principal: input.principal,
    seatActive: true,
    teamKey: input.itemTeamKey,
    teamScopes: input.teamScopes,
    demoOrganization: input.demoOrganization,
  }).allowed;
}

/**
 * Records the verdict, and the Correction that a corrected off-goal flag also produces.
 *
 * Two rows for one click on `off_goal_flag_wrong`, and both matter. The `feedback_entries` row is
 * what suppresses the flag on every future report; the `corrections` row is the durable record of
 * the manager's judgement against Compass's — the prior verdict quoted verbatim, the manager's own,
 * and the evidence that was offered. Separating them is what lets a correction still be *read back*
 * after a suppression is lifted, and what makes "a Correction row is written" a checkable claim
 * rather than a rephrasing of "the flag stopped appearing".
 */
export async function applyManagerFeedback(
  scoped: ScopedDb,
  request: ApplyFeedbackRequest,
): Promise<ApplyFeedbackResult> {
  const item = await findReportItemByStableId(scoped, request.stableId);
  if (item === null) {
    return {
      ok: false,
      reason: 'unknown_item',
      detail:
        `Compass holds no report item with id \`${request.stableId}\`, so there is nothing to record a verdict ` +
        'against. Open the report and use the buttons on the claim itself.',
    };
  }

  const cause = {
    entityRef: item.causeEntityRef,
    causeKind: item.causeKind,
    causeDiscriminator: item.causeDiscriminator,
  };

  if (!feedbackActionIsOffered(item.sectionKey as SectionKey, cause, request.action)) {
    return {
      ok: false,
      reason: 'action_not_offered',
      detail:
        `\`${request.action}\` is not one of the actions Compass offers on this item. A completion, a Win and a ` +
        'Progress figure are statements of fact about work that already happened, and there is no verdict to give ' +
        'on one.',
    };
  }

  if (request.action === 'dismiss_risk' && (request.reason === null || request.reason.trim().length === 0)) {
    return {
      ok: false,
      reason: 'reason_required',
      detail:
        'A dismissal needs a reason. It is what the corrections screen shows back to you in six weeks, and what ' +
        `distinguishes a deliberate judgement from a misclick — the risk then stays suppressed until its severity ` +
        `rises by ${MATERIAL_WORSENING_DELTA} points.`,
    };
  }

  if (request.action === 'explain_unattributed' && (request.reason === null || request.reason.trim().length === 0)) {
    /**
     * The one action whose entire content *is* the reason.
     *
     * Compass asked what the work was for. An empty answer would silence the question while
     * recording nothing, which is strictly worse than the snooze sitting beside it: the snooze at
     * least says "not now" honestly and comes back. Refused here rather than in the component, so
     * the rule holds for the email and Slack channels too.
     */
    return {
      ok: false,
      reason: 'reason_required',
      detail:
        'Compass asked what these commits were for, so this needs an answer to record. Say what the work was — ' +
        'it is kept as a correction and shown back on the corrections screen. If you would rather not say now, ' +
        'snooze the question instead.',
    };
  }

  const snoozeDays = request.snoozeDays ?? DEFAULT_SNOOZE_DAYS;
  if (request.action === 'snooze' && (!Number.isInteger(snoozeDays) || snoozeDays < 1 || snoozeDays > MAX_SNOOZE_DAYS)) {
    return {
      ok: false,
      reason: 'invalid_snooze',
      detail: `A snooze runs for a whole number of days between 1 and ${MAX_SNOOZE_DAYS}.`,
    };
  }

  const entry = await recordItemFeedback(scoped, {
    action: request.action,
    reportItemStableId: item.stableId,
    causeEntityRef: cause.entityRef,
    causeKind: cause.causeKind,
    causeDiscriminator: cause.causeDiscriminator,
    reason: request.reason === null || request.reason.trim().length === 0 ? null : request.reason.trim(),
    snoozeUntil: request.action === 'snooze' ? ((request.now + snoozeDays * MILLIS_PER_DAY) as Instant) : null,
    // The baseline a dismissal's return is measured against, read off the item the manager was
    // actually looking at. Recorded for every action so the corrections screen can always say how
    // severe the finding was when the verdict was given.
    severityScoreAtVerdict: item.severityScore,
    sourceChannel: request.channel,
    authorUserId: request.authorUserId,
    reportId: item.reportId,
    submittedAt: request.now,
  });

  let correctionWritten = false;
  if (request.action === 'off_goal_flag_wrong') {
    const written = await recordManagerCorrection(scoped, {
      // The objective the flag was about, taken from the cause rather than re-parsed from prose.
      subjectKind: 'objective',
      subjectKey: cause.entityRef.startsWith('objective:') ? cause.entityRef.slice('objective:'.length) : cause.entityRef,
      priorBelief: item.headline,
      newBelief:
        request.reason === null || request.reason.trim().length === 0
          ? 'The manager states that this work does serve a current objective, so the off-goal flag was wrong.'
          : `The manager states that the off-goal flag was wrong: ${request.reason.trim()}`,
      contradiction: 'off_goal_flag_wrong',
      // The verdict itself is the evidence: what Compass claimed, and where. A commit SHA would be
      // the wrong artifact — the contradiction is about the *alignment judgement*, not about any
      // one commit, and pointing at a commit would imply Compass had been wrong about that commit.
      evidenceKind: 'report_item',
      evidenceLabel: item.stableId,
      evidenceSourceKey: 'compass',
      evidenceSourceRecordId: item.stableId,
      observedAt: request.now,
      detectedAt: request.now,
    });
    correctionWritten = written.written;
  }

  return { ok: true, entry, sentence: sentenceFor(request.action, snoozeDays), correctionWritten };
}

/**
 * What the reader is told, per action.
 *
 * Each one states the *effect on future reports* rather than acknowledging the click. "Recorded" is
 * not an outcome a manager can check; "you will not see this again unless its severity rises by 100
 * points" is, and it is also a promise the pipeline actually keeps.
 */
export function sentenceFor(action: FeedbackAction, snoozeDays: number): string {
  switch (action) {
    case 'dismiss_risk':
      return `Dismissed. Compass will keep this risk out of your report unless its severity rises by ${MATERIAL_WORSENING_DELTA} points, and will say what worsened if it ever does.`;
    case 'off_goal_flag_wrong':
      return 'Recorded as a correction. This off-goal flag will not appear again, and the correction is on the corrections screen with what Compass claimed and what you said.';
    case 'accept_recommendation':
      return 'Accepted. Tomorrow’s report shows this as your decision with today’s date rather than suggesting it again.';
    case 'reject_recommendation':
      return 'Rejected. Compass will not suggest this step for this item again.';
    case 'blocker_already_resolved':
      return 'Noted as already resolved. It stays out of your report unless the condition starts again.';
    case 'explain_unattributed':
      // Says what it covers, because "answered" without a scope would read as "Compass will stop
      // asking about unexplained commits", which is the opposite of what this feature is for.
      return 'Thank you — recorded. Compass will not ask about these commits again, and your answer is on the corrections screen. Work it does not cover is still asked about.';
    case 'snooze':
      return `Snoozed for ${snoozeDays} day${snoozeDays === 1 ? '' : 's'}. It comes back on its own after that if it is still true.`;
  }
}

/** Whether one cause is the off-goal flag — the one action that also writes a Correction. */
export const isOffGoalCause = (causeKind: string): boolean => causeKind === OFF_GOAL_CAUSE_KIND;
