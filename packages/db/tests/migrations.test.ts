import { instantFromIso, timeWindow } from '@compass/clock';
import { completeCoverage, unavailableCoverage } from '@compass/connector-port';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPEND_ONLY_TABLE_NAMES,
  AppendOnlyTableError,
  NAMED_ENTITIES,
  ORGANIZATION_ID_COLUMN,
  ScopedDb,
  appendEntityVersion,
  corrections,
  entityRowId,
  entityTableName,
  entityVersionRowId,
  entityVersions,
  insertIngestRun,
  listRecentIngestRuns,
  orgScope,
  organizations,
  schema,
  sprintScopeChanges,
  ticketStatusTransitions,
  tickets,
  users,
} from '@compass/db';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

/** Every declared table, paired with its name, for the schema-vs-migration check. */
const SCHEMA_TABLES: readonly (readonly [string, PgTable])[] = Object.values(
  schema as Record<string, unknown>,
)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => [getTableConfig(table).name, table] as const)
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
/** Its own tenant, so the append-only probe cannot collide with the two above. */
const ORG_PROBE = '99999999-9999-4999-8999-999999999999';
const at = (iso: string) => instantFromIso(iso);
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
});

afterAll(async () => {
  await database.close();
});

const appliedMigrationCount = async (): Promise<number> => {
  const result = await database.client.query<{ count: string }>(
    'select count(*)::text as count from drizzle.__drizzle_migrations',
  );
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
};

describe('pnpm db:migrate', () => {
  it('applies cleanly to an empty database', async () => {
    expect(await appliedMigrationCount()).toBeGreaterThan(0);
  });

  it('is idempotent on re-run', async () => {
    const before = await appliedMigrationCount();

    await database.migrate();
    await database.migrate();

    expect(await appliedMigrationCount()).toBe(before);
  });

  it('produces tables that all carry a non-null organization_id', async () => {
    const tables = await database.client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
    );
    expect(tables.rows.length).toBeGreaterThan(0);

    for (const { table_name: tableName } of tables.rows) {
      const columns = await database.client.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`,
        [tableName, ORGANIZATION_ID_COLUMN],
      );

      expect(columns.rows.length, `${tableName} has no ${ORGANIZATION_ID_COLUMN} column`).toBe(1);
      expect(columns.rows[0]?.is_nullable, `${tableName}.${ORGANIZATION_ID_COLUMN} must be NOT NULL`).toBe('NO');
    }
  });

  /**
   * The drift tripwire.
   *
   * Everything else in this file checks the migrated database, and `schema.test.ts`
   * checks the drizzle declarations, but nothing compared the two — so a column
   * dropped from `src/schema/*.ts` and left behind in `drizzle/*.sql` typechecked,
   * migrated, and then failed at runtime with a NOT NULL violation on the first
   * INSERT. This asserts the two agree, in both directions, for every table.
   */
  it.each(SCHEMA_TABLES)('%s has exactly the columns the drizzle schema declares', async (name, table) => {
    const found = await database.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1`,
      [name],
    );

    const inDatabase = found.rows.map((row) => row.column_name).sort();
    const declared = getTableConfig(table).columns.map((column) => column.name).sort();

    expect(inDatabase, `${name} exists in the schema but not in the migration`).not.toEqual([]);
    // One assertion rather than two set-differences: the diff vitest prints on
    // failure names the offending column directly.
    expect(inDatabase).toEqual(declared);
  });

  it('creates a natural-key uniqueness constraint for every entity table', async () => {
    for (const definition of NAMED_ENTITIES) {
      const table = entityTableName(definition.kind);
      const found = await database.client.query<{ constraint_name: string }>(
        `select constraint_name from information_schema.table_constraints
          where table_schema = 'public' and table_name = $1 and constraint_type = 'UNIQUE'`,
        [table],
      );

      expect(found.rows.map((row) => row.constraint_name), `${table} lost its natural-key constraint`).toContain(
        `${table}_org_natural_key`,
      );
    }
  });

  it('refuses an UPDATE or a DELETE on every append-only table, in the database itself', async () => {
    for (const table of APPEND_ONLY_TABLE_NAMES) {
      await expect(
        database.client.query(`update "${table}" set organization_id = organization_id`),
        `${table} accepted an UPDATE`,
      ).rejects.toThrow(/append-only/i);

      await expect(
        database.client.query(`delete from "${table}"`),
        `${table} accepted a DELETE`,
      ).rejects.toThrow(/append-only/i);

      await expect(
        database.client.query(`truncate table "${table}"`),
        `${table} accepted a TRUNCATE`,
      ).rejects.toThrow(/append-only/i);
    }
  });

  it('still accepts an INSERT on those same tables — appending is the whole point', async () => {
    const scoped = new ScopedDb(database.db, orgScope(ORG_PROBE));
    await database.db
      .insert(organizations)
      .values({
        id: ORG_PROBE,
        organizationId: ORG_PROBE,
        name: 'Append Only Probe',
        slug: 'append-only-probe',
        timezone: 'UTC',
        createdAt: asDate('2026-07-01T00:00:00Z'),
        updatedAt: asDate('2026-07-01T00:00:00Z'),
      })
      .onConflictDoNothing()
      .execute();

    await appendEntityVersion(scoped, {
      id: entityVersionRowId(ORG_PROBE, 'ticket', 'DEV-1', 1),
      entityKind: 'ticket',
      entityNaturalKey: 'DEV-1',
      entityId: entityRowId(ORG_PROBE, 'ticket', 'DEV-1'),
      version: 1,
      trackedFields: { status: 'Blocked' },
      changedFields: ['status'],
      observedAt: asDate('2026-07-30T08:15:00Z'),
      evidenceSourceKey: 'primary-tracker',
      evidenceSourceRecordId: 'issue-1',
    });

    const rows = await database.client.query<{ count: string }>(
      'select count(*)::text as count from entity_versions',
    );
    expect(Number.parseInt(rows.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('refuses the same mutation one layer up, so neither guard is the only one', () => {
    const scoped = new ScopedDb(database.db, orgScope(ORG_PROBE));

    expect(() => scoped.updateIn(entityVersions, { version: 2 })).toThrow(AppendOnlyTableError);
    expect(() => scoped.deleteFrom(corrections)).toThrow(AppendOnlyTableError);
    expect(() => scoped.updateIn(ticketStatusTransitions, { toStatus: 'Done' })).toThrow(AppendOnlyTableError);
    expect(() => scoped.deleteFrom(sprintScopeChanges)).toThrow(AppendOnlyTableError);
    // Entity rows are the current belief and are meant to move.
    expect(() => scoped.updateIn(tickets, { status: 'Done' })).not.toThrow();
  });

  /**
   * Row-level security, asserted per table rather than per migration.
   *
   * Migration 0018 enables RLS by looping over the tables that carry `organization_id`, which covers
   * every table that exists *at that point*. Nothing in the migration can cover the table somebody
   * adds in 0019 — `drizzle-kit generate` does not emit `ENABLE ROW LEVEL SECURITY`, so the generated
   * SQL for a new table will look complete and arrive with no policy at all. These tests are what
   * makes that a build failure rather than a silent gap, which is why they are stated over the
   * migrated database and not over a list.
   */
  describe('row-level security', () => {
    const POLICY_SUFFIX = '_tenant_isolation';

    it('is enabled on every table, with no exemption list', async () => {
      const rows = await database.client.query<{ table_name: string; enabled: boolean }>(
        `select c.relname as table_name, c.relrowsecurity as enabled
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
          order by c.relname`,
      );

      expect(rows.rows.length, 'no tables were found at all').toBeGreaterThan(0);
      expect(
        rows.rows.filter((row) => !row.enabled).map((row) => row.table_name),
        'these tables have no row-level security — add them to a migration like 0018',
      ).toEqual([]);
    });

    it('gives every table one tenant policy, on reads and on writes alike', async () => {
      const policies = await database.client.query<{
        tablename: string;
        policyname: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `select tablename, policyname, cmd, qual, with_check
           from pg_policies where schemaname = 'public' order by tablename, policyname`,
      );
      const tables = await database.client.query<{ table_name: string }>(
        `select c.relname as table_name
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
          order by c.relname`,
      );

      for (const { table_name: tableName } of tables.rows) {
        const forTable = policies.rows.filter((row) => row.tablename === tableName);

        expect(forTable.map((row) => row.policyname), `${tableName} has no tenant policy`).toEqual([
          `${tableName}${POLICY_SUFFIX}`,
        ]);
        // `FOR ALL`: a row a caller cannot read must not be one it can write either.
        expect(forTable[0]?.cmd, `${tableName}'s policy does not cover every command`).toBe('ALL');

        for (const predicate of [forTable[0]?.qual, forTable[0]?.with_check]) {
          expect(predicate, `${tableName}'s policy is missing a predicate`).not.toBeNull();
          expect(predicate).toContain('organization_id');
          expect(predicate).toContain('compass_current_organization');
        }
      }
    });

    it('reads an unset tenant as NULL rather than raising, so the predicate fails closed', async () => {
      // `organization_id = NULL` is NULL, never true. A connection that has not said which tenant it
      // is therefore sees nothing — which is the whole reason the third argument to
      // `current_setting` is there. Were it to raise instead, every query would error and somebody
      // would be tempted to make the policy permissive to get the app working again.
      const result = await database.client.query<{ tenant: string | null }>(
        'select compass_current_organization() as tenant',
      );

      expect(result.rows[0]?.tenant).toBeNull();
    });
  });

  it('holds the tenant root to its own check constraint', async () => {
    await expect(
      database.client.query(
        `insert into organizations (id, ${ORGANIZATION_ID_COLUMN}, name, slug, timezone, created_at, updated_at)
         values ($1, $2, 'Mismatched', 'mismatched', 'UTC', now(), now())`,
        [ORG_A, ORG_B],
      ),
    ).rejects.toThrow();
  });
});

describe('two organizations sharing one database', () => {
  const scopeFor = (organizationId: string) => new ScopedDb(database.db, orgScope(organizationId));

  beforeAll(async () => {
    for (const [id, name] of [
      [ORG_A, 'Acme Platform'],
      [ORG_B, 'Beta Robotics'],
    ] as const) {
      await database.db
        .insert(organizations)
        .values({
          id,
          organizationId: id,
          name,
          slug: name.toLowerCase().replace(/\s+/g, '-'),
          timezone: 'Europe/London',
          createdAt: asDate('2026-07-01T00:00:00Z'),
          updatedAt: asDate('2026-07-01T00:00:00Z'),
        })
        .execute();
    }

    await scopeFor(ORG_A)
      .insertInto(users, {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'priya@example.com',
        displayName: 'Priya Raman',
        passwordHash: null,
        createdAt: asDate('2026-07-01T00:00:00Z'),
        updatedAt: asDate('2026-07-01T00:00:00Z'),
      })
      .execute();

    await scopeFor(ORG_B)
      .insertInto(users, {
        id: '44444444-4444-4444-8444-444444444444',
        email: 'marcus@example.com',
        displayName: 'Marcus Hale',
        passwordHash: null,
        createdAt: asDate('2026-07-01T00:00:00Z'),
        updatedAt: asDate('2026-07-01T00:00:00Z'),
      })
      .execute();
  });

  it('never returns another organization rows', async () => {
    const forA = await scopeFor(ORG_A).selectFrom(users);
    const forB = await scopeFor(ORG_B).selectFrom(users);

    expect(forA.map((row) => row.email)).toEqual(['priya@example.com']);
    expect(forB.map((row) => row.email)).toEqual(['marcus@example.com']);
  });

  it('stamps the scope organization on every inserted row', async () => {
    const rows = await scopeFor(ORG_A).selectFrom(users);

    expect(rows.every((row) => row.organizationId === ORG_A)).toBe(true);
  });

  it('records ingest runs and their per-source coverage inside the scope', async () => {
    const window = timeWindow(at('2026-07-29T00:00:00Z'), at('2026-07-30T00:00:00Z'));
    const observedAt = at('2026-07-30T08:00:00Z');

    await insertIngestRun(
      scopeFor(ORG_A),
      {
        id: '55555555-5555-4555-8555-555555555555',
        connectorId: 'seed:foundation-v1',
        window,
        startedAt: observedAt,
        completedAt: observedAt,
        status: 'unavailable',
        totalRecords: 3,
        artifactCounts: {
          commits: 2,
          pull_requests: 1,
          reviews: 0,
          branch_refs: 0,
          release_tags: 0,
          issues: 0,
          issue_transitions: 0,
          sprints: 0,
          sprint_scope_changes: 0,
          messages: 0,
        },
      },
      [
        {
          id: '66666666-6666-4666-8666-666666666666',
          coverage: completeCoverage({
            sourceKey: 'primary-code',
            sourceKind: 'code',
            artifact: 'commits',
            requestedWindow: window,
            observedAt,
            recordCount: 2,
          }),
        },
        {
          id: '77777777-7777-4777-8777-777777777777',
          coverage: unavailableCoverage({
            sourceKey: 'legacy-code',
            sourceKind: 'code',
            artifact: 'commits',
            requestedWindow: window,
            observedAt,
            reason: 'authentication_failed',
            detail: 'legacy-code rejected the stored credential.',
          }),
        },
      ],
    );

    const runsForA = await listRecentIngestRuns(scopeFor(ORG_A));
    const runsForB = await listRecentIngestRuns(scopeFor(ORG_B));

    expect(runsForA).toHaveLength(1);
    expect(runsForA[0]?.status).toBe('unavailable');
    expect(runsForA[0]?.window).toEqual(window);
    expect(runsForB).toHaveLength(0);

    const coverage = await database.client.query<{ source_key: string }>(
      'select source_key, status, reason from ingest_source_coverage order by source_key',
    );
    expect(coverage.rows.map((row) => row.source_key)).toEqual([
      'legacy-code',
      'primary-code',
    ]);
  });

  /**
   * One run, one row, always.
   *
   * `ingestRunRowId` derives the id from `(organization, connector, window,
   * attempt)`, so re-ingesting the same window produces the same id by design. A
   * plain insert made that a duplicate-key error, which meant the container's
   * cold start — which re-ingests whenever there is no report for the day yet —
   * failed on its second boot and served `/` as a stack trace. The journal
   * therefore records the later observation over the same row.
   */
  it('replays an ingest run into the same row, recording the later observation', async () => {
    const window = timeWindow(at('2026-07-29T00:00:00Z'), at('2026-07-30T00:00:00Z'));
    const runId = '55555555-5555-4555-8555-555555555555';
    const coverageId = '77777777-7777-4777-8777-777777777777';
    const laterAt = at('2026-07-30T09:30:00Z');

    const before = await listRecentIngestRuns(scopeFor(ORG_A));
    expect(before).toHaveLength(1);
    expect(before[0]?.totalRecords).toBe(3);

    await insertIngestRun(
      scopeFor(ORG_A),
      {
        id: runId,
        connectorId: 'seed:foundation-v1',
        window,
        startedAt: laterAt,
        completedAt: laterAt,
        // The source came back up between the two runs, and the journal has to say
        // so rather than keep reporting the older, worse status.
        status: 'complete',
        totalRecords: 9,
        artifactCounts: {
          commits: 6,
          pull_requests: 3,
          reviews: 0,
          branch_refs: 0,
          release_tags: 0,
          issues: 0,
          issue_transitions: 0,
          sprints: 0,
          sprint_scope_changes: 0,
          messages: 0,
        },
      },
      [
        {
          id: coverageId,
          coverage: completeCoverage({
            sourceKey: 'legacy-code',
            sourceKind: 'code',
            artifact: 'commits',
            requestedWindow: window,
            observedAt: laterAt,
            recordCount: 4,
          }),
        },
      ],
    );

    const after = await listRecentIngestRuns(scopeFor(ORG_A));
    expect(after, 'a replay must update, not accumulate').toHaveLength(1);
    expect(after[0]?.id).toBe(runId);
    expect(after[0]?.status).toBe('complete');
    expect(after[0]?.totalRecords).toBe(9);
    expect(after[0]?.startedAt).toBe(laterAt);

    // The coverage row is updated in place too, and the other source's row is
    // untouched: a replay that named one source must not erase the other.
    const coverage = await database.client.query<{
      source_key: string;
      status: string;
      record_count: number;
    }>('select source_key, status, record_count from ingest_source_coverage order by source_key');

    expect(coverage.rows).toHaveLength(2);
    expect(coverage.rows[0]?.source_key).toBe('legacy-code');
    expect(coverage.rows[0]?.status).toBe('complete');
    expect(Number(coverage.rows[0]?.record_count)).toBe(4);
    expect(coverage.rows[1]?.source_key).toBe('primary-code');
  });

  /**
   * The same isolation, proved without `ScopedDb` in the picture at all.
   *
   * Everything above this asserts that the *application* adds `organization_id = $1`. This asserts
   * that the database refuses a cross-tenant read on its own, to a caller that never went through
   * `ScopedDb` and could not be made to — a psql session, a BI tool, a managed provider's REST API,
   * a connection string with lesser privileges. Without it, migration 0018's policies are text that
   * nothing ever evaluates: PostgreSQL exempts a table's owner from its own policies, and every other
   * test in this file (and in the app) runs as the owner, so a policy with a broken predicate would
   * pass every one of them.
   *
   * The probe role is therefore not a convenience — it is the only way to execute the policy at all.
   */
  describe('a role that does not own the tables', () => {
    const PROBE_ROLE = 'compass_rls_probe';

    beforeAll(async () => {
      await database.client.exec(
        `create role ${PROBE_ROLE} nologin;
         grant usage on schema public to ${PROBE_ROLE};
         grant select on all tables in schema public to ${PROBE_ROLE};`,
      );
    });

    /**
     * The email addresses `users` yields to the probe role for a given tenant.
     *
     * `SET LOCAL` inside a transaction, exactly as migration 0013's erasure flag and the production
     * code path do it: the role and the tenant both die with the `rollback`, so one case cannot leak
     * its setting into the next.
     */
    const emailsVisibleTo = async (organizationId: string | null): Promise<readonly string[]> => {
      const declareTenant =
        organizationId === null ? '' : `set local compass.organization_id = '${organizationId}';`;

      try {
        const statements = await database.client.exec(
          `begin;
           set local role ${PROBE_ROLE};
           ${declareTenant}
           select email from users order by email;
           rollback;`,
        );
        // Second to last: the `rollback` is last, and the shape holds whether or not a tenant was set.
        const rows = (statements[statements.length - 2]?.rows ?? []) as { email: string }[];
        return rows.map((row) => row.email);
      } finally {
        // A failed statement leaves the transaction open and aborted. This closes it either way, so
        // one broken expectation cannot take the rest of the file with it.
        await database.client.exec('rollback').catch(() => undefined);
      }
    };

    it('sees only the tenant it declares', async () => {
      expect(await emailsVisibleTo(ORG_A)).toEqual(['priya@example.com']);
      expect(await emailsVisibleTo(ORG_B)).toEqual(['marcus@example.com']);
    });

    it('sees nothing at all when it declares no tenant', async () => {
      // The fail-closed half. An unset GUC must not mean "everything" — that is the default a
      // permissive policy would produce, and it would be indistinguishable from working.
      expect(await emailsVisibleTo(null)).toEqual([]);
    });

    it('sees nothing for a tenant that does not exist', async () => {
      expect(await emailsVisibleTo('88888888-8888-4888-8888-888888888888')).toEqual([]);
    });

    it('still reads everything as the owner, which is what keeps the app and the worker working', async () => {
      // Stated rather than assumed. Migration 0018 deliberately does not FORCE row-level security,
      // because the worker's pipeline and the seed tooling query with no request context to take a
      // tenant from. If a future migration forces it, this test fails and names the reason.
      const owner = await database.client.query<{ email: string }>('select email from users order by email');

      expect(owner.rows.map((row) => row.email)).toEqual(['marcus@example.com', 'priya@example.com']);
    });
  });
});

/**
 * Migration 0018's other half, on a database where the roles it names exist.
 *
 * The REVOKE is guarded by `pg_roles`, because `anon` and `authenticated` are Supabase's and exist on
 * no developer machine — so on every database anybody actually migrates during development, that
 * branch is skipped. Which makes it the one branch in the migration that would first execute in
 * production, and `REVOKE`/`ALTER DEFAULT PRIVILEGES` are built as strings and parsed at runtime, so a
 * typo in one is invisible until then. That is worth a second engine.
 *
 * Its own database, and its own migration run: the roles have to exist *before* the migration for the
 * branch to be taken at all, which the shared harness above cannot arrange for itself.
 */
describe('pnpm db:migrate against a managed provider’s roles', () => {
  let provider: TestDatabase;

  beforeAll(async () => {
    provider = await createTestDatabase();
    await provider.client.exec(
      `create role anon nologin;
       create role authenticated nologin;
       grant usage on schema public to anon, authenticated;`,
    );
    await provider.migrate();
  });

  afterAll(async () => {
    await provider.close();
  });

  it('applies, and leaves the API roles no privilege on any table', async () => {
    const grants = await provider.client.query<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('anon', 'authenticated')`,
    );

    expect(grants.rows, 'PostgREST can still address these tables').toEqual([]);
  });

  it('withdraws the default privilege too, so the next table does not arrive granted', async () => {
    // The half that is easy to miss. Revoking on existing tables and leaving the schema default in
    // place means the fix silently expires the next time a migration adds a table.
    await provider.client.exec('create table default_privilege_probe (organization_id uuid not null)');

    const grants = await provider.client.query<{ grantee: string }>(
      `select grantee from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'default_privilege_probe'
          and grantee in ('anon', 'authenticated')`,
    );

    expect(grants.rows).toEqual([]);
  });
});

/**
 * The feedback vocabulary is closed in the database, not only in TypeScript.
 *
 * `@compass/analysis` owns the list and every caller validates against it, but the CHECK constraint
 * is what makes a seventh value unwritable by *any* path — a migration script, a psql session, a
 * future route that forgot to validate. That guarantee has a cost worth testing: adding an action
 * in TypeScript alone produces a route that accepts it, writes it, and fails on INSERT with a
 * constraint violation the manager reads as "Compass is broken". Migration 0020 widened the
 * constraint for `explain_unattributed`; this is what proves the two halves agree.
 */
describe('the feedback action vocabulary is enforced by the database', () => {
  const ORG_CHECK = '44444444-4444-4444-8444-444444444444';

  let rowCounter = 0;

  const insertAction = async (action: string): Promise<void> => {
    rowCounter += 1;
    const rowId = `44444444-0000-4000-8000-${String(rowCounter).padStart(12, '0')}`;
    await database.client.query(
      `insert into feedback_entries
         (id, organization_id, natural_key, first_seen_at, last_seen_at, belief_at, version,
          report_item_stable_id, cause_entity_ref, cause_kind, cause_discriminator,
          action, submitted_at, source_channel)
       values ($1, $2, $3, now(), now(), now(), 1,
               'v1:0000000000000000', 'commit:unattributed:platform:abc', 'unattributed', '',
               $4, now(), 'web')`,
      [rowId, ORG_CHECK, `probe-${rowCounter}`, action],
    );
  };

  beforeAll(async () => {
    await database.seedOrganization({
      organizationId: ORG_CHECK,
      name: 'Constraint Probe',
      slug: 'constraint-probe',
      timezone: 'UTC',
      at: asDate('2026-07-31T09:00:00Z'),
    });
  });

  it('accepts the answer to the unattributed question', async () => {
    // The action migration 0020 added. Before it, this insert failed and the feature was unusable
    // from the first click despite typechecking and passing every unit test.
    await expect(insertAction('explain_unattributed')).resolves.toBeUndefined();
  });

  it('still accepts the six that predate it', async () => {
    for (const action of [
      'dismiss_risk',
      'off_goal_flag_wrong',
      'accept_recommendation',
      'reject_recommendation',
      'blocker_already_resolved',
    ]) {
      await expect(insertAction(action), action).resolves.toBeUndefined();
    }
  });

  it('still refuses a value the pipeline would not understand', async () => {
    // The half the widening must not have loosened. A verdict no branch handles is a row that
    // silently suppresses nothing, which is why this is a constraint and not a convention.
    await expect(insertAction('thumbs_up')).rejects.toThrow(/feedback_entries_action_check/);
  });
});
