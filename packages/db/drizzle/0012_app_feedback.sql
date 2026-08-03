-- ---------------------------------------------------------------------------
-- `app_feedback` — what somebody told us about Compass itself.
--
-- A new table rather than a column on `feedback_entries`, and the distinction is the whole point.
-- `feedback_entries` holds a manager's verdict on a *finding inside a report*: it is a knowledge
-- entity, it is keyed to a report item's stable id, it is versioned, and the analysis core reads it
-- to decide what tomorrow's report says. This table holds a note about the product — "this page is
-- confusing", "the projected date looks wrong" — and nothing in the pipeline reads it or ever
-- should. Free text typed into a support box must not be able to become an input to an alignment
-- verdict, and two tables is the only way to make that structural rather than a convention.
--
-- ## Why it is flat
--
-- No `natural_key`, no `version`, no `entity_versions` companion, and it is absent from the entity
-- registry. A submission is an event that happened once at a known instant, not a belief about the
-- organization that can be revised, so there is nothing for `observe()` to diff and no second
-- version of it that could exist. It sits beside `auth_tokens` and `share_links`: plain rows with a
-- tenant and a timestamp.
--
-- ## `organization_id` NOT NULL, `user_id` nullable
--
-- The two are known by different means, and only one of them can genuinely be absent. The
-- organization is resolved at the request edge from the deployment itself, so it is always known,
-- which is what keeps this table inside the same isolation as everything else — the schema gate
-- requires a non-null `organization_id` on every table and there is no exemption list to creep into.
-- The user comes from a session, and the seeded demonstration report at `/` is deliberately readable
-- with none: the reader who most needs to say the page is confusing is the one who has not signed up
-- yet. NULL therefore states "submitted without a session" rather than pointing at a placeholder
-- user who does not exist.
--
-- ## The two CHECK constraints
--
-- Written here as well as in the route's validator, for the same reason `feedback_entries.action`
-- and `manager_memos.memo_kind` are: the application check is the one that produces a sentence
-- somebody reads, and the database check is the one that holds for every other path — a psql
-- session, a future importer, a bug in the handler. An empty message is refused because a row with
-- nothing in it is indistinguishable from a lost message, and the length ceiling is refused rather
-- than truncated because silently storing half of what somebody wrote is worse than telling them it
-- was too long. 4000 characters is `APP_FEEDBACK_MAX_LENGTH` in
-- `packages/db/src/repositories/app-feedback.ts`.
-- ---------------------------------------------------------------------------

CREATE TABLE "app_feedback" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid,
  "message" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_message_not_empty_check"
  CHECK (length(btrim("message")) > 0);--> statement-breakpoint

ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_message_length_check"
  CHECK (length("message") <= 4000);--> statement-breakpoint

-- The one read this table serves: newest first, within the tenant.
CREATE INDEX "app_feedback_org_created_idx" ON "app_feedback" USING btree ("organization_id","created_at");
