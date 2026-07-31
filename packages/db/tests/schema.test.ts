import { getTableConfig, PgTable, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  APPEND_ONLY_TABLE_NAMES,
  ENTITY_KINDS,
  NAMED_ENTITIES,
  NAMED_ENTITY_REQUIRED_COLUMNS,
  ORGANIZATION_ID_COLUMN,
  UnknownEntityKindError,
  UnscopedTableError,
  assertOrgScopedTable,
  entityTableName,
  isAppendOnlyTableName,
  isEntityKind,
  isNamedEntityTable,
  isOrgScopedTable,
  namedEntity,
  schema,
} from '@compass/db';

/**
 * The enumeration reads the exported drizzle schema objects rather than parsing
 * the migration SQL, so a table added to `src/schema/*.ts` is policed the moment
 * it exists — before anyone generates a migration for it.
 *
 * `schema` is widened to a record of unknowns first: it also exports column
 * helpers and constants, and narrowing a heterogeneous union in place is what
 * makes the predicate unassignable to its own parameter.
 */
const tables: PgTable[] = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable =>
  is(value, PgTable),
);

const tableNames = tables.map((table) => getTableConfig(table).name).sort();

const columnNames = (table: PgTable): readonly string[] =>
  getTableConfig(table).columns.map((column) => column.name);

describe('base schema convention', () => {
  it('defines every foundation and knowledge-model table', () => {
    expect(tableNames).toEqual([
      'absences',
      'audit_log_entries',
      'auth_tokens',
      'blockers',
      'branch_refs',
      'commits',
      'companies',
      'corrections',
      'developers',
      'entity_versions',
      'features',
      'feedback_entries',
      'identity_links',
      'ingest_runs',
      'ingest_source_coverage',
      'manager_memos',
      'membership_team_scopes',
      'memberships',
      'narration_traces',
      'objective_links',
      'objective_scope_links',
      'objective_versions',
      'objectives',
      'organizations',
      'projects',
      'pull_requests',
      'recommendations',
      'release_tags',
      'report_item_evidence',
      'report_items',
      'report_sections',
      'reports',
      'repositories',
      'reviews',
      'risks',
      'sessions',
      'source_configs',
      'sprint_scope_changes',
      'sprints',
      'teams',
      'ticket_status_transitions',
      'tickets',
      'unmatched_identities',
      'users',
      'wins',
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

/**
 * The acceptance criterion for the versioned knowledge model, stated as a test:
 * every entity the report speaks about is a first-class row with the four
 * convention columns and an append-only history companion.
 */
describe('the named-entity registry', () => {
  /** The entities the knowledge-model task names explicitly. */
  const REQUIRED_ENTITIES = [
    'company',
    'objective',
    'project',
    'team',
    'developer',
    'identity_link',
    'feature',
    'ticket',
    'sprint',
    'blocker',
    'risk',
    'recommendation',
  ] as const;

  it.each(REQUIRED_ENTITIES)('declares %s as a named entity', (kind) => {
    expect(isEntityKind(kind), `${kind} is not in ENTITY_KINDS`).toBe(true);
    expect(() => namedEntity(kind)).not.toThrow();
  });

  it('has one registry entry per declared kind, and no orphans either way', () => {
    expect(NAMED_ENTITIES.map((definition) => definition.kind).sort()).toEqual([...ENTITY_KINDS].sort());
  });

  it.each(NAMED_ENTITIES.map((definition) => [definition.kind, definition] as const))(
    '%s carries organization_id, natural_key, first_seen_at and last_seen_at',
    (kind, definition) => {
      const present = columnNames(definition.table as PgTable);

      for (const required of NAMED_ENTITY_REQUIRED_COLUMNS) {
        expect(present, `${entityTableName(kind)} has no ${required} column`).toContain(required);
      }
      expect(present, `${entityTableName(kind)} has no belief_at column`).toContain('belief_at');
      expect(present, `${entityTableName(kind)} has no version column`).toContain('version');
      expect(isNamedEntityTable(definition.table)).toBe(true);
    },
  );

  it.each(NAMED_ENTITIES.map((definition) => [definition.kind, definition] as const))(
    '%s is keyed uniquely by (organization_id, natural_key)',
    (kind, definition) => {
      const config = getTableConfig(definition.table as PgTable);
      const constraint = config.uniqueConstraints.find(
        (candidate) => candidate.name === `${entityTableName(kind)}_org_natural_key`,
      );

      expect(constraint, `${entityTableName(kind)} has no natural-key uniqueness constraint`).toBeDefined();
      expect(constraint?.columns.map((column) => column.name)).toEqual([ORGANIZATION_ID_COLUMN, 'natural_key']);
    },
  );

  it.each(NAMED_ENTITIES.map((definition) => [definition.kind, definition] as const))(
    '%s has at least one append-only history table, and every one of them really is',
    (kind, definition) => {
      expect(definition.historyTables.length, `${entityTableName(kind)} has no history table`).toBeGreaterThan(0);

      for (const historyTable of definition.historyTables) {
        expect(tableNames, `${historyTable} is not a table in the schema`).toContain(historyTable);
        expect(
          isAppendOnlyTableName(historyTable),
          `${historyTable} is registered as history but is not append-only`,
        ).toBe(true);
      }
    },
  );

  it.each(NAMED_ENTITIES.map((definition) => [definition.kind, definition] as const))(
    '%s tracks only fields its table actually has',
    (kind, definition) => {
      const properties = Object.keys(definition.table as unknown as Record<string, unknown>);

      for (const field of definition.trackedFields) {
        expect(properties, `${entityTableName(kind)} has no \`${field}\` column`).toContain(field);
      }
      for (const field of definition.instantFields) {
        expect(definition.trackedFields, `${field} is an instant field but not a tracked one`).toContain(field);
      }
    },
  );

  it('never tracks a convention column, so a sighting is not mistaken for a change', () => {
    for (const definition of NAMED_ENTITIES) {
      for (const reserved of ['naturalKey', 'firstSeenAt', 'lastSeenAt', 'beliefAt', 'version', 'id', 'organizationId']) {
        expect(definition.trackedFields, `${definition.kind} tracks the reserved column ${reserved}`).not.toContain(
          reserved,
        );
      }
    }
  });

  it('names the kind rather than shrugging when asked for one it does not have', () => {
    expect(() => namedEntity('sprint_burndown' as never)).toThrow(UnknownEntityKindError);
    expect(isEntityKind('sprint_burndown')).toBe(false);
    expect(isEntityKind(42)).toBe(false);
  });
});

describe('the append-only register', () => {
  it('lists the history tables and nothing that is meant to move', () => {
    expect([...APPEND_ONLY_TABLE_NAMES]).toEqual([
      'audit_log_entries',
      'corrections',
      'entity_versions',
      'objective_links',
      'objective_scope_links',
      'objective_versions',
      'sprint_scope_changes',
      'ticket_status_transitions',
    ]);
  });

  /**
   * The goal store earns its place on that list rather than inheriting it.
   *
   * An objective is *edited* through this table, which is exactly the case where
   * somebody reaches for an UPDATE. It is append-only because a persisted report
   * cites a revision by number and rewriting one would change what yesterday's
   * alignment verdict resolved against — so the guard is asserted here as well as
   * exercised against a real engine in `migrations.test.ts`.
   */
  it('holds the goal store to the append-only rule, since an edit is where an UPDATE is tempting', () => {
    for (const table of ['objective_versions', 'objective_scope_links', 'objective_links']) {
      expect(isAppendOnlyTableName(table), `${table} must refuse an UPDATE`).toBe(true);
      expect(tableNames, `${table} is not a table in the schema`).toContain(table);
    }
  });

  it('does not claim an entity table is append-only — current beliefs are meant to move', () => {
    for (const definition of NAMED_ENTITIES) {
      expect(isAppendOnlyTableName(entityTableName(definition.kind))).toBe(false);
    }
  });

  it('leaves the ingest journal mutable, since a run is opened and then closed', () => {
    expect(isAppendOnlyTableName('ingest_runs')).toBe(false);
  });
});
