CREATE TYPE "public"."delivery_channel" AS ENUM('email', 'slack');--> statement-breakpoint
CREATE TYPE "public"."delivery_scope" AS ENUM('team', 'merged', 'both');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('sent', 'failed', 'deferred', 'skipped', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."share_audience" AS ENUM('org_members', 'public');--> statement-breakpoint
CREATE TYPE "public"."share_link_access_outcome" AS ENUM('served', 'expired', 'revoked', 'forbidden', 'not_found');--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "delivery_channel" NOT NULL,
	"target" text NOT NULL,
	"scope" "delivery_scope" NOT NULL,
	"send_time" text NOT NULL,
	"timezone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"unsubscribe_token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subscriptions_org_user_channel_key" UNIQUE("organization_id","user_id","channel"),
	CONSTRAINT "subscriptions_org_unsubscribe_hash_key" UNIQUE("organization_id","unsubscribe_token_hash")
);
--> statement-breakpoint
CREATE TABLE "delivery_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"report_id" uuid,
	"delivery_date" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"channel" "delivery_channel" NOT NULL,
	"target" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" "delivery_status" NOT NULL,
	"provider_message_id" text,
	"error" text,
	"detail" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"audience" "share_audience" DEFAULT 'org_members' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "share_links_org_token_hash_key" UNIQUE("organization_id","token_hash")
);
--> statement-breakpoint
CREATE TABLE "share_link_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"share_link_id" uuid,
	"outcome" "share_link_access_outcome" NOT NULL,
	"ip_prefix" text,
	"user_agent" text,
	"user_id" uuid,
	"accessed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_access" ADD CONSTRAINT "share_link_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_access" ADD CONSTRAINT "share_link_access_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_access" ADD CONSTRAINT "share_link_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_org_active_idx" ON "subscriptions" USING btree ("organization_id","active");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Exactly one *successful* send per scheduled delivery, enforced by the engine.
--
-- Partial, over `status = 'sent'`. The two acceptance criteria pull in opposite
-- directions: "the same job enqueued twice sends exactly one message" wants
-- uniqueness, and "each attempt writes a DeliveryLog row" wants many rows per
-- scheduled send. A plain unique constraint on these five columns would satisfy
-- the first by making the second retry a duplicate-key crash instead of a retry.
--
-- This shape lets `failed`, `deferred` and `skipped` attempts accumulate freely
-- while making a second `sent` row impossible. It is also the half of the
-- guarantee that survives the queue: a pg-boss singletonKey stops a duplicate
-- while the job is live, but once the queue is drained the key is gone and only
-- the database still remembers that Tuesday's report was already delivered.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "delivery_log_one_send_per_scheduled_delivery" ON "delivery_log" USING btree ("organization_id","subscription_id","delivery_date","scope_kind","scope_key") WHERE "delivery_log"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "delivery_log_org_subscription_date_idx" ON "delivery_log" USING btree ("organization_id","subscription_id","delivery_date");--> statement-breakpoint
CREATE INDEX "delivery_log_org_status_idx" ON "delivery_log" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "share_links_org_report_idx" ON "share_links" USING btree ("organization_id","report_id");--> statement-breakpoint
CREATE INDEX "share_link_access_org_link_idx" ON "share_link_access" USING btree ("organization_id","share_link_id");--> statement-breakpoint
CREATE INDEX "share_link_access_org_accessed_idx" ON "share_link_access" USING btree ("organization_id","accessed_at");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Both new logs are append-only, in the database as well as in `ScopedDb`.
--
-- `delivery_log` and `share_link_access` are event logs rather than state. The
-- questions they exist to answer — "did the manager get Tuesday's report, and if
-- not what did the provider say" and "who opened this shared link" — cannot be
-- answered by a table whose rows can be edited afterwards. `compass_reject_history_mutation()`
-- is declared in 0001; these are two more tables that use it.
-- ---------------------------------------------------------------------------
CREATE TRIGGER delivery_log_append_only BEFORE UPDATE OR DELETE ON "delivery_log" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER delivery_log_no_truncate BEFORE TRUNCATE ON "delivery_log" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER share_link_access_append_only BEFORE UPDATE OR DELETE ON "share_link_access" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER share_link_access_no_truncate BEFORE TRUNCATE ON "share_link_access" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();
