CREATE TABLE "team_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"team_key" text NOT NULL,
	"developer_key" text NOT NULL,
	"membership_role" text NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "team_memberships_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "tracked_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"project_key" text NOT NULL,
	"tracked" boolean NOT NULL,
	"archived_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "tracked_projects_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "tracked_repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"repository_key" text NOT NULL,
	"tracked" boolean NOT NULL,
	"archived_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "tracked_repositories_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "working_calendars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"team_key" text NOT NULL,
	"working_weekdays" jsonb NOT NULL,
	"holidays" jsonb NOT NULL,
	"timezone" text NOT NULL,
	CONSTRAINT "working_calendars_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- `absences.source` is added in three steps rather than as one NOT NULL.
--
-- Unlike `sessions.token_hash` in 0005, rows here *can* already exist: the roster
-- provisioning path has always accepted absences, so a deployment that declared one
-- has a row with no source. A bare `ADD COLUMN ... NOT NULL` would fail that
-- migration, and a `DEFAULT 'manual'` left in place would silently let a future
-- insert omit the field — which is the one thing this column exists to prevent.
--
-- So: add nullable, state what the existing rows were, then close the column. Every
-- absence that predates this migration came through the roster provisioning path,
-- which is the manual one, so `manual` is the true answer rather than a convenient one.
-- ---------------------------------------------------------------------------
ALTER TABLE "absences" ADD COLUMN "source" text;--> statement-breakpoint
UPDATE "absences" SET "source" = 'manual' WHERE "source" IS NULL;--> statement-breakpoint
ALTER TABLE "absences" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "absences" ADD COLUMN "source_ref" text;--> statement-breakpoint
-- `author_identity_key` is nullable with no backfill, deliberately. It cannot be
-- reconstructed for an artifact already ingested — the identifier a matched author
-- presented is not on the row — so a null here means "ingested before Compass kept
-- this", and attribution for those artifacts stays where ingest put it. The next
-- ingest of the same window fills it in, because re-observing is idempotent.

ALTER TABLE "commits" ADD COLUMN "author_identity_key" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "author_identity_key" text;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_projects" ADD CONSTRAINT "tracked_projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_repositories" ADD CONSTRAINT "tracked_repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_calendars" ADD CONSTRAINT "working_calendars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_memberships_org_last_seen_idx" ON "team_memberships" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "team_memberships_org_team_idx" ON "team_memberships" USING btree ("organization_id","team_key");--> statement-breakpoint
CREATE INDEX "team_memberships_org_developer_idx" ON "team_memberships" USING btree ("organization_id","developer_key");--> statement-breakpoint
CREATE INDEX "tracked_projects_org_last_seen_idx" ON "tracked_projects" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "tracked_projects_org_project_idx" ON "tracked_projects" USING btree ("organization_id","project_key");--> statement-breakpoint
CREATE INDEX "tracked_repositories_org_last_seen_idx" ON "tracked_repositories" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "tracked_repositories_org_repo_idx" ON "tracked_repositories" USING btree ("organization_id","repository_key");--> statement-breakpoint
CREATE INDEX "working_calendars_org_last_seen_idx" ON "working_calendars" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "working_calendars_org_team_idx" ON "working_calendars" USING btree ("organization_id","team_key");