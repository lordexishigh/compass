import { getTableColumns, is } from 'drizzle-orm';
import { PgTable, type PgColumn } from 'drizzle-orm/pg-core';

import { ORGANIZATION_ID_COLUMN } from './schema/columns.js';

/**
 * An organization scope. Every query in Compass is built from one of these —
 * there is no other way to reach the database.
 */
export interface OrgScope {
  readonly organizationId: string;
}

export class MissingOrgScopeError extends Error {
  constructor(detail: string) {
    super(`No organization scope: ${detail}. Every query must be built from an OrgScope.`);
    this.name = 'MissingOrgScopeError';
  }
}

export class UnscopedTableError extends Error {
  constructor(tableName: string) {
    super(
      `Table \`${tableName}\` has no \`${ORGANIZATION_ID_COLUMN}\` column, so it cannot be queried through the scoped layer.`,
    );
    this.name = 'UnscopedTableError';
  }
}

export class CrossOrgWriteError extends Error {
  constructor(expected: string, received: string) {
    super(`Refusing to write a row owned by organization ${received} through a scope for ${expected}.`);
    this.name = 'CrossOrgWriteError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds a scope, rejecting anything that would produce a query matching more
 * than one tenant. This throws at call time — an unscoped query never reaches
 * the database to return unscoped rows.
 */
export function orgScope(organizationId: unknown): OrgScope {
  if (typeof organizationId !== 'string' || organizationId.trim().length === 0) {
    throw new MissingOrgScopeError(`received ${organizationId === undefined ? 'undefined' : JSON.stringify(organizationId)}`);
  }
  if (!UUID_PATTERN.test(organizationId)) {
    throw new MissingOrgScopeError(`\`${organizationId}\` is not an organization id`);
  }
  return Object.freeze({ organizationId });
}

/** Validates a scope handed in from outside TypeScript's reach (JSON, JS callers). */
export function requireOrgScope(scope: OrgScope | null | undefined): OrgScope {
  if (scope === null || scope === undefined) {
    throw new MissingOrgScopeError('the scope argument was not supplied');
  }
  return orgScope((scope as { organizationId?: unknown }).organizationId);
}

/** Any table that follows the base schema convention. */
export type OrgScopedTable = PgTable & { readonly organizationId: PgColumn };

export function isOrgScopedTable(table: unknown): table is OrgScopedTable {
  if (!is(table, PgTable)) return false;
  const columns = getTableColumns(table as PgTable);
  const column = columns['organizationId'];
  return column !== undefined && column.name === ORGANIZATION_ID_COLUMN;
}

export function assertOrgScopedTable(table: unknown, tableName: string): asserts table is OrgScopedTable {
  if (!isOrgScopedTable(table)) {
    throw new UnscopedTableError(tableName);
  }
}
