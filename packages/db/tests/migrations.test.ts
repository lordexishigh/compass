import { instantFromIso, timeWindow } from '@compass/clock';
import { completeCoverage, unavailableCoverage } from '@compass/connector-port';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORGANIZATION_ID_COLUMN,
  ScopedDb,
  insertIngestRun,
  listRecentIngestRuns,
  orgScope,
  organizations,
  users,
} from '@compass/db';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
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
});
