import {
  isFeedbackAction,
  type FeedbackLedger,
  type FeedbackRecord,
  type PriorReportState,
} from '@compass/analysis';
import type { Instant } from '@compass/clock';
import {
  findPriorReportState,
  readFeedbackLedger,
  type ScopedDb,
  type StoredFeedbackEntry,
} from '@compass/db';

/**
 * Loading the two pieces of history the analysis core is *told* about.
 *
 * The core is pure: it reads no clock and no database, so change-awareness and suppression
 * cannot be a query made from inside it. They are values handed in, and this is the one place
 * the rows become those values.
 *
 * That split is what makes the whole feature testable without a database — `applyFeedback` and
 * `applyChangeAwareness` take plain objects — and it is why the ten-day simulation can chain
 * reports by feeding each one's own prior state back in.
 */

/**
 * The prior report for a scope, or null when there is none.
 *
 * `before` is the instant the new report is *for*, and the lookup is strictly earlier. A replay
 * regenerates the report for an instant it has already covered, and a `<=` lookup would compare
 * that report against itself: everything would come back `unchanged` at the age it already had,
 * and the second generation of any day would lose a morning's movement.
 */
export async function loadPriorReportState(
  scoped: ScopedDb,
  scope: { readonly scopeKind: string; readonly scopeKey: string },
  before: Instant,
): Promise<PriorReportState | null> {
  const prior = await findPriorReportState(scoped, scope, before);
  if (prior === null) return null;

  return {
    instant: prior.reportInstant,
    items: prior.items.map((item) => ({
      stableId: item.stableId,
      firstSeenAt: item.firstSeenAt,
      severityScore: item.severityScore,
    })),
  };
}

/**
 * One persisted verdict as the analysis core's own shape.
 *
 * A row whose `action` is not one of the six is **dropped**, not coerced. The database has a
 * CHECK constraint that makes such a row unwritable, so reaching this branch means the constraint
 * was removed or the row predates it — and in either case the honest response is to ignore a
 * verdict Compass does not understand rather than to guess which of the six it meant. Guessing
 * would suppress a finding for a reason nobody could reconstruct.
 */
export function feedbackRecordFrom(row: StoredFeedbackEntry): FeedbackRecord | null {
  if (!isFeedbackAction(row.action)) return null;

  return {
    action: row.action,
    cause: {
      entityRef: row.causeEntityRef,
      causeKind: row.causeKind,
      causeDiscriminator: row.causeDiscriminator,
    },
    reason: row.reason,
    submittedAt: row.submittedAt,
    snoozeUntil: row.snoozeUntil,
    severityScoreAtVerdict: row.severityScoreAtVerdict,
    sourceChannel: row.sourceChannel,
    authorUserId: row.authorUserId,
  };
}

/** Every verdict this organization has recorded, as the ledger the core applies. */
export async function loadFeedbackLedger(scoped: ScopedDb): Promise<FeedbackLedger> {
  const rows = await readFeedbackLedger(scoped);
  return { records: rows.map(feedbackRecordFrom).filter((record): record is FeedbackRecord => record !== null) };
}
