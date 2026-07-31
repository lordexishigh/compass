CREATE TABLE "report_item_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"report_item_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"source_key" text NOT NULL,
	"source_record_id" text NOT NULL,
	"commit_sha" text,
	"pull_request_number" integer,
	"issue_key" text,
	"artifact_kind" text NOT NULL,
	"artifact_id" text NOT NULL,
	CONSTRAINT "report_item_evidence_item_ordinal_key" UNIQUE("report_item_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "report_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"report_section_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"stable_id" text NOT NULL,
	"headline" text NOT NULL,
	"detail" text NOT NULL,
	"change_tag" text NOT NULL,
	"age_days" integer NOT NULL,
	"change_clause" text,
	"ladder" jsonb,
	"has_ladder" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "report_items_section_ordinal_key" UNIQUE("report_section_id","ordinal"),
	CONSTRAINT "report_items_section_stable_id_key" UNIQUE("report_section_id","stable_id")
);
--> statement-breakpoint
CREATE TABLE "report_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"prose" text NOT NULL,
	"payload" jsonb NOT NULL,
	"item_count" integer NOT NULL,
	"empty_statement" text NOT NULL,
	"summary" text,
	CONSTRAINT "report_sections_report_ordinal_key" UNIQUE("report_id","ordinal"),
	CONSTRAINT "report_sections_report_section_key" UNIQUE("report_id","section_key")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"schema_version" integer NOT NULL,
	"report_instant" timestamp with time zone NOT NULL,
	"report_date" text NOT NULL,
	"timezone" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"payload_json" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prose" text NOT NULL,
	"renderer_id" text NOT NULL,
	"coverage_status" text NOT NULL,
	"ingest_run_id" uuid,
	"generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reports_org_scope_instant_key" UNIQUE("organization_id","scope_kind","scope_key","report_instant")
);
--> statement-breakpoint
ALTER TABLE "report_item_evidence" ADD CONSTRAINT "report_item_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_item_evidence" ADD CONSTRAINT "report_item_evidence_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_item_evidence" ADD CONSTRAINT "report_item_evidence_report_item_id_report_items_id_fk" FOREIGN KEY ("report_item_id") REFERENCES "public"."report_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_report_section_id_report_sections_id_fk" FOREIGN KEY ("report_section_id") REFERENCES "public"."report_sections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_ingest_run_id_ingest_runs_id_fk" FOREIGN KEY ("ingest_run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_item_evidence_org_artifact_idx" ON "report_item_evidence" USING btree ("organization_id","artifact_kind","artifact_id");--> statement-breakpoint
CREATE INDEX "report_items_org_report_idx" ON "report_items" USING btree ("organization_id","report_id");--> statement-breakpoint
CREATE INDEX "report_sections_org_idx" ON "report_sections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "reports_org_scope_date_idx" ON "reports" USING btree ("organization_id","scope_kind","scope_key","report_date");