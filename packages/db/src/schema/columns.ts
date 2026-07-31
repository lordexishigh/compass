import { type Instant, instantFromEpochMillis, toEpochMillis } from '@compass/clock';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The base schema convention: every row carries the organization that owns it.
 *
 * Tenant isolation is enforced in application code (the pooler makes per-request
 * Postgres roles unreliable), so this column plus the scoped-query layer is the
 * whole guarantee. `tests/schema.test.ts` enumerates every table in the schema
 * and fails on any that lacks it — including the `organizations` table itself,
 * which carries `organization_id` equal to its own `id` under a check
 * constraint, so there is no exemption list to creep.
 */
export const ORGANIZATION_ID_COLUMN = 'organization_id';

/** Fresh builder per table: drizzle column builders are not reusable objects. */
export const organizationId = () => uuid(ORGANIZATION_ID_COLUMN).notNull();

/**
 * `created_at` and `updated_at` carry no database default on purpose. Every
 * write passes the instant it was given, so a test with a FixedClock produces
 * byte-identical rows and nothing silently reads the server clock.
 */
export const recordTimestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/** Timestamps recorded once at ingest and never rewritten. */
export const instantColumn = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const toDatabaseInstant = (instant: Instant): Date => new Date(toEpochMillis(instant));

export const fromDatabaseInstant = (value: Date): Instant => instantFromEpochMillis(value.getTime());

export const fromNullableDatabaseInstant = (value: Date | null): Instant | null =>
  value === null ? null : fromDatabaseInstant(value);
