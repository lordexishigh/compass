import {
  and,
  eq,
  getTableName,
  sql,
  type InferInsertModel,
  type InferSelectModel,
  type Query,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';

import { isAppendOnlyTableName } from './schema/history.js';
import {
  AppendOnlyTableError,
  CrossOrgWriteError,
  assertOrgScopedTable,
  requireOrgScope,
  type OrgScope,
  type OrgScopedTable,
} from './scope.js';

/** Any drizzle PostgreSQL database handle — node-postgres in production, PGlite in tests. */
export type CompassDatabase = PgDatabase<PgQueryResultHKT>;

/**
 * Insert values minus the organization: the scope supplies it, so a caller
 * cannot pass one at all. (A JavaScript caller still can, which is why
 * `insertInto` also checks at runtime and throws `CrossOrgWriteError`.)
 */
export type ScopedInsert<TTable extends OrgScopedTable> =
  InferInsertModel<TTable> extends infer TModel
    ? { [TKey in keyof TModel as TKey extends 'organizationId' ? never : TKey]: TModel[TKey] }
    : never;

/**
 * A scoped select: awaitable, minimally chainable, and inspectable via
 * `toSQL()` so tests can assert the organization predicate is present.
 */
export interface ScopedSelect<TRow> extends PromiseLike<TRow[]> {
  orderBy(...columns: (SQL | PgColumn)[]): ScopedSelect<TRow>;
  limit(count: number): ScopedSelect<TRow>;
  offset(count: number): ScopedSelect<TRow>;
  toSQL(): Query;
  execute(): Promise<TRow[]>;
}

/**
 * The single data-access chokepoint.
 *
 * Every read and write goes through an instance of this, and every instance
 * holds an organization scope that was validated when it was constructed. The
 * organization predicate is added by this layer, not by the caller, so no route,
 * permalink, export or email link can forget it. `tests/scoped-db.test.ts`
 * inspects the emitted SQL to prove the predicate is always present.
 */
export class ScopedDb {
  readonly #db: CompassDatabase;
  readonly #scope: OrgScope;
  /**
   * True only for the handle `eraseWithin` hands its callback.
   *
   * Not a constructor parameter, and not settable from outside: a caller cannot build an
   * erasing handle, they can only be given one for the duration of one transaction.
   */
  readonly #erasing: boolean;

  constructor(db: CompassDatabase, scope: OrgScope, erasing = false) {
    if (db === null || db === undefined) {
      throw new TypeError('ScopedDb requires a database handle.');
    }
    // Throws at construction rather than returning an unscoped query builder.
    this.#scope = requireOrgScope(scope);
    this.#db = db;
    this.#erasing = erasing;
  }

  /**
   * Runs a block in which the append-only tables may be deleted from.
   *
   * The one sanctioned exception to the append-only guarantee, and it exists for exactly
   * one caller: self-serve erasure. `entity_versions` holds display names,
   * `ticket_status_transitions` holds who moved what, `audit_log_entries` holds who did
   * what — so a deletion that skipped them would leave the personal data in place and
   * mail a confirmation saying otherwise.
   *
   * Three things make this narrow rather than a hole in the guarantee:
   *
   *  - **It is a transaction.** `SET LOCAL` dies with the transaction, so a pooled
   *    connection cannot hand the permission to whatever borrows it next. An erasure that
   *    throws half-way rolls back rather than leaving a half-deleted tenant.
   *  - **The permission is on the handle, not the class.** Only the `ScopedDb` passed to
   *    `run` has it; the outer handle the caller already holds still refuses.
   *  - **Both layers had to be changed together.** The database trigger checks the same
   *    GUC (see migration 0013), so neither guard is the only one, and a future caller
   *    that tried to delete history without this method is refused twice.
   */
  async eraseWithin<T>(run: (erasing: ScopedDb) => Promise<T>): Promise<T> {
    const database = this.#db as CompassDatabase & {
      transaction: <R>(fn: (tx: CompassDatabase) => Promise<R>) => Promise<R>;
    };

    return database.transaction(async (tx) => {
      // `SET LOCAL` rather than `SET`: the permission must not survive the transaction.
      await tx.execute(sql`set local compass.erasure = 'on'`);
      return run(new ScopedDb(tx, this.#scope, true));
    });
  }

  get organizationId(): string {
    return this.#scope.organizationId;
  }

  get scope(): OrgScope {
    return this.#scope;
  }

  /** The organization predicate for a table, for callers composing their own SQL. */
  organizationPredicate(table: OrgScopedTable): SQL {
    assertOrgScopedTable(table, getTableName(table));
    const predicate = eq(table.organizationId, this.#scope.organizationId);
    if (predicate === undefined) {
      throw new TypeError('Failed to build an organization predicate.');
    }
    return predicate;
  }

  /**
   * The application-layer half of the append-only guarantee. The database
   * trigger is the other half; neither is trusted to be the only one.
   */
  #refuseHistoryMutation(table: OrgScopedTable, operation: 'update' | 'delete'): void {
    // An erasing handle may delete history — and only delete it. Editing a past row is
    // still refused even during an erasure: the point of erasure is that the record is
    // gone, never that it says something different.
    if (this.#erasing && operation === 'delete') return;

    const name = getTableName(table);
    if (isAppendOnlyTableName(name)) {
      throw new AppendOnlyTableError(name, operation);
    }
  }

  #where(table: OrgScopedTable, extra?: SQL): SQL {
    const scoped = this.organizationPredicate(table);
    if (!extra) return scoped;
    const combined = and(scoped, extra);
    return combined ?? scoped;
  }

  selectFrom<TTable extends OrgScopedTable>(table: TTable, where?: SQL): ScopedSelect<InferSelectModel<TTable>> {
    assertOrgScopedTable(table, getTableName(table));
    // drizzle's `.from()` overload cannot narrow a generic table, so the table
    // is widened for the call and the row type is restored on the way out. The
    // organization predicate is applied here either way.
    return this.#db
      .select()
      .from(table as PgTable)
      .where(this.#where(table, where)) as unknown as ScopedSelect<InferSelectModel<TTable>>;
  }

  insertInto<TTable extends OrgScopedTable>(table: TTable, values: ScopedInsert<TTable> | ScopedInsert<TTable>[]) {
    assertOrgScopedTable(table, getTableName(table));
    const rows = (Array.isArray(values) ? values : [values]).map((row) => {
      const declared = (row as { organizationId?: string }).organizationId;
      if (declared !== undefined && declared !== this.#scope.organizationId) {
        throw new CrossOrgWriteError(this.#scope.organizationId, declared);
      }
      return { ...row, organizationId: this.#scope.organizationId };
    });
    // The scope has just supplied the one column `ScopedInsert` omitted.
    return this.#db.insert(table).values(rows as InferInsertModel<TTable>[]);
  }

  updateIn<TTable extends OrgScopedTable>(table: TTable, values: PgUpdateSetSource<TTable>, where?: SQL) {
    assertOrgScopedTable(table, getTableName(table));
    this.#refuseHistoryMutation(table, 'update');
    return this.#db.update(table).set(values).where(this.#where(table, where));
  }

  deleteFrom<TTable extends OrgScopedTable>(table: TTable, where?: SQL) {
    assertOrgScopedTable(table, getTableName(table));
    this.#refuseHistoryMutation(table, 'delete');
    // The generic table cannot be proven to have a non-empty selection at this
    // level of abstraction; the runtime guard above is what matters here.
    return this.#db.delete(table as PgTable).where(this.#where(table, where));
  }
}

/**
 * The only way to obtain a ScopedDb. Callers pass the organization id they
 * resolved from the session (or the explicit demo-mode resolver); passing
 * nothing throws here rather than producing a cross-tenant read.
 */
export function createScopedDb(db: CompassDatabase): (scope: OrgScope) => ScopedDb {
  return (scope: OrgScope) => new ScopedDb(db, scope);
}
