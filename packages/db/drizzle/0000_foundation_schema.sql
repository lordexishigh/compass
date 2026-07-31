CREATE TYPE "public"."membership_role" AS ENUM('owner', 'manager', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TABLE "audit_log_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text NOT NULL,
	"total_records" integer NOT NULL,
	"artifact_counts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_source_coverage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"ingest_run_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_kind" text NOT NULL,
	"artifact" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"requested_window_start" timestamp with time zone NOT NULL,
	"requested_window_end" timestamp with time zone NOT NULL,
	"covered_window_start" timestamp with time zone,
	"covered_window_end" timestamp with time zone,
	"record_count" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ingest_source_coverage_run_source_artifact_key" UNIQUE("ingest_run_id","source_key","artifact")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"status" "membership_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memberships_org_user_key" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "organizations_slug_key" UNIQUE("slug"),
	CONSTRAINT "organizations_org_id_is_self" CHECK ("organizations"."organization_id" = "organizations"."id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_kind" text NOT NULL,
	"connector_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_configs_org_key" UNIQUE("organization_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_org_email_key" UNIQUE("organization_id","email")
);
--> statement-breakpoint
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_source_coverage" ADD CONSTRAINT "ingest_source_coverage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_source_coverage" ADD CONSTRAINT "ingest_source_coverage_ingest_run_id_ingest_runs_id_fk" FOREIGN KEY ("ingest_run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_occurred_idx" ON "audit_log_entries" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ingest_runs_org_window_idx" ON "ingest_runs" USING btree ("organization_id","window_start","window_end");--> statement-breakpoint
CREATE INDEX "ingest_source_coverage_org_idx" ON "ingest_source_coverage" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sessions_org_user_idx" ON "sessions" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("organization_id");