import { is } from 'drizzle-orm';
import { PgTable, getTableConfig, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { ORGANIZATION_ID_COLUMN, UnscopedTableError, assertOrgScopedTable, isOrgScopedTable, schema } from '@compass/db';

/**
 * The enumeration reads the exported drizzle schema objects rather than parsing
 * the migration SQL, so a table added to `src/schema/tables.ts` is policed the
 * moment it exists — before anyone generates a migration for it.
 *
 * `schema` is widened to a record of unknowns first: it also exports column
 * helpers and constants, and narrowing a heterogeneous union in place is what
 * makes the predicate unassignable to its own parameter.
 */
const tables: PgTable[] = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable =>
  is(value, PgTable),
);

describe('base schema convention', () => {
  it('defines at least the foundation tables', () => {
    const names = tables.map((table) => getTableConfig(table).name).sort();

    expect(names).toEqual([
      'audit_log_entries',
      'ingest_runs',
      'ingest_source_coverage',
      'memberships',
      'organizations',
      'sessions',
      'source_configs',
      'users',
    ]);
  });

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s carries a non-null organization_id',
    (name, table) => {
      const column = getTableConfig(table).columns.find((candidate) => candidate.name === ORGANIZATION_ID_COLUMN);

      expect(column, `table ${name} has no ${ORGANIZATION_ID_COLUMN} column`).toBeDefined();
      expect(column?.notNull, `${name}.${ORGANIZATION_ID_COLUMN} must be NOT NULL`).toBe(true);
      expect(column?.columnType).toBe('PgUUID');
    },
  );

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s is queryable through the scoped layer',
    (_name, table) => {
      expect(isOrgScopedTable(table)).toBe(true);
    },
  );

  it('holds the tenant root to the same rule via a check constraint', () => {
    const config = getTableConfig(schema.organizations);

    expect(config.checks.map((constraint) => constraint.name)).toContain('organizations_org_id_is_self');
  });

  it('rejects a table that forgot the convention', () => {
    const unscoped = pgTable('reports_without_a_tenant', {
      id: uuid('id').primaryKey(),
      title: text('title').notNull(),
    });

    expect(isOrgScopedTable(unscoped)).toBe(false);
    expect(() => assertOrgScopedTable(unscoped, 'reports_without_a_tenant')).toThrow(UnscopedTableError);
  });

  it('rejects a table whose column is merely named like the convention', () => {
    const misnamed = pgTable('nearly', {
      id: uuid('id').primaryKey(),
      organizationId: uuid('org_id').notNull(),
    });

    expect(isOrgScopedTable(misnamed)).toBe(false);
  });
});
