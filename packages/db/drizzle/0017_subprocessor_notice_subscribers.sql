-- ---------------------------------------------------------------------------
-- `subprocessor_notice_subscribers` — who has asked to be told before the subprocessor list changes.
--
-- Compass publishes a 30-day advance-notice commitment on `/trust/subprocessors`. A commitment with
-- nobody to notify is a sentence on a page, so the promise needs a list — and the list has to remember
-- *what it last announced*, or a job that ran twice would send the same notice twice and a job that had
-- never run would announce the whole existing list as though every entry were new.
--
-- ## `organization_id NOT NULL` on a row that belongs to no customer
--
-- The subscriber is usually a data protection officer evaluating Compass, who has no account and never
-- will. The schema gate requires a non-null `organization_id` on every table and there is no exemption
-- list — which is right, because an exemption list is how tenant isolation quietly stops applying to one
-- table.
--
-- So the column holds the organization that *operates this deployment*, resolved at the request edge in
-- exactly the way `app_feedback` (migration 0012) resolves it for an anonymous submission. That is not a
-- fiction: the notice obligation is the operator's, the list is theirs to honour, and scoping the row
-- keeps it inside the same isolation boundary as everything else rather than beside it.
--
-- ## Why the address is in the clear when every other secret in this schema is hashed
--
-- Because it has to be *used*. A session secret is only ever compared, so it is hashed; this address has
-- to receive an email, so hashing it would make the table useless. What protects it instead is that it is
-- the only personal column in the row: no name, no account, no organization of their own, nothing to
-- correlate it against. The unsubscribe token *is* hashed, for the usual reason — a dump that could
-- unsubscribe people is a dump that could silently stop the notice arriving.
--
-- ## `confirmed_at` is nullable and load-bearing
--
-- NULL means "asked, not yet confirmed", and an unconfirmed row is never sent a notice. Without the
-- distinction anybody could subscribe somebody else's address to mail they never asked for — a small
-- abuse, but one that would arrive under Compass's name.
-- ---------------------------------------------------------------------------

CREATE TABLE "subprocessor_notice_subscribers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "email" text NOT NULL,
  "confirmed_at" timestamp with time zone,
  "last_noticed_digest" text,
  "last_noticed_at" timestamp with time zone,
  "unsubscribe_token_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "subprocessor_notice_subscribers" ADD CONSTRAINT "subprocessor_notice_subscribers_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- An address is stored lower-cased by the route, and this refuses the rest: a blank subscription is
-- indistinguishable from a lost one, and something with no `@` in it is a typo that will never receive
-- the notice it was created to receive. Written here as well as in the route's validator for the same
-- reason every other CHECK in this schema is: the application check produces a sentence somebody reads,
-- and this one holds for every other path — a psql session, a future importer, a bug in the handler.
ALTER TABLE "subprocessor_notice_subscribers" ADD CONSTRAINT "subprocessor_notice_subscribers_email_shape_check"
  CHECK (length(btrim("email")) > 2 AND position('@' in "email") > 1 AND "email" = lower("email"));--> statement-breakpoint

-- One row per address per deployment. This is what makes the subscribe endpoint idempotent: a second
-- submission of the same address re-sends the confirmation instead of creating a second row, so a
-- double-clicked button cannot produce two notices for one person.
CREATE UNIQUE INDEX "subprocessor_notice_subscribers_email_key"
  ON "subprocessor_notice_subscribers" USING btree ("organization_id","email");--> statement-breakpoint

-- The notice job's read: confirmed subscribers, within the tenant.
CREATE INDEX "subprocessor_notice_subscribers_confirmed_idx"
  ON "subprocessor_notice_subscribers" USING btree ("organization_id","confirmed_at");
