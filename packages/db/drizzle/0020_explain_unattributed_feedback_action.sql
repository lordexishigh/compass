-- The unattributed question gains an answer: `explain_unattributed`.
--
-- `feedback_entries_action_check` is a closed vocabulary in the database as well as in
-- `@compass/analysis`, and that is the point of it — a verdict the pipeline does not understand
-- must not be writable by any path, including psql. The cost of that guarantee is this migration:
-- widening the vocabulary in TypeScript alone would have produced a route that validated the
-- action, accepted it, and then failed on INSERT with a constraint violation the manager would
-- read as "Compass is broken".
--
-- Postgres has no ALTER CONSTRAINT for a CHECK, so it is dropped and recreated. Both statements
-- name the constraint explicitly rather than relying on a generated name.
--
-- The new value is an *answer* to the question the unattributed bucket asks. It suppresses that
-- question for the commits it was written about and no others: the cause the row is keyed on
-- carries a digest of the commit set (`unattributedRefId` in `packages/analysis/src/alignment.ts`),
-- so a bucket holding different work is a different cause that no answer covers.
ALTER TABLE "feedback_entries" DROP CONSTRAINT "feedback_entries_action_check";--> statement-breakpoint

ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_action_check"
  CHECK ("action" IN (
    'dismiss_risk',
    'off_goal_flag_wrong',
    'accept_recommendation',
    'reject_recommendation',
    'blocker_already_resolved',
    'explain_unattributed',
    'snooze'
  ));--> statement-breakpoint

-- `feedback_entries_snooze_check` is deliberately left alone. It says an end instant belongs to a
-- snooze and to nothing else, and that stays true: an answer has no expiry, so `snooze_until` is
-- null on every `explain_unattributed` row and the existing equality still holds.
