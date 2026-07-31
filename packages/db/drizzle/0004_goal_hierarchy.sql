CREATE TABLE "objective_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_instant" timestamp with time zone NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"subject_label" text NOT NULL,
	"source" text NOT NULL,
	"node_id" text,
	"node_revision" integer,
	"chain_node_ids" jsonb NOT NULL,
	"matched_substring" text,
	"matched_offset" integer,
	"matched_in" text,
	"score" double precision,
	"threshold" double precision,
	"compared_text_a" text,
	"compared_text_b" text,
	"serves_current_objective" boolean,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "objective_links_org_instant_subject_key" UNIQUE("organization_id","report_instant","subject_kind","subject_key")
);
--> statement-breakpoint
CREATE TABLE "objective_scope_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"link_key" text NOT NULL,
	"revision" integer NOT NULL,
	"node_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"detached" boolean NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" text,
	CONSTRAINT "objective_scope_links_org_link_revision_key" UNIQUE("organization_id","link_key","revision")
);
--> statement-breakpoint
CREATE TABLE "objective_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"revision" integer NOT NULL,
	"objective_kind" text NOT NULL,
	"parent_node_id" text,
	"title" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"is_current" boolean NOT NULL,
	"archived" boolean NOT NULL,
	"origin" text NOT NULL,
	"subject_kind" text,
	"subject_key" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" text,
	"change_note" text,
	CONSTRAINT "objective_versions_org_node_revision_key" UNIQUE("organization_id","node_id","revision")
);
--> statement-breakpoint
ALTER TABLE "objective_links" ADD CONSTRAINT "objective_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_scope_links" ADD CONSTRAINT "objective_scope_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_versions" ADD CONSTRAINT "objective_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "objective_links_org_subject_idx" ON "objective_links" USING btree ("organization_id","subject_kind","subject_key");--> statement-breakpoint
CREATE INDEX "objective_links_org_node_idx" ON "objective_links" USING btree ("organization_id","node_id");--> statement-breakpoint
CREATE INDEX "objective_scope_links_org_subject_idx" ON "objective_scope_links" USING btree ("organization_id","subject_kind","subject_key");--> statement-breakpoint
CREATE INDEX "objective_versions_org_node_recorded_idx" ON "objective_versions" USING btree ("organization_id","node_id","recorded_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- The goal store is append-only, at the level that cannot be bypassed.
--
-- Editing an objective appends a revision; archiving one appends a revision with
-- `archived = true`; the end of a revision's belief window is derived from the
-- next revision rather than written back. So no row here is ever sealed in place,
-- and that has to hold for a psql session and a migration as well as for
-- application code — a report a manager kept cites these rows by revision, and an
-- UPDATE would silently rewrite what yesterday's alignment verdict resolved
-- against. `src/schema/goals.ts` states the full rule.
--
-- Statement-level, like the triggers in 0001: a row-level trigger does not fire
-- for a statement that matches no rows, so `delete from objective_versions` would
-- succeed silently on an empty table and the guard would read as working when it
-- was not being exercised at all.
-- ---------------------------------------------------------------------------
CREATE TRIGGER objective_versions_append_only BEFORE UPDATE OR DELETE ON "objective_versions" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER objective_versions_no_truncate BEFORE TRUNCATE ON "objective_versions" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER objective_scope_links_append_only BEFORE UPDATE OR DELETE ON "objective_scope_links" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER objective_scope_links_no_truncate BEFORE TRUNCATE ON "objective_scope_links" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER objective_links_append_only BEFORE UPDATE OR DELETE ON "objective_links" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER objective_links_no_truncate BEFORE TRUNCATE ON "objective_links" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();