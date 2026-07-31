import {
  goalHierarchyAt,
  goalHierarchyFromSnapshot,
  type AlignmentAssessment,
  type AnalysisSnapshot,
  type GoalHierarchy,
} from '@compass/analysis';
import type { Instant } from '@compass/clock';
import {
  loadGoalStore,
  recordObjectiveLinks,
  syncGoalNodes,
  type GoalNodeInput,
  type ObjectiveLinkInput,
  type ScopedDb,
} from '@compass/db';

/**
 * Keeping the goal store and the knowledge model in step, and writing the links
 * resolution produced.
 *
 * The pipeline is the only layer that holds both `@compass/db` and
 * `@compass/analysis`, so the translation between the stored goal hierarchy and the
 * pure one belongs here — exactly as `persist.ts` owns the translation between the
 * structured report and its rows.
 *
 * ## Which direction wins
 *
 * Two things write goal nodes and they must not fight:
 *
 *  - **This sync**, on every run, projecting the objectives and sprint goals
 *    already in the knowledge model. It writes `origin: 'observed'` — not because
 *    an objective is an observation, but because *a sync is nobody's opinion*.
 *  - **The goals API**, when a manager edits one. It writes `origin: 'declared'`.
 *
 * `syncGoalNodes` refuses to supersede a `declared` revision with an `observed`
 * one, so a manager who reworded a sprint goal in Compass keeps that wording
 * through the next ingest. Without that rule the edit surface would appear to work
 * and then silently revert overnight, which is worse than not having one.
 */

/**
 * The goal nodes the knowledge model implies, as store inputs.
 *
 * Derived through `goalHierarchyFromSnapshot`, which is the same function the
 * analysis core falls back to when there is no store at all. Using one derivation
 * for both is what makes a first run and a hundredth run agree about the chain.
 */
export function goalNodeInputsFromSnapshot(
  snapshot: AnalysisSnapshot,
  instant: Instant,
): readonly GoalNodeInput[] {
  return goalHierarchyFromSnapshot(snapshot, instant).nodes.map((node) => ({
    nodeId: node.nodeId,
    objectiveKind: node.kind,
    parentNodeId: node.parentNodeId,
    title: node.title,
    effectiveFrom: node.effectiveFrom as Instant,
    effectiveUntil: node.effectiveUntil === null ? null : (node.effectiveUntil as Instant),
    isCurrent: node.isCurrent,
    archived: false,
    origin: 'observed',
    subjectKind: node.subjectKind,
    subjectKey: node.subjectKey,
    recordedBy: null,
    changeNote: null,
  }));
}

/**
 * Projects the model's objectives and sprint goals into the store.
 *
 * Idempotent: `appendGoalRevision` compares content and appends nothing when the
 * wording has not moved, so running this on every report — which is what happens —
 * does not add a revision per run.
 */
export async function syncGoalHierarchy(
  scoped: ScopedDb,
  snapshot: AnalysisSnapshot,
  instant: Instant,
): Promise<{ readonly appended: number; readonly unchanged: number; readonly skipped: number }> {
  return syncGoalNodes(scoped, goalNodeInputsFromSnapshot(snapshot, instant), instant);
}

/**
 * The stored hierarchy as it stood at one instant.
 *
 * Every revision is read and the *pure* rule picks which one is in force, because
 * that rule is the freeze guarantee and there must be exactly one implementation of
 * it. See `packages/analysis/src/goal-hierarchy.ts`.
 */
export async function loadGoalHierarchyAt(scoped: ScopedDb, instant: Instant): Promise<GoalHierarchy> {
  const store = await loadGoalStore(scoped);
  return goalHierarchyAt(
    store.nodes.map((node) => ({
      nodeId: node.nodeId,
      revision: node.revision,
      // The store holds the kind as text so a future kind needs no migration; a row
      // whose kind this build does not recognise is dropped rather than guessed at.
      kind: node.objectiveKind === 'company' ? 'company' : node.objectiveKind === 'quarter' ? 'quarter' : 'sprint_goal',
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
    instant,
  );
}

/**
 * The ObjectiveLink rows one assessment produced.
 *
 * Unattributed resolutions are deliberately absent: no link, no verdict. That is
 * the storage half of the same commitment the report's wording makes, and it means
 * a query over `objective_links` can never be mistaken for a claim about work
 * Compass could not place.
 */
export function objectiveLinkInputsFrom(assessment: AlignmentAssessment): readonly ObjectiveLinkInput[] {
  const inputs: ObjectiveLinkInput[] = [];

  for (const resolution of assessment.resolutions) {
    if (resolution.alignmentClass === 'unattributed') continue;
    const evidence = resolution.evidence;

    inputs.push({
      subjectKind: resolution.subjectKind,
      subjectKey: resolution.subjectKey,
      subjectLabel: resolution.subjectLabel,
      source: resolution.alignmentClass,
      nodeId: resolution.nodeId,
      nodeRevision: resolution.nodeRevision,
      chainNodeIds: resolution.chainNodeIds,
      matchedSubstring: 'matchedSubstring' in evidence ? evidence.matchedSubstring : null,
      matchedOffset: 'matchedOffset' in evidence ? evidence.matchedOffset : null,
      matchedIn: 'matchedIn' in evidence ? evidence.matchedIn : null,
      score: evidence.tier === 'semantic' ? evidence.score : null,
      threshold: evidence.tier === 'semantic' ? evidence.threshold : null,
      comparedTextA: evidence.tier === 'semantic' ? evidence.comparedTextA : null,
      comparedTextB: evidence.tier === 'semantic' ? evidence.comparedTextB : null,
      servesCurrentObjective: resolution.servesCurrentObjective,
    });
  }

  return inputs;
}

/** Writes the links for one report instant. Returns how many rows were offered. */
export async function persistObjectiveLinks(
  scoped: ScopedDb,
  reportInstant: Instant,
  assessment: AlignmentAssessment,
  recordedAt: Instant,
): Promise<number> {
  return recordObjectiveLinks(scoped, reportInstant, objectiveLinkInputsFrom(assessment), recordedAt);
}
