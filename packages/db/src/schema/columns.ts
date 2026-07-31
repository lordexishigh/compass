import { type Instant, instantFromEpochMillis, toEpochMillis } from '@compass/clock';
import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

/**
 * The named-entity convention, on top of the base one.
 *
 * Every knowledge entity is a first-class row identified by a *stable natural
 * key* — the key the source itself uses, `DEV-501` or `checkout-web#9201` — not
 * by a surrogate the ingest run invented. That is what makes a second ingest of
 * the same window an upsert rather than a duplicate, and what lets an item keep
 * its identity across days so the report can say "day 6" instead of "new".
 *
 * `first_seen_at` and `last_seen_at` are the elapsed-fact substrate: they are the
 * earliest and latest instants at which Compass observed the entity, taken from
 * the observed record's own event time and never from the run clock. Every
 * elapsed sentence in the product ("still blocked, day 6") is arithmetic over
 * `first_seen_at` and the report instant.
 *
 * `packages/db/tests/schema.test.ts` enumerates the entity registry and fails on
 * any entity table that lacks one of these four columns or an append-only
 * history companion.
 */
export const NATURAL_KEY_COLUMN = 'natural_key';
export const FIRST_SEEN_AT_COLUMN = 'first_seen_at';
export const LAST_SEEN_AT_COLUMN = 'last_seen_at';
export const BELIEF_AT_COLUMN = 'belief_at';
export const VERSION_COLUMN = 'version';

/**
 * The four convention columns plus the two that make versioning checkable.
 *
 * `belief_at` is the observation instant the *currently held* tracked fields came
 * from. It exists so an out-of-order window cannot overwrite a newer belief with
 * an older one: a record whose event time precedes `belief_at` advances
 * `last_seen_at` and may pull `first_seen_at` back, but never rewrites the
 * fields. `version` counts tracked-field revisions and always equals the number
 * of `entity_versions` rows for the entity.
 */
export const entityStateColumns = () => ({
  naturalKey: text(NATURAL_KEY_COLUMN).notNull(),
  firstSeenAt: instantColumn(FIRST_SEEN_AT_COLUMN).notNull(),
  lastSeenAt: instantColumn(LAST_SEEN_AT_COLUMN).notNull(),
  beliefAt: instantColumn(BELIEF_AT_COLUMN).notNull(),
  version: integer(VERSION_COLUMN).notNull(),
});

/** The columns every named entity table must carry, by database name. */
export const NAMED_ENTITY_REQUIRED_COLUMNS = [
  ORGANIZATION_ID_COLUMN,
  NATURAL_KEY_COLUMN,
  FIRST_SEEN_AT_COLUMN,
  LAST_SEEN_AT_COLUMN,
] as const;

export const toDatabaseInstant = (instant: Instant): Date => new Date(toEpochMillis(instant));

export const fromDatabaseInstant = (value: Date): Instant => instantFromEpochMillis(value.getTime());

export const fromNullableDatabaseInstant = (value: Date | null): Instant | null =>
  value === null ? null : fromDatabaseInstant(value);
