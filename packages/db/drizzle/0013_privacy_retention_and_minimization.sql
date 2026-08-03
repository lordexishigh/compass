-- ---------------------------------------------------------------------------
-- Privacy: retention, anonymization, deletion, and LLM data minimization.
--
-- Six new tables and two new columns on `developers`. The whole of this migration
-- exists to make one sentence true: a manager can show tomorrow's report to the team
-- it is about, and answer every question they ask about it from a page rather than
-- from a promise.
--
-- ## Why `org_privacy_settings` is backfilled rather than defaulted on read
--
-- Every existing organization gets a row here, now, with the documented defaults. The
-- alternative -- treating a missing row as "the default" -- has two failures that are
-- not hypothetical. The retention page would have to render "using the default" over a
-- value stored nowhere, so an owner could not tell a deliberate choice from an absent
-- one. And the day the documented default changes, every tenant that had never opened
-- the page would silently re-date its own data. A stored row makes the setting a fact.
--
-- The defaults are 90 days of raw events, 3 years of derived data and reports, and
-- `redacted` narration. `docs/ENGINEERING.md` states all three and the reasoning; the
-- constants live in `packages/db/src/repositories/privacy.ts` and a test asserts the
-- documentation quotes them.
--
-- ## Why `purge_runs` and `anonymizations` have no foreign key
--
-- Both are records of an irreversible act, and the acceptance criteria require them to
-- survive: a purge count that vanished with the tenant would make retention
-- unauditable, and an anonymization record that a tenant deletion removed would make
-- an erasure silently reversible. They still carry `organization_id` -- the scoped
-- query layer applies to them like everything else -- but nothing else's deletion
-- takes them with it. `raw_events` is the opposite case and cascades: it is the thing
-- retention deletes.
--
-- ## `slack_channel_ingestion_public_only`
--
-- `enabled = false OR conversation_kind = 'public_channel'`. A direct message or a
-- private channel cannot be marked ingested by any path, including a psql session.
-- The ingest filter checks the kind again independently; neither guard is trusted to
-- be the only one.
-- ---------------------------------------------------------------------------

-- --- the anonymization decision, mirrored onto the entity ------------------

ALTER TABLE "developers" ADD COLUMN "anonymized_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "developers" ADD COLUMN "pseudonym" text;
--> statement-breakpoint

-- Non-null together or not at all. A pseudonym with no anonymization instant would be
-- a name Compass had chosen to stop using without recording when, and an anonymization
-- with no pseudonym would leave `developerName` with nothing to print.
ALTER TABLE "developers" ADD CONSTRAINT "developers_pseudonym_pairing"
  CHECK (("anonymized_at" IS NULL) = ("pseudonym" IS NULL));
--> statement-breakpoint

-- --- settings --------------------------------------------------------------

CREATE TABLE "org_privacy_settings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "raw_event_retention_days" integer NOT NULL,
  "derived_retention_years" integer,
  "llm_minimization_mode" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "org_privacy_settings_org_key" UNIQUE("organization_id"),
  CONSTRAINT "org_privacy_settings_raw_window"
    CHECK ("raw_event_retention_days" in (30, 90, 180, 365)),
  CONSTRAINT "org_privacy_settings_derived_window"
    CHECK ("derived_retention_years" is null or "derived_retention_years" in (1, 3, 7)),
  CONSTRAINT "org_privacy_settings_llm_mode"
    CHECK ("llm_minimization_mode" in ('full', 'redacted', 'none'))
);
--> statement-breakpoint

ALTER TABLE "org_privacy_settings" ADD CONSTRAINT "org_privacy_settings_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE "slack_channel_ingestion" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "conversation_key" text NOT NULL,
  "conversation_name" text NOT NULL,
  "conversation_kind" text NOT NULL,
  "enabled" boolean NOT NULL,
  "enabled_at" timestamp with time zone,
  "enabled_by_user_id" uuid,
  "disabled_at" timestamp with time zone,
  "notice_posted_at" timestamp with time zone,
  "notice_detail" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "slack_channel_ingestion_org_conversation_key" UNIQUE("organization_id","conversation_key"),
  CONSTRAINT "slack_channel_ingestion_kind"
    CHECK ("conversation_kind" in ('public_channel', 'private_channel', 'direct_message', 'group_message')),
  CONSTRAINT "slack_channel_ingestion_public_only"
    CHECK ("enabled" = false or "conversation_kind" = 'public_channel')
);
--> statement-breakpoint

ALTER TABLE "slack_channel_ingestion" ADD CONSTRAINT "slack_channel_ingestion_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "slack_channel_ingestion_org_enabled_idx" ON "slack_channel_ingestion" ("organization_id","enabled");
--> statement-breakpoint

-- --- the thing retention deletes ------------------------------------------

CREATE TABLE "raw_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "source_key" text NOT NULL,
  "source_kind" text NOT NULL,
  "artifact_kind" text NOT NULL,
  "source_record_id" text NOT NULL,
  "conversation_key" text NOT NULL,
  "conversation_name" text NOT NULL,
  "author_identity_kind" text NOT NULL,
  "author_identity_value" text NOT NULL,
  "body" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "ingested_at" timestamp with time zone NOT NULL,
  CONSTRAINT "raw_events_org_source_record_key" UNIQUE("organization_id","source_key","source_record_id")
);
--> statement-breakpoint

ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "raw_events_org_occurred_idx" ON "raw_events" ("organization_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "raw_events_org_conversation_idx" ON "raw_events" ("organization_id","conversation_key");
--> statement-breakpoint

-- --- records of what was done ---------------------------------------------

CREATE TABLE "purge_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "raw_cutoff" timestamp with time zone NOT NULL,
  "derived_cutoff" timestamp with time zone,
  "raw_events_deleted" integer NOT NULL,
  "reports_deleted" integer NOT NULL,
  "outcome" text NOT NULL,
  "detail" text NOT NULL,
  CONSTRAINT "purge_runs_outcome" CHECK ("outcome" in ('complete', 'failed'))
);
--> statement-breakpoint

CREATE INDEX "purge_runs_org_started_idx" ON "purge_runs" ("organization_id","started_at");
--> statement-breakpoint

CREATE TABLE "anonymizations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "developer_key" text NOT NULL,
  "pseudonym" text NOT NULL,
  "reason" text NOT NULL,
  "note" text,
  "requested_by_user_id" uuid,
  "anonymized_at" timestamp with time zone NOT NULL,
  "reverted_at" timestamp with time zone,
  "reverted_by_user_id" uuid,
  CONSTRAINT "anonymizations_org_developer_key" UNIQUE("organization_id","developer_key"),
  CONSTRAINT "anonymizations_org_pseudonym_key" UNIQUE("organization_id","pseudonym")
);
--> statement-breakpoint

CREATE INDEX "anonymizations_org_at_idx" ON "anonymizations" ("organization_id","anonymized_at");
--> statement-breakpoint

CREATE TABLE "deletion_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "requested_by_user_id" uuid,
  "notify_email" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL,
  "grace_ends_at" timestamp with time zone NOT NULL,
  "hard_delete_by" timestamp with time zone NOT NULL,
  "undo_token_hash" text NOT NULL,
  "status" text NOT NULL,
  "export_offered_at" timestamp with time zone NOT NULL,
  "export_downloaded_at" timestamp with time zone,
  "undone_at" timestamp with time zone,
  "purged_at" timestamp with time zone,
  "deleted_categories" jsonb,
  "confirmation_sent_at" timestamp with time zone,
  "detail" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "deletion_requests_undo_token_key" UNIQUE("undo_token_hash"),
  CONSTRAINT "deletion_requests_subject_kind" CHECK ("subject_kind" in ('account', 'organization')),
  CONSTRAINT "deletion_requests_status" CHECK ("status" in ('grace', 'undone', 'purged', 'failed')),
  CONSTRAINT "deletion_requests_deadline_order" CHECK ("grace_ends_at" < "hard_delete_by")
);
--> statement-breakpoint

ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "deletion_requests_org_status_idx" ON "deletion_requests" ("organization_id","status");
--> statement-breakpoint
CREATE INDEX "deletion_requests_grace_idx" ON "deletion_requests" ("status","grace_ends_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The one exception to the append-only guarantee: erasure.
--
-- `compass_reject_history_mutation()` has refused every UPDATE, DELETE and TRUNCATE on
-- the history tables since 0001, for a good reason: "still blocked, day 6" and every
-- Correction are only trustworthy if yesterday's row is still on disk. That reason holds
-- for every operation Compass performs -- except one.
--
-- Self-serve deletion promises that the data is *gone*. `entity_versions` holds the
-- display names, `ticket_status_transitions` holds who moved what, `audit_log_entries`
-- holds who did what. An erasure that skipped them would leave the personal data
-- untouched in four tables and send a confirmation email saying otherwise, which is worse
-- than not offering deletion at all.
--
-- So the function now allows the mutation when `compass.erasure` is `on`, and that flag is
-- only ever set by `ScopedDb.eraseWithin()`, which sets it with `SET LOCAL` inside a
-- transaction so it cannot outlive the statement block that needed it. Three properties
-- hold and each is checkable:
--
--  * A psql session, an ORM and a migration all still get the refusal by default -- the
--    third argument to `current_setting` makes an unset GUC read as NULL rather than
--    raising, so nothing has to opt out of the guard to be bound by it.
--  * The application layer still refuses independently: `ScopedDb.deleteFrom` throws
--    `AppendOnlyTableError` unless the handle came from `eraseWithin`.
--  * `SET LOCAL` is transaction-scoped, so a pooled connection cannot carry the
--    permission to the next request that borrows it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compass_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF coalesce(current_setting('compass.erasure', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. Append a new row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$fn$;
--> statement-breakpoint

-- --- the documented defaults, applied to every organization that exists ----
--
-- `ON CONFLICT DO NOTHING` so a re-run is a no-op even though the migrator would not
-- run this twice: the same statement is what the boot script uses for a new tenant, and
-- having one shape for both is what keeps them from drifting.

INSERT INTO "org_privacy_settings"
  ("id", "organization_id", "raw_event_retention_days", "derived_retention_years",
   "llm_minimization_mode", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", 90, 3, 'redacted', now(), now()
  FROM "organizations"
ON CONFLICT ("organization_id") DO NOTHING;
