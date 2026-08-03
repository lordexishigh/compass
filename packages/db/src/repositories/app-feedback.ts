import type { Instant } from '@compass/clock';
import { desc } from 'drizzle-orm';

import { appFeedback } from '../schema/app-feedback.js';
import { fromDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Submissions about the product itself: storing one, and reading them back.
 *
 * Two functions and nothing else. There is deliberately no update and no delete: a note somebody
 * typed is a record of what they said at a moment, and an owner who could edit it would be editing
 * somebody else's words. It is not in `APPEND_ONLY_TABLE_NAMES` because it needs no trigger to be
 * append-only in practice — the only writer is `recordAppFeedback`, and there is no other path.
 */

/** The longest message the product will store. Mirrored by a CHECK constraint in `0012`. */
export const APP_FEEDBACK_MAX_LENGTH = 4_000;

export interface AppFeedbackInput {
  readonly id: string;
  /** The submitting user, or null when the submission carried no session. */
  readonly userId: string | null;
  readonly message: string;
}

export interface StoredAppFeedback {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string | null;
  readonly message: string;
  readonly createdAt: Instant;
}

const toStored = (row: typeof appFeedback.$inferSelect): StoredAppFeedback => ({
  id: row.id,
  organizationId: row.organizationId,
  userId: row.userId,
  message: row.message,
  createdAt: fromDatabaseInstant(row.createdAt),
});

/**
 * Stores one submission.
 *
 * `at` is the request edge's own instant rather than a database `now()`, so the row agrees with
 * every other timestamp the same request wrote and a fixed-clock test can assert an exact value.
 */
export async function recordAppFeedback(
  scoped: ScopedDb,
  input: AppFeedbackInput,
  at: Instant,
): Promise<StoredAppFeedback> {
  await scoped
    .insertInto(appFeedback, {
      id: input.id,
      userId: input.userId,
      message: input.message,
      createdAt: toDatabaseInstant(at),
    })
    .execute();

  return {
    id: input.id,
    organizationId: scoped.organizationId,
    userId: input.userId,
    message: input.message,
    createdAt: at,
  };
}

/**
 * Every submission for this organization, most recent first.
 *
 * The tiebreak on `id` is load-bearing rather than tidy. `created_at` comes from the request edge's
 * clock, and two submissions accepted inside the same millisecond — which is ordinary in a test and
 * possible under a burst — would otherwise come back in whatever order the planner chose, so
 * "newest first" would be true of the pair but unstable between reads. A descending id makes the
 * order total.
 */
export async function readAppFeedback(scoped: ScopedDb): Promise<readonly StoredAppFeedback[]> {
  const rows = await scoped
    .selectFrom(appFeedback)
    .orderBy(desc(appFeedback.createdAt), desc(appFeedback.id));

  return rows.map(toStored);
}
