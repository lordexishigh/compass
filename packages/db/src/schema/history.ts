import { doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId } from './columns.js';
import { organizations } from './tables.js';

/**
 * Append-only history.
 *
 * Nothing in this file is ever UPDATEd or DELETEd. Three independent mechanisms
 * enforce that rather than one:
 *
 *  1. `ScopedDb.updateIn` / `deleteFrom` throw `AppendOnlyTableError` for any
 *     table in `APPEND_ONLY_TABLE_NAMES`, so the application layer cannot do it
 *     even by accident.
 *  2. A `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger on each of these tables
 *     raises, so a hand-written query, a migration or a psql session cannot
 *     either. (See the tail of `drizzle/0001_knowledge_model.sql`.)
 *  3. `packages/db/tests/migrations.test.ts` asserts both against a real engine —
 *     the trigger by attempting each mutation, the application guard by calling
 *     `updateIn`/`deleteFrom` — and `packages/knowledge-model/tests/reconcile.test.ts`
 *     asserts the consequence: writing a Correction leaves every prior row intact.
 *
 * Re-inserting a row that already exists is *not* a mutation: every table here
 * carries a natural uniqueness constraint and writes go through
 * `onConflictDoNothing`, which is what makes a repeated ingest of the same window
 * produce zero new history rows without anything having to be overwritten.
 */

/**
 * One row per tracked-field revision of one entity, for every entity family.
 *
 * `tracked_fields` is the entity's complete tracked state as of this version, so
 * a prior belief can be read back verbatim long after the entity row has moved
 * on. `changed_fields` names what this revision changed, sorted, so a diff never
 * has to be recomputed to answer "what changed since yesterday".
 */
export const entityVersions = pgTable(
  'entity_versions',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    entityKind: text('entity_kind').notNull(),
    entityNaturalKey: text('entity_natural_key').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** 1 for the first sighting, then one higher per tracked-field change. */
    version: integer('version').notNull(),
    trackedFields: jsonb('tracked_fields').$type<Record<string, unknown>>().notNull(),
    changedFields: jsonb('changed_fields').$type<readonly string[]>().notNull(),
    /** The observed record's own event time, never the run clock. */
    observedAt: instantColumn('observed_at').notNull(),
    evidenceSourceKey: text('evidence_source_key'),
    evidenceSourceRecordId: text('evidence_source_record_id'),
  },
  (table) => [
    unique('entity_versions_org_entity_version_key').on(
      table.organizationId,
      table.entityKind,
      table.entityNaturalKey,
      table.version,
    ),
    index('entity_versions_org_entity_idx').on(table.organizationId, table.entityKind, table.entityNaturalKey),
  ],
);

/**
 * A tracker status change, exactly as the tracker reported it.
 *
 * Uniqueness is on the source's own record id, so an overlapping window that
 * returns the same transition twice inserts once. Cycle time and "how long has
 * this been in progress" are read from here, not from the ticket's current row.
 */
export const ticketStatusTransitions = pgTable(
  'ticket_status_transitions',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    ticketKey: text('ticket_key').notNull(),
    sourceKey: text('source_key').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    fromStatusCategory: text('from_status_category'),
    toStatusCategory: text('to_status_category').notNull(),
    actorDeveloperKey: text('actor_developer_key'),
    transitionedAt: instantColumn('transitioned_at').notNull(),
  },
  (table) => [
    unique('ticket_status_transitions_org_source_record_key').on(
      table.organizationId,
      table.sourceKey,
      table.sourceRecordId,
    ),
    index('ticket_status_transitions_org_ticket_idx').on(
      table.organizationId,
      table.ticketKey,
      table.transitionedAt,
    ),
  ],
);

/**
 * An item added to or removed from a sprint. Scope creep, evidenced.
 *
 * Only what the source reported is stored. Whether the change landed *after the
 * sprint started* is deliberately absent: that is a derivation against the
 * sprint's own `start_at`, and a derivation written into append-only history can
 * never be corrected. A backfill that reaches the scope change before it reaches
 * the sprint would have frozen the wrong answer permanently. The flag is computed
 * where it is used instead — in the risk projection and in the snapshot — from the
 * sprint row, which is free to arrive later.
 */
export const sprintScopeChanges = pgTable(
  'sprint_scope_changes',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    sprintKey: text('sprint_key').notNull(),
    ticketKey: text('ticket_key').notNull(),
    sourceKey: text('source_key').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    /** `added` or `removed`. */
    change: text('change').notNull(),
    actorDeveloperKey: text('actor_developer_key'),
    changedAt: instantColumn('changed_at').notNull(),
  },
  (table) => [
    unique('sprint_scope_changes_org_source_record_key').on(
      table.organizationId,
      table.sourceKey,
      table.sourceRecordId,
    ),
    index('sprint_scope_changes_org_sprint_idx').on(table.organizationId, table.sprintKey, table.changedAt),
  ],
);

/**
 * A Correction: new data contradicted a belief Compass had already stated.
 *
 * This is the row behind "reported blocked yesterday, actually merged". It holds
 * the prior belief verbatim, the new belief, the evidence artifact that settled
 * it and the instant the contradiction was detected. Writing one never touches
 * the prior belief — `entity_versions` still holds it, and the entity row moves
 * forward with a *new* version rather than an edited one.
 *
 * Uniqueness is on (subject, prior version, evidence record), which is what makes
 * the same contradiction re-observed in an overlapping window produce exactly one
 * Correction.
 */
export const corrections = pgTable(
  'corrections',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    /** Which entity version held the belief that turned out to be wrong. */
    priorVersion: integer('prior_version').notNull(),
    priorBelief: text('prior_belief').notNull(),
    newBelief: text('new_belief').notNull(),
    /** Free-text kind, e.g. `blocked_but_merged`. Open so new patterns are legal. */
    contradiction: text('contradiction').notNull(),
    evidenceKind: text('evidence_kind').notNull(),
    evidenceLabel: text('evidence_label').notNull(),
    evidenceSourceKey: text('evidence_source_key').notNull(),
    evidenceSourceRecordId: text('evidence_source_record_id').notNull(),
    /** When the contradicting artifact happened. */
    observedAt: instantColumn('observed_at').notNull(),
    /** When Compass noticed. Always the ingest instant, passed in. */
    detectedAt: instantColumn('detected_at').notNull(),
    /** Bumped nowhere: a Correction is stated once and then read from history. */
    occurrenceCount: doublePrecision('occurrence_count').notNull(),
  },
  (table) => [
    unique('corrections_org_subject_evidence_key').on(
      table.organizationId,
      table.subjectKind,
      table.subjectKey,
      table.priorVersion,
      table.evidenceSourceRecordId,
    ),
    index('corrections_org_detected_idx').on(table.organizationId, table.detectedAt),
  ],
);

/**
 * Tables no code path may UPDATE or DELETE, by database name.
 *
 * `ingest_runs` is deliberately absent: a run row is opened and then closed, so
 * it is mutable by design. Its immutability comes from nothing ever rewriting a
 * completed run, not from the table refusing writes.
 */
export const APPEND_ONLY_TABLE_NAMES = [
  'audit_log_entries',
  'corrections',
  'entity_versions',
  'sprint_scope_changes',
  'ticket_status_transitions',
] as const;

export type AppendOnlyTableName = (typeof APPEND_ONLY_TABLE_NAMES)[number];

export function isAppendOnlyTableName(name: string): name is AppendOnlyTableName {
  return (APPEND_ONLY_TABLE_NAMES as readonly string[]).includes(name);
}
