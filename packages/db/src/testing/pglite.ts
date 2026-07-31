import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { MIGRATIONS_FOLDER } from '../migrate.js';
import { ScopedDb } from '../scoped-db.js';
import type { CompassDatabase } from '../scoped-db.js';
import { orgScope } from '../scope.js';
import { organizations } from '../schema/tables.js';

/**
 * A real PostgreSQL 17, in process, for tests in any package.
 *
 * This is a separate entry point (`@compass/db/testing`) rather than part of the
 * package's main export, for the same reason `@compass/connector-port/testkit` is:
 * production code must not be able to reach a test database by importing the
 * package it already depends on. `@electric-sql/pglite` is a devDependency and is
 * never imported from `src/index.ts`, so no deployed bundle contains it.
 *
 * Every layer above the database is tested against the real engine — real
 * migrations, real check constraints, real unique violations, real triggers. A
 * mocked query builder would happily accept an UPDATE on an append-only table,
 * which is exactly the failure these tests exist to catch.
 */
export interface TestDatabase {
  readonly db: CompassDatabase;
  readonly client: PGlite;
  migrate(): Promise<void>;
  /** A ScopedDb for one organization — the only way in, in tests as in production. */
  scopedFor(organizationId: string): ScopedDb;
  /** Inserts the tenant root so foreign keys resolve. */
  seedOrganization(input: SeedOrganizationInput): Promise<void>;
  close(): Promise<void>;
}

export interface SeedOrganizationInput {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  /** Passed in, never read from a clock, so rows are byte-stable across runs. */
  readonly at: Date;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client) as unknown as CompassDatabase;

  const harness: TestDatabase = {
    db,
    client,
    migrate: async () => {
      await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    scopedFor: (organizationId: string) => new ScopedDb(db, orgScope(organizationId)),
    seedOrganization: async (input: SeedOrganizationInput) => {
      await db
        .insert(organizations)
        .values({
          id: input.organizationId,
          organizationId: input.organizationId,
          name: input.name,
          slug: input.slug,
          timezone: input.timezone,
          createdAt: input.at,
          updatedAt: input.at,
        })
        .execute();
    },
    close: async () => {
      await client.close();
    },
  };

  return harness;
}

/**
 * A migrated database with one organization already in it — what most tests want.
 */
export async function createMigratedTestDatabase(
  organization: SeedOrganizationInput,
): Promise<TestDatabase> {
  const database = await createTestDatabase();
  await database.migrate();
  await database.seedOrganization(organization);
  return database;
}

/**
 * Every row of every table in the public schema, ordered deterministically —
 * the "full DB snapshot" the idempotency test compares.
 *
 * `exclude` exists for the ingest journal: `ingest_runs` records that a run
 * happened, so a third run *must* add a row there. Excluding it is what lets the
 * test state the real property — that a replayed window changes no knowledge —
 * instead of a weaker one.
 */
export async function databaseSnapshot(
  client: PGlite,
  options: { readonly exclude?: readonly string[] } = {},
): Promise<Record<string, readonly Record<string, unknown>[]>> {
  const excluded = new Set([...(options.exclude ?? []), '__drizzle_migrations']);

  const tables = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  );

  const snapshot: Record<string, readonly Record<string, unknown>[]> = {};
  for (const { table_name: tableName } of tables.rows) {
    if (excluded.has(tableName)) continue;
    const columns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by column_name`,
      [tableName],
    );
    const orderBy = columns.rows.map((row) => `"${row.column_name}"`).join(', ');
    const rows = await client.query<Record<string, unknown>>(
      `select * from "${tableName}"${orderBy.length > 0 ? ` order by ${orderBy}` : ''}`,
    );
    snapshot[tableName] = rows.rows;
  }
  return snapshot;
}

/** Row counts per table, for tests that only care that nothing grew. */
export async function tableRowCounts(
  client: PGlite,
  tableNames: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tableName of [...tableNames].sort()) {
    const result = await client.query<{ count: string }>(`select count(*)::text as count from "${tableName}"`);
    counts[tableName] = Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }
  return counts;
}
