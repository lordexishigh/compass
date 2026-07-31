-- ---------------------------------------------------------------------------
-- Manager Memos: the manager's write access to the org model.
--
-- `manager_memos` has existed since 0001 as a placeholder holding `raw_text` and a
-- nullable `memo_kind`, explicitly waiting for the closed five-kind schema. This
-- migration turns it into that table: the columns, then the constraints that make the
-- five kinds closed.
--
-- ## Why these columns can be added NOT NULL directly
--
-- Unlike `absences.source` in 0007 — which needed add-nullable / backfill / close,
-- because the roster provisioning path had always accepted absences and rows could
-- already exist — nothing in the product has ever written a `manager_memos` row. The
-- table is empty in every deployment, so a NOT NULL column with no default cannot fail
-- here, and giving these columns a DEFAULT to work around a problem that does not exist
-- would leave the defaults behind as a way for a future insert to omit the fields the
-- memo's whole meaning depends on.
--
-- The same reasoning closes `memo_kind`: a memo only comes to exist once extraction has
-- classified it into one of the five kinds. An unclassifiable line is refused and never
-- persisted; a memo whose subject is ambiguous waits for the manager to choose a
-- candidate. There is no state in which a row exists without a kind.
--
-- ## Why the CHECK constraints are hand-written
--
-- `drizzle-kit generate` does not emit CHECK constraints from the table declaration, and
-- these are not decoration. `memo_kind` is the switch every downstream effect turns on:
-- a sixth value would land in no branch at all — the suppression would not happen, the
-- sprint would not be recomputed — with nothing anywhere to see. The application
-- validator refuses an out-of-schema line with a sentence a manager can read; the
-- constraint makes the value unwritable by any path, including a psql session.
--
-- They are deliberately kept out of the drizzle schema: a `check()` declared there but
-- absent from the meta snapshot would be re-emitted by the next `db:generate` as a
-- duplicate `ADD CONSTRAINT`, which fails.
-- ---------------------------------------------------------------------------
ALTER TABLE "manager_memos" ADD COLUMN "subject_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "subject_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "subject_confidence" double precision NOT NULL;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "subject_candidates" jsonb;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "disambiguated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "effective_from" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "effective_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "open_ended" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD COLUMN "source_channel" text NOT NULL;--> statement-breakpoint
ALTER TABLE "manager_memos" ALTER COLUMN "memo_kind" SET NOT NULL;--> statement-breakpoint

-- The closed five, enforced by the database as well as by the validator.
ALTER TABLE "manager_memos" ADD CONSTRAINT "manager_memos_kind_check"
  CHECK ("memo_kind" IN ('unavailable', 'descoped', 'reprioritized', 'external_blocker', 'context_note'));--> statement-breakpoint

-- Which of the three intakes carried it. The row is otherwise identical across all
-- three, which is the acceptance criterion for the channels.
ALTER TABLE "manager_memos" ADD CONSTRAINT "manager_memos_source_channel_check"
  CHECK ("source_channel" IN ('email', 'slack', 'web'));--> statement-breakpoint

-- Exactly one of `effective_until` / `open_ended`, as a biconditional.
--
-- "Out until Thursday" and "out indefinitely" are different assertions and the
-- difference is load-bearing: a memo that became silently open-ended because a date
-- failed to parse would suppress findings forever, and one that silently acquired an end
-- date would stop suppressing them without saying so.
ALTER TABLE "manager_memos" ADD CONSTRAINT "manager_memos_effective_window_check"
  CHECK (("effective_until" IS NULL) = "open_ended");--> statement-breakpoint

-- A closed range must cover at least one instant, for the same reason an Absence must.
ALTER TABLE "manager_memos" ADD CONSTRAINT "manager_memos_effective_order_check"
  CHECK ("effective_until" IS NULL OR "effective_until" > "effective_from");--> statement-breakpoint

-- A probability, not a score. Resolution below the threshold asks the manager instead.
ALTER TABLE "manager_memos" ADD CONSTRAINT "manager_memos_subject_confidence_check"
  CHECK ("subject_confidence" >= 0 AND "subject_confidence" <= 1);--> statement-breakpoint

ALTER TABLE "manager_memos" ADD CONSTRAINT "manager_memos_subject_kind_check"
  CHECK ("subject_kind" IN ('developer', 'team', 'sprint', 'ticket', 'project'));--> statement-breakpoint

CREATE INDEX "manager_memos_org_subject_idx" ON "manager_memos" USING btree ("organization_id","subject_kind","subject_key");--> statement-breakpoint
CREATE INDEX "manager_memos_org_effective_idx" ON "manager_memos" USING btree ("organization_id","effective_from");
