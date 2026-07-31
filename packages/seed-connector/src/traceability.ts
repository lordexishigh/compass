import type { CommitRecord, IssueRecord, SprintRecord } from '@compass/connector-port';

import { diceSimilarity, sharedTokens, tokenSet } from './text.js';

/**
 * The four traceability classes, and the resolution order that decides them.
 *
 * Real repositories are messy in a specific way: most commits name their ticket
 * only in a branch, a few name nothing at all, and a stubborn minority can only
 * be tied to an objective by what they say. A seed that skips that messiness
 * would let the alignment engine look far better than it is, so the seed models
 * all four classes in documented proportions and this module is what decides
 * which class a commit is actually in.
 *
 * Resolution runs top to bottom and stops at the first hit:
 *
 *   1. `structural`   — a ticket key in the commit message, for a ticket that
 *                       sits on a sprint carrying a goal. The whole chain
 *                       commit → ticket → sprint → sprint goal is stored data.
 *   2. `inferred`     — a ticket key in the branch name only, or a key for a
 *                       ticket with no goal chain (a Kanban ticket, say). The
 *                       hint is all there is.
 *   3. `semantic`     — no ticket key anywhere, but the message shares enough
 *                       wording with a goal or objective to clear the threshold.
 *   4. `unattributed` — nothing at all. Rendered as a question, never a verdict.
 */
export const TRACEABILITY_CLASSES = ['structural', 'inferred', 'semantic', 'unattributed'] as const;

export type TraceabilityClass = (typeof TRACEABILITY_CLASSES)[number];

/**
 * The documented semantic acceptance threshold: Dice ≥ 0.30 over normalised
 * token sets. Below it a commit is unattributed — a question, not an accusation.
 */
export const SEMANTIC_MATCH_THRESHOLD = 0.3;

/** `PLAT-482`, `CHK-701`. Two to five uppercase letters, a hyphen, digits. */
export const TICKET_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,4}-\d+\b/;

export interface AlignmentTarget {
  /** `PLAT/Sprint 43` for a sprint goal, `OBJ-Q3-CHK` for an objective. */
  readonly key: string;
  readonly kind: 'sprint_goal' | 'objective';
  readonly text: string;
}

interface PreparedTarget extends AlignmentTarget {
  readonly tokens: ReadonlySet<string>;
}

export interface TraceabilityContext {
  readonly knownItemKeys: ReadonlySet<string>;
  /** Items whose sprint carries a goal — the only ones a structural chain reaches. */
  readonly itemKeysWithGoalChain: ReadonlySet<string>;
  readonly targets: readonly PreparedTarget[];
}

export interface TraceabilityResolution {
  readonly revisionId: string;
  readonly traceabilityClass: TraceabilityClass;
  /** Which ticket the resolution used, if any. */
  readonly itemKey: string | null;
  /** Where the ticket key was found. */
  readonly foundIn: 'message' | 'branch' | null;
  /** The goal or objective a semantic match landed on. */
  readonly targetKey: string | null;
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

export interface TraceabilityDistributionEntry {
  readonly traceabilityClass: TraceabilityClass;
  readonly count: number;
  /** Share of all commits, rounded to one decimal place. */
  readonly percentage: number;
}

export function firstTicketKey(text: string | null): string | null {
  if (text === null) return null;
  return TICKET_KEY_PATTERN.exec(text)?.[0] ?? null;
}

export function buildTraceabilityContext(input: {
  readonly issues: readonly IssueRecord[];
  readonly sprints: readonly SprintRecord[];
  readonly objectives: readonly { readonly key: string; readonly title: string }[];
}): TraceabilityContext {
  const sprintsById = new Map(input.sprints.map((sprint) => [sprint.sourceRecordId, sprint]));

  const knownItemKeys = new Set(input.issues.map((issue) => issue.itemKey));
  const itemKeysWithGoalChain = new Set(
    input.issues
      .filter((issue) => issue.sprintRefs.some((ref) => (sprintsById.get(ref)?.goal ?? null) !== null))
      .map((issue) => issue.itemKey),
  );

  const targets: PreparedTarget[] = [
    ...input.sprints
      .filter((sprint) => sprint.goal !== null)
      .map((sprint) => ({
        key: `${sprint.projectKey}/${sprint.name}`,
        kind: 'sprint_goal' as const,
        text: sprint.goal ?? '',
      })),
    ...input.objectives.map((objective) => ({
      key: objective.key,
      kind: 'objective' as const,
      text: objective.title,
    })),
  ]
    .map((target) => ({ ...target, tokens: tokenSet(target.text) }))
    // Sorted so the best-match tie-break is a documented total order, never
    // whichever record the source happened to return first.
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  return { knownItemKeys, itemKeysWithGoalChain, targets };
}

/** The best-scoring alignment target for a piece of text, above zero. */
export function bestSemanticMatch(
  text: string,
  context: TraceabilityContext,
): { readonly target: AlignmentTarget; readonly score: number; readonly matchedTokens: readonly string[] } | null {
  const tokens = tokenSet(text);
  let best: { target: PreparedTarget; score: number } | null = null;

  for (const target of context.targets) {
    const score = diceSimilarity(tokens, target.tokens);
    // Strictly greater keeps the first target in the sorted order on a tie.
    if (best === null || score > best.score) best = { target, score };
  }

  if (best === null || best.score <= 0) return null;
  return {
    target: { key: best.target.key, kind: best.target.kind, text: best.target.text },
    score: best.score,
    matchedTokens: sharedTokens(tokens, best.target.tokens),
  };
}

/**
 * Which of the four classes this commit falls into, decided from the commit
 * record alone. The generator does not get to tell this function the answer —
 * it re-derives it, which is what makes the manifest's proportions checkable.
 */
export function classifyCommitTraceability(
  commit: CommitRecord,
  context: TraceabilityContext,
): TraceabilityResolution {
  const messageKey = firstTicketKey(commit.message);
  const branchKey = firstTicketKey(commit.branchName);

  if (messageKey !== null && context.knownItemKeys.has(messageKey) && context.itemKeysWithGoalChain.has(messageKey)) {
    return {
      revisionId: commit.revisionId,
      traceabilityClass: 'structural',
      itemKey: messageKey,
      foundIn: 'message',
      targetKey: null,
      score: 1,
      matchedTokens: [messageKey],
    };
  }

  const hintKey =
    messageKey !== null && context.knownItemKeys.has(messageKey)
      ? { key: messageKey, foundIn: 'message' as const }
      : branchKey !== null && context.knownItemKeys.has(branchKey)
        ? { key: branchKey, foundIn: 'branch' as const }
        : null;

  if (hintKey !== null) {
    return {
      revisionId: commit.revisionId,
      traceabilityClass: 'inferred',
      itemKey: hintKey.key,
      foundIn: hintKey.foundIn,
      targetKey: null,
      score: 1,
      matchedTokens: [hintKey.key],
    };
  }

  const semantic = bestSemanticMatch(commit.message, context);
  if (semantic !== null && semantic.score >= SEMANTIC_MATCH_THRESHOLD) {
    return {
      revisionId: commit.revisionId,
      traceabilityClass: 'semantic',
      itemKey: null,
      foundIn: null,
      targetKey: semantic.target.key,
      score: semantic.score,
      matchedTokens: semantic.matchedTokens,
    };
  }

  return {
    revisionId: commit.revisionId,
    traceabilityClass: 'unattributed',
    itemKey: null,
    foundIn: null,
    targetKey: null,
    score: semantic?.score ?? 0,
    matchedTokens: [],
  };
}

/** Percentage to one decimal place, computed the same way everywhere. */
export const sharePercentage = (count: number, total: number): number =>
  total === 0 ? 0 : Math.round((count / total) * 1000) / 10;

/**
 * The class distribution over a set of commits, always in `TRACEABILITY_CLASSES`
 * order and always with all four entries present — an absent class must read as
 * a zero, not as a missing row.
 */
export function traceabilityDistribution(
  commits: readonly CommitRecord[],
  context: TraceabilityContext,
): readonly TraceabilityDistributionEntry[] {
  const counts = new Map<TraceabilityClass, number>(TRACEABILITY_CLASSES.map((name) => [name, 0]));
  for (const commit of commits) {
    const resolution = classifyCommitTraceability(commit, context);
    counts.set(resolution.traceabilityClass, (counts.get(resolution.traceabilityClass) ?? 0) + 1);
  }
  return TRACEABILITY_CLASSES.map((traceabilityClass) => {
    const count = counts.get(traceabilityClass) ?? 0;
    return { traceabilityClass, count, percentage: sharePercentage(count, commits.length) };
  });
}
