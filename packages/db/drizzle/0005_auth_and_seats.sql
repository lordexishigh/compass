CREATE TYPE "public"."auth_token_purpose" AS ENUM('magic_link', 'password_reset', 'invite');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"issued_by_user_id" uuid,
	CONSTRAINT "auth_tokens_org_hash_key" UNIQUE("organization_id","token_hash")
);
--> statement-breakpoint
CREATE TABLE "membership_team_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"team_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "membership_team_scopes_org_membership_team_key" UNIQUE("organization_id","membership_id","team_key")
);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- `token_hash` is added NOT NULL with no default and no backfill, deliberately.
--
-- Before this migration nothing in the product could create a session row: the
-- table was declared in 0000 as part of the foundation schema and sign-in did not
-- exist yet, so there is nothing to backfill and a default would only be there to
-- serve rows that cannot be present. If a hand-made row somehow is, this ALTER
-- fails loudly rather than inventing a digest for a cookie nobody holds — which is
-- the correct outcome for a credential column.
-- ---------------------------------------------------------------------------
ALTER TABLE "sessions" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rotated_from_session_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_team_scopes" ADD CONSTRAINT "membership_team_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_team_scopes" ADD CONSTRAINT "membership_team_scopes_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_tokens_org_user_purpose_idx" ON "auth_tokens" USING btree ("organization_id","user_id","purpose");--> statement-breakpoint
CREATE INDEX "membership_team_scopes_org_membership_idx" ON "membership_team_scopes" USING btree ("organization_id","membership_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_org_token_hash_key" UNIQUE("organization_id","token_hash");