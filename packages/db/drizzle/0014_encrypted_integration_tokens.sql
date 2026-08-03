-- ---------------------------------------------------------------------------
-- Encrypted integration tokens: the two tables that hold a credential Compass has to
-- be able to *use*, and hold it unreadable.
--
-- ## Why two tables and not one column
--
-- Every other bearer secret in this schema is stored as a SHA-256 digest, because Compass
-- only ever needs to *recognise* it — a session cookie, a magic link, a share token, a
-- deletion undo token. An integration's OAuth access and refresh tokens are the opposite
-- case: Compass has to present the actual bytes to GitHub tomorrow morning, so a digest is
-- useless and the plaintext has to be recoverable.
--
-- Recoverable is not readable. `organization_data_keys` holds one 32-byte data key per
-- organization, itself sealed under a KMS master key that lives only in the environment; a
-- token in `integration_tokens` is sealed under that data key. So a database dump contains
-- wrapped keys and ciphertext and nothing that opens either, and one organization's key
-- opens one organization's tokens.
--
-- ## The CHECK on `sealed_value`
--
-- `like 'v1:aes-256-gcm.%'` is the one that earns its place. Every other guarantee here is
-- upheld by application code that could be bypassed by a migration, a script or a psql
-- session; this one means a *bare token* cannot be stored by any of them. The failure it
-- prevents is specific and has happened to other products: somebody pastes a token in by
-- hand to unblock an integration at 2am, it works, and the column quietly holds plaintext
-- from then on.
--
-- ## Why `expires_at` is in the clear
--
-- The refresh scheduler has to know when an access token dies. Decrypting every token on
-- every tick to find out would mean the master key was resident in memory during routine
-- work. An expiry says *when*, not *what*, so it is a plain column.
--
-- ## Not added to `source_configs`
--
-- `source_configs.settings` is a jsonb blob the roster endpoints read, diff and return. A
-- token in there would be safe only as long as every future caller of that column
-- remembered it was in there. A separate table with no plaintext read path is the
-- structural version of the rule: `/api/roster` cannot leak a token because it does not
-- select from a table that has one.
-- ---------------------------------------------------------------------------

CREATE TABLE "organization_data_keys" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "wrapped_data_key" text NOT NULL,
  "key_version" integer NOT NULL,
  "master_key_version" integer NOT NULL,
  "rotated_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "organization_data_keys_org_key" UNIQUE("organization_id"),
  CONSTRAINT "organization_data_keys_version_positive" CHECK ("key_version" >= 1),
  CONSTRAINT "organization_data_keys_master_version_positive" CHECK ("master_key_version" >= 1)
);--> statement-breakpoint

ALTER TABLE "organization_data_keys" ADD CONSTRAINT "organization_data_keys_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "integration_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "source_key" text NOT NULL,
  "token_kind" text NOT NULL,
  "sealed_value" text NOT NULL,
  "key_version" integer NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "integration_tokens_org_source_kind_key" UNIQUE("organization_id","source_key","token_kind"),
  CONSTRAINT "integration_tokens_kind" CHECK ("token_kind" in ('access', 'refresh')),
  CONSTRAINT "integration_tokens_version_positive" CHECK ("key_version" >= 1),
  CONSTRAINT "integration_tokens_sealed" CHECK ("sealed_value" like 'v1:aes-256-gcm.%')
);--> statement-breakpoint

ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "integration_tokens_org_expiry_idx" ON "integration_tokens" USING btree ("organization_id","expires_at");
