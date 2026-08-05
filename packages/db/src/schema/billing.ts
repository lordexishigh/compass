import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { organizations } from './tables.js';

/**
 * What an organization is paying for, and which Stripe events Compass has already acted on.
 *
 * Two tables, and the split is the design.
 *
 * ## `organization_subscriptions` — the current belief, one row per tenant
 *
 * Mutable, unlike the history tables: a subscription genuinely moves between states and there is no
 * value in an append-only ledger of Stripe's own status transitions, which Stripe already keeps and
 * shows in its dashboard. What Compass needs is the answer to "may this organization generate a
 * report this morning", and that is one row.
 *
 * **There is no `is_read_only` column, deliberately.** Entitlement is derived by
 * `billingState(facts, now)` in `@compass/billing` from the instants below. A stored flag would need
 * a scheduled job to flip it, and a job that has not run yet — or ran once and crashed — would leave
 * a trial that expired on Tuesday fully open on Friday. Deriving it on read means the restriction
 * takes effect at the instant it is due, on every surface, with no scheduler in the trust path.
 *
 * **The two deadline columns are frozen, not derived.** `dunning_deadline_at` is written when the
 * payment failed rather than recomputed from `dunning_started_at` on every read, for the same reason
 * `sessions.expires_at` is stored: "you have until Friday" is a promise made to a person, and a
 * grace period an operator later shortens must not retroactively move a deadline somebody was told.
 *
 * ## `billing_events` — the idempotency ledger
 *
 * Stripe redelivers. It redelivers on a timeout, on a deploy, on a 500, and it redelivers events
 * that already succeeded. So every webhook that changes state records its event id **in the same
 * transaction as the change**, behind a UNIQUE constraint: the second delivery's insert conflicts,
 * the transaction is abandoned before it writes anything, and the state moves exactly once. A
 * check-then-write without the constraint would still race two concurrent redeliveries into two
 * state changes, which is why the guarantee is in the database and not in the handler.
 *
 * The unique index is on `stripe_event_id` alone rather than on `(organization_id, stripe_event_id)`.
 * Stripe event ids are globally unique, and scoping the constraint per tenant would let the same
 * event be applied once per organization if it were ever misattributed — the opposite of what the
 * constraint is for.
 */
export const organizationSubscriptions = pgTable(
  'organization_subscriptions',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /**
     * Stripe's customer id, or null before the first checkout.
     *
     * Null is a real state and not a placeholder: an organization on a trial that has never opened
     * checkout has no Stripe customer at all, and inventing one at signup would create a billing
     * record for every tyre-kicker.
     */
    stripeCustomerId: text('stripe_customer_id'),
    /** Null until a subscription exists at Stripe. */
    stripeSubscriptionId: text('stripe_subscription_id'),
    /**
     * One of `@compass/billing`'s `SUBSCRIPTION_STATUSES`.
     *
     * Text with a CHECK constraint rather than a Postgres enum: adding a status to an enum needs a
     * migration that cannot run inside a transaction on older servers, and the closed union already
     * lives in TypeScript where a new value is a compile error until it is declared.
     */
    status: text('status').notNull(),
    /** One of `PLAN_IDS`, or null before a plan has been chosen. */
    planId: text('plan_id'),
    /** Seats the plan is paid for. Null before checkout completes. */
    seatAllowance: integer('seat_allowance'),
    trialEndsAt: instantColumn('trial_ends_at'),
    currentPeriodEndsAt: instantColumn('current_period_ends_at'),
    /** When the first payment failed. Null whenever the subscription is not in dunning. */
    dunningStartedAt: instantColumn('dunning_started_at'),
    /** Frozen at the moment of failure. See the note above on why this is stored. */
    dunningDeadlineAt: instantColumn('dunning_deadline_at'),
    /**
     * When the owner was last emailed about a failed payment.
     *
     * Present so dunning mail is sent once per window rather than once per webhook: Stripe retries a
     * failed invoice several times and each retry is another `invoice.payment_failed`. An owner who
     * received four identical emails would filter the fifth.
     */
    dunningNotifiedAt: instantColumn('dunning_notified_at'),
    ...recordTimestamps(),
  },
  (table) => [
    // One subscription per organization. The read is always "this tenant's row", and the constraint
    // is what makes the upsert in `repositories/billing.ts` a genuine upsert.
    uniqueIndex('organization_subscriptions_org_key').on(table.organizationId),
  ],
);

export const billingEvents = pgTable(
  'billing_events',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** Stripe's own event id, e.g. `evt_1A2b3C`. The idempotency key. */
    stripeEventId: text('stripe_event_id').notNull(),
    stripeEventType: text('stripe_event_type').notNull(),
    /** The instant Compass applied it, from the request edge's clock. */
    processedAt: instantColumn('processed_at').notNull(),
    /** One sentence saying what changed, for an operator reading the table directly. */
    detail: text('detail').notNull(),
  },
  (table) => [
    // The guarantee. Global rather than per-tenant: see the note above.
    uniqueIndex('billing_events_stripe_event_key').on(table.stripeEventId),
    index('billing_events_org_processed_idx').on(table.organizationId, table.processedAt),
  ],
);
