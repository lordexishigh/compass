import type { Instant } from '@compass/clock';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { narrationTraces } from '../schema/narration.js';
import {
  anonymizations,
  deletionRequests,
  orgPrivacySettings,
  purgeRuns,
  rawEvents,
  slackChannelIngestion,
} from '../schema/privacy.js';
import { reportItemEvidence, reportItems, reportSections, reports } from '../schema/reports.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Privacy reads and writes: retention, anonymization, deletion, chat opt-in.
 *
 * Every function here takes a `ScopedDb`, so a cross-tenant privacy read is not
 * something a caller can express — which matters more here than anywhere else in the
 * package, because these are the queries that answer "what do you hold about me".
 */

// ---------------------------------------------------------------------------
// Settings, and the documented defaults
// ---------------------------------------------------------------------------

/** 30 | 90 | 180 | 365 days. The choices the retention page offers. */
export const RAW_RETENTION_CHOICES = [30, 90, 180, 365] as const;
export type RawRetentionDays = (typeof RAW_RETENTION_CHOICES)[number];

/** 1 | 3 | 7 years, or `null` for indefinite. */
export const DERIVED_RETENTION_CHOICES = [1, 3, 7, null] as const;
export type DerivedRetentionYears = (typeof DERIVED_RETENTION_CHOICES)[number];

export const LLM_MINIMIZATION_MODES = ['full', 'redacted', 'none'] as const;
export type LlmMinimizationMode = (typeof LLM_MINIMIZATION_MODES)[number];

/**
 * What a new organization gets, and what every existing one was backfilled with.
 *
 * These three numbers are the documented defaults. `docs/ENGINEERING.md` quotes them
 * and `tools/quality-gates/tests/documented-constants.test.ts` diffs the two, so the
 * documentation cannot drift from the behaviour.
 *
 *  - **90 days of raw events.** Long enough that a manager investigating last quarter's
 *    slip can still see the conversation, short enough that Compass is not a permanent
 *    archive of what a team said to each other. 30 is offered for teams that want the
 *    shortest defensible window and 365 for regulated ones.
 *  - **3 years of derived data and reports.** A report is the product; deleting it early
 *    destroys the continuity the whole design rests on. Three years covers the
 *    performance-review and planning horizons a manager actually looks back over.
 *  - **`redacted` narration.** The deliberate part. Redacted mode sends pseudonyms to
 *    the model and puts the real names back locally, so the *reader's* report is
 *    byte-identical to full mode while the provider never sees who works here. Choosing
 *    it by default costs the reader nothing and is the strongest posture that does.
 */
export const PRIVACY_DEFAULTS = Object.freeze({
  rawEventRetentionDays: 90 as RawRetentionDays,
  derivedRetentionYears: 3 as DerivedRetentionYears,
  llmMinimizationMode: 'redacted' as LlmMinimizationMode,
});

export interface PrivacySettingsRow {
  readonly id: string;
  readonly rawEventRetentionDays: number;
  /** Null means indefinite: derived data and reports are never purged. */
  readonly derivedRetentionYears: number | null;
  readonly llmMinimizationMode: LlmMinimizationMode;
  readonly updatedAt: Instant;
}

const asMode = (value: string): LlmMinimizationMode =>
  (LLM_MINIMIZATION_MODES as readonly string[]).includes(value) ? (value as LlmMinimizationMode) : 'none';

const settingsRow = (row: typeof orgPrivacySettings.$inferSelect): PrivacySettingsRow => ({
  id: row.id,
  rawEventRetentionDays: row.rawEventRetentionDays,
  derivedRetentionYears: row.derivedRetentionYears,
  llmMinimizationMode: asMode(row.llmMinimizationMode),
  updatedAt: fromDatabaseInstant(row.updatedAt),
});

export async function readPrivacySettings(scoped: ScopedDb): Promise<PrivacySettingsRow | null> {
  const rows = await scoped.selectFrom(orgPrivacySettings).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : settingsRow(row);
}

/**
 * The settings row, created with the documented defaults if it is missing.
 *
 * Written on boot rather than defaulted on read, for the reason `0013`'s note gives:
 * an owner has to be able to tell a deliberate choice from an absent one, and a later
 * change to the defaults must not silently re-date an existing tenant's data.
 *
 * `onConflictDoNothing` because the web app and the worker boot together in
 * `docker compose up` and both call this.
 */
export async function ensurePrivacySettings(
  scoped: ScopedDb,
  input: { readonly id: string; readonly at: Instant },
): Promise<PrivacySettingsRow> {
  const existing = await readPrivacySettings(scoped);
  if (existing !== null) return existing;

  const at = toDatabaseInstant(input.at);
  await scoped
    .insertInto(orgPrivacySettings, {
      id: input.id,
      rawEventRetentionDays: PRIVACY_DEFAULTS.rawEventRetentionDays,
      derivedRetentionYears: PRIVACY_DEFAULTS.derivedRetentionYears,
      llmMinimizationMode: PRIVACY_DEFAULTS.llmMinimizationMode,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .execute();

  const created = await readPrivacySettings(scoped);
  if (created === null) {
    throw new Error(
      `Privacy settings for organization ${scoped.organizationId} could not be created or read back. ` +
        'Compass will not run with an unknown retention window.',
    );
  }
  return created;
}

export async function updatePrivacySettings(
  scoped: ScopedDb,
  input: {
    readonly rawEventRetentionDays?: RawRetentionDays;
    readonly derivedRetentionYears?: DerivedRetentionYears;
    readonly llmMinimizationMode?: LlmMinimizationMode;
    readonly at: Instant;
  },
): Promise<void> {
  await scoped
    .updateIn(orgPrivacySettings, {
      ...(input.rawEventRetentionDays === undefined
        ? {}
        : { rawEventRetentionDays: input.rawEventRetentionDays }),
      // Written explicitly when present, because `null` is a *value* here — indefinite —
      // and spreading it away would make "switch retention off" unexpressible.
      ...(input.derivedRetentionYears === undefined
        ? {}
        : { derivedRetentionYears: input.derivedRetentionYears }),
      ...(input.llmMinimizationMode === undefined ? {} : { llmMinimizationMode: input.llmMinimizationMode }),
      updatedAt: toDatabaseInstant(input.at),
    })
    .execute();
}

// ---------------------------------------------------------------------------
// Raw events
// ---------------------------------------------------------------------------

export interface RawEventInput {
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceKind: string;
  readonly artifactKind: string;
  readonly sourceRecordId: string;
  readonly conversationKey: string;
  readonly conversationName: string;
  readonly authorIdentityKind: string;
  readonly authorIdentityValue: string;
  readonly body: string;
  readonly occurredAt: Instant;
  readonly ingestedAt: Instant;
}

export interface StoredRawEvent {
  readonly id: string;
  readonly sourceKey: string;
  readonly artifactKind: string;
  readonly conversationKey: string;
  readonly conversationName: string;
  readonly authorIdentityKind: string;
  readonly authorIdentityValue: string;
  readonly body: string;
  readonly occurredAt: Instant;
}

const rawEventRow = (row: typeof rawEvents.$inferSelect): StoredRawEvent => ({
  id: row.id,
  sourceKey: row.sourceKey,
  artifactKind: row.artifactKind,
  conversationKey: row.conversationKey,
  conversationName: row.conversationName,
  authorIdentityKind: row.authorIdentityKind,
  authorIdentityValue: row.authorIdentityValue,
  body: row.body,
  occurredAt: fromDatabaseInstant(row.occurredAt),
});

/**
 * Records raw events, idempotently.
 *
 * Keyed on `(organization, source, source record id)` and upserted, so re-ingesting an
 * overlapping window rewrites the same rows instead of accumulating copies. That is
 * what makes the purge count meaningful: it counts messages, not sightings.
 */
export async function recordRawEvents(scoped: ScopedDb, inputs: readonly RawEventInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  await scoped
    .insertInto(
      rawEvents,
      inputs.map((input) => ({
        id: input.id,
        sourceKey: input.sourceKey,
        sourceKind: input.sourceKind,
        artifactKind: input.artifactKind,
        sourceRecordId: input.sourceRecordId,
        conversationKey: input.conversationKey,
        conversationName: input.conversationName,
        authorIdentityKind: input.authorIdentityKind,
        authorIdentityValue: input.authorIdentityValue,
        body: input.body,
        occurredAt: toDatabaseInstant(input.occurredAt),
        ingestedAt: toDatabaseInstant(input.ingestedAt),
      })),
    )
    .onConflictDoUpdate({
      target: [rawEvents.organizationId, rawEvents.sourceKey, rawEvents.sourceRecordId],
      set: {
        body: sql`excluded.body`,
        conversationName: sql`excluded.conversation_name`,
        occurredAt: sql`excluded.occurred_at`,
        ingestedAt: sql`excluded.ingested_at`,
      },
    })
    .execute();

  return inputs.length;
}

export async function countRawEvents(scoped: ScopedDb): Promise<number> {
  const rows = await scoped.selectFrom(rawEvents);
  return rows.length;
}

/**
 * Every raw event attributable to one of a person's own identifiers.
 *
 * The transparency page's evidence for "here is the chat Compass has read that names
 * you". Matched on the source's own identifier rather than on the resolved developer,
 * because a raw event is stored before identity resolution and must stay readable when
 * a link is later removed.
 */
export async function listRawEventsForIdentities(
  scoped: ScopedDb,
  identityValues: readonly string[],
): Promise<readonly StoredRawEvent[]> {
  if (identityValues.length === 0) return [];
  const rows = await scoped
    .selectFrom(rawEvents, inArray(rawEvents.authorIdentityValue, [...identityValues]))
    .orderBy(rawEvents.occurredAt);
  return rows.map(rawEventRow);
}

/** Everything Compass has read in one conversation, newest first. */
export async function listRawEventsForConversation(
  scoped: ScopedDb,
  conversationKey: string,
): Promise<readonly StoredRawEvent[]> {
  const rows = await scoped
    .selectFrom(rawEvents, eq(rawEvents.conversationKey, conversationKey))
    .orderBy(rawEvents.occurredAt);
  return rows.map(rawEventRow);
}

/**
 * Deletes every raw event that occurred before `cutoff`, and says how many.
 *
 * The count is taken by selecting the ids first rather than from the driver's
 * `rowCount`. That is deliberate: `rowCount` is a driver-shaped number that PGlite and
 * node-postgres report differently, and the purge record is an auditable claim rather
 * than a debug line. Selecting first also makes the count and the delete agree on
 * exactly one predicate.
 */
export async function purgeRawEventsBefore(scoped: ScopedDb, cutoff: Instant): Promise<number> {
  const doomed = await scoped.selectFrom(rawEvents, lt(rawEvents.occurredAt, toDatabaseInstant(cutoff)));
  if (doomed.length === 0) return 0;

  await scoped
    .deleteFrom(
      rawEvents,
      inArray(
        rawEvents.id,
        doomed.map((row) => row.id),
      ),
    )
    .execute();

  return doomed.length;
}

/**
 * Deletes stored reports generated before `cutoff`, children first.
 *
 * Children explicitly rather than by `ON DELETE CASCADE`, matching `saveReport`'s own
 * replay path: the report tables were built without cascades so that a stray delete
 * cannot silently take four tables with it, and retention is not the place to make an
 * exception to that.
 *
 * Feedback is deliberately *not* deleted with the report. `feedback_entries.report_id`
 * is not a foreign key precisely because a verdict outlives the page it was given on —
 * a manager's dismissal is their own record, not the report's.
 */
export async function purgeReportsBefore(scoped: ScopedDb, cutoff: Instant): Promise<number> {
  const doomed = await scoped.selectFrom(reports, lt(reports.reportInstant, toDatabaseInstant(cutoff)));
  if (doomed.length === 0) return 0;

  const ids = doomed.map((row) => row.id);

  await scoped.deleteFrom(narrationTraces, inArray(narrationTraces.reportId, ids)).execute();
  await scoped.deleteFrom(reportItemEvidence, inArray(reportItemEvidence.reportId, ids)).execute();
  await scoped.deleteFrom(reportItems, inArray(reportItems.reportId, ids)).execute();
  await scoped.deleteFrom(reportSections, inArray(reportSections.reportId, ids)).execute();
  await scoped.deleteFrom(reports, inArray(reports.id, ids)).execute();

  return ids.length;
}

// ---------------------------------------------------------------------------
// Purge records
// ---------------------------------------------------------------------------

export interface PurgeRunInput {
  readonly id: string;
  readonly startedAt: Instant;
  readonly completedAt: Instant | null;
  readonly rawCutoff: Instant;
  readonly derivedCutoff: Instant | null;
  readonly rawEventsDeleted: number;
  readonly reportsDeleted: number;
  readonly outcome: 'complete' | 'failed';
  readonly detail: string;
}

export interface StoredPurgeRun extends Omit<PurgeRunInput, 'outcome'> {
  readonly outcome: string;
}

const purgeRow = (row: typeof purgeRuns.$inferSelect): StoredPurgeRun => ({
  id: row.id,
  startedAt: fromDatabaseInstant(row.startedAt),
  completedAt: fromNullableDatabaseInstant(row.completedAt),
  rawCutoff: fromDatabaseInstant(row.rawCutoff),
  derivedCutoff: fromNullableDatabaseInstant(row.derivedCutoff),
  rawEventsDeleted: row.rawEventsDeleted,
  reportsDeleted: row.reportsDeleted,
  outcome: row.outcome,
  detail: row.detail,
});

/**
 * Records a purge — including one that deleted nothing.
 *
 * A run that found nothing to delete still writes a row, because the retention page's
 * "last purge" line is the only evidence an owner has that the job is alive. A page
 * saying "never" because the window has not been crossed is indistinguishable from one
 * whose scheduler died three months ago.
 */
export async function recordPurgeRun(scoped: ScopedDb, input: PurgeRunInput): Promise<void> {
  await scoped
    .insertInto(purgeRuns, {
      id: input.id,
      startedAt: toDatabaseInstant(input.startedAt),
      completedAt: input.completedAt === null ? null : toDatabaseInstant(input.completedAt),
      rawCutoff: toDatabaseInstant(input.rawCutoff),
      derivedCutoff: input.derivedCutoff === null ? null : toDatabaseInstant(input.derivedCutoff),
      rawEventsDeleted: input.rawEventsDeleted,
      reportsDeleted: input.reportsDeleted,
      outcome: input.outcome,
      detail: input.detail,
    })
    .onConflictDoNothing()
    .execute();
}

export async function latestPurgeRun(scoped: ScopedDb): Promise<StoredPurgeRun | null> {
  const rows = await scoped.selectFrom(purgeRuns).orderBy(sql`${purgeRuns.startedAt} desc`).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : purgeRow(row);
}

export async function listPurgeRuns(scoped: ScopedDb, limit = 20): Promise<readonly StoredPurgeRun[]> {
  const rows = await scoped.selectFrom(purgeRuns).orderBy(sql`${purgeRuns.startedAt} desc`).limit(limit);
  return rows.map(purgeRow);
}

// ---------------------------------------------------------------------------
// Anonymization
// ---------------------------------------------------------------------------

export interface AnonymizationInput {
  readonly id: string;
  readonly developerKey: string;
  readonly pseudonym: string;
  readonly reason: string;
  readonly note: string | null;
  readonly requestedByUserId: string | null;
  readonly anonymizedAt: Instant;
}

export interface StoredAnonymization {
  readonly id: string;
  readonly developerKey: string;
  readonly pseudonym: string;
  readonly reason: string;
  readonly note: string | null;
  readonly requestedByUserId: string | null;
  readonly anonymizedAt: Instant;
  readonly revertedAt: Instant | null;
}

const anonymizationRow = (row: typeof anonymizations.$inferSelect): StoredAnonymization => ({
  id: row.id,
  developerKey: row.developerKey,
  pseudonym: row.pseudonym,
  reason: row.reason,
  note: row.note,
  requestedByUserId: row.requestedByUserId,
  anonymizedAt: fromDatabaseInstant(row.anonymizedAt),
  revertedAt: fromNullableDatabaseInstant(row.revertedAt),
});

export class PseudonymCollisionError extends Error {
  constructor(pseudonym: string) {
    super(
      `The pseudonym \`${pseudonym}\` is already in use in this organization. Compass salts the ` +
        'derivation and retries, so reaching this means every candidate collided — which should be ' +
        'impossible below tens of thousands of people. The anonymization was not recorded.',
    );
    this.name = 'PseudonymCollisionError';
  }
}

/**
 * Records an anonymization, or returns the one that already exists.
 *
 * Idempotent on the developer key: asking twice is not two erasures, and the second
 * call must not fail a manager's click. The *pseudonym* uniqueness is enforced by the
 * database, and the caller is expected to have salted its candidate — see
 * `pseudonymMap` in `@compass/knowledge-model`.
 */
export async function recordAnonymization(
  scoped: ScopedDb,
  input: AnonymizationInput,
): Promise<StoredAnonymization> {
  const existing = await findAnonymization(scoped, input.developerKey);
  if (existing !== null && existing.revertedAt === null) return existing;

  await scoped
    .insertInto(anonymizations, {
      id: input.id,
      developerKey: input.developerKey,
      pseudonym: input.pseudonym,
      reason: input.reason,
      note: input.note,
      requestedByUserId: input.requestedByUserId,
      anonymizedAt: toDatabaseInstant(input.anonymizedAt),
      revertedAt: null,
      revertedByUserId: null,
    })
    .onConflictDoUpdate({
      // A previously reverted anonymization is re-asserted on the same row, so the
      // history of "anonymised, restored, anonymised again" stays one lineage.
      target: [anonymizations.organizationId, anonymizations.developerKey],
      set: {
        pseudonym: input.pseudonym,
        reason: input.reason,
        note: input.note,
        requestedByUserId: input.requestedByUserId,
        anonymizedAt: toDatabaseInstant(input.anonymizedAt),
        revertedAt: null,
        revertedByUserId: null,
      },
    })
    .execute();

  const stored = await findAnonymization(scoped, input.developerKey);
  if (stored === null) throw new PseudonymCollisionError(input.pseudonym);
  return stored;
}

export async function findAnonymization(
  scoped: ScopedDb,
  developerKey: string,
): Promise<StoredAnonymization | null> {
  const rows = await scoped
    .selectFrom(anonymizations, eq(anonymizations.developerKey, developerKey))
    .limit(1);
  const row = rows.at(0);
  return row === undefined ? null : anonymizationRow(row);
}

/** Live anonymizations only — the ones whose names are currently withdrawn. */
export async function listAnonymizations(scoped: ScopedDb): Promise<readonly StoredAnonymization[]> {
  const rows = await scoped
    .selectFrom(anonymizations, isNull(anonymizations.revertedAt))
    .orderBy(anonymizations.developerKey);
  return rows.map(anonymizationRow);
}

/**
 * Puts a name back — as a second recorded act, never as the absence of the first.
 *
 * The row is kept and stamped rather than deleted, so "this person was anonymised on
 * the 3rd and restored on the 5th" stays answerable. A mistaken erasure request has to
 * be fixable; a silent one does not.
 */
export async function revertAnonymization(
  scoped: ScopedDb,
  input: { readonly developerKey: string; readonly byUserId: string | null; readonly at: Instant },
): Promise<void> {
  await scoped
    .updateIn(
      anonymizations,
      { revertedAt: toDatabaseInstant(input.at), revertedByUserId: input.byUserId },
      eq(anonymizations.developerKey, input.developerKey),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// Slack channel opt-in
// ---------------------------------------------------------------------------

export const CONVERSATION_KINDS = [
  'public_channel',
  'private_channel',
  'direct_message',
  'group_message',
] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export interface SlackChannelInput {
  readonly id: string;
  readonly conversationKey: string;
  readonly conversationName: string;
  readonly conversationKind: ConversationKind;
  readonly enabled: boolean;
  readonly byUserId: string | null;
  readonly at: Instant;
}

export interface StoredSlackChannel {
  readonly id: string;
  readonly conversationKey: string;
  readonly conversationName: string;
  readonly conversationKind: string;
  readonly enabled: boolean;
  readonly enabledAt: Instant | null;
  readonly disabledAt: Instant | null;
  readonly noticePostedAt: Instant | null;
  readonly noticeDetail: string | null;
}

const channelRow = (row: typeof slackChannelIngestion.$inferSelect): StoredSlackChannel => ({
  id: row.id,
  conversationKey: row.conversationKey,
  conversationName: row.conversationName,
  conversationKind: row.conversationKind,
  enabled: row.enabled,
  enabledAt: fromNullableDatabaseInstant(row.enabledAt),
  disabledAt: fromNullableDatabaseInstant(row.disabledAt),
  noticePostedAt: fromNullableDatabaseInstant(row.noticePostedAt),
  noticeDetail: row.noticeDetail,
});

export class PrivateConversationError extends Error {
  readonly conversationKind: string;

  constructor(conversationName: string, conversationKind: string) {
    super(
      `Compass will not read \`${conversationName}\`: it is a ${conversationKind.replace(/_/g, ' ')}. ` +
        'Only public channels can be turned on, and that is not a setting — direct messages and private ' +
        'channels are outside what Compass reads at all.',
    );
    this.name = 'PrivateConversationError';
    this.conversationKind = conversationKind;
  }
}

/**
 * Turns a channel's ingestion on or off, and refuses anything that is not public.
 *
 * The refusal is here as well as in the CHECK constraint and again in the ingest
 * filter. Three guards for one rule looks excessive until you name them: the
 * constraint makes the state unwritable, this makes the *refusal legible* to the person
 * who tried, and the ingest filter means a row that somehow existed would still be
 * skipped. Only the middle one can produce a sentence a manager reads.
 */
export async function setSlackChannelIngestion(
  scoped: ScopedDb,
  input: SlackChannelInput,
): Promise<StoredSlackChannel> {
  if (input.enabled && input.conversationKind !== 'public_channel') {
    throw new PrivateConversationError(input.conversationName, input.conversationKind);
  }

  const at = toDatabaseInstant(input.at);

  await scoped
    .insertInto(slackChannelIngestion, {
      id: input.id,
      conversationKey: input.conversationKey,
      conversationName: input.conversationName,
      conversationKind: input.conversationKind,
      enabled: input.enabled,
      enabledAt: input.enabled ? at : null,
      enabledByUserId: input.enabled ? input.byUserId : null,
      disabledAt: input.enabled ? null : at,
      noticePostedAt: null,
      noticeDetail: null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [slackChannelIngestion.organizationId, slackChannelIngestion.conversationKey],
      set: {
        conversationName: input.conversationName,
        conversationKind: input.conversationKind,
        enabled: input.enabled,
        // `enabled_at` is only rewritten when the channel is being turned on, so the
        // settings page can say *when* each ingested channel was enabled rather than
        // when its row was last touched.
        ...(input.enabled ? { enabledAt: at, enabledByUserId: input.byUserId, disabledAt: null } : { disabledAt: at }),
        updatedAt: at,
      },
    })
    .execute();

  const stored = await findSlackChannel(scoped, input.conversationKey);
  if (stored === null) {
    throw new Error(`The channel row for \`${input.conversationKey}\` could not be read back after writing.`);
  }
  return stored;
}

export async function findSlackChannel(
  scoped: ScopedDb,
  conversationKey: string,
): Promise<StoredSlackChannel | null> {
  const rows = await scoped
    .selectFrom(slackChannelIngestion, eq(slackChannelIngestion.conversationKey, conversationKey))
    .limit(1);
  const row = rows.at(0);
  return row === undefined ? null : channelRow(row);
}

/** Every conversation Compass knows about, ingested or not. What the settings page lists. */
export async function listSlackChannels(scoped: ScopedDb): Promise<readonly StoredSlackChannel[]> {
  const rows = await scoped.selectFrom(slackChannelIngestion).orderBy(slackChannelIngestion.conversationName);
  return rows.map(channelRow);
}

/**
 * The conversation keys ingest is allowed to read.
 *
 * Both predicates, even though the CHECK constraint makes the second redundant: this
 * is the query the ingest filter is built from, and a filter that relied on a
 * constraint elsewhere in the schema would be one schema change away from silence.
 */
export async function ingestibleConversationKeys(scoped: ScopedDb): Promise<readonly string[]> {
  const rows = await scoped.selectFrom(
    slackChannelIngestion,
    and(eq(slackChannelIngestion.enabled, true), eq(slackChannelIngestion.conversationKind, 'public_channel')),
  );
  return rows.map((row) => row.conversationKey).sort();
}

/** Records the outcome of the bot's own "Compass reads this channel" post. */
export async function recordChannelNotice(
  scoped: ScopedDb,
  input: {
    readonly conversationKey: string;
    readonly postedAt: Instant | null;
    readonly detail: string;
  },
): Promise<void> {
  await scoped
    .updateIn(
      slackChannelIngestion,
      {
        noticePostedAt: input.postedAt === null ? null : toDatabaseInstant(input.postedAt),
        noticeDetail: input.detail,
      },
      eq(slackChannelIngestion.conversationKey, input.conversationKey),
    )
    .execute();
}

/** Channels that are on but have not been told about yet. The notice job's work list. */
export async function channelsAwaitingNotice(scoped: ScopedDb): Promise<readonly StoredSlackChannel[]> {
  const rows = await scoped
    .selectFrom(
      slackChannelIngestion,
      and(eq(slackChannelIngestion.enabled, true), isNull(slackChannelIngestion.noticePostedAt)),
    )
    .orderBy(slackChannelIngestion.conversationName);
  return rows.map(channelRow);
}

// ---------------------------------------------------------------------------
// Deletion requests
// ---------------------------------------------------------------------------

export type DeletionSubjectKind = 'account' | 'organization';
export type DeletionStatus = 'grace' | 'undone' | 'purged' | 'failed';

export interface DeletionRequestInput {
  readonly id: string;
  readonly subjectKind: DeletionSubjectKind;
  readonly subjectId: string;
  readonly requestedByUserId: string | null;
  readonly notifyEmail: string;
  readonly requestedAt: Instant;
  readonly graceEndsAt: Instant;
  readonly hardDeleteBy: Instant;
  readonly undoTokenHash: string;
  readonly exportOfferedAt: Instant;
  readonly detail: string;
}

export interface StoredDeletionRequest {
  readonly id: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly requestedByUserId: string | null;
  readonly notifyEmail: string;
  readonly requestedAt: Instant;
  readonly graceEndsAt: Instant;
  readonly hardDeleteBy: Instant;
  readonly status: string;
  readonly exportOfferedAt: Instant;
  readonly exportDownloadedAt: Instant | null;
  readonly undoneAt: Instant | null;
  readonly purgedAt: Instant | null;
  readonly deletedCategories: readonly string[] | null;
  readonly confirmationSentAt: Instant | null;
  readonly detail: string;
}

const deletionRow = (row: typeof deletionRequests.$inferSelect): StoredDeletionRequest => ({
  id: row.id,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  requestedByUserId: row.requestedByUserId,
  notifyEmail: row.notifyEmail,
  requestedAt: fromDatabaseInstant(row.requestedAt),
  graceEndsAt: fromDatabaseInstant(row.graceEndsAt),
  hardDeleteBy: fromDatabaseInstant(row.hardDeleteBy),
  status: row.status,
  exportOfferedAt: fromDatabaseInstant(row.exportOfferedAt),
  exportDownloadedAt: fromNullableDatabaseInstant(row.exportDownloadedAt),
  undoneAt: fromNullableDatabaseInstant(row.undoneAt),
  purgedAt: fromNullableDatabaseInstant(row.purgedAt),
  deletedCategories: row.deletedCategories,
  confirmationSentAt: fromNullableDatabaseInstant(row.confirmationSentAt),
  detail: row.detail,
});

export async function insertDeletionRequest(
  scoped: ScopedDb,
  input: DeletionRequestInput,
): Promise<StoredDeletionRequest> {
  const at = toDatabaseInstant(input.requestedAt);

  await scoped
    .insertInto(deletionRequests, {
      id: input.id,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      requestedByUserId: input.requestedByUserId,
      notifyEmail: input.notifyEmail,
      requestedAt: at,
      graceEndsAt: toDatabaseInstant(input.graceEndsAt),
      hardDeleteBy: toDatabaseInstant(input.hardDeleteBy),
      undoTokenHash: input.undoTokenHash,
      status: 'grace',
      exportOfferedAt: toDatabaseInstant(input.exportOfferedAt),
      exportDownloadedAt: null,
      undoneAt: null,
      purgedAt: null,
      deletedCategories: null,
      confirmationSentAt: null,
      detail: input.detail,
      createdAt: at,
      updatedAt: at,
    })
    .execute();

  const stored = await findDeletionRequest(scoped, input.id);
  if (stored === null) {
    throw new Error(`The deletion request ${input.id} could not be read back after writing.`);
  }
  return stored;
}

export async function findDeletionRequest(scoped: ScopedDb, id: string): Promise<StoredDeletionRequest | null> {
  const rows = await scoped.selectFrom(deletionRequests, eq(deletionRequests.id, id)).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : deletionRow(row);
}

/**
 * The request an undo link names, found by the digest of its token.
 *
 * By digest, never by the token: the token exists in one email and nowhere else, so a
 * leaked copy of this table cannot cancel — or complete — somebody's deletion. Same
 * arrangement as `sessions.token_hash` and the share links.
 */
export async function findDeletionRequestByUndoHash(
  scoped: ScopedDb,
  undoTokenHash: string,
): Promise<StoredDeletionRequest | null> {
  const rows = await scoped
    .selectFrom(deletionRequests, eq(deletionRequests.undoTokenHash, undoTokenHash))
    .limit(1);
  const row = rows.at(0);
  return row === undefined ? null : deletionRow(row);
}

/** The live request for a subject, if any. `grace` is the only live status. */
export async function findLiveDeletionRequest(
  scoped: ScopedDb,
  subjectKind: DeletionSubjectKind,
  subjectId: string,
): Promise<StoredDeletionRequest | null> {
  const rows = await scoped
    .selectFrom(
      deletionRequests,
      and(
        eq(deletionRequests.subjectKind, subjectKind),
        eq(deletionRequests.subjectId, subjectId),
        eq(deletionRequests.status, 'grace'),
      ),
    )
    .limit(1);
  const row = rows.at(0);
  return row === undefined ? null : deletionRow(row);
}

export async function listDeletionRequests(scoped: ScopedDb): Promise<readonly StoredDeletionRequest[]> {
  const rows = await scoped.selectFrom(deletionRequests).orderBy(sql`${deletionRequests.requestedAt} desc`);
  return rows.map(deletionRow);
}

/**
 * Requests whose grace period has ended and which are therefore due to be purged.
 *
 * `grace_ends_at <= now`, not `hard_delete_by <= now`. The seven days are the person's
 * window to change their mind; the thirty are Compass's deadline to have finished. A
 * job that waited for the second would be honouring the outer bound by missing the
 * point of the inner one.
 */
export async function listDeletionRequestsDue(
  scoped: ScopedDb,
  now: Instant,
): Promise<readonly StoredDeletionRequest[]> {
  const rows = await scoped
    .selectFrom(
      deletionRequests,
      and(eq(deletionRequests.status, 'grace'), lt(deletionRequests.graceEndsAt, toDatabaseInstant(now))),
    )
    .orderBy(deletionRequests.graceEndsAt);
  return rows.map(deletionRow);
}

export async function markDeletionUndone(
  scoped: ScopedDb,
  input: { readonly id: string; readonly at: Instant; readonly detail: string },
): Promise<void> {
  await scoped
    .updateIn(
      deletionRequests,
      {
        status: 'undone',
        undoneAt: toDatabaseInstant(input.at),
        detail: input.detail,
        updatedAt: toDatabaseInstant(input.at),
      },
      and(eq(deletionRequests.id, input.id), eq(deletionRequests.status, 'grace')),
    )
    .execute();
}

export async function markExportDownloaded(
  scoped: ScopedDb,
  input: { readonly id: string; readonly at: Instant },
): Promise<void> {
  await scoped
    .updateIn(
      deletionRequests,
      { exportDownloadedAt: toDatabaseInstant(input.at), updatedAt: toDatabaseInstant(input.at) },
      eq(deletionRequests.id, input.id),
    )
    .execute();
}

export async function markDeletionPurged(
  scoped: ScopedDb,
  input: {
    readonly id: string;
    readonly at: Instant;
    readonly categories: readonly string[];
    readonly confirmationSentAt: Instant | null;
    readonly detail: string;
    readonly outcome: 'purged' | 'failed';
  },
): Promise<void> {
  await scoped
    .updateIn(
      deletionRequests,
      {
        status: input.outcome,
        purgedAt: input.outcome === 'purged' ? toDatabaseInstant(input.at) : null,
        deletedCategories: [...input.categories],
        confirmationSentAt:
          input.confirmationSentAt === null ? null : toDatabaseInstant(input.confirmationSentAt),
        detail: input.detail,
        updatedAt: toDatabaseInstant(input.at),
      },
      eq(deletionRequests.id, input.id),
    )
    .execute();
}
