import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
  index,
} from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';

export const membershipRole = pgEnum('membership_role', ['owner', 'manager', 'member', 'viewer']);
export const membershipStatus = pgEnum('membership_status', ['pending', 'active', 'revoked']);

/**
 * The tenant root.
 *
 * `organization_id` duplicates `id` under a check constraint so that the rule
 * "every table carries a non-null organization_id" has no exception, and the
 * scoped-query layer can be applied uniformly — including to this table.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** IANA zone used when a team has no working calendar of its own yet. */
    timezone: text('timezone').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    unique('organizations_slug_key').on(table.slug),
    check('organizations_org_id_is_self', sql`${table.organizationId} = ${table.id}`),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** Argon2id hash. Null until the user sets a password (magic-link signup). */
    passwordHash: text('password_hash'),
    ...recordTimestamps(),
  },
  (table) => [
    unique('users_org_email_key').on(table.organizationId, table.email),
    index('users_org_idx').on(table.organizationId),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: membershipRole('role').notNull(),
    status: membershipStatus('status').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    unique('memberships_org_user_key').on(table.organizationId, table.userId),
    index('memberships_org_idx').on(table.organizationId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    issuedAt: instantColumn('issued_at').notNull(),
    lastUsedAt: instantColumn('last_used_at').notNull(),
    expiresAt: instantColumn('expires_at').notNull(),
    revokedAt: instantColumn('revoked_at'),
  },
  (table) => [index('sessions_org_user_idx').on(table.organizationId, table.userId)],
);

/** Append-only. No update or delete path exists for this table by design. */
export const auditLogEntries = pgTable(
  'audit_log_entries',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    occurredAt: instantColumn('occurred_at').notNull(),
  },
  (table) => [index('audit_log_org_occurred_idx').on(table.organizationId, table.occurredAt)],
);

/** A configured data source, named the way the connector port names it. */
export const sourceConfigs = pgTable(
  'source_configs',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    sourceKey: text('source_key').notNull(),
    sourceKind: text('source_kind').notNull(),
    connectorId: text('connector_id').notNull(),
    enabled: boolean('enabled').notNull(),
    settings: jsonb('settings').notNull(),
    ...recordTimestamps(),
  },
  (table) => [unique('source_configs_org_key').on(table.organizationId, table.sourceKey)],
);

/** One row per pull of one half-open window through the connector port. */
export const ingestRuns = pgTable(
  'ingest_runs',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    connectorId: text('connector_id').notNull(),
    windowStart: instantColumn('window_start').notNull(),
    windowEnd: instantColumn('window_end').notNull(),
    startedAt: instantColumn('started_at').notNull(),
    completedAt: instantColumn('completed_at'),
    /** complete | partial | unavailable — the worst coverage status of the run. */
    status: text('status').notNull(),
    totalRecords: integer('total_records').notNull(),
    artifactCounts: jsonb('artifact_counts').notNull(),
  },
  (table) => [
    index('ingest_runs_org_window_idx').on(table.organizationId, table.windowStart, table.windowEnd),
  ],
);

/** Per-source coverage for an ingest run — what the freshness line is built from. */
export const ingestSourceCoverage = pgTable(
  'ingest_source_coverage',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    ingestRunId: uuid('ingest_run_id')
      .notNull()
      .references(() => ingestRuns.id),
    sourceKey: text('source_key').notNull(),
    sourceKind: text('source_kind').notNull(),
    artifact: text('artifact').notNull(),
    status: text('status').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail').notNull(),
    requestedWindowStart: instantColumn('requested_window_start').notNull(),
    requestedWindowEnd: instantColumn('requested_window_end').notNull(),
    coveredWindowStart: instantColumn('covered_window_start'),
    coveredWindowEnd: instantColumn('covered_window_end'),
    recordCount: integer('record_count').notNull(),
    observedAt: instantColumn('observed_at').notNull(),
  },
  (table) => [
    unique('ingest_source_coverage_run_source_artifact_key').on(
      table.ingestRunId,
      table.sourceKey,
      table.artifact,
    ),
    index('ingest_source_coverage_org_idx').on(table.organizationId),
  ],
);
