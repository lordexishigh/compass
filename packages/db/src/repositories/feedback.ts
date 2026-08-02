import type { Instant } from '@compass/clock';
import { and, asc, desc, eq } from 'drizzle-orm';

import { correctionRowId, entityRowId } from '../entity-id.js';
import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { feedbackLinkUses } from '../schema/delivery.js';
import { feedbackEntries } from '../schema/entities.js';
import { corrections } from '../schema/history.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Feedback persistence, and the Correction a corrected off-goal flag writes.
 *
 * ## What the natural key is, and why
 *
 * `(action, entityRef, causeKind, causeDiscriminator)`. So a manager who dismisses the same
 * risk twice updates one row rather than accumulating two, and a re-snooze *moves* the end
 * date instead of leaving an older, shorter snooze behind for the verdict to trip over. The
 * entity-version history still records every revision — `feedback` is a declared entity in the
 * registry — so nothing is lost by the row being singular.
 *
 * The action is part of the key rather than a mutable field on it, because the six actions are
 * not alternatives: "I already fixed this" and "not for a fortnight" are two true statements a
 * manager can make about one blocker, and folding them into one row would make the second
 * silently erase the first.
 *
 * ## Why this layer names no analysis type
 *
 * `@compass/db` sits below `@compass/analysis`, so the shapes here are plain strings and
 * numbers and the action vocabulary is a database CHECK plus the validator in
 * `packages/analysis/src/feedback.ts`. The pipeline is the layer that holds both and does the
 * translation, exactly as it does for the structured report.
 */

export interface RecordFeedbackInput {
  readonly action: string;
  readonly reportItemStableId: string;
  readonly causeEntityRef: string;
  readonly causeKind: string;
  readonly causeDiscriminator: string;
  readonly reason: string | null;
  /** Non-null only for `snooze`, which the database also enforces. */
  readonly snoozeUntil: Instant | null;
  /** The dismissal baseline. Null means "no baseline", which suppresses indefinitely. */
  readonly severityScoreAtVerdict: number | null;
  /** `web` | `email` | `slack`. */
  readonly sourceChannel: string;
  readonly authorUserId: string | null;
  /** The report the manager was reading. Not a foreign key — feedback outlives the page. */
  readonly reportId: string | null;
  readonly submittedAt: Instant;
}

export interface StoredFeedbackEntry {
  readonly id: string;
  readonly action: string;
  readonly reportItemStableId: string;
  readonly causeEntityRef: string;
  readonly causeKind: string;
  readonly causeDiscriminator: string;
  readonly reason: string | null;
  readonly snoozeUntil: Instant | null;
  readonly severityScoreAtVerdict: number | null;
  readonly sourceChannel: string;
  readonly authorUserId: string | null;
  readonly reportId: string | null;
  readonly submittedAt: Instant;
}

/** The natural key. Spelled once, so a write and a read cannot disagree about it. */
export const feedbackNaturalKey = (input: {
  readonly action: string;
  readonly causeEntityRef: string;
  readonly causeKind: string;
  readonly causeDiscriminator: string;
}): string =>
  // Length-prefixed for the same reason `canonicalIdentityString` is: a natural key
  // legitimately contains colons, and `a:b` + `c` must not collide with `a` + `b:c`.
  [input.action, input.causeEntityRef, input.causeKind, input.causeDiscriminator]
    .map((field) => `${field.length}:${field}`)
    .join('|');

/**
 * Records one verdict, replacing an earlier one of the same action on the same condition.
 *
 * An upsert rather than an insert, and for a concrete reason: a manager who clicks "snooze"
 * twice — because the first click's page had not reloaded, because they clicked in Slack and
 * again in the web view — must end with one snooze, the later one. A plain insert would leave
 * the older row for `feedbackVerdictFor` to find, and since it evaluates newest-first the
 * behaviour would be *nearly* right, which is worse than wrong: it would only misbehave once
 * the newer row expired and the stale one silently took over.
 */
export async function recordItemFeedback(
  scoped: ScopedDb,
  input: RecordFeedbackInput,
): Promise<StoredFeedbackEntry> {
  const naturalKey = feedbackNaturalKey(input);
  const id = entityRowId(scoped.organizationId, 'feedback', naturalKey);
  const submittedAt = toDatabaseInstant(input.submittedAt);

  const [existing] = await scoped.selectFrom(feedbackEntries, eq(feedbackEntries.id, id)).limit(1);

  const fields = {
    reportItemStableId: input.reportItemStableId,
    causeEntityRef: input.causeEntityRef,
    causeKind: input.causeKind,
    causeDiscriminator: input.causeDiscriminator,
    action: input.action,
    reason: input.reason,
    note: null,
    snoozeUntil: input.snoozeUntil === null ? null : toDatabaseInstant(input.snoozeUntil),
    severityScoreAtVerdict: input.severityScoreAtVerdict,
    sourceChannel: input.sourceChannel,
    authorUserId: input.authorUserId,
    reportId: input.reportId,
    submittedAt,
  };

  if (existing === undefined) {
    await scoped.insertInto(feedbackEntries, {
      id,
      naturalKey,
      firstSeenAt: submittedAt,
      lastSeenAt: submittedAt,
      beliefAt: submittedAt,
      version: 1,
      ...fields,
    });
  } else {
    await scoped.updateIn(
      feedbackEntries,
      {
        ...fields,
        // `first_seen_at` is when the manager first said this, and it does not move: a
        // re-snooze is the same standing instruction restated, not a new one.
        lastSeenAt: submittedAt,
        beliefAt: submittedAt,
        version: existing.version + 1,
      },
      eq(feedbackEntries.id, id),
    );
  }

  const stored = await findFeedbackById(scoped, id);
  if (stored === null) throw new Error(`Feedback ${id} was written but could not be read back.`);
  return stored;
}

const toStored = (row: typeof feedbackEntries.$inferSelect): StoredFeedbackEntry => ({
  id: row.id,
  action: row.action,
  reportItemStableId: row.reportItemStableId,
  causeEntityRef: row.causeEntityRef,
  causeKind: row.causeKind,
  causeDiscriminator: row.causeDiscriminator,
  reason: row.reason,
  snoozeUntil: fromNullableDatabaseInstant(row.snoozeUntil),
  severityScoreAtVerdict: row.severityScoreAtVerdict,
  sourceChannel: row.sourceChannel,
  authorUserId: row.authorUserId,
  reportId: row.reportId,
  submittedAt: fromDatabaseInstant(row.submittedAt),
});

export async function findFeedbackById(scoped: ScopedDb, id: string): Promise<StoredFeedbackEntry | null> {
  const [row] = await scoped.selectFrom(feedbackEntries, eq(feedbackEntries.id, id)).limit(1);
  return row === undefined ? null : toStored(row);
}

/**
 * Every verdict this organization has recorded, newest first.
 *
 * The whole ledger rather than a per-item query, because the pipeline applies it to a whole
 * report: one read beats one query per item, and the volume is bounded by how many findings a
 * manager has ever acted on — hundreds, not millions. When that stops being true the filter to
 * add is by cause, and the shape returned here does not change.
 */
export async function readFeedbackLedger(scoped: ScopedDb): Promise<readonly StoredFeedbackEntry[]> {
  const rows = await scoped
    .selectFrom(feedbackEntries)
    .orderBy(desc(feedbackEntries.submittedAt), asc(feedbackEntries.naturalKey));
  return rows.map(toStored);
}

/** The verdicts of one action — what the corrections screen lists. */
export async function readFeedbackByAction(
  scoped: ScopedDb,
  action: string,
): Promise<readonly StoredFeedbackEntry[]> {
  const rows = await scoped
    .selectFrom(feedbackEntries, eq(feedbackEntries.action, action))
    .orderBy(desc(feedbackEntries.submittedAt), asc(feedbackEntries.naturalKey));
  return rows.map(toStored);
}

// ---------------------------------------------------------------------------
// The Correction a corrected off-goal flag writes
// ---------------------------------------------------------------------------

export interface ManagerCorrectionInput {
  readonly subjectKind: string;
  readonly subjectKey: string;
  /** What Compass said. Quoted verbatim — never a paraphrase of its own verdict. */
  readonly priorBelief: string;
  /** What the manager says instead. */
  readonly newBelief: string;
  /** `off_goal_flag_wrong` today. Open, so a new kind of correction is legal. */
  readonly contradiction: string;
  readonly evidenceKind: string;
  readonly evidenceLabel: string;
  readonly evidenceSourceKey: string;
  readonly evidenceSourceRecordId: string;
  readonly observedAt: Instant;
  readonly detectedAt: Instant;
}

/**
 * Writes the Correction row a manager's verdict produces.
 *
 * `corrections` is append-only — `ScopedDb` refuses an update or a delete on it — so a repeated
 * correction of the same flag has to be *the same row*, which the derived id gives: the key is
 * `(subject, prior version, evidence record)` and `prior_version` is 0 here because the belief
 * being contradicted is a *report verdict* rather than an entity version. A manager clicking
 * "wrong" twice therefore hits a duplicate key rather than appending a second contradiction, and
 * the insert is skipped when the row already exists.
 *
 * Two rows are written for one click and both matter. This one is the durable record of the
 * manager's judgement against Compass's — the thing an audit reads. The `feedback_entries` row
 * beside it is what actually suppresses the flag on tomorrow's report. Separating them is what
 * lets a correction be *read back* even after the suppression has been undone.
 */
export async function recordManagerCorrection(
  scoped: ScopedDb,
  input: ManagerCorrectionInput,
): Promise<{ readonly id: string; readonly written: boolean }> {
  const priorVersion = 0;
  const id = correctionRowId(
    scoped.organizationId,
    input.subjectKind,
    input.subjectKey,
    priorVersion,
    input.evidenceSourceRecordId,
  );

  const [existing] = await scoped.selectFrom(corrections, eq(corrections.id, id)).limit(1);
  if (existing !== undefined) return { id, written: false };

  await scoped.insertInto(corrections, {
    id,
    subjectKind: input.subjectKind,
    subjectKey: input.subjectKey,
    priorVersion,
    priorBelief: input.priorBelief,
    newBelief: input.newBelief,
    contradiction: input.contradiction,
    evidenceKind: input.evidenceKind,
    evidenceLabel: input.evidenceLabel,
    evidenceSourceKey: input.evidenceSourceKey,
    evidenceSourceRecordId: input.evidenceSourceRecordId,
    observedAt: toDatabaseInstant(input.observedAt),
    detectedAt: toDatabaseInstant(input.detectedAt),
    occurrenceCount: 1,
  });

  return { id, written: true };
}

export interface StoredCorrection {
  readonly id: string;
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly priorBelief: string;
  readonly newBelief: string;
  readonly contradiction: string;
  readonly evidenceLabel: string;
  readonly detectedAt: Instant;
}

/** The corrections of one kind, newest first — the corrections screen's own read. */
export async function readCorrections(
  scoped: ScopedDb,
  contradiction: string,
): Promise<readonly StoredCorrection[]> {
  const rows = await scoped
    .selectFrom(corrections, eq(corrections.contradiction, contradiction))
    .orderBy(desc(corrections.detectedAt), asc(corrections.subjectKey));

  return rows.map((row) => ({
    id: row.id,
    subjectKind: row.subjectKind,
    subjectKey: row.subjectKey,
    priorBelief: row.priorBelief,
    newBelief: row.newBelief,
    contradiction: row.contradiction,
    evidenceLabel: row.evidenceLabel,
    detectedAt: fromDatabaseInstant(row.detectedAt),
  }));
}

// ---------------------------------------------------------------------------
// Single-use email feedback links
// ---------------------------------------------------------------------------

/**
 * Claims a signed email link, or reports that it has already been spent.
 *
 * The insert *is* the check. A read-then-write would let two concurrent requests — a mail
 * client's prefetch and the manager's own click, arriving milliseconds apart — both find the
 * digest absent and both mutate state. Here the second one violates the primary key and is told
 * so, which is the guarantee the criterion asks for rather than an approximation of it.
 *
 * A `false` return is not an error: it is "this link has been used", which the route turns into a
 * stated page rather than a failure. Compass's own words, since the person reading it is a
 * manager who clicked a link twice and not an attacker.
 */
export async function claimFeedbackLink(
  scoped: ScopedDb,
  input: {
    readonly tokenDigest: string;
    readonly reportItemStableId: string;
    readonly action: string;
    readonly usedAt: Instant;
  },
): Promise<boolean> {
  const [existing] = await scoped
    .selectFrom(feedbackLinkUses, eq(feedbackLinkUses.tokenDigest, input.tokenDigest))
    .limit(1);
  if (existing !== undefined) return false;

  try {
    await scoped.insertInto(feedbackLinkUses, {
      tokenDigest: input.tokenDigest,
      reportItemStableId: input.reportItemStableId,
      action: input.action,
      usedAt: toDatabaseInstant(input.usedAt),
    });
    return true;
  } catch {
    // The primary key refused it, so another request claimed it between the read and the write.
    // That request is the one that gets to act; this one is a replay and is told so.
    return false;
  }
}

/** Whether a link has been spent, without spending it. For a read-only preview. */
export async function feedbackLinkWasUsed(scoped: ScopedDb, tokenDigest: string): Promise<boolean> {
  const [row] = await scoped
    .selectFrom(feedbackLinkUses, and(eq(feedbackLinkUses.tokenDigest, tokenDigest)))
    .limit(1);
  return row !== undefined;
}
