-- ---------------------------------------------------------------------------
-- Row-level security on every tenant table.
--
-- `ScopedDb` adds `organization_id = $1` to every statement it builds and `tests/scoped-db.test.ts`
-- inspects the emitted SQL to prove it. That is the enforced path and it stays the enforced path.
-- What it cannot do is bind anything that does not go through it: a psql session, a future importer,
-- an ORM someone reaches for in a hurry, or — the case this migration exists for — a managed
-- provider's auto-generated REST API, which connects with its own role and never sees this code at
-- all. On Supabase, PostgREST exposes every table in `public` to the `anon` role; a table with no
-- row-level policy and a stray grant is a table the internet can read. "Compass adds the predicate"
-- is a true sentence about the application and says nothing about the database.
--
-- So the database gets its own predicate, and it is the same predicate.
--
-- ## The tenant comes from a request-scoped setting
--
-- `compass_current_organization()` reads `compass.organization_id`, following the pattern migration
-- 0013 already established for `compass.erasure`: a GUC set with `SET LOCAL` inside a transaction, so
-- it dies with the transaction and a pooled connection cannot hand one request's tenant to the next.
-- The third argument to `current_setting` makes an unset GUC read as NULL rather than raising, and
-- `organization_id = NULL` is NULL rather than true — so a connection that has not said which tenant
-- it is reads nothing. Fail-closed is the only safe default here: the alternative, a policy that
-- permits everything when the setting is absent, is not a lock.
--
-- ## Why `FORCE ROW LEVEL SECURITY` is deliberately *not* set
--
-- This is the load-bearing decision in this file and it deserves to be stated rather than discovered.
--
-- PostgreSQL exempts a table's owner from its own policies unless the table is forced. Compass runs
-- migrations and application queries as the same role, so that role owns these tables and is exempt.
-- Adding FORCE would therefore change the behaviour of every existing caller at once — the Next.js
-- app, the pg-boss worker, the seed and golden-fixture tooling, and every PGlite test — and all of
-- them query without a request context. Two of those (the worker's nightly pipeline and the seed
-- tooling) have no HTTP request to take a tenant from at all. FORCE without threading a GUC through
-- all of them does not harden Compass; it breaks it, and the failure mode is "every report is empty",
-- which is exactly the kind of silence this schema is built to avoid.
--
-- What RLS buys unforced is precisely the exposure the audit named: any role that is *not* the owner —
-- `anon`, `authenticated`, a read-only analyst, a BI tool, a compromised connection string with lesser
-- privileges — is now bound by the policy, and gets nothing without declaring a tenant. The REVOKE
-- below closes the same door from the other side, so neither is the only guard.
--
-- To promote RLS from the second lock to the first, a deployment needs a runtime role that does not
-- own the tables, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, and `SET LOCAL compass.organization_id`
-- inside the transaction that serves each request. `compass_current_organization()` is the seam that
-- makes that a configuration change rather than a schema change. `docs/ENGINEERING.md` records it.
--
-- ## Data-driven rather than a list
--
-- Every table in this schema carries a non-null `organization_id` — `tests/migrations.test.ts`
-- asserts it for every table with no exemption list — so the loop below can key off the column
-- instead of a hand-written table list that would silently miss the next table somebody adds. The
-- loop only covers tables that exist *now*; the regression gate in `tests/migrations.test.ts` is what
-- covers the ones added later, and it fails the build rather than trusting anyone to remember.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compass_current_organization() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $fn$
  SELECT nullif(btrim(coalesce(current_setting('compass.organization_id', true), '')), '')::uuid;
$fn$;--> statement-breakpoint

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

    -- The migrator does not replay a migration, but this statement is also the one a new table's
    -- migration should copy, and `CREATE POLICY` has no `IF NOT EXISTS`. Guarding it here means the
    -- shape is safe to reuse.
    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = tenant_table
         AND policyname = policy_name
    ) THEN
      -- One policy `FOR ALL`: the same predicate on read and on write. A row that cannot be seen
      -- must not be creatable either, or a caller could write into a tenant it cannot read back.
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
$rls$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The other half: no grant for the managed provider's API roles.
--
-- RLS decides which *rows* a role may see; a grant decides whether it may address the table at all.
-- Supabase creates `anon` and `authenticated` and points PostgREST at them, and Compass has no use
-- for either — it talks to PostgreSQL directly and its authorization lives in `ROLE_MATRIX`. So the
-- privileges are withdrawn as well as the rows, and the default privileges too, or the next table
-- created in this schema would arrive with the grant restored.
--
-- Guarded by existence rather than assumed: these roles do not exist on a plain PostgreSQL 17, on the
-- docker-compose database, or under PGlite, and a migration that failed on `role "anon" does not
-- exist` would fail every developer's first `pnpm db:migrate`. The privilege exception is caught for
-- the same reason from the other direction: on a managed provider the migration role may not be
-- permitted to alter another role's grants, and that is a warning for an operator to act on in the
-- provider's SQL console — not a reason to leave the database unmigrated.
-- ---------------------------------------------------------------------------

DO $revoke$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      BEGIN
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
          api_role
        );
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE WARNING
          'Could not revoke public-schema privileges from %. Run the REVOKE in the provider''s SQL console: row-level security is enabled, but the role can still address the tables.',
          api_role;
      END;
    END IF;
  END LOOP;
END
$revoke$;
