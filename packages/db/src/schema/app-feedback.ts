import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId } from './columns.js';
import { organizations, users } from './tables.js';

/**
 * What somebody told us about **Compass itself**.
 *
 * ## Why this is not `feedback_entries`
 *
 * The name is deliberately unambiguous, because the product already has a table called
 * `feedback_entries` and the two answer opposite questions:
 *
 *  - `feedback_entries` is a manager's verdict on *a finding inside a report* — dismiss this
 *    risk, this off-goal flag is wrong. It is a knowledge entity, it is keyed to a report item's
 *    stable id, it is versioned, and the analysis core reads it to decide what tomorrow's report
 *    says. A row there changes the product's output.
 *  - `app_feedback` is a note about the product: this page is confusing, the projected date looks
 *    wrong, I wish it did X. Nothing in the pipeline reads it, and nothing should — a sentence
 *    typed into a support box must never become an input to an alignment verdict. It is read by
 *    the owner and by whoever maintains the deployment, and by nobody else.
 *
 * So this is a plain, flat table beside `auth_tokens` and `share_links` rather than an entry in
 * the entity registry. It carries no `natural_key`, no `version` and no `entity_versions`
 * companion, and that is correct: a submission is an event that happened once at a known instant,
 * not a belief about the org that can be revised. Registering it as an entity would have obliged
 * `observe()` to diff it, which is meaningless for free text somebody typed.
 *
 * ## `user_id` is nullable and `organization_id` is not
 *
 * The two are known by different means and one of them can genuinely be absent. The organization
 * is resolved at the request edge from the deployment itself, so it is always known — which is
 * what keeps this table inside the same tenant isolation as everything else and lets `ScopedDb`
 * add its predicate. The *user* comes from a session, and the seeded demonstration report at `/`
 * is deliberately readable with no session at all: the person who most needs to tell us the page
 * is confusing is the one who has not signed up yet. Null therefore means "submitted without a
 * session", stated rather than papered over with a placeholder user.
 */
export const appFeedback = pgTable(
  'app_feedback',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /**
     * The submitting user, when there was a session. Null for an anonymous submission.
     *
     * `ON DELETE` is left alone, like every other user reference in the schema: a note about the
     * product outlives the seat of whoever wrote it, and a removed seat must not silently delete
     * the report of a bug.
     */
    userId: uuid('user_id').references(() => users.id),
    /** What they typed, verbatim. Bounded by a CHECK constraint, never truncated silently. */
    message: text('message').notNull(),
    /**
     * The instant the submission was accepted, from the request edge's clock and passed in.
     *
     * No database default, following the convention in `columns.ts`: every write hands over the
     * instant it was given, so a test with a fixed clock produces byte-identical rows and nothing
     * in this table can quietly disagree with the clock the rest of the request ran on.
     */
    createdAt: instantColumn('created_at').notNull(),
  },
  (table) => [
    // The one read this table serves: newest first, within the tenant.
    index('app_feedback_org_created_idx').on(table.organizationId, table.createdAt),
  ],
);
