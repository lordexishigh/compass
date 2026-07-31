CREATE TABLE "narration_traces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"narrator_id" text NOT NULL,
	"model" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"attempt" integer NOT NULL,
	"attempt_count" integer NOT NULL,
	"outcome" text NOT NULL,
	"untraceable_tokens" text[] NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"prose_length" integer NOT NULL,
	"detail" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "narration_traces_report_section_attempt_key" UNIQUE("report_id","section_key","attempt")
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "fallback_renderer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "narration_traces" ADD CONSTRAINT "narration_traces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_traces" ADD CONSTRAINT "narration_traces_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "narration_traces_org_outcome_idx" ON "narration_traces" USING btree ("organization_id","outcome");--> statement-breakpoint
CREATE INDEX "narration_traces_report_idx" ON "narration_traces" USING btree ("report_id");