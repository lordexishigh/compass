import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { organizations } from './tables.js';

/**
 * Who has asked to be told before the subprocessor list changes.
 *
 * ## Why this table exists at all
 *
 * Compass publishes a 30-day advance-notice commitment on `/trust/subprocessors`. A commitment with
 * nobody to notify is a sentence on a page, so the promise needs a list — and the list needs to remember
 * *what it last announced*, or a job that ran twice would send the same notice twice and a job that had
 * never run would announce the entire existing list as though it were a change.
 *
 * ## `organization_id` on a row that belongs to no customer
 *
 * The subscriber is usually a data protection officer evaluating Compass who has no account and never
 * will. The schema gate requires a non-null `organization_id` on every table with no exemption list, and
 * that is right — an exemption list is how tenant isolation quietly stops applying to one table.
 *
 * So the column holds the organization that *operates this deployment*, resolved at the request edge
 * exactly as `app_feedback` resolves it for an anonymous submission. That is not a fiction: the notice
 * obligation is the deployment operator's, the list is theirs to honour, and scoping it keeps the row
 * inside the same isolation boundary as everything else rather than beside it.
 *
 * ## Why the address is stored in the clear
 *
 * Unlike a session secret or an OAuth token, this address has to be *used* — a notice has to be sent to
 * it — and it is the only thing the row is for. Hashing it would make the table useless. What protects it
 * is that it is the sole column: no name, no organization, no account, nothing to correlate.
 */
export const subprocessorNoticeSubscribers = pgTable(
  'subprocessor_notice_subscribers',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** Lower-cased at the boundary, so one address cannot be subscribed twice by capitalisation. */
    email: text('email').notNull(),
    /**
     * Set when the subscriber clicked the link in the confirmation email.
     *
     * Null means "asked, not yet confirmed", and an unconfirmed row is **never sent a notice**. Without
     * this, anybody could subscribe somebody else's address to mail they never asked for — a small abuse,
     * but one that would arrive under Compass's name and be indistinguishable from a leak of that address.
     */
    confirmedAt: instantColumn('confirmed_at'),
    /**
     * The digest of the subprocessor list as it stood when this subscriber was last notified.
     *
     * Per-subscriber rather than global, so somebody who subscribes today is not immediately sent a
     * notice about a change that happened before they arrived: their row starts at the *current* digest,
     * which reads as "you are up to date" rather than as "everything is new".
     */
    lastNoticedDigest: text('last_noticed_digest'),
    lastNoticedAt: instantColumn('last_noticed_at'),
    /**
     * SHA-256 of the unsubscribe token, never the token.
     *
     * Same discipline as `subscriptions.unsubscribe_token_hash`: the link in the email carries the
     * secret, the database holds only what proves a presented one is right. A leaked dump therefore
     * cannot unsubscribe anybody, which matters because unsubscribing somebody silently is exactly how
     * a 30-day notice fails to arrive.
     */
    unsubscribeTokenHash: text('unsubscribe_token_hash').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    // One row per address per deployment. This is what makes the subscribe endpoint idempotent: a second
    // submission of the same address re-sends the confirmation rather than creating a second row.
    uniqueIndex('subprocessor_notice_subscribers_email_key').on(table.organizationId, table.email),
    // The notice job's read: confirmed subscribers whose digest is behind the published one.
    index('subprocessor_notice_subscribers_confirmed_idx').on(table.organizationId, table.confirmedAt),
  ],
);
