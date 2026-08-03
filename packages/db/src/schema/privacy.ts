import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { organizations } from './tables.js';

/**
 * Privacy: retention, anonymization, deletion, and what the model is allowed to see.
 *
 * Six tables, and the split between them is the design. Three of them are *settings
 * and queues* that belong to a living organization; three are *records of what was
 * done* that have to outlive the thing they were done to.
 *
 * ## Which tables reference `organizations` and which deliberately do not
 *
 * `org_privacy_settings`, `slack_channel_ingestion` and `deletion_requests` carry a
 * foreign key: they are configuration, and configuration for an organization that no
 * longer exists is meaningless.
 *
 * `purge_runs` and `anonymizations` carry none, on purpose. The acceptance criteria
 * require that a purge's count and timestamp survive and that an anonymization writes
 * a record that cannot be silently reversed — and an organization hard-delete that
 * cascaded them away would satisfy neither. Both still carry `organization_id`, so the
 * scoped-query layer applies to them exactly as it does to everything else; what they
 * do not carry is a constraint that makes their own deletion somebody else's side
 * effect. `raw_events` is the mirror image: it is the thing retention exists to
 * delete, so it cascades.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The per-organization privacy posture: how long data is kept, and how much of it the
 * model is shown.
 *
 * One row per organization, and the row is written when the organization is created
 * rather than defaulted at read time. That is a deliberate choice with a visible
 * consequence: the retention page shows a *setting* an owner can read and change on
 * day one, instead of the words "using the default" over a value stored nowhere. It
 * also means a later change to the documented default cannot silently re-date every
 * existing tenant's data.
 *
 * ## Why the windows are closed vocabularies
 *
 * `raw_event_retention_days` is CHECK-constrained to 30, 90, 180 or 365, and
 * `derived_retention_years` to 1, 3, 7 or NULL. The spec names those choices, and an
 * open integer would mean a typo could set a nine-day window that silently deleted
 * the week a manager was about to read. NULL is `indefinite` — the absence of a
 * deadline, which is a different statement from a very long one and is the value the
 * purge treats as "do not touch derived data at all".
 *
 * `llm_minimization_mode` is `full`, `redacted` or `none`, constrained here as well
 * as in `@compass/narrator`, for the reason every closed vocabulary in this schema is
 * constrained twice: a fourth value would land in no branch of the narration switch,
 * and the failure would be a report that quietly went out through the wrong path.
 */
export const orgPrivacySettings = pgTable(
  'org_privacy_settings',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** 30 | 90 | 180 | 365. The window verbatim third-party text is kept for. */
    rawEventRetentionDays: integer('raw_event_retention_days').notNull(),
    /** 1 | 3 | 7 years, or NULL for indefinite. Governs reports and derived rows. */
    derivedRetentionYears: integer('derived_retention_years'),
    /** `full` | `redacted` | `none`. See `@compass/narrator`'s minimization module. */
    llmMinimizationMode: text('llm_minimization_mode').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    unique('org_privacy_settings_org_key').on(table.organizationId),
    check(
      'org_privacy_settings_raw_window',
      sql`${table.rawEventRetentionDays} in (30, 90, 180, 365)`,
    ),
    check(
      'org_privacy_settings_derived_window',
      sql`${table.derivedRetentionYears} is null or ${table.derivedRetentionYears} in (1, 3, 7)`,
    ),
    check(
      'org_privacy_settings_llm_mode',
      sql`${table.llmMinimizationMode} in ('full', 'redacted', 'none')`,
    ),
  ],
);

/**
 * A chat conversation a manager has explicitly opted into reading.
 *
 * Slack ingestion is opt-in per named channel and there is no wildcard: a conversation
 * with no row here is not ingested, which makes "which channels does Compass read"
 * answerable by selecting from one table rather than by reasoning about a filter.
 *
 * ## The constraint that matters
 *
 * `slack_channel_ingestion_public_only` says `enabled = false OR conversation_kind =
 * 'public_channel'`. A direct message or a private channel is therefore *unenablable*
 * by any path — a route, a script, a psql session — rather than merely unenabled by
 * the code that happens to write these rows today. The ingest path filters on kind
 * again independently, because neither guard is trusted to be the only one, and
 * `packages/ingest/tests/chat-ingest.test.ts` asserts the filter holds even when a
 * row claims a private channel is enabled.
 *
 * `notice_posted_at` records the bot's own announcement in the channel. It is nullable
 * because posting can fail — a bot that is not in the channel yet, a revoked token —
 * and the settings page states that honestly rather than implying the team was told.
 */
export const slackChannelIngestion = pgTable(
  'slack_channel_ingestion',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** The provider's own opaque conversation id. */
    conversationKey: text('conversation_key').notNull(),
    conversationName: text('conversation_name').notNull(),
    /** `public_channel` | `private_channel` | `direct_message` | `group_message`. */
    conversationKind: text('conversation_kind').notNull(),
    enabled: boolean('enabled').notNull(),
    /** When it was first turned on. Shown on the settings page beside the name. */
    enabledAt: instantColumn('enabled_at'),
    enabledByUserId: uuid('enabled_by_user_id'),
    disabledAt: instantColumn('disabled_at'),
    /** When the bot announced itself in the channel. Null means it could not. */
    noticePostedAt: instantColumn('notice_posted_at'),
    /** The outcome sentence from the last notice attempt, for the settings page. */
    noticeDetail: text('notice_detail'),
    ...recordTimestamps(),
  },
  (table) => [
    unique('slack_channel_ingestion_org_conversation_key').on(table.organizationId, table.conversationKey),
    index('slack_channel_ingestion_org_enabled_idx').on(table.organizationId, table.enabled),
    check(
      'slack_channel_ingestion_kind',
      sql`${table.conversationKind} in ('public_channel', 'private_channel', 'direct_message', 'group_message')`,
    ),
    // The whole of "DMs and private channels are never ingested", in the database.
    check(
      'slack_channel_ingestion_public_only',
      sql`${table.enabled} = false or ${table.conversationKind} = 'public_channel'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// The thing retention deletes
// ---------------------------------------------------------------------------

/**
 * One verbatim third-party message, kept only as long as the raw window allows.
 *
 * ## Why this table exists at all, when nothing else stores raw text for its own sake
 *
 * Every other artifact family the connector port carries is *projected* into a typed
 * knowledge entity and the original is discarded — a commit becomes a `commits` row, an
 * issue becomes a `tickets` row. Chat is the exception: a message's value is its prose,
 * so there is nothing to project it into, and a message Compass has read is a message
 * Compass is holding. That is precisely the thing a team reading over their manager's
 * shoulder worries about, so it is the thing that gets an explicit window, an explicit
 * opt-in, and a purge that actually issues a DELETE.
 *
 * `body` is the message text as posted. It is never shown to the narrator —
 * `assertNoRawIngestedText` fails the build if a field named `body` reaches the
 * narration payload — and it is never read by the analysis core.
 *
 * The unique key is `(organization, source, source record id)`, so re-ingesting an
 * overlapping window rewrites the same row rather than accumulating copies. Retention
 * therefore deletes a bounded set and the purge count means what it says.
 */
export const rawEvents = pgTable(
  'raw_events',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    sourceKey: text('source_key').notNull(),
    sourceKind: text('source_kind').notNull(),
    /** The connector-port artifact family. `messages` is the only one stored today. */
    artifactKind: text('artifact_kind').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    conversationKey: text('conversation_key').notNull(),
    conversationName: text('conversation_name').notNull(),
    /** The identifier the source attributed this to, unresolved. */
    authorIdentityKind: text('author_identity_kind').notNull(),
    authorIdentityValue: text('author_identity_value').notNull(),
    /** Verbatim. The only column in Compass whose whole purpose is to be deleted. */
    body: text('body').notNull(),
    /** The message's own posting time. What the retention window is measured against. */
    occurredAt: instantColumn('occurred_at').notNull(),
    ingestedAt: instantColumn('ingested_at').notNull(),
  },
  (table) => [
    unique('raw_events_org_source_record_key').on(table.organizationId, table.sourceKey, table.sourceRecordId),
    index('raw_events_org_occurred_idx').on(table.organizationId, table.occurredAt),
    index('raw_events_org_conversation_idx').on(table.organizationId, table.conversationKey),
  ],
);

// ---------------------------------------------------------------------------
// Records of what was done
// ---------------------------------------------------------------------------

/**
 * One row per purge, whether it deleted anything or not.
 *
 * A run that found nothing to delete still writes a row, and that is the point: the
 * retention page's "last purge" line is evidence that the job is running, and a page
 * that said "never" because the window has not been crossed yet is indistinguishable
 * from a page whose scheduler died in March.
 *
 * The cutoffs are stored alongside the counts because a count on its own is not
 * auditable — "deleted 412 rows" tells an owner nothing they can check, while
 * "deleted 412 raw events older than 2026-05-05" is a claim they can go and verify.
 */
export const purgeRuns = pgTable(
  'purge_runs',
  {
    id: uuid('id').primaryKey(),
    // No FK, deliberately: see the module note. A purge record outlives its tenant.
    organizationId: organizationId(),
    startedAt: instantColumn('started_at').notNull(),
    completedAt: instantColumn('completed_at'),
    /** The instant raw events had to predate to be deleted. */
    rawCutoff: instantColumn('raw_cutoff').notNull(),
    /** Null when derived retention is indefinite, in which case nothing derived was touched. */
    derivedCutoff: instantColumn('derived_cutoff'),
    rawEventsDeleted: integer('raw_events_deleted').notNull(),
    reportsDeleted: integer('reports_deleted').notNull(),
    /** `complete` or `failed`. A failure keeps its row so the page can say so. */
    outcome: text('outcome').notNull(),
    /** One sentence in the product's voice. What the retention page prints. */
    detail: text('detail').notNull(),
  },
  (table) => [
    index('purge_runs_org_started_idx').on(table.organizationId, table.startedAt),
    check('purge_runs_outcome', sql`${table.outcome} in ('complete', 'failed')`),
  ],
);

/**
 * A person whose name Compass has stopped printing.
 *
 * The row is the anonymization: it carries the developer key, the pseudonym assigned,
 * who asked and when. `developers.anonymized_at` and `developers.pseudonym` mirror it
 * so the pure analysis path can read the decision out of the snapshot without a join,
 * and the version history behind that entity records the change like any other.
 *
 * ## "Cannot be silently reversed"
 *
 * Three things hold that up together. This row has no delete path in the application.
 * The `developers` change appends an `entity_versions` row, and that table refuses
 * UPDATE and DELETE in the database itself. And an `audit_log_entries` row is written
 * naming the actor. Un-anonymising is possible — a mistaken erasure request has to be
 * fixable — but it is a second recorded act, not the absence of the first.
 *
 * The pseudonym carries a per-organization unique constraint. `pseudonymFor` is a
 * 32-bit digest into two word lists and will collide eventually; the anonymize path
 * salts until the insert succeeds, so the *stored* pseudonym is unique by construction
 * rather than by probability.
 */
export const anonymizations = pgTable(
  'anonymizations',
  {
    id: uuid('id').primaryKey(),
    // No FK, deliberately: the record of an erasure must survive the tenant's own erasure.
    organizationId: organizationId(),
    developerKey: text('developer_key').notNull(),
    pseudonym: text('pseudonym').notNull(),
    /** `departed` | `erasure_request`. Open text; stated verbatim on the roster. */
    reason: text('reason').notNull(),
    /** The manager's own words, when they gave any. */
    note: text('note'),
    requestedByUserId: uuid('requested_by_user_id'),
    anonymizedAt: instantColumn('anonymized_at').notNull(),
    /** Set when a later, equally recorded act put the name back. */
    revertedAt: instantColumn('reverted_at'),
    revertedByUserId: uuid('reverted_by_user_id'),
  },
  (table) => [
    unique('anonymizations_org_developer_key').on(table.organizationId, table.developerKey),
    unique('anonymizations_org_pseudonym_key').on(table.organizationId, table.pseudonym),
    index('anonymizations_org_at_idx').on(table.organizationId, table.anonymizedAt),
  ],
);

/**
 * A request to delete an account or a whole organization, and where it is in its life.
 *
 * ## The three deadlines, and why they are stored rather than derived
 *
 * `grace_ends_at` is seven days after the request; `hard_delete_by` is thirty. Both are
 * computed once, at request time, from the injected clock — not derived on read from
 * `requested_at` plus a constant. The reason is the same one `sessions` gives for
 * freezing `expires_at`: a deadline derived on read moves whenever the constant is
 * edited, and "the grace period was seven days when you asked" is a promise Compass
 * made to a person, not a configuration value.
 *
 * `undo_token_hash` is a SHA-256 digest, never the token. The token goes in one email
 * and exists nowhere else, exactly like a session cookie or a magic link — a leaked
 * backup of this table must not let somebody else cancel, or complete, a deletion.
 *
 * `deleted_categories` is the enumeration the confirmation email carries. It is written
 * by the purge itself, from what the purge actually deleted, so the email cannot claim
 * a category the code did not touch.
 */
export const deletionRequests = pgTable(
  'deletion_requests',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** `account` or `organization`. */
    subjectKind: text('subject_kind').notNull(),
    /** The user id for `account`, the organization id for `organization`. */
    subjectId: text('subject_id').notNull(),
    requestedByUserId: uuid('requested_by_user_id'),
    /** Where the confirmation and the undo link were sent. */
    notifyEmail: text('notify_email').notNull(),
    requestedAt: instantColumn('requested_at').notNull(),
    /** Frozen at request time. Undo works up to this instant and not after. */
    graceEndsAt: instantColumn('grace_ends_at').notNull(),
    /** Frozen at request time. The purge must have completed by this instant. */
    hardDeleteBy: instantColumn('hard_delete_by').notNull(),
    /** SHA-256 of the undo secret, hex. Never the secret. */
    undoTokenHash: text('undo_token_hash').notNull(),
    /** `grace` | `undone` | `purged` | `failed`. */
    status: text('status').notNull(),
    /** When the export was offered. Always set: it is offered in the same act. */
    exportOfferedAt: instantColumn('export_offered_at').notNull(),
    exportDownloadedAt: instantColumn('export_downloaded_at'),
    undoneAt: instantColumn('undone_at'),
    purgedAt: instantColumn('purged_at'),
    /** What the purge deleted, as the confirmation email enumerates it. */
    deletedCategories: jsonb('deleted_categories').$type<readonly string[]>(),
    confirmationSentAt: instantColumn('confirmation_sent_at'),
    /** One sentence in the product's voice. Shown wherever the request is shown. */
    detail: text('detail').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    unique('deletion_requests_undo_token_key').on(table.undoTokenHash),
    index('deletion_requests_org_status_idx').on(table.organizationId, table.status),
    index('deletion_requests_grace_idx').on(table.status, table.graceEndsAt),
    check('deletion_requests_subject_kind', sql`${table.subjectKind} in ('account', 'organization')`),
    check(
      'deletion_requests_status',
      sql`${table.status} in ('grace', 'undone', 'purged', 'failed')`,
    ),
    // A grace period that ends after the hard deadline would be a request that can
    // never be undone in time and can never be purged on time.
    check('deletion_requests_deadline_order', sql`${table.graceEndsAt} < ${table.hardDeleteBy}`),
  ],
);
