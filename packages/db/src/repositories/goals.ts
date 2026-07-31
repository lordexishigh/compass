import type { Instant } from '@compass/clock';
import { and, asc, eq } from 'drizzle-orm';

import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { objectiveLinks, objectiveScopeLinks, objectiveVersions } from '../schema/goals.js';
import { deterministicUuid } from '../entity-id.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * The goal store, read and appended.
 *
 * This layer is deliberately dumb about time. It reads *every* revision and hands
 * them all upward; it never selects "the current one", because the rule that
 * decides which revision is in force at an instant belongs in the pure layer where
 * it can be unit-tested and where exactly one implementation exists
 * (`goalHierarchyAt` in `packages/analysis/src/goal-hierarchy.ts`). A `WHERE
 * recorded_at <= $1 ORDER BY ... LIMIT 1` here would be a second implementation of
 * the freeze rule, in SQL, that no test could reach — and the two would disagree
 * the first time either changed.
 *
 * Writes are appends and nothing else. `objective_versions` is in
 * `APPEND_ONLY_TABLE_NAMES`, so `ScopedDb` refuses an UPDATE or a DELETE on it and
 * the database trigger refuses one underneath that; the repository could not
 * mutate a prior revision even if a caller asked it to.
 */

/** `declared` — a manager wrote it. `observed` — synced from a sprint's own goal. */
export type GoalNodeOrigin = 'declared' | 'observed';

export interface GoalNodeRevisionRow {
  readonly nodeId: string;
  readonly revision: number;
  readonly objectiveKind: string;
  readonly parentNodeId: string | null;
  readonly title: string;
  readonly effectiveFrom: Instant;
  readonly effectiveUntil: Instant | null;
  readonly isCurrent: boolean;
  readonly archived: boolean;
  readonly origin: GoalNodeOrigin;
  readonly subjectKind: string | null;
  readonly subjectKey: string | null;
  readonly recordedAt: Instant;
  readonly recordedBy: string | null;
  readonly changeNote: string | null;
}

export interface GoalScopeLinkRow {
  readonly linkKey: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly effectiveFrom: Instant;
  readonly effectiveUntil: Instant | null;
  readonly detached: boolean;
  readonly recordedAt: Instant;
  readonly recordedBy: string | null;
}

/** Everything the effective-dating rule needs, in one read. */
export interface GoalStoreContents {
  readonly nodes: readonly GoalNodeRevisionRow[];
  readonly links: readonly GoalScopeLinkRow[];
}

/** The id of one goal revision, derived so a replayed sync lands on the same row. */
export const goalRevisionRowId = (organizationId: string, nodeId: string, revision: number): string =>
  deterministicUuid(`objective-version:${organizationId}:${nodeId}:${revision}`);

export const goalScopeLinkRowId = (organizationId: string, linkKey: string, revision: number): string =>
  deterministicUuid(`objective-scope-link:${organizationId}:${linkKey}:${revision}`);

export const objectiveLinkRowId = (
  organizationId: string,
  reportInstantMillis: number,
  subjectKind: string,
  subjectKey: string,
): string =>
  deterministicUuid(`objective-link:${organizationId}:${reportInstantMillis}:${subjectKind}:${subjectKey}`);

/** `<node>|<subject kind>|<subject key>` — stable across a detach and a reattach. */
export const scopeLinkKey = (nodeId: string, subjectKind: string, subjectKey: string): string =>
  `${nodeId}|${subjectKind}|${subjectKey}`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every revision of every node and link, in a documented order.
 *
 * Ordered by `(node, revision)` rather than by `recorded_at`: revision numbers are
 * a total order this layer controls, and PostgreSQL has never promised to return
 * rows in insertion order.
 */
export async function loadGoalStore(scoped: ScopedDb): Promise<GoalStoreContents> {
  const nodeRows = await scoped
    .selectFrom(objectiveVersions)
    .orderBy(asc(objectiveVersions.nodeId), asc(objectiveVersions.revision));
  const linkRows = await scoped
    .selectFrom(objectiveScopeLinks)
    .orderBy(asc(objectiveScopeLinks.linkKey), asc(objectiveScopeLinks.revision));

  return {
    nodes: nodeRows.map(toNodeRow),
    links: linkRows.map(toLinkRow),
  };
}

/** Every revision of one node, oldest first — the history a read endpoint shows. */
export async function loadGoalNodeHistory(
  scoped: ScopedDb,
  nodeId: string,
): Promise<readonly GoalNodeRevisionRow[]> {
  const rows = await scoped
    .selectFrom(objectiveVersions, eq(objectiveVersions.nodeId, nodeId))
    .orderBy(asc(objectiveVersions.revision));
  return rows.map(toNodeRow);
}

const toNodeRow = (row: typeof objectiveVersions.$inferSelect): GoalNodeRevisionRow => ({
  nodeId: row.nodeId,
  revision: row.revision,
  objectiveKind: row.objectiveKind,
  parentNodeId: row.parentNodeId,
  title: row.title,
  effectiveFrom: fromDatabaseInstant(row.effectiveFrom),
  effectiveUntil: fromNullableDatabaseInstant(row.effectiveUntil),
  isCurrent: row.isCurrent,
  archived: row.archived,
  origin: row.origin === 'declared' ? 'declared' : 'observed',
  subjectKind: row.subjectKind,
  subjectKey: row.subjectKey,
  recordedAt: fromDatabaseInstant(row.recordedAt),
  recordedBy: row.recordedBy,
  changeNote: row.changeNote,
});

const toLinkRow = (row: typeof objectiveScopeLinks.$inferSelect): GoalScopeLinkRow => ({
  linkKey: row.linkKey,
  revision: row.revision,
  nodeId: row.nodeId,
  subjectKind: row.subjectKind,
  subjectKey: row.subjectKey,
  effectiveFrom: fromDatabaseInstant(row.effectiveFrom),
  effectiveUntil: fromNullableDatabaseInstant(row.effectiveUntil),
  detached: row.detached,
  recordedAt: fromDatabaseInstant(row.recordedAt),
  recordedBy: row.recordedBy,
});

// ---------------------------------------------------------------------------
// Appending
// ---------------------------------------------------------------------------

/** The content of a goal node, without the bookkeeping the store adds. */
export interface GoalNodeInput {
  readonly nodeId: string;
  readonly objectiveKind: string;
  readonly parentNodeId: string | null;
  readonly title: string;
  readonly effectiveFrom: Instant;
  readonly effectiveUntil: Instant | null;
  readonly isCurrent: boolean;
  readonly archived?: boolean;
  readonly origin: GoalNodeOrigin;
  readonly subjectKind?: string | null;
  readonly subjectKey?: string | null;
  readonly recordedBy?: string | null;
  readonly changeNote?: string | null;
}

export class GoalNodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`No goal node \`${nodeId}\` exists in this organization, so there is no revision to append to.`);
    this.name = 'GoalNodeNotFoundError';
  }
}

export class GoalNodeExistsError extends Error {
  constructor(nodeId: string) {
    super(
      `Goal node \`${nodeId}\` already exists. Edit it — which appends a revision — rather than creating it twice; ` +
        'a node id is the identity a persisted report cites.',
    );
    this.name = 'GoalNodeExistsError';
  }
}

export interface GoalWriteResult {
  readonly nodeId: string;
  readonly revision: number;
  /** False when the append was skipped because nothing had changed. */
  readonly appended: boolean;
  readonly row: GoalNodeRevisionRow;
}

/**
 * Appends the next revision of a node.
 *
 * `expectExisting` is how create and update are told apart, and it is checked
 * rather than assumed: creating a node that already exists would give it a second
 * revision-1 row and break the unique constraint, and updating one that does not
 * exist would silently invent it. Both are refused by name.
 *
 * When the content is byte-for-byte what the open revision already says, nothing
 * is appended and `appended` is false. That is what makes the sync on every boot
 * idempotent: a roster re-applied unchanged produces no new revisions, so the
 * store does not grow a row per container restart and the effective-dating history
 * stays readable.
 */
export async function appendGoalRevision(
  scoped: ScopedDb,
  input: GoalNodeInput,
  recordedAt: Instant,
  expectExisting: boolean | null = null,
): Promise<GoalWriteResult> {
  const history = await loadGoalNodeHistory(scoped, input.nodeId);
  const open = history.at(-1) ?? null;

  if (expectExisting === true && open === null) throw new GoalNodeNotFoundError(input.nodeId);
  if (expectExisting === false && open !== null) throw new GoalNodeExistsError(input.nodeId);

  const candidate: GoalNodeRevisionRow = {
    nodeId: input.nodeId,
    revision: (open?.revision ?? 0) + 1,
    objectiveKind: input.objectiveKind,
    parentNodeId: input.parentNodeId,
    title: input.title,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil,
    isCurrent: input.isCurrent,
    archived: input.archived ?? false,
    origin: input.origin,
    subjectKind: input.subjectKind ?? null,
    subjectKey: input.subjectKey ?? null,
    recordedAt,
    recordedBy: input.recordedBy ?? null,
    changeNote: input.changeNote ?? null,
  };

  if (open !== null && sameContent(open, candidate)) {
    return { nodeId: input.nodeId, revision: open.revision, appended: false, row: open };
  }

  await scoped
    .insertInto(objectiveVersions, {
      id: goalRevisionRowId(scoped.organizationId, candidate.nodeId, candidate.revision),
      nodeId: candidate.nodeId,
      revision: candidate.revision,
      objectiveKind: candidate.objectiveKind,
      parentNodeId: candidate.parentNodeId,
      title: candidate.title,
      effectiveFrom: toDatabaseInstant(candidate.effectiveFrom),
      effectiveUntil: candidate.effectiveUntil === null ? null : toDatabaseInstant(candidate.effectiveUntil),
      isCurrent: candidate.isCurrent,
      archived: candidate.archived,
      origin: candidate.origin,
      subjectKind: candidate.subjectKind,
      subjectKey: candidate.subjectKey,
      recordedAt: toDatabaseInstant(candidate.recordedAt),
      recordedBy: candidate.recordedBy,
      changeNote: candidate.changeNote,
    })
    .onConflictDoNothing();

  return { nodeId: candidate.nodeId, revision: candidate.revision, appended: true, row: candidate };
}

/**
 * Whether two revisions say the same thing.
 *
 * `recordedAt`, `recordedBy`, `changeNote` and `revision` are excluded: they
 * describe the act of recording rather than the goal, and including them would
 * make every sync append a row whose only difference was its own timestamp.
 */
function sameContent(left: GoalNodeRevisionRow, right: GoalNodeRevisionRow): boolean {
  return (
    left.objectiveKind === right.objectiveKind &&
    left.parentNodeId === right.parentNodeId &&
    left.title === right.title &&
    left.effectiveFrom === right.effectiveFrom &&
    left.effectiveUntil === right.effectiveUntil &&
    left.isCurrent === right.isCurrent &&
    left.archived === right.archived &&
    left.origin === right.origin &&
    left.subjectKind === right.subjectKind &&
    left.subjectKey === right.subjectKey
  );
}

/**
 * Archives a node by appending a revision, never by deleting one.
 *
 * The archived revision keeps the title and the horizon, so a report generated for
 * a past instant still resolves the chain and prints the wording that was in force
 * then. Archiving is a statement about the future, not an erasure of the past.
 */
export async function archiveGoalNode(
  scoped: ScopedDb,
  nodeId: string,
  recordedAt: Instant,
  options: { readonly recordedBy?: string | null; readonly changeNote?: string | null } = {},
): Promise<GoalWriteResult> {
  const history = await loadGoalNodeHistory(scoped, nodeId);
  const open = history.at(-1);
  if (open === undefined) throw new GoalNodeNotFoundError(nodeId);

  return appendGoalRevision(
    scoped,
    {
      nodeId: open.nodeId,
      objectiveKind: open.objectiveKind,
      parentNodeId: open.parentNodeId,
      title: open.title,
      effectiveFrom: open.effectiveFrom,
      effectiveUntil: open.effectiveUntil,
      // An archived goal is not the current plan by definition, whatever the prior
      // revision said. Leaving `is_current` true on an archived node would let an
      // abandoned objective keep pulling work onto itself.
      isCurrent: false,
      archived: true,
      origin: open.origin,
      subjectKind: open.subjectKind,
      subjectKey: open.subjectKey,
      recordedBy: options.recordedBy ?? null,
      changeNote: options.changeNote ?? 'Archived.',
    },
    recordedAt,
    true,
  );
}

export interface GoalScopeLinkInput {
  readonly nodeId: string;
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly effectiveFrom: Instant;
  readonly effectiveUntil?: Instant | null;
  readonly detached?: boolean;
  readonly recordedBy?: string | null;
}

/** Attaches (or, with `detached`, detaches) a work item from a goal node. */
export async function appendGoalScopeLink(
  scoped: ScopedDb,
  input: GoalScopeLinkInput,
  recordedAt: Instant,
): Promise<{ readonly linkKey: string; readonly revision: number }> {
  const linkKey = scopeLinkKey(input.nodeId, input.subjectKind, input.subjectKey);
  const existing = await scoped
    .selectFrom(objectiveScopeLinks, eq(objectiveScopeLinks.linkKey, linkKey))
    .orderBy(asc(objectiveScopeLinks.revision));
  const revision = (existing.at(-1)?.revision ?? 0) + 1;

  await scoped
    .insertInto(objectiveScopeLinks, {
      id: goalScopeLinkRowId(scoped.organizationId, linkKey, revision),
      linkKey,
      revision,
      nodeId: input.nodeId,
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      effectiveFrom: toDatabaseInstant(input.effectiveFrom),
      effectiveUntil: input.effectiveUntil == null ? null : toDatabaseInstant(input.effectiveUntil),
      detached: input.detached ?? false,
      recordedAt: toDatabaseInstant(recordedAt),
      recordedBy: input.recordedBy ?? null,
    })
    .onConflictDoNothing();

  return { linkKey, revision };
}

/**
 * Syncs a set of nodes into the store, appending only what has changed.
 *
 * Called on every boot with the declared roster's objectives, and after every
 * ingest with the observed sprint goals, so a deployment that has never opened the
 * goals screen still has a complete hierarchy to align against.
 *
 * An `observed` sync never supersedes a `declared` revision. A manager who
 * rewrote a sprint goal in Compass has said something the tracker does not know,
 * and the next ingest must not quietly undo it.
 */
export async function syncGoalNodes(
  scoped: ScopedDb,
  nodes: readonly GoalNodeInput[],
  recordedAt: Instant,
): Promise<{ readonly appended: number; readonly unchanged: number; readonly skipped: number }> {
  let appended = 0;
  let unchanged = 0;
  let skipped = 0;

  // Sorted so a sync writes in the same order every time and the revision numbers
  // of a fresh database are reproducible.
  for (const node of [...nodes].sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0))) {
    const history = await loadGoalNodeHistory(scoped, node.nodeId);
    const open = history.at(-1);

    if (node.origin === 'observed' && open !== undefined && open.origin === 'declared') {
      skipped += 1;
      continue;
    }

    const result = await appendGoalRevision(scoped, node, recordedAt);
    if (result.appended) appended += 1;
    else unchanged += 1;
  }

  return { appended, unchanged, skipped };
}

// ---------------------------------------------------------------------------
// The resolution output
// ---------------------------------------------------------------------------

export interface ObjectiveLinkInput {
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly subjectLabel: string;
  readonly source: string;
  readonly nodeId: string | null;
  readonly nodeRevision: number | null;
  readonly chainNodeIds: readonly string[];
  readonly matchedSubstring: string | null;
  readonly matchedOffset: number | null;
  readonly matchedIn: string | null;
  readonly score: number | null;
  readonly threshold: number | null;
  readonly comparedTextA: string | null;
  readonly comparedTextB: string | null;
  readonly servesCurrentObjective: boolean | null;
}

/**
 * Writes the ObjectiveLinks one report's resolution produced.
 *
 * Ids are derived from `(organization, report instant, subject)`, so regenerating a
 * report for an instant it has already covered lands on the same rows. The insert
 * is `onConflictDoNothing` rather than an upsert because the table is append-only
 * and because the content is a pure function of the instant and the hierarchy in
 * force at it — a replay computes the same answer, so there is nothing to update.
 */
export async function recordObjectiveLinks(
  scoped: ScopedDb,
  reportInstant: Instant,
  links: readonly ObjectiveLinkInput[],
  recordedAt: Instant,
): Promise<number> {
  if (links.length === 0) return 0;

  const rows = links.map((link) => ({
    id: objectiveLinkRowId(scoped.organizationId, reportInstant, link.subjectKind, link.subjectKey),
    reportInstant: toDatabaseInstant(reportInstant),
    subjectKind: link.subjectKind,
    subjectKey: link.subjectKey,
    subjectLabel: link.subjectLabel,
    source: link.source,
    nodeId: link.nodeId,
    nodeRevision: link.nodeRevision,
    chainNodeIds: link.chainNodeIds,
    matchedSubstring: link.matchedSubstring,
    matchedOffset: link.matchedOffset,
    matchedIn: link.matchedIn,
    score: link.score,
    threshold: link.threshold,
    comparedTextA: link.comparedTextA,
    comparedTextB: link.comparedTextB,
    servesCurrentObjective: link.servesCurrentObjective,
    recordedAt: toDatabaseInstant(recordedAt),
  }));

  await scoped.insertInto(objectiveLinks, rows).onConflictDoNothing();
  return rows.length;
}

export interface StoredObjectiveLink extends ObjectiveLinkInput {
  readonly reportInstant: Instant;
  readonly recordedAt: Instant;
}

/** Every link resolved for one instant, subject order — what an audit reads. */
export async function listObjectiveLinks(
  scoped: ScopedDb,
  reportInstant: Instant,
): Promise<readonly StoredObjectiveLink[]> {
  const rows = await scoped
    .selectFrom(objectiveLinks, eq(objectiveLinks.reportInstant, toDatabaseInstant(reportInstant)))
    .orderBy(asc(objectiveLinks.subjectKind), asc(objectiveLinks.subjectKey));

  return rows.map((row) => ({
    reportInstant: fromDatabaseInstant(row.reportInstant),
    subjectKind: row.subjectKind,
    subjectKey: row.subjectKey,
    subjectLabel: row.subjectLabel,
    source: row.source,
    nodeId: row.nodeId,
    nodeRevision: row.nodeRevision,
    chainNodeIds: row.chainNodeIds,
    matchedSubstring: row.matchedSubstring,
    matchedOffset: row.matchedOffset,
    matchedIn: row.matchedIn,
    score: row.score,
    threshold: row.threshold,
    comparedTextA: row.comparedTextA,
    comparedTextB: row.comparedTextB,
    servesCurrentObjective: row.servesCurrentObjective,
    recordedAt: fromDatabaseInstant(row.recordedAt),
  }));
}

/** Every link that ever named one subject, newest instant first. */
export async function findObjectiveLinksForSubject(
  scoped: ScopedDb,
  subjectKind: string,
  subjectKey: string,
): Promise<readonly StoredObjectiveLink[]> {
  const rows = await scoped
    .selectFrom(
      objectiveLinks,
      and(eq(objectiveLinks.subjectKind, subjectKind), eq(objectiveLinks.subjectKey, subjectKey)),
    )
    .orderBy(asc(objectiveLinks.reportInstant));

  return rows
    .map((row) => ({
      reportInstant: fromDatabaseInstant(row.reportInstant),
      subjectKind: row.subjectKind,
      subjectKey: row.subjectKey,
      subjectLabel: row.subjectLabel,
      source: row.source,
      nodeId: row.nodeId,
      nodeRevision: row.nodeRevision,
      chainNodeIds: row.chainNodeIds,
      matchedSubstring: row.matchedSubstring,
      matchedOffset: row.matchedOffset,
      matchedIn: row.matchedIn,
      score: row.score,
      threshold: row.threshold,
      comparedTextA: row.comparedTextA,
      comparedTextB: row.comparedTextB,
      servesCurrentObjective: row.servesCurrentObjective,
      recordedAt: fromDatabaseInstant(row.recordedAt),
    }))
    .reverse();
}
