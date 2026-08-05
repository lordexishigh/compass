-- ---------------------------------------------------------------------------
-- Federated identity: OAuth SSO, SAML, and SCIM's view of a seat.
--
-- ## `user_identities.subject` is the key, and the email is not
--
-- The load-bearing decision in this migration. An email address is mutable and reassignable — a
-- colleague changes their surname, or leaves and their address is handed to somebody new — so keying a
-- federated identity on the address means the second person inherits the first person's account. The
-- key is therefore the provider's own immutable subject (Google's `sub`, GitHub's numeric `id`, the
-- SAML `NameID`), and the address is stored beside it as a fact asserted at link time: used for the
-- first match, never as the identity afterwards.
--
-- `email_verified` is stored as the provider asserted it, because the linking rule turns on it — an
-- unverified provider email is never auto-linked to an existing account. Recording the assertion makes
-- that decision auditable after the fact instead of a branch that ran once and left no trace.
--
-- ## `saml_assertion_replays` is the replay defence, and the unique index *is* the mechanism
--
-- A SAML assertion is a bearer credential valid for its whole `NotOnOrAfter` window. Anyone who
-- captures one — a proxy log, a browser history, a shared terminal — can post it again inside that
-- window and be signed in as its subject. The only defence is remembering which ids have been spent,
-- and that memory has to survive a deploy and be shared between the web and worker processes, so it is
-- a table rather than a cache.
--
-- Acceptance is an INSERT. If it succeeds this is the first presentation; if it violates
-- `saml_assertion_replays_org_assertion_key` it is a replay. That is what makes the guarantee hold
-- under concurrency: two simultaneous posts of the same assertion both pass any SELECT-then-INSERT
-- check, and exactly one of them wins an INSERT.
--
-- ## No IdP may mint an owner
--
-- `saml_connections.default_role` carries a CHECK that excludes `owner`. An IdP that could create
-- owners would mean anybody who can add a user to a directory group can take over the Compass
-- organization — a privilege escalation dressed as provisioning. It is a constraint rather than a
-- handler check so that no future importer, no psql session and no bug in a route can widen it.
--
-- ## Row-level security
--
-- Migration 0018's loop covered every table that existed then and cannot cover these. The same DO
-- block is repeated at the foot of this file, verbatim in shape, because `drizzle-kit generate` does
-- not emit `ENABLE ROW LEVEL SECURITY` and a new table would otherwise arrive with no policy at all.
-- `tests/migrations.test.ts` asserts RLS per table with no exemption list, so omitting this is a build
-- failure rather than a silent gap.
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."identity_provider" AS ENUM('google', 'github', 'saml', 'scim');--> statement-breakpoint

CREATE TABLE "user_identities" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "provider" "identity_provider" NOT NULL,
  "subject" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean NOT NULL,
  "linked_at" timestamp with time zone NOT NULL,
  "last_sign_in_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- An empty subject is not an identity. Written here as well as in the handler because this constraint
-- holds for every other path into the column — a psql session, a future importer, a bug in a route.
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_subject_not_empty_check"
  CHECK (length(btrim("subject")) > 0);--> statement-breakpoint

-- The address is stored normalised, and the constraint is what keeps it that way: a mixed-case row
-- would match no lookup and would look like a missing identity rather than a malformed one.
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_email_normalised_check"
  CHECK ("email" = lower(btrim("email")) AND length("email") > 0);--> statement-breakpoint

-- One local user per (provider, subject): the anti-duplication guarantee, in the database. A
-- read-then-insert in a handler would let two concurrent first sign-ins from the same Google account
-- both create a user, which is exactly the duplicate the acceptance criterion forbids — and it is easy
-- to hit, because a person who double-clicks the button produces it.
CREATE UNIQUE INDEX "user_identities_org_provider_subject_key"
  ON "user_identities" USING btree ("organization_id","provider","subject");--> statement-breakpoint

-- And one identity per provider per person, from the other direction. Without it a single account
-- could accumulate two Google identities, and unlinking Google would leave a second Google door open
-- that no screen listed.
CREATE UNIQUE INDEX "user_identities_org_provider_user_key"
  ON "user_identities" USING btree ("organization_id","provider","user_id");--> statement-breakpoint

CREATE INDEX "user_identities_org_user_idx" ON "user_identities" USING btree ("organization_id","user_id");--> statement-breakpoint

CREATE TABLE "saml_connections" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "idp_entity_id" text NOT NULL,
  "idp_sso_url" text NOT NULL,
  "idp_certificate" text NOT NULL,
  "default_role" "membership_role" NOT NULL,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "saml_connections" ADD CONSTRAINT "saml_connections_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- See the header. No IdP may mint an owner, and this is where that is true rather than intended.
ALTER TABLE "saml_connections" ADD CONSTRAINT "saml_connections_default_role_not_owner_check"
  CHECK ("default_role" <> 'owner');--> statement-breakpoint

ALTER TABLE "saml_connections" ADD CONSTRAINT "saml_connections_certificate_not_empty_check"
  CHECK (length(btrim("idp_certificate")) > 0);--> statement-breakpoint

-- One IdP per organization. A deployment needing two would drop this index and nothing above it moves.
CREATE UNIQUE INDEX "saml_connections_org_key" ON "saml_connections" USING btree ("organization_id");--> statement-breakpoint

CREATE TABLE "saml_assertion_replays" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "assertion_id" text NOT NULL,
  "issuer" text NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL,
  "not_on_or_after" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "saml_assertion_replays" ADD CONSTRAINT "saml_assertion_replays_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "saml_assertion_replays" ADD CONSTRAINT "saml_assertion_replays_assertion_id_not_empty_check"
  CHECK (length(btrim("assertion_id")) > 0);--> statement-breakpoint

-- The replay defence itself. See the header: acceptance is an INSERT against this index.
CREATE UNIQUE INDEX "saml_assertion_replays_org_assertion_key"
  ON "saml_assertion_replays" USING btree ("organization_id","assertion_id");--> statement-breakpoint

CREATE INDEX "saml_assertion_replays_org_expiry_idx"
  ON "saml_assertion_replays" USING btree ("organization_id","not_on_or_after");--> statement-breakpoint

CREATE TABLE "scim_credentials" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "label" text NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "scim_credentials" ADD CONSTRAINT "scim_credentials_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- A 64-character lower-case hex SHA-256. This constraint is what stops a plaintext bearer token ever
-- reaching this column by any path: a real token is 43 base64url characters and would fail it.
ALTER TABLE "scim_credentials" ADD CONSTRAINT "scim_credentials_token_hash_shape_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

CREATE UNIQUE INDEX "scim_credentials_org_token_key"
  ON "scim_credentials" USING btree ("organization_id","token_hash");--> statement-breakpoint

CREATE INDEX "scim_credentials_org_revoked_idx"
  ON "scim_credentials" USING btree ("organization_id","revoked_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security for the four tables above.
--
-- The same shape migration 0018 established, and deliberately the same data-driven loop rather than
-- four hand-written pairs: it keys off `organization_id`, so it covers exactly the tables this
-- migration added and would cover a fifth if one were added beside them.
-- ---------------------------------------------------------------------------

DO $rls$
DECLARE
  tenant_table text;
  policy_name text;
BEGIN
  FOR tenant_table IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
       AND a.attname = 'organization_id'
       AND a.attnum > 0
       AND NOT a.attisdropped
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tenant_table);

    policy_name := tenant_table || '_tenant_isolation';

    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = tenant_table
         AND policyname = policy_name
    ) THEN
      -- One policy `FOR ALL`: the same predicate on read and on write, so a row that cannot be seen
      -- is not one that can be written either.
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL '
        'USING (organization_id = compass_current_organization()) '
        'WITH CHECK (organization_id = compass_current_organization())',
        policy_name,
        tenant_table
      );
    END IF;
  END LOOP;
END
$rls$;
