import { and, asc, eq, getTableName, type InferSelectModel, type SQL } from 'drizzle-orm';

import { corrections, entityVersions, sprintScopeChanges, ticketStatusTransitions } from '../schema/history.js';
import type { NamedEntityTable } from '../schema/registry.js';
import type { ScopedDb, ScopedInsert } from '../scoped-db.js';
import type { OrgScopedTable } from '../scope.js';

/**
 * Row-level plumbing for the knowledge model.
 *
 * This is the only file that knows drizzle exists on the write path for entities.
 * `@compass/knowledge-model` sits above it and reasons in terms of observations,
 * versions and beliefs; it never builds a predicate, which is why it needs no
 * database driver in its dependency list.
 *
 * Every function here takes a `ScopedDb`, so the organization predicate is applied
 * by the layer below and cannot be forgotten by a caller.
 */

export type EntityRow<TTable extends NamedEntityTable> = InferSelectModel<TTable>;

/** Values a caller hands in, keyed by drizzle property name. */
export type RowValues = Readonly<Record<string, unknown>>;

const asInsert = <TTable extends OrgScopedTable>(values: RowValues): ScopedInsert<TTable> =>
  // The generic table cannot prove its insert shape at this level of abstraction.
  // The registry is what guarantees the keys line up, and the schema test is what
  // proves the registry does.
  values as unknown as ScopedInsert<TTable>;

export async function findEntityRow<TTable extends NamedEntityTable>(
  scoped: ScopedDb,
  table: TTable,
  naturalKey: string,
): Promise<EntityRow<TTable> | null> {
  const rows = await scoped.selectFrom(table, eq(table.naturalKey, naturalKey)).limit(1);
  return (rows[0] as EntityRow<TTable> | undefined) ?? null;
}

/**
 * Every row of one entity family, ordered by natural key.
 *
 * The ORDER BY is not decoration: without it PostgreSQL is free to return rows in
 * any order it likes, and the snapshot builder above would produce a different
 * byte sequence on a different day. Ordering is asserted at the snapshot boundary
 * too, but it starts here.
 */
export async function listEntityRows<TTable extends NamedEntityTable>(
  scoped: ScopedDb,
  table: TTable,
  where?: SQL,
): Promise<readonly EntityRow<TTable>[]> {
  const rows = await scoped.selectFrom(table, where).orderBy(asc(table.naturalKey));
  return rows as readonly EntityRow<TTable>[];
}

export async function insertEntityRow<TTable extends NamedEntityTable>(
  scoped: ScopedDb,
  table: TTable,
  values: RowValues,
): Promise<void> {
  await scoped.insertInto(table, asInsert<TTable>(values)).execute();
}

/**
 * Rewrites the entity row's own columns. Entity rows are the *current* belief and
 * are meant to move; the append-only rule applies to history tables, which this
 * function cannot reach — `ScopedDb.updateIn` throws for those.
 */
export async function patchEntityRow<TTable extends NamedEntityTable>(
  scoped: ScopedDb,
  table: TTable,
  naturalKey: string,
  values: RowValues,
): Promise<void> {
  await scoped
    .updateIn(table, values as never, eq(table.naturalKey, naturalKey))
    .execute();
}

export async function countEntityRows(scoped: ScopedDb, table: NamedEntityTable): Promise<number> {
  const rows = await scoped.selectFrom(table);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Append-only writes. All of them are insert-if-absent.
// ---------------------------------------------------------------------------

export interface EntityVersionInput {
  readonly id: string;
  readonly entityKind: string;
  readonly entityNaturalKey: string;
  readonly entityId: string;
  readonly version: number;
  readonly trackedFields: Record<string, unknown>;
  readonly changedFields: readonly string[];
  readonly observedAt: Date;
  readonly evidenceSourceKey: string | null;
  readonly evidenceSourceRecordId: string | null;
}

/**
 * Appends one version row, or does nothing if that exact version already exists.
 *
 * `onConflictDoNothing` is what makes a replayed window a no-op without any read
 * happening first: the uniqueness constraint on (organization, kind, key, version)
 * decides, inside the database, whether this is new information.
 */
export async function appendEntityVersion(scoped: ScopedDb, input: EntityVersionInput): Promise<void> {
  await scoped
    .insertInto(entityVersions, {
      id: input.id,
      entityKind: input.entityKind,
      entityNaturalKey: input.entityNaturalKey,
      entityId: input.entityId,
      version: input.version,
      trackedFields: input.trackedFields,
      changedFields: input.changedFields,
      observedAt: input.observedAt,
      evidenceSourceKey: input.evidenceSourceKey,
      evidenceSourceRecordId: input.evidenceSourceRecordId,
    })
    .onConflictDoNothing()
    .execute();
}

export async function listEntityVersions(
  scoped: ScopedDb,
  filter: { readonly entityKind?: string; readonly entityNaturalKey?: string } = {},
): Promise<readonly InferSelectModel<typeof entityVersions>[]> {
  const predicates = [
    filter.entityKind === undefined ? undefined : eq(entityVersions.entityKind, filter.entityKind),
    filter.entityNaturalKey === undefined
      ? undefined
      : eq(entityVersions.entityNaturalKey, filter.entityNaturalKey),
  ].filter((predicate): predicate is SQL => predicate !== undefined);

  return scoped
    .selectFrom(entityVersions, predicates.length === 0 ? undefined : (and(...predicates) as SQL))
    .orderBy(asc(entityVersions.entityKind), asc(entityVersions.entityNaturalKey), asc(entityVersions.version));
}

export interface TicketStatusTransitionInput {
  readonly id: string;
  readonly ticketKey: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly fromStatusCategory: string | null;
  readonly toStatusCategory: string;
  readonly actorDeveloperKey: string | null;
  readonly transitionedAt: Date;
}

export async function appendTicketStatusTransition(
  scoped: ScopedDb,
  input: TicketStatusTransitionInput,
): Promise<void> {
  await scoped.insertInto(ticketStatusTransitions, { ...input }).onConflictDoNothing().execute();
}

export async function listTicketStatusTransitions(
  scoped: ScopedDb,
): Promise<readonly InferSelectModel<typeof ticketStatusTransitions>[]> {
  return scoped
    .selectFrom(ticketStatusTransitions)
    .orderBy(
      asc(ticketStatusTransitions.ticketKey),
      asc(ticketStatusTransitions.transitionedAt),
      asc(ticketStatusTransitions.sourceRecordId),
    );
}

export interface SprintScopeChangeInput {
  readonly id: string;
  readonly sprintKey: string;
  readonly ticketKey: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly change: string;
  readonly actorDeveloperKey: string | null;
  readonly changedAt: Date;
}

export async function appendSprintScopeChange(scoped: ScopedDb, input: SprintScopeChangeInput): Promise<void> {
  await scoped.insertInto(sprintScopeChanges, { ...input }).onConflictDoNothing().execute();
}

export async function listSprintScopeChanges(
  scoped: ScopedDb,
): Promise<readonly InferSelectModel<typeof sprintScopeChanges>[]> {
  return scoped
    .selectFrom(sprintScopeChanges)
    .orderBy(
      asc(sprintScopeChanges.sprintKey),
      asc(sprintScopeChanges.changedAt),
      asc(sprintScopeChanges.sourceRecordId),
    );
}

export interface CorrectionInput {
  readonly id: string;
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly priorVersion: number;
  readonly priorBelief: string;
  readonly newBelief: string;
  readonly contradiction: string;
  readonly evidenceKind: string;
  readonly evidenceLabel: string;
  readonly evidenceSourceKey: string;
  readonly evidenceSourceRecordId: string;
  readonly observedAt: Date;
  readonly detectedAt: Date;
}

/**
 * Writes a Correction, once. The natural uniqueness constraint means the same
 * contradiction re-observed by an overlapping window produces no second row, so
 * "exactly one Correction" is a property of the schema rather than of a caller
 * remembering to check.
 */
export async function insertCorrection(scoped: ScopedDb, input: CorrectionInput): Promise<void> {
  await scoped
    .insertInto(corrections, { ...input, occurrenceCount: 1 })
    .onConflictDoNothing()
    .execute();
}

export async function listCorrections(
  scoped: ScopedDb,
): Promise<readonly InferSelectModel<typeof corrections>[]> {
  return scoped
    .selectFrom(corrections)
    .orderBy(asc(corrections.detectedAt), asc(corrections.subjectKind), asc(corrections.subjectKey));
}

/** The table name behind a drizzle table, for error messages and snapshots. */
export const tableNameOf = (table: OrgScopedTable): string => getTableName(table);
