import {
  goalChainIds,
  goalHierarchyAt,
  isGoalNodeKind,
  type GoalHierarchy,
  type GoalNodeKind,
} from '@compass/analysis';
import { SystemClock, instantFromIso, toIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  appendGoalRevision,
  archiveGoalNode,
  loadGoalNodeHistory,
  loadGoalStore,
  orgScope,
  type GoalNodeInput,
  type GoalNodeRevisionRow,
  type GoalStoreContents,
} from '@compass/db';
import { resolveSeededRun } from '@compass/seed-connector';

import { database } from './report-source';

/**
 * The goal hierarchy, read and written from the request edge.
 *
 * This is the thin server half of the goals surface. It owns three things and
 * nothing else: which organization the request is for, what instant "now" is, and
 * the translation between the store's rows and the JSON the endpoints return.
 *
 * The effective-dating rule is *not* here. Every read loads all revisions and hands
 * them to `goalHierarchyAt`, the one implementation of the freeze rule, so the
 * `?at=` parameter and the report pipeline resolve the hierarchy identically. See
 * `docs/ARCHITECTURE.md`, "Effective dating and the freeze rule".
 *
 * Authentication arrives with `alpha-auth-tenancy-and-seats`; until then the
 * organization is the seeded one, resolved through the same `resolveSeededRun` both
 * process edges already call, so this surface edits the goals the report on `/` is
 * actually measured against.
 */

/** The tenant this surface edits. One resolver, shared with the report edge. */
export function goalScope(): ScopedDb {
  const run = resolveSeededRun({ hostNow: new SystemClock().now() });
  return new ScopedDb(database(), orgScope(run.organizationId));
}

/** The edge's own instant. The only place this surface reads a clock. */
export const nowAtEdge = (): Instant => new SystemClock().now();

export class InvalidGoalRequestError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidGoalRequestError';
    this.detail = detail;
  }
}

export interface GoalNodeView {
  readonly nodeId: string;
  readonly revision: number;
  readonly kind: GoalNodeKind;
  readonly parentNodeId: string | null;
  readonly title: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly isCurrent: boolean;
  readonly archived: boolean;
  readonly origin: string;
  readonly subjectKind: string | null;
  readonly subjectKey: string | null;
  readonly recordedAt: string;
  readonly recordedBy: string | null;
  readonly changeNote: string | null;
  /** The chain up to the root, leaf first — what an alignment verdict cites. */
  readonly chainNodeIds: readonly string[];
}

export interface GoalListView {
  /** The instant this hierarchy was resolved for. Echoed so a reader can check. */
  readonly at: string;
  readonly nodes: readonly GoalNodeView[];
  readonly attachments: readonly {
    readonly nodeId: string;
    readonly subjectKind: string;
    readonly subjectKey: string;
  }[];
}

const toView = (row: GoalNodeRevisionRow, hierarchy: GoalHierarchy): GoalNodeView => ({
  nodeId: row.nodeId,
  revision: row.revision,
  kind: isGoalNodeKind(row.objectiveKind) ? row.objectiveKind : 'quarter',
  parentNodeId: row.parentNodeId,
  title: row.title,
  effectiveFrom: toIso(row.effectiveFrom),
  effectiveUntil: row.effectiveUntil === null ? null : toIso(row.effectiveUntil),
  isCurrent: row.isCurrent,
  archived: row.archived,
  origin: row.origin,
  subjectKind: row.subjectKind,
  subjectKey: row.subjectKey,
  recordedAt: toIso(row.recordedAt),
  recordedBy: row.recordedBy,
  changeNote: row.changeNote,
  chainNodeIds: goalChainIds(hierarchy, row.nodeId),
});

/**
 * The hierarchy in force at an instant.
 *
 * `at` defaults to now, which is the only sensible default for an editing surface —
 * but it is a parameter, and passing a past instant is how a manager asks what
 * yesterday's report was measured against.
 */
/** The store's rows, resolved through the one implementation of the freeze rule. */
function hierarchyFrom(store: GoalStoreContents, at: Instant): GoalHierarchy {
  return goalHierarchyAt(
    store.nodes.map((node) => ({
      nodeId: node.nodeId,
      revision: node.revision,
      kind: isGoalNodeKind(node.objectiveKind) ? node.objectiveKind : 'quarter',
      parentNodeId: node.parentNodeId,
      title: node.title,
      effectiveFrom: node.effectiveFrom,
      effectiveUntil: node.effectiveUntil,
      isCurrent: node.isCurrent,
      archived: node.archived,
      origin: node.origin,
      subjectKind: node.subjectKind,
      subjectKey: node.subjectKey,
      recordedAt: node.recordedAt,
    })),
    store.links.map((link) => ({
      linkKey: link.linkKey,
      revision: link.revision,
      nodeId: link.nodeId,
      subjectKind: link.subjectKind,
      subjectKey: link.subjectKey,
      effectiveFrom: link.effectiveFrom,
      effectiveUntil: link.effectiveUntil,
      detached: link.detached,
      recordedAt: link.recordedAt,
    })),
    at,
  );
}

export async function listGoals(at: Instant = nowAtEdge()): Promise<GoalListView> {
  const store = await loadGoalStore(goalScope());
  const hierarchy = hierarchyFrom(store, at);

  // Re-joined to the stored rows so the view carries `recordedBy` and the change
  // note, which the pure hierarchy has no reason to hold.
  const rowByNode = new Map(store.nodes.map((node) => [`${node.nodeId}@${node.revision}`, node]));

  return {
    at: toIso(at),
    nodes: hierarchy.nodes
      .map((node) => rowByNode.get(`${node.nodeId}@${node.revision}`))
      .filter((row): row is GoalNodeRevisionRow => row !== undefined)
      .map((row) => toView(row, hierarchy)),
    attachments: hierarchy.subjectLinks.map((link) => ({
      nodeId: link.nodeId,
      subjectKind: link.subjectKind,
      subjectKey: link.subjectKey,
    })),
  };
}

export interface GoalHistoryView {
  readonly nodeId: string;
  /** Every revision, oldest first. Nothing is ever removed from this list. */
  readonly revisions: readonly GoalNodeView[];
}

/** One node's whole history — what "show me what changed" reads. */
export async function readGoal(nodeId: string): Promise<GoalHistoryView | null> {
  const scoped = goalScope();
  const history = await loadGoalNodeHistory(scoped, nodeId);
  if (history.length === 0) return null;

  // Each revision's chain is resolved against its *own* instant, not against
  // today's hierarchy: a past revision's parent may since have been reworded or
  // archived, and printing today's chain beside a historical wording would be a
  // quiet lie about what that revision meant.
  const store = await loadGoalStore(scoped);
  const revisions: GoalNodeView[] = [];
  for (const row of history) {
    revisions.push(toView(row, hierarchyFrom(store, row.recordedAt)));
  }

  return { nodeId, revisions };
}

/** The fields a write accepts, before any of them have been trusted. */
export interface GoalWriteBody {
  readonly nodeId?: unknown;
  readonly kind?: unknown;
  readonly parentNodeId?: unknown;
  readonly title?: unknown;
  readonly effectiveFrom?: unknown;
  readonly effectiveUntil?: unknown;
  readonly isCurrent?: unknown;
  readonly changeNote?: unknown;
  readonly recordedBy?: unknown;
}

const text = (value: unknown, field: string, required = true): string | null => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new InvalidGoalRequestError(`\`${field}\` is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new InvalidGoalRequestError(`\`${field}\` must be a string.`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new InvalidGoalRequestError(`\`${field}\` cannot be blank.`);
  return trimmed.length === 0 ? null : trimmed;
};

const instant = (value: unknown, field: string, required = true): Instant | null => {
  const raw = text(value, field, required);
  if (raw === null) return null;
  try {
    return instantFromIso(raw);
  } catch {
    throw new InvalidGoalRequestError(`\`${field}\` must be an ISO-8601 instant, e.g. 2026-07-01T00:00:00Z.`);
  }
};

/**
 * Validates a write body into a store input.
 *
 * Every field is checked and named in the failure, because this surface is the one
 * place a human types into the goal hierarchy and a 500 with no explanation would
 * make the whole feature feel broken rather than the request wrong. `defaults`
 * supplies the prior revision's values on an edit, so a PATCH may send one field.
 */
export function goalInputFrom(
  body: GoalWriteBody,
  defaults: GoalNodeRevisionRow | null,
): GoalNodeInput {
  const nodeId = defaults?.nodeId ?? text(body.nodeId, 'nodeId');
  if (nodeId === null) throw new InvalidGoalRequestError('`nodeId` is required.');

  const kindValue = body.kind ?? defaults?.objectiveKind;
  const kind = text(kindValue, 'kind');
  if (!isGoalNodeKind(kind)) {
    throw new InvalidGoalRequestError('`kind` must be one of `company`, `quarter` or `sprint_goal`.');
  }

  const title = body.title === undefined && defaults !== null ? defaults.title : text(body.title, 'title');
  if (title === null) throw new InvalidGoalRequestError('`title` is required.');

  const effectiveFrom =
    body.effectiveFrom === undefined && defaults !== null
      ? defaults.effectiveFrom
      : instant(body.effectiveFrom, 'effectiveFrom');
  if (effectiveFrom === null) throw new InvalidGoalRequestError('`effectiveFrom` is required.');

  const effectiveUntil =
    body.effectiveUntil === undefined && defaults !== null
      ? defaults.effectiveUntil
      : instant(body.effectiveUntil, 'effectiveUntil', false);

  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) {
    throw new InvalidGoalRequestError('`effectiveUntil` must be after `effectiveFrom`; a goal cannot end before it starts.');
  }

  const isCurrent =
    body.isCurrent === undefined ? (defaults?.isCurrent ?? false) : body.isCurrent === true || body.isCurrent === 'true';

  if (kind === 'company' && (body.parentNodeId ?? defaults?.parentNodeId ?? null) !== null) {
    throw new InvalidGoalRequestError('A company objective is the root of the chain and has no parent.');
  }

  return {
    nodeId,
    objectiveKind: kind,
    parentNodeId:
      body.parentNodeId === undefined
        ? (defaults?.parentNodeId ?? null)
        : text(body.parentNodeId, 'parentNodeId', false),
    title,
    effectiveFrom,
    effectiveUntil,
    isCurrent,
    archived: false,
    // A hand-written revision is `declared`, and the sync refuses to supersede one.
    // That is what stops the next ingest quietly reverting this edit.
    origin: 'declared',
    subjectKind: defaults?.subjectKind ?? null,
    subjectKey: defaults?.subjectKey ?? null,
    recordedBy: text(body.recordedBy, 'recordedBy', false),
    changeNote: text(body.changeNote, 'changeNote', false),
  };
}

export interface GoalWriteView {
  readonly nodeId: string;
  readonly revision: number;
  /** False when the submitted content was identical to the open revision. */
  readonly appended: boolean;
  readonly recordedAt: string;
}

export async function createGoal(body: GoalWriteBody): Promise<GoalWriteView> {
  const at = nowAtEdge();
  const result = await appendGoalRevision(goalScope(), goalInputFrom(body, null), at, false);
  return { nodeId: result.nodeId, revision: result.revision, appended: result.appended, recordedAt: toIso(at) };
}

export async function updateGoal(nodeId: string, body: GoalWriteBody): Promise<GoalWriteView> {
  const scoped = goalScope();
  const history = await loadGoalNodeHistory(scoped, nodeId);
  const open = history.at(-1) ?? null;
  const at = nowAtEdge();

  const result = await appendGoalRevision(scoped, goalInputFrom(body, open), at, true);
  return { nodeId: result.nodeId, revision: result.revision, appended: result.appended, recordedAt: toIso(at) };
}

export async function archiveGoal(nodeId: string, changeNote: string | null): Promise<GoalWriteView> {
  const at = nowAtEdge();
  const result = await archiveGoalNode(goalScope(), nodeId, at, {
    ...(changeNote === null ? {} : { changeNote }),
  });
  return { nodeId: result.nodeId, revision: result.revision, appended: result.appended, recordedAt: toIso(at) };
}
