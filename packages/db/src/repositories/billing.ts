import type { Instant } from '@compass/clock';
import { desc } from 'drizzle-orm';

import { billingEvents, organizationSubscriptions } from '../schema/billing.js';
import {
  fromDatabaseInstant,
  fromNullableDatabaseInstant,
  toDatabaseInstant,
} from '../schema/columns.js';
import { orgScope } from '../scope.js';
import { ScopedDb, type CompassDatabase } from '../scoped-db.js';

/**
 * Reading and writing what an organization pays for.
 *
 * The two interesting functions are `upsertBillingSubscription` — a genuine upsert against the one-row-per-
 * organization unique index rather than a select-then-insert two webhooks could both pass — and
 * `applyBillingEventOnce`, which is where the idempotency guarantee actually lives.
 *
 * This file holds no policy. Whether an expired trial restricts anything is
 * `@compass/billing`'s `billingState`, computed from the row this returns; a repository that decided
 * entitlement would put the rule in the layer that cannot be unit-tested without a database.
 */

export interface StoredBillingSubscription {
  readonly id: string;
  readonly organizationId: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly status: string;
  readonly planId: string | null;
  readonly seatAllowance: number | null;
  readonly trialEndsAt: Instant | null;
  readonly currentPeriodEndsAt: Instant | null;
  readonly dunningStartedAt: Instant | null;
  readonly dunningDeadlineAt: Instant | null;
  readonly dunningNotifiedAt: Instant | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

const toStored = (row: typeof organizationSubscriptions.$inferSelect): StoredBillingSubscription => ({
  id: row.id,
  organizationId: row.organizationId,
  stripeCustomerId: row.stripeCustomerId,
  stripeSubscriptionId: row.stripeSubscriptionId,
  status: row.status,
  planId: row.planId,
  seatAllowance: row.seatAllowance,
  trialEndsAt: fromNullableDatabaseInstant(row.trialEndsAt),
  currentPeriodEndsAt: fromNullableDatabaseInstant(row.currentPeriodEndsAt),
  dunningStartedAt: fromNullableDatabaseInstant(row.dunningStartedAt),
  dunningDeadlineAt: fromNullableDatabaseInstant(row.dunningDeadlineAt),
  dunningNotifiedAt: fromNullableDatabaseInstant(row.dunningNotifiedAt),
  createdAt: fromDatabaseInstant(row.createdAt),
  updatedAt: fromDatabaseInstant(row.updatedAt),
});

/** The organization's subscription, or null when it has never had one. */
export async function findBillingSubscription(scoped: ScopedDb): Promise<StoredBillingSubscription | null> {
  const rows = await scoped.selectFrom(organizationSubscriptions).limit(1);
  const row = rows[0];
  return row === undefined ? null : toStored(row);
}

/** The fields a caller may set. Absent keys are left as they are. */
export interface BillingSubscriptionWrite {
  readonly stripeCustomerId?: string | null;
  readonly stripeSubscriptionId?: string | null;
  readonly status?: string;
  readonly planId?: string | null;
  readonly seatAllowance?: number | null;
  readonly trialEndsAt?: Instant | null;
  readonly currentPeriodEndsAt?: Instant | null;
  readonly dunningStartedAt?: Instant | null;
  readonly dunningDeadlineAt?: Instant | null;
  readonly dunningNotifiedAt?: Instant | null;
}

/** Translates the caller's instants into database values, dropping absent keys. */
function toColumns(write: BillingSubscriptionWrite): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (write.stripeCustomerId !== undefined) columns['stripeCustomerId'] = write.stripeCustomerId;
  if (write.stripeSubscriptionId !== undefined) {
    columns['stripeSubscriptionId'] = write.stripeSubscriptionId;
  }
  if (write.status !== undefined) columns['status'] = write.status;
  if (write.planId !== undefined) columns['planId'] = write.planId;
  if (write.seatAllowance !== undefined) columns['seatAllowance'] = write.seatAllowance;

  // Each instant column is nullable and `null` is a *meaningful* value — clearing a dunning window
  // is how a recovered payment restores access — so `null` is written through while `undefined`
  // means "leave it alone". Collapsing the two would make a clear indistinguishable from a no-op.
  for (const [key, value] of [
    ['trialEndsAt', write.trialEndsAt],
    ['currentPeriodEndsAt', write.currentPeriodEndsAt],
    ['dunningStartedAt', write.dunningStartedAt],
    ['dunningDeadlineAt', write.dunningDeadlineAt],
    ['dunningNotifiedAt', write.dunningNotifiedAt],
  ] as const) {
    if (value === undefined) continue;
    columns[key] = value === null ? null : toDatabaseInstant(value);
  }

  return columns;
}

/**
 * Create or update the organization's subscription row.
 *
 * `ON CONFLICT (organization_id) DO UPDATE` against the unique index, rather than a read followed by
 * an insert-or-update: two Stripe webhooks for the same organization arriving together would both
 * see no row and both insert, and one would fail on the constraint anyway. Letting the database
 * decide makes the second one an update.
 */
export async function upsertBillingSubscription(
  scoped: ScopedDb,
  input: { readonly id: string; readonly write: BillingSubscriptionWrite },
  at: Instant,
): Promise<void> {
  const columns = toColumns(input.write);
  const timestamp = toDatabaseInstant(at);

  await scoped
    .insertInto(organizationSubscriptions, {
      id: input.id,
      // A row has to start somewhere: `none` is the documented status of an organization with no
      // subscription, and any real status in `write` overwrites it in the same statement.
      status: 'none',
      ...columns,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as never)
    .onConflictDoUpdate({
      target: organizationSubscriptions.organizationId,
      // `createdAt` is deliberately absent: the row's own creation instant is not moved by a later
      // webhook, so "since when has this organization been a customer" stays answerable.
      set: { ...columns, updatedAt: timestamp },
    })
    .execute();
}

export interface StoredBillingEvent {
  readonly id: string;
  readonly stripeEventId: string;
  readonly stripeEventType: string;
  readonly processedAt: Instant;
  readonly detail: string;
}

/** The events already applied, newest first. The billing page's audit list. */
export async function listBillingEvents(
  scoped: ScopedDb,
  limit = 20,
): Promise<readonly StoredBillingEvent[]> {
  const rows = await scoped
    .selectFrom(billingEvents)
    .orderBy(desc(billingEvents.processedAt), desc(billingEvents.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    stripeEventId: row.stripeEventId,
    stripeEventType: row.stripeEventType,
    processedAt: fromDatabaseInstant(row.processedAt),
    detail: row.detail,
  }));
}

export interface ApplyEventOnceInput {
  readonly organizationId: string;
  /** Row id for the ledger entry. */
  readonly id: string;
  readonly stripeEventId: string;
  readonly stripeEventType: string;
  readonly detail: string;
  /** The subscription row id to use if one has to be created. */
  readonly subscriptionRowId: string;
  readonly write: BillingSubscriptionWrite;
}

export interface ApplyEventOnceResult {
  /** False when this event id had already been recorded, so nothing was changed. */
  readonly applied: boolean;
}

/**
 * Record the event and apply its change, exactly once, in one transaction.
 *
 * ## Why this is one function and not two calls the caller sequences
 *
 * The guarantee is "one state change per event id, under redelivery *and* under concurrency", and it
 * only holds if the ledger insert and the subscription update commit or roll back together. Sequenced
 * from the route, a crash between them would leave the event recorded and the change unmade — and
 * the redelivery, seeing the ledger row, would decline to fix it. So the transaction boundary is
 * here, where it cannot be forgotten.
 *
 * ## The insert comes first, and its conflict is the whole mechanism
 *
 * `INSERT … ON CONFLICT DO NOTHING RETURNING id` returns one row when this event is new and *no*
 * rows when it has been seen. That is an atomic test-and-set against the unique index: two
 * simultaneous redeliveries both attempt it, one wins, the other gets an empty result and returns
 * without writing. A `SELECT … then INSERT` would let both pass the check.
 *
 * Takes the raw database handle rather than a `ScopedDb` because it needs to open a transaction and
 * build a scoped handle *inside* it — a `ScopedDb` wraps a connection that is already chosen, and
 * writing through the outer one would put half the work outside the transaction.
 */
export async function applyBillingEventOnce(
  database: CompassDatabase,
  input: ApplyEventOnceInput,
  at: Instant,
): Promise<ApplyEventOnceResult> {
  const transactional = database as CompassDatabase & {
    transaction: <R>(fn: (tx: CompassDatabase) => Promise<R>) => Promise<R>;
  };

  return transactional.transaction(async (tx) => {
    const scoped = new ScopedDb(tx, orgScope(input.organizationId));

    const inserted = await scoped
      .insertInto(billingEvents, {
        id: input.id,
        stripeEventId: input.stripeEventId,
        stripeEventType: input.stripeEventType,
        processedAt: toDatabaseInstant(at),
        detail: input.detail,
      })
      .onConflictDoNothing({ target: billingEvents.stripeEventId })
      .returning({ id: billingEvents.id });

    // Seen before. Returning without writing is the idempotent answer, and the caller reports 200 —
    // a non-2xx would make Stripe redeliver an event that has already been applied.
    if (inserted.length === 0) return { applied: false };

    await upsertBillingSubscription(scoped, { id: input.subscriptionRowId, write: input.write }, at);

    return { applied: true };
  });
}
