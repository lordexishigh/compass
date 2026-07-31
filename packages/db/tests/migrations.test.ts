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
});
