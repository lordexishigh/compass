import { compareNumbers, compareStable, type Instant } from './instant.js';
import {
  entitiesOfKind,
  instantField,
  textField,
  type AnalysisEntity,
  type AnalysisSnapshot,
} from './snapshot.js';

/**
 * The goal hierarchy, and the effective-dating rule that reads it.
 *
 * A Compass alignment verdict is only as trustworthy as the chain it resolved
 * against, so the chain is a stored, versioned, editable object: company
 * objective → quarter objective → sprint goal, and from any node downward to the
 * Features and tickets a manager has attached to it.
 *
 * ## Two time axes, and why both are needed
 *
 * Every revision carries two pairs of instants and they answer different
 * questions. Confusing them is the mistake this comment exists to prevent.
 *
 *  - **`effectiveFrom` / `effectiveUntil` — the goal's own horizon.** "Q3 runs
 *    from 1 July to 30 September." This is business data the manager states, it is
 *    what `objectives.effective_from` has always meant in this codebase, and it is
 *    what `isCurrent` is declared against.
 *  - **`recordedAt` — when Compass came to believe this wording.** An edit appends
 *    a revision with a later `recordedAt`; the prior revision is never touched. A
 *    revision is therefore in force over `[recordedAt, nextRevision.recordedAt)`,
 *    which is derived rather than stored, because storing the end would mean
 *    writing to a row that has already been read by a report somebody kept.
 *
 * ## The freeze-vs-re-evaluate rule
 *
 * `goalHierarchyAt(revisions, instant)` is the single implementation of that rule
 * and every caller goes through it — the report pipeline, the goals API's `?at=`
 * parameter, and the tests. It selects, per node, the revision with the greatest
 * `recordedAt` at or before `instant`.
 *
 * The consequence, stated plainly and asserted by
 * `tests/goal-hierarchy.test.ts`: **rewording an objective today can never change
 * what Compass said about yesterday.** A verdict already inside a persisted report
 * is frozen — the stored payload is the thing a manager read and is never
 * rewritten — and a verdict *recomputed* for a past instant resolves against the
 * wording in force at that instant, so a regenerate reproduces the frozen verdict
 * instead of re-judging last week's work against this week's goal. The full rule,
 * including what *is* allowed to change a past verdict, is in
 * `docs/ARCHITECTURE.md` under "Effective dating and the freeze rule".
 */

export const GOAL_NODE_KINDS = ['company', 'quarter', 'sprint_goal'] as const;

export type GoalNodeKind = (typeof GOAL_NODE_KINDS)[number];

export function isGoalNodeKind(value: unknown): value is GoalNodeKind {
  return typeof value === 'string' && (GOAL_NODE_KINDS as readonly string[]).includes(value);
}

/** How a node came to exist. An observed node is refreshed from a sprint goal; a
 *  declared one was written by a manager and observation never overwrites it. */
export type GoalNodeOrigin = 'declared' | 'observed';

/**
 * One revision of one goal node.
 *
 * `revision` counts from 1 and never restarts. `archived` is how a node is
 * removed: an archive is an appended revision, so the history of a goal that was
 * abandoned mid-quarter survives the abandonment.
 */
export interface GoalNodeRevision {
  readonly nodeId: string;
  readonly revision: number;
  readonly kind: GoalNodeKind;
  readonly parentNodeId: string | null;
  readonly title: string;
  /** The goal's own horizon. Null `effectiveUntil` means open-ended. */
  readonly effectiveFrom: number;
  readonly effectiveUntil: number | null;
  /** The manager's declaration that today's work is measured against this goal. */
  readonly isCurrent: boolean;
  readonly archived: boolean;
  readonly origin: GoalNodeOrigin;
  /** What a `sprint_goal` node belongs to: `sprint` and the sprint's natural key. */
  readonly subjectKind: string | null;
  readonly subjectKey: string | null;
  /** When this revision was recorded — the belief axis. */
  readonly recordedAt: number;
}

/**
 * A declared attachment of a work item to a goal node: the "down to Feature/epic
 * and ticket" half of the chain. Revisioned exactly like a node, so detaching a
 * link is an append rather than a delete.
 */
export interface GoalSubjectLinkRevision {
  readonly linkKey: string;
  readonly revision: number;
  readonly nodeId: string;
  /** `feature`, `ticket`, `sprint` or `project`. */
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly effectiveFrom: number;
  readonly effectiveUntil: number | null;
  /** True once the manager has detached it. The row stays; the link stops. */
  readonly detached: boolean;
  readonly recordedAt: number;
}

/** The hierarchy as of one instant: at most one revision per node, per link. */
export interface GoalHierarchy {
  /** The instant this was resolved for. Printed in the evidence panel. */
  readonly resolvedAt: number;
  readonly nodes: readonly GoalNodeRevision[];
  readonly subjectLinks: readonly GoalSubjectLinkRevision[];
}

export const EMPTY_GOAL_HIERARCHY: GoalHierarchy = Object.freeze({
  resolvedAt: 0,
  nodes: Object.freeze([]) as readonly GoalNodeRevision[],
  subjectLinks: Object.freeze([]) as readonly GoalSubjectLinkRevision[],
});

// ---------------------------------------------------------------------------
// The effective-dating rule
// ---------------------------------------------------------------------------

/**
 * The revision of each node in force at `instant`, archived nodes dropped.
 *
 * Ties on `recordedAt` are broken by the higher `revision`, so two edits recorded
 * at the same instant resolve to the later one rather than to whichever row the
 * database returned first. Nodes are returned sorted by `nodeId` — the semantic
 * tier's tie-break is a documented total order, never row order.
 */
export function goalHierarchyAt(
  revisions: readonly GoalNodeRevision[],
  links: readonly GoalSubjectLinkRevision[],
  instant: Instant,
): GoalHierarchy {
  const nodes = [...pickLatest(revisions, (revision) => revision.nodeId, instant).values()]
    .filter((node) => !node.archived)
    .sort((left, right) => compareStable(left.nodeId, right.nodeId));

  const subjectLinks = [...pickLatest(links, (link) => link.linkKey, instant).values()]
    .filter((link) => !link.detached)
    .sort(
      (left, right) =>
        compareStable(left.nodeId, right.nodeId) ||
        compareStable(left.subjectKind, right.subjectKind) ||
        compareStable(left.subjectKey, right.subjectKey),
    );

  return { resolvedAt: instant, nodes, subjectLinks };
}

function pickLatest<T extends { readonly revision: number; readonly recordedAt: number }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  instant: Instant,
): ReadonlyMap<string, T> {
  const chosen = new Map<string, T>();
  for (const row of rows) {
    if (row.recordedAt > instant) continue;
    const key = keyOf(row);
    const existing = chosen.get(key);
    if (
      existing === undefined ||
      compareNumbers(row.recordedAt, existing.recordedAt) > 0 ||
      (row.recordedAt === existing.recordedAt && row.revision > existing.revision)
    ) {
      chosen.set(key, row);
    }
  }
  return chosen;
}

/** Whether a goal's own horizon contains an instant. Open-ended ends never close. */
export function horizonContains(node: GoalNodeRevision, instant: Instant): boolean {
  return node.effectiveFrom <= instant && (node.effectiveUntil === null || instant < node.effectiveUntil);
}

// ---------------------------------------------------------------------------
// Reading the graph
// ---------------------------------------------------------------------------

export function goalNodeById(hierarchy: GoalHierarchy, nodeId: string | null): GoalNodeRevision | null {
  if (nodeId === null) return null;
  return hierarchy.nodes.find((node) => node.nodeId === nodeId) ?? null;
}

/**
 * The chain from a node up to its root, leaf first.
 *
 * Bounded by the node count rather than trusting the data to be acyclic: a
 * hand-edited hierarchy that named itself as its own parent would otherwise hang
 * the report generator, and a hang is far harder to diagnose than a short chain.
 */
export function goalChain(hierarchy: GoalHierarchy, nodeId: string | null): readonly GoalNodeRevision[] {
  const chain: GoalNodeRevision[] = [];
  const seen = new Set<string>();
  let current = goalNodeById(hierarchy, nodeId);

  while (current !== null && !seen.has(current.nodeId) && chain.length <= hierarchy.nodes.length) {
    seen.add(current.nodeId);
    chain.push(current);
    current = goalNodeById(hierarchy, current.parentNodeId);
  }
  return chain;
}

/** The chain as node ids, leaf first — what an ObjectiveLink persists. */
export const goalChainIds = (hierarchy: GoalHierarchy, nodeId: string | null): readonly string[] =>
  goalChain(hierarchy, nodeId).map((node) => node.nodeId);

/**
 * The nearest objective at or above a node — the thing a verdict is allowed to
 * name. A sprint goal is a means; the objective is what the work is *for*, and it
 * is the objective's `isCurrent` that decides whether work is off-goal.
 */
export function objectiveAbove(hierarchy: GoalHierarchy, nodeId: string | null): GoalNodeRevision | null {
  return goalChain(hierarchy, nodeId).find((node) => node.kind !== 'sprint_goal') ?? null;
}

/** The sprint-goal node attached to one sprint, by the sprint's natural key. */
export function sprintGoalFor(hierarchy: GoalHierarchy, sprintKey: string | null): GoalNodeRevision | null {
  if (sprintKey === null) return null;
  return (
    hierarchy.nodes.find(
      (node) => node.kind === 'sprint_goal' && node.subjectKind === 'sprint' && node.subjectKey === sprintKey,
    ) ?? null
  );
}

/** Every declared attachment naming one subject, node id order. */
export function subjectLinksFor(
  hierarchy: GoalHierarchy,
  subjectKind: string,
  subjectKey: string,
): readonly GoalSubjectLinkRevision[] {
  return hierarchy.subjectLinks.filter(
    (link) => link.subjectKind === subjectKind && link.subjectKey === subjectKey,
  );
}

// ---------------------------------------------------------------------------
// Deriving a hierarchy from the snapshot
// ---------------------------------------------------------------------------

/**
 * The hierarchy implied by the knowledge model itself.
 *
 * The stored goal hierarchy in `objective_versions` is the authority, and the
 * pipeline loads it. This exists for the two callers that legitimately have no
 * store to read: the analysis core's own tests, which must stay pure, and a
 * deployment whose goal store has not been provisioned yet — where deriving the
 * chain from the objectives and sprint goals already in the model is strictly
 * better than emitting no alignment at all and calling every commit unattributed.
 *
 * It is the *same data*: `packages/db`'s goal store is provisioned from the
 * declared objectives and the observed sprint goals, which is what these rows
 * are. Node ids are chosen to match — an objective is its own key, a sprint goal
 * is `PROJECT/Sprint 46` — so a report generated either way names the same chain.
 *
 * @snapshotAccessor projects already-materialized objective and sprint rows into the goal graph; the instant it is handed is the belief instant every revision is stamped with.
 */
export function goalHierarchyFromSnapshot(snapshot: AnalysisSnapshot, instant: Instant): GoalHierarchy {
  const nodes: GoalNodeRevision[] = [];

  for (const objective of entitiesOfKind(snapshot, 'objective')) {
    const kind = textField(objective, 'objectiveKind');
    if (!isGoalNodeKind(kind) || kind === 'sprint_goal') continue;

    nodes.push({
      nodeId: objective.naturalKey,
      revision: objective.version,
      kind,
      parentNodeId: textField(objective, 'parentObjectiveKey'),
      title: textField(objective, 'title') ?? objective.naturalKey,
      effectiveFrom: instantField(objective, 'effectiveFrom') ?? objective.firstSeenAt,
      effectiveUntil: instantField(objective, 'effectiveUntil'),
      isCurrent: objective.fields['isCurrent'] === true,
      archived: false,
      origin: 'declared',
      subjectKind: null,
      subjectKey: null,
      recordedAt: objective.beliefAt,
    });
  }

  // A sprint goal belongs under the objective its team named. Where no team claims
  // the project, the sprint goal is a root: Compass will not guess which objective
  // a sprint serves, and an inferred parent would put a whole sprint's work under
  // somebody else's goal.
  const objectiveByProject = projectObjectiveIndex(snapshot);

  for (const sprint of entitiesOfKind(snapshot, 'sprint')) {
    const goal = textField(sprint, 'goal');
    const projectKey = textField(sprint, 'projectKey');
    if (goal === null || goal.length === 0 || projectKey === null) continue;

    nodes.push({
      nodeId: sprintGoalNodeId(projectKey, textField(sprint, 'name') ?? sprint.naturalKey),
      revision: sprint.version,
      kind: 'sprint_goal',
      parentNodeId: objectiveByProject.get(projectKey) ?? null,
      title: goal,
      effectiveFrom: instantField(sprint, 'startAt') ?? sprint.firstSeenAt,
      effectiveUntil: instantField(sprint, 'endAt'),
      isCurrent: true,
      archived: false,
      origin: 'observed',
      subjectKind: 'sprint',
      subjectKey: sprint.naturalKey,
      recordedAt: sprint.beliefAt,
    });
  }

  return goalHierarchyAt(nodes, [], instant);
}

/**
 * `PLAT/Sprint 46` — a sprint goal's node id.
 *
 * The project and the sprint name rather than the sprint's source record id, so
 * the id a manager sees in the evidence panel is one they recognise from their own
 * board, and so the seed generator and this layer agree on it without a lookup.
 */
export const sprintGoalNodeId = (projectKey: string, sprintName: string): string =>
  `${projectKey}/${sprintName}`;

/**
 * Which objective each project's team measures itself against.
 *
 * @snapshotAccessor a configuration lookup — which objective a team named — with no temporal semantics; the callers that resolve a hierarchy are the ones told the instant.
 */
export function projectObjectiveIndex(snapshot: AnalysisSnapshot): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const team of entitiesOfKind(snapshot, 'team')) {
    const projectKey = textField(team, 'projectKey');
    const objectiveKey = textField(team, 'objectiveKey');
    if (projectKey === null || objectiveKey === null) continue;
    index.set(projectKey, objectiveKey);
  }
  for (const project of entitiesOfKind(snapshot, 'project')) {
    if (index.has(project.naturalKey)) continue;
    const teamKey = textField(project, 'teamKey');
    if (teamKey === null) continue;
    const objectiveKey = teamObjective(snapshot, teamKey);
    if (objectiveKey !== null) index.set(project.naturalKey, objectiveKey);
  }
  return index;
}

function teamObjective(snapshot: AnalysisSnapshot, teamKey: string): string | null {
  const team: AnalysisEntity | undefined = entitiesOfKind(snapshot, 'team').find(
    (candidate) => candidate.naturalKey === teamKey,
  );
  return team === undefined ? null : textField(team, 'objectiveKey');
}
