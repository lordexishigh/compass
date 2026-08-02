import {
  ALIGNMENT_TICKET_KEY_PATTERN,
  alignmentTokenSet,
  diceSimilarity,
  findTicketKey,
  roundScore,
  sharedAlignmentTokens,
} from './alignment-text.js';
import { commitEvidence, orderedEvidence, ticketEvidence, type EvidenceRef } from './evidence.js';
import {
  goalChainIds,
  goalHierarchyFromSnapshot,
  goalNodeById,
  objectiveAbove,
  projectObjectiveIndex,
  sprintGoalFor,
  subjectLinksFor,
  type GoalHierarchy,
  type GoalNodeRevision,
} from './goal-hierarchy.js';
import { compareNumbers, compareStable, wholeDaysBetween, windowContains, type Instant, type TimeWindow } from './instant.js';
import { entityRef, stableItemId } from './identity.js';
import {
  entitiesOfKind,
  instantField,
  isDone,
  scopedCommits,
  scopedTickets,
  textField,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';
import { THRESHOLDS, thresholdRef, type ThresholdRef } from './thresholds.js';

/**
 * Three-tier alignment resolution, and the one gate that can emit OFF-GOAL.
 *
 * Alignment is the claim the whole product is positioned on, and it is also the
 * single most dangerous thing Compass says: one wrong OFF-GOAL flag against a
 * named developer and the manager either has to defend it to their team or quietly
 * stops trusting every other sentence on the page. So this file is written to make
 * the *wrong* output structurally hard to produce, not merely unlikely.
 *
 * ## The three tiers, in order, first hit wins
 *
 *  1. **`configured`** — a stored chain. A manager attached this ticket (or its
 *     Feature) to a goal node, or the ticket sits on a sprint that carries a goal,
 *     or its project's team names an objective. The full chain of node ids is
 *     persisted with the link, so a reader can walk it.
 *  2. **`inferred`** — a tracker key found in a branch name, or a key for a ticket
 *     that reaches no goal chain. The link records the *exact matched substring
 *     and its offset*, because "we found `PLAT-742` at character 8 of
 *     `feature/PLAT-742-legacy-billing-migration`" is checkable and "we inferred
 *     it" is not.
 *  3. **`semantic`** — no key anywhere, but the text shares enough vocabulary with
 *     a goal to clear T17. The link records the score, the threshold and *both*
 *     compared texts, so the manager sees precisely what Compass compared.
 *
 * Anything that clears none of the three is **`unattributed`**: it goes in a
 * bucket, is rendered as a question, and produces no verdict about anybody. That
 * is a product commitment, not a nicety — see `assertUnattributedNamesNobody`.
 *
 * ## The OFF-GOAL gate
 *
 * `OFF_GOAL_LABEL` appears in exactly one place in Compass — `offGoalVerdict` —
 * and that function's first statement is `if (!passesOffGoalGate(...)) return
 * null`. There is no second path to the label, which is why the property test in
 * `tests/report-invariants.test.ts` can enumerate low-confidence and unattributed
 * inputs and assert that none of them can produce one.
 *
 * The gate has three limbs and all three must hold:
 *
 *  - confidence at or above the configured threshold (T17);
 *  - a **named** objective that is positively declared non-current — `isCurrent`
 *    must be literally `false`, never merely absent or unknown;
 *  - that attribution must beat the chain the work already sits in. Work whose own
 *    sprint goal explains it at least as well is not off-goal; it is work that
 *    happens to share some words with last quarter.
 */

export const ALIGNMENT_TIERS = ['configured', 'inferred', 'semantic'] as const;

export type AlignmentTier = (typeof ALIGNMENT_TIERS)[number];

/** The four resolution classes. `unattributed` is the honest fourth. */
export const ALIGNMENT_CLASSES = [...ALIGNMENT_TIERS, 'unattributed'] as const;

export type AlignmentClass = (typeof ALIGNMENT_CLASSES)[number];

/**
 * The configured confidence threshold, as a ratio in [0, 1].
 *
 * Declared as T17 in basis points, like every other ratio threshold, and divided
 * here so there is one conversion rather than one per caller.
 */
export const SEMANTIC_CONFIDENCE_THRESHOLD = THRESHOLDS.T17.value / 10_000;

/**
 * The only string in Compass that labels work off-goal.
 *
 * Kept as a constant so a grep for it lands on the gate rather than on a template,
 * and so the smoke test and the web view can look for the same bytes the analysis
 * core emits.
 */
export const OFF_GOAL_LABEL = 'OFF-GOAL';

/** The confidence a literal key match carries: the string is either there or not. */
export const LITERAL_MATCH_CONFIDENCE = 1;

// ---------------------------------------------------------------------------
// Evidence — what the one-click panel shows
// ---------------------------------------------------------------------------

export interface ConfiguredAlignmentEvidence {
  readonly tier: 'configured';
  /** Leaf first: sprint goal, then quarter, then company. */
  readonly chainNodeIds: readonly string[];
  readonly chainTitles: readonly string[];
  /** Which stored relation put the subject on the chain. */
  readonly via: 'declared_ticket_link' | 'declared_feature_link' | 'ticket_sprint_goal' | 'team_objective';
  /** Present when a tracker key in the commit message is what reached the ticket. */
  readonly matchedSubstring: string | null;
  readonly matchedOffset: number | null;
  readonly matchedIn: 'commit_message' | 'branch_name' | null;
  readonly searchedText: string | null;
}

export interface InferredAlignmentEvidence {
  readonly tier: 'inferred';
  readonly chainNodeIds: readonly string[];
  readonly chainTitles: readonly string[];
  /** The exact substring that matched, verbatim. The panel underlines it. */
  readonly matchedSubstring: string;
  /** Its offset in `searchedText`, so the highlight cannot drift. */
  readonly matchedOffset: number;
  readonly matchedIn: 'commit_message' | 'branch_name';
  readonly searchedText: string;
  readonly via: 'ticket_key_in_branch' | 'ticket_key_without_goal_chain';
}

export interface SemanticAlignmentEvidence {
  readonly tier: 'semantic';
  readonly chainNodeIds: readonly string[];
  readonly chainTitles: readonly string[];
  readonly score: number;
  readonly threshold: number;
  /** The subject's own text, as compared. */
  readonly comparedTextA: string;
  /** The goal's text, as compared. */
  readonly comparedTextB: string;
  readonly matchedTokens: readonly string[];
}

export interface UnattributedAlignmentEvidence {
  readonly tier: 'unattributed';
  /** The best score anything scored. Below the threshold, by construction. */
  readonly score: number;
  readonly threshold: number;
  readonly comparedTextA: string;
  /** Null when nothing shared a single word with any goal. */
  readonly comparedTextB: string | null;
  readonly matchedTokens: readonly string[];
  /** The question the report asks. Never a statement about a person. */
  readonly question: string;
}

export type AlignmentEvidence =
  | ConfiguredAlignmentEvidence
  | InferredAlignmentEvidence
  | SemanticAlignmentEvidence
  | UnattributedAlignmentEvidence;

// ---------------------------------------------------------------------------
// One subject's resolution
// ---------------------------------------------------------------------------

export type AlignmentSubjectKind = 'commit' | 'ticket';

/**
 * The strongest non-current attribution found for one subject.
 *
 * Computed for every subject, whatever tier resolved it: work can sit
 * structurally inside the current sprint and still be *about* something the
 * organization stopped funding, which is exactly the seeded billing-migration
 * case. `currentScore` is what the same text scored against the chain it already
 * sits on, and the gate requires this to beat it.
 */
export interface OffGoalCandidate {
  readonly objectiveNodeId: string;
  readonly objectiveTitle: string;
  /** When that objective stopped being the plan. Null when open-ended. */
  readonly objectiveEffectiveUntil: number | null;
  readonly score: number;
  readonly threshold: number;
  readonly currentScore: number;
  readonly comparedTextA: string;
  readonly comparedTextB: string;
  readonly matchedTokens: readonly string[];
  readonly chainNodeIds: readonly string[];
}

export interface AlignmentResolution {
  readonly subjectKind: AlignmentSubjectKind;
  /** The entity's natural key — what an ObjectiveLink row points at. */
  readonly subjectKey: string;
  /** What a human says out loud: `PLAT-742`, `4f5a6b7`. */
  readonly subjectLabel: string;
  /** The text the semantic tier compared, kept so the panel can show it. */
  readonly subjectText: string;
  /** The subject's own event time. Orders the list and ages the verdict. */
  readonly at: number;
  readonly alignmentClass: AlignmentClass;
  readonly nodeId: string | null;
  readonly nodeTitle: string | null;
  readonly nodeRevision: number | null;
  readonly chainNodeIds: readonly string[];
  readonly confidence: number;
  readonly threshold: number;
  readonly objectiveNodeId: string | null;
  readonly objectiveTitle: string | null;
  /** Null when nothing was attributed at all — never guessed as `true`. */
  readonly servesCurrentObjective: boolean | null;
  readonly evidence: AlignmentEvidence;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly offGoalCandidate: OffGoalCandidate | null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface OffGoalGateInput {
  /** The confidence behind the attribution. */
  readonly confidence: number;
  readonly threshold: number;
  /** The objective the work is attributed to. Null means no attribution at all. */
  readonly attributedObjectiveNodeId: string | null;
  /** `false` only when the manager declared it non-current. Never inferred. */
  readonly attributedObjectiveIsCurrent: boolean | null;
  /** What the same text scored against the chain the work already sits in. */
  readonly currentObjectiveConfidence: number;
}

/**
 * Whether an OFF-GOAL label may be emitted. The only authority on that question.
 *
 * Written to fail closed on every unusual input: a non-finite confidence, a null
 * or unknown currency, a missing objective id and an empty objective id are all
 * refusals. A property test enumerates those cases; this function is what it
 * enumerates against.
 */
export function passesOffGoalGate(input: OffGoalGateInput): boolean {
  // No positive attribution: nothing is being served, so nothing can be off-goal.
  if (input.attributedObjectiveNodeId === null || input.attributedObjectiveNodeId.length === 0) return false;

  // `false` and nothing else. `null` means Compass does not know whether the
  // objective is current, and "we are not sure" must never read as "not current".
  if (input.attributedObjectiveIsCurrent !== false) return false;

  if (!Number.isFinite(input.confidence) || !Number.isFinite(input.threshold)) return false;
  if (input.confidence < input.threshold) return false;

  // The attribution has to beat the chain the work already sits in. Otherwise the
  // sprint goal explains it at least as well, and Compass has no business saying
  // the work serves something else.
  if (!Number.isFinite(input.currentObjectiveConfidence)) return false;
  return input.confidence > input.currentObjectiveConfidence;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type AlignmentVerdictKind = 'off_goal' | 'unattributed';

export interface AlignmentVerdictSubject {
  readonly kind: AlignmentSubjectKind;
  readonly key: string;
  readonly label: string;
}

export interface AlignmentVerdict {
  /** Derived from the cause and the objective, never from the report or the run. */
  readonly stableId: string;
  readonly kind: AlignmentVerdictKind;
  /** `OFF-GOAL`, or null. An unattributed item carries no label by design. */
  readonly label: string | null;
  readonly headline: string;
  readonly detail: string;
  /** Set on an unattributed verdict: the question the report asks instead. */
  readonly question: string | null;
  readonly confidence: number;
  readonly threshold: ThresholdRef;
  readonly resolvedTier: AlignmentClass;
  readonly objectiveNodeId: string | null;
  readonly objectiveTitle: string | null;
  readonly subjects: readonly AlignmentVerdictSubject[];
  readonly evidence: AlignmentEvidence;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly ageDays: number;
}

export interface AlignmentCoverageRow {
  readonly subjectKind: AlignmentSubjectKind;
  readonly alignmentClass: AlignmentClass;
  readonly count: number;
}

export interface AlignmentAssessment {
  readonly threshold: ThresholdRef;
  /** The instant the goal hierarchy was resolved for. The panel prints it. */
  readonly hierarchyResolvedAt: number;
  readonly goalNodeCount: number;
  readonly resolutions: readonly AlignmentResolution[];
  readonly coverage: readonly AlignmentCoverageRow[];
  readonly verdicts: readonly AlignmentVerdict[];
  /** One sentence stating how much of the window Compass could actually place. */
  readonly statement: string;
}

export interface AlignmentOptions {
  /**
   * The stored hierarchy, resolved for the report instant. Omitted only where
   * there is no store to read — see `goalHierarchyFromSnapshot`.
   */
  readonly hierarchy?: GoalHierarchy;
  /** The window whose commits are resolved. Defaults to the report window. */
  readonly window?: TimeWindow;
  /** Overrides T17. Configuration, so a manager can tune their own tolerance. */
  readonly threshold?: number;
}

/**
 * Resolves alignment for every commit in the window and every open item in scope.
 *
 * Pure: the hierarchy and the instant are parameters, and two calls with the same
 * arguments produce byte-identical output. Commits are the interesting subject —
 * they are where a real repository is messy — but open tickets are resolved too,
 * because the seeded off-goal stream is three tickets and a manager needs the item
 * keys, not only the SHAs.
 */
export function assessAlignment(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  options: AlignmentOptions = {},
): AlignmentAssessment {
  const hierarchy = options.hierarchy ?? goalHierarchyFromSnapshot(snapshot, instant);
  const threshold = options.threshold ?? SEMANTIC_CONFIDENCE_THRESHOLD;
  const window = options.window ?? snapshot.window;
  const context = buildContext(snapshot, hierarchy, threshold);

  const resolutions: AlignmentResolution[] = [];

  for (const commit of scopedCommits(snapshot, scope)) {
    const authoredAt = instantField(commit, 'authoredAt');
    if (authoredAt === null || !windowContains(window, authoredAt)) continue;
    resolutions.push(resolveCommit(commit, authoredAt, context));
  }

  for (const ticket of scopedTickets(snapshot, scope)) {
    if (isDone(ticket)) continue;
    resolutions.push(resolveTicket(ticket, context));
  }

  resolutions.sort(
    (left, right) =>
      compareStable(left.subjectKind, right.subjectKind) || compareStable(left.subjectKey, right.subjectKey),
  );

  // Off-goal first, then the question. The order is the order a manager should
  // read them: what Compass is confident about, then what it is asking.
  const unattributed = unattributedVerdict(snapshot.organizationId, resolutions);
  const verdicts: readonly AlignmentVerdict[] = [
    ...offGoalVerdicts(snapshot.organizationId, resolutions, instant),
    ...(unattributed === null ? [] : [unattributed]),
  ];

  return {
    threshold: thresholdRef('T17'),
    hierarchyResolvedAt: hierarchy.resolvedAt,
    goalNodeCount: hierarchy.nodes.length,
    resolutions,
    coverage: coverageOf(resolutions),
    verdicts,
    statement: coverageStatement(resolutions, hierarchy),
  };
}

// ---------------------------------------------------------------------------
// Resolution context
// ---------------------------------------------------------------------------

interface PreparedTarget {
  readonly node: GoalNodeRevision;
  readonly tokens: ReadonlySet<string>;
}

interface AlignmentContext {
  readonly hierarchy: GoalHierarchy;
  readonly threshold: number;
  readonly ticketsByItemKey: ReadonlyMap<string, AnalysisEntity>;
  readonly objectiveByProject: ReadonlyMap<string, string>;
  /** Every goal node with its token set, in node-id order — the tie-break order. */
  readonly targets: readonly PreparedTarget[];
  /** The non-current objectives, the only nodes an OFF-GOAL verdict may name. */
  readonly nonCurrentObjectives: readonly PreparedTarget[];
}

function buildContext(
  snapshot: AnalysisSnapshot,
  hierarchy: GoalHierarchy,
  threshold: number,
): AlignmentContext {
  const ticketsByItemKey = new Map<string, AnalysisEntity>();
  for (const ticket of entitiesOfKind(snapshot, 'ticket')) {
    const itemKey = textField(ticket, 'itemKey') ?? ticket.naturalKey;
    ticketsByItemKey.set(itemKey, ticket);
  }

  // `hierarchy.nodes` is already sorted by node id, so the best-match tie-break is
  // a documented total order rather than whichever row the store returned first.
  const targets = hierarchy.nodes.map((node) => ({ node, tokens: alignmentTokenSet(node.title) }));

  return {
    hierarchy,
    threshold,
    ticketsByItemKey,
    objectiveByProject: projectObjectiveIndex(snapshot),
    targets,
    nonCurrentObjectives: targets.filter(
      (target) => target.node.kind !== 'sprint_goal' && target.node.isCurrent === false,
    ),
  };
}

/** The goal node a ticket reaches, and how. Null when it reaches none. */
function goalForTicket(
  ticket: AnalysisEntity,
  context: AlignmentContext,
): { readonly node: GoalNodeRevision; readonly via: ConfiguredAlignmentEvidence['via'] } | null {
  const itemKey = textField(ticket, 'itemKey') ?? ticket.naturalKey;

  const declared = subjectLinksFor(context.hierarchy, 'ticket', itemKey)[0];
  const declaredNode = goalNodeById(context.hierarchy, declared?.nodeId ?? null);
  if (declaredNode !== null) return { node: declaredNode, via: 'declared_ticket_link' };

  const featureKey = textField(ticket, 'featureKey');
  if (featureKey !== null) {
    const viaFeature = subjectLinksFor(context.hierarchy, 'feature', featureKey)[0];
    const featureNode = goalNodeById(context.hierarchy, viaFeature?.nodeId ?? null);
    if (featureNode !== null) return { node: featureNode, via: 'declared_feature_link' };
  }

  const sprintGoal = sprintGoalFor(context.hierarchy, textField(ticket, 'sprintKey'));
  if (sprintGoal !== null) return { node: sprintGoal, via: 'ticket_sprint_goal' };

  return null;
}

/** The objective a project's team names — the chain a keyless sprint falls back to. */
function teamObjectiveNode(ticket: AnalysisEntity, context: AlignmentContext): GoalNodeRevision | null {
  const projectKey = textField(ticket, 'projectKey');
  if (projectKey === null) return null;
  return goalNodeById(context.hierarchy, context.objectiveByProject.get(projectKey) ?? null);
}

// ---------------------------------------------------------------------------
// Resolving a commit
// ---------------------------------------------------------------------------

function resolveCommit(commit: AnalysisEntity, authoredAt: Instant, context: AlignmentContext): AlignmentResolution {
  const message = textField(commit, 'message') ?? '';
  const branchName = textField(commit, 'branchName');
  const reference = commitEvidence(commit);
  const base = {
    subjectKind: 'commit' as const,
    subjectKey: commit.naturalKey,
    subjectLabel: reference.label,
    subjectText: message,
    at: authoredAt,
    threshold: context.threshold,
  };

  const messageMatch = findTicketKey(message);
  const branchMatch = findTicketKey(branchName);
  const messageTicket = messageMatch === null ? undefined : context.ticketsByItemKey.get(messageMatch.key);
  const branchTicket = branchMatch === null ? undefined : context.ticketsByItemKey.get(branchMatch.key);

  // Tier 1: the key is in the message and the ticket it names reaches a goal.
  if (messageTicket !== undefined && messageMatch !== null) {
    const goal = goalForTicket(messageTicket, context);
    if (goal !== null) {
      const refs = orderedEvidence([reference, ticketEvidence(messageTicket)]);
      return finish(base, context, goal.node, 'configured', LITERAL_MATCH_CONFIDENCE, refs, {
        tier: 'configured',
        chainNodeIds: goalChainIds(context.hierarchy, goal.node.nodeId),
        chainTitles: chainTitles(context, goal.node.nodeId),
        via: goal.via,
        matchedSubstring: messageMatch.key,
        matchedOffset: messageMatch.offset,
        matchedIn: 'commit_message',
        searchedText: message,
      });
    }
  }

  // Tier 2: a key exists somewhere, but it is either only in the branch name or it
  // names a ticket with no goal chain. Either way the hint is all there is, so the
  // link records the exact string and where it was found.
  const hint =
    messageTicket !== undefined && messageMatch !== null
      ? {
          ticket: messageTicket,
          match: messageMatch,
          searchedText: message,
          matchedIn: 'commit_message' as const,
          via: 'ticket_key_without_goal_chain' as const,
        }
      : branchTicket !== undefined && branchMatch !== null && branchName !== null
        ? {
            ticket: branchTicket,
            match: branchMatch,
            searchedText: branchName,
            matchedIn: 'branch_name' as const,
            via: 'ticket_key_in_branch' as const,
          }
        : null;

  if (hint !== null) {
    const goal = goalForTicket(hint.ticket, context);
    const node = goal?.node ?? teamObjectiveNode(hint.ticket, context);
    const refs = orderedEvidence([reference, ticketEvidence(hint.ticket)]);
    return finish(base, context, node, 'inferred', LITERAL_MATCH_CONFIDENCE, refs, {
      tier: 'inferred',
      chainNodeIds: goalChainIds(context.hierarchy, node?.nodeId ?? null),
      chainTitles: chainTitles(context, node?.nodeId ?? null),
      matchedSubstring: hint.match.key,
      matchedOffset: hint.match.offset,
      matchedIn: hint.matchedIn,
      searchedText: hint.searchedText,
      via: hint.via,
    });
  }

  // Tier 3, then the bucket.
  return semanticOrUnattributed(base, context, message, orderedEvidence([reference]), 'commits');
}

// ---------------------------------------------------------------------------
// Resolving a ticket
// ---------------------------------------------------------------------------

function resolveTicket(ticket: AnalysisEntity, context: AlignmentContext): AlignmentResolution {
  const itemKey = textField(ticket, 'itemKey') ?? ticket.naturalKey;
  const title = textField(ticket, 'title') ?? '';
  const reference = ticketEvidence(ticket);
  const refs = orderedEvidence([reference]);
  const base = {
    subjectKind: 'ticket' as const,
    subjectKey: ticket.naturalKey,
    subjectLabel: itemKey,
    subjectText: title,
    at: instantField(ticket, 'createdAt') ?? ticket.firstSeenAt,
    threshold: context.threshold,
  };

  const goal = goalForTicket(ticket, context);
  if (goal !== null) {
    return finish(base, context, goal.node, 'configured', LITERAL_MATCH_CONFIDENCE, refs, {
      tier: 'configured',
      chainNodeIds: goalChainIds(context.hierarchy, goal.node.nodeId),
      chainTitles: chainTitles(context, goal.node.nodeId),
      via: goal.via,
      matchedSubstring: null,
      matchedOffset: null,
      matchedIn: null,
      searchedText: null,
    });
  }

  // A tracker item with no sprint goal still has a team, and the team names an
  // objective. That is a stored relation rather than an inference, so it is
  // `configured` — which is why a Kanban team's work resolves against its quarter
  // objective instead of falling into the bucket.
  const teamObjective = teamObjectiveNode(ticket, context);
  if (teamObjective !== null) {
    return finish(base, context, teamObjective, 'configured', LITERAL_MATCH_CONFIDENCE, refs, {
      tier: 'configured',
      chainNodeIds: goalChainIds(context.hierarchy, teamObjective.nodeId),
      chainTitles: chainTitles(context, teamObjective.nodeId),
      via: 'team_objective',
      matchedSubstring: null,
      matchedOffset: null,
      matchedIn: null,
      searchedText: null,
    });
  }

  return semanticOrUnattributed(base, context, title, refs, 'items');
}

// ---------------------------------------------------------------------------
// Tier 3 and the bucket
// ---------------------------------------------------------------------------

interface ResolutionBase {
  readonly subjectKind: AlignmentSubjectKind;
  readonly subjectKey: string;
  readonly subjectLabel: string;
  readonly subjectText: string;
  readonly at: number;
  readonly threshold: number;
}

function semanticOrUnattributed(
  base: ResolutionBase,
  context: AlignmentContext,
  text: string,
  refs: readonly EvidenceRef[],
  noun: string,
): AlignmentResolution {
  const best = bestMatch(text, context.targets);

  if (best !== null && best.score >= context.threshold) {
    return finish(base, context, best.target.node, 'semantic', best.score, refs, {
      tier: 'semantic',
      chainNodeIds: goalChainIds(context.hierarchy, best.target.node.nodeId),
      chainTitles: chainTitles(context, best.target.node.nodeId),
      score: best.score,
      threshold: context.threshold,
      comparedTextA: text,
      comparedTextB: best.target.node.title,
      matchedTokens: best.matchedTokens,
    });
  }

  return finish(base, context, null, 'unattributed', best?.score ?? 0, refs, {
    tier: 'unattributed',
    score: best?.score ?? 0,
    threshold: context.threshold,
    comparedTextA: text,
    comparedTextB: best?.target.node.title ?? null,
    matchedTokens: best?.matchedTokens ?? [],
    question: `What ${noun === 'items' ? 'was this item' : 'was this commit'} for?`,
  });
}

interface BestMatch {
  readonly target: PreparedTarget;
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

/**
 * The best-scoring goal for a piece of text, above zero.
 *
 * Strictly-greater keeps the first target in node-id order on a tie, so two goals
 * that score identically always resolve the same way. That is the whole reason
 * `targets` is sorted rather than merely enumerated.
 */
function bestMatch(text: string, targets: readonly PreparedTarget[]): BestMatch | null {
  const tokens = alignmentTokenSet(text);
  let best: { target: PreparedTarget; score: number } | null = null;

  for (const target of targets) {
    const score = diceSimilarity(tokens, target.tokens);
    if (best === null || score > best.score) best = { target, score };
  }

  if (best === null || best.score <= 0) return null;
  return {
    target: best.target,
    score: roundScore(best.score),
    matchedTokens: sharedAlignmentTokens(tokens, best.target.tokens),
  };
}

const chainTitles = (context: AlignmentContext, nodeId: string | null): readonly string[] =>
  goalChainIds(context.hierarchy, nodeId).map(
    (id) => goalNodeById(context.hierarchy, id)?.title ?? id,
  );

/**
 * Completes a resolution: the chain, the currency of the objective it reached, and
 * the strongest non-current attribution the same text supports.
 *
 * Every resolution goes through here, which is what makes "the off-goal candidate
 * is computed for every subject regardless of tier" true by construction rather
 * than by four call sites remembering to do it.
 */
function finish(
  base: ResolutionBase,
  context: AlignmentContext,
  node: GoalNodeRevision | null,
  alignmentClass: AlignmentClass,
  confidence: number,
  evidenceRefs: readonly EvidenceRef[],
  evidence: AlignmentEvidence,
): AlignmentResolution {
  const objective = objectiveAbove(context.hierarchy, node?.nodeId ?? null);
  const chainNodeIds = goalChainIds(context.hierarchy, node?.nodeId ?? null);
  const servesCurrent = objective === null ? null : objective.isCurrent;

  return {
    ...base,
    alignmentClass,
    nodeId: node?.nodeId ?? null,
    nodeTitle: node?.title ?? null,
    nodeRevision: node?.revision ?? null,
    chainNodeIds,
    confidence: roundScore(confidence),
    objectiveNodeId: objective?.nodeId ?? null,
    objectiveTitle: objective?.title ?? null,
    servesCurrentObjective: servesCurrent,
    evidence,
    evidenceRefs,
    offGoalCandidate: offGoalCandidateFor(base, context, chainNodeIds),
  };
}

/**
 * The strongest non-current objective this text supports, with what it scored
 * against the chain it already sits on.
 *
 * `currentScore` is measured against the subject's own chain rather than against
 * every current goal in the organization, and deliberately: the question is
 * whether some abandoned objective explains this work better than *the plan this
 * work is on*, not whether it beats some other team's sprint.
 */
function offGoalCandidateFor(
  base: ResolutionBase,
  context: AlignmentContext,
  chainNodeIds: readonly string[],
): OffGoalCandidate | null {
  if (context.nonCurrentObjectives.length === 0) return null;

  const best = bestMatch(base.subjectText, context.nonCurrentObjectives);
  if (best === null || best.score < context.threshold) return null;

  const tokens = alignmentTokenSet(base.subjectText);
  let currentScore = 0;
  for (const nodeId of chainNodeIds) {
    const node = goalNodeById(context.hierarchy, nodeId);
    if (node === null) continue;
    const objective = objectiveAbove(context.hierarchy, node.nodeId);
    if (objective !== null && objective.isCurrent !== true) continue;
    currentScore = Math.max(currentScore, diceSimilarity(tokens, alignmentTokenSet(node.title)));
  }

  return {
    objectiveNodeId: best.target.node.nodeId,
    objectiveTitle: best.target.node.title,
    objectiveEffectiveUntil: best.target.node.effectiveUntil,
    score: best.score,
    threshold: context.threshold,
    currentScore: roundScore(currentScore),
    comparedTextA: base.subjectText,
    comparedTextB: best.target.node.title,
    matchedTokens: best.matchedTokens,
    chainNodeIds: goalChainIds(context.hierarchy, best.target.node.nodeId),
  };
}

// ---------------------------------------------------------------------------
// From resolutions to verdicts
// ---------------------------------------------------------------------------

/**
 * The one place an OFF-GOAL label is produced.
 *
 * Returns null unless the gate passes. There is no other constructor of
 * `OFF_GOAL_LABEL` anywhere in Compass, which is what the property test relies
 * on: enumerate inputs the gate must refuse, and no label can exist.
 */
export function offGoalVerdict(
  organizationId: string,
  candidate: OffGoalCandidate,
  subjects: readonly AlignmentVerdictSubject[],
  evidenceRefs: readonly EvidenceRef[],
  ageDays: number,
  resolvedTier: AlignmentClass,
  attributedObjectiveIsCurrent: boolean | null,
): AlignmentVerdict | null {
  const gate: OffGoalGateInput = {
    confidence: candidate.score,
    threshold: candidate.threshold,
    attributedObjectiveNodeId: candidate.objectiveNodeId,
    attributedObjectiveIsCurrent,
    currentObjectiveConfidence: candidate.currentScore,
  };
  if (!passesOffGoalGate(gate)) return null;
  if (subjects.length === 0) return null;

  const items = subjects.filter((subject) => subject.kind === 'ticket');
  const commits = subjects.filter((subject) => subject.kind === 'commit');
  const parts = [
    items.length === 0 ? null : `${items.length} open ${items.length === 1 ? 'item' : 'items'}`,
    commits.length === 0 ? null : `${commits.length} ${commits.length === 1 ? 'commit' : 'commits'}`,
  ].filter((part): part is string => part !== null);

  return {
    stableId: stableItemId({
      organizationId,
      entityRef: entityRef('objective', candidate.objectiveNodeId),
      causeKind: 'off_goal',
    }),
    kind: 'off_goal',
    label: OFF_GOAL_LABEL,
    headline: `${OFF_GOAL_LABEL} — ${parts.join(' and ')} serve ${candidate.objectiveNodeId}, "${candidate.objectiveTitle}", which is not a current objective`,
    detail:
      `${subjects.map((subject) => subject.label).join(', ')} match ${candidate.objectiveNodeId} more closely than the goal chain they sit on ` +
      `(${candidate.score} against ${candidate.currentScore}). Compass compared "${candidate.comparedTextA}" with "${candidate.comparedTextB}"; ` +
      `the shared wording is ${candidate.matchedTokens.length === 0 ? 'none' : candidate.matchedTokens.join(', ')}.`,
    question: null,
    confidence: candidate.score,
    threshold: thresholdRef('T17'),
    resolvedTier,
    objectiveNodeId: candidate.objectiveNodeId,
    objectiveTitle: candidate.objectiveTitle,
    subjects,
    evidence: {
      tier: 'semantic',
      chainNodeIds: candidate.chainNodeIds,
      chainTitles: [],
      score: candidate.score,
      threshold: candidate.threshold,
      comparedTextA: candidate.comparedTextA,
      comparedTextB: candidate.comparedTextB,
      matchedTokens: candidate.matchedTokens,
    },
    evidenceRefs,
    ageDays,
  };
}

/**
 * One verdict per non-current objective, never one per commit.
 *
 * A page that repeated the same finding once per SHA would read as an indictment
 * of whoever wrote them. Grouping by the objective the work actually serves states
 * the fact once, names the objective rather than the person, and gives the manager
 * the whole stream to talk about.
 */
function offGoalVerdicts(
  organizationId: string,
  resolutions: readonly AlignmentResolution[],
  instant: Instant,
): readonly AlignmentVerdict[] {
  const groups = new Map<string, AlignmentResolution[]>();
  for (const resolution of resolutions) {
    const candidate = resolution.offGoalCandidate;
    if (candidate === null) continue;
    const bucket = groups.get(candidate.objectiveNodeId);
    if (bucket === undefined) groups.set(candidate.objectiveNodeId, [resolution]);
    else bucket.push(resolution);
  }

  const verdicts: AlignmentVerdict[] = [];

  // Sorted by the objective the verdict will name, so two runs emit the same
  // section in the same order.
  const grouped = [...groups.entries()]
    .sort(([left], [right]) => compareStable(left, right))
    .map(([, group]) => group);

  for (const group of grouped) {
    // The strongest attribution in the group carries the evidence: it is the one a
    // manager should be shown first, and the one an argument will be about.
    const strongest = [...group].sort(
      (left, right) =>
        compareNumbers(right.offGoalCandidate?.score ?? 0, left.offGoalCandidate?.score ?? 0) ||
        compareStable(left.subjectKey, right.subjectKey),
    )[0];
    const candidate = strongest?.offGoalCandidate;
    if (strongest === undefined || candidate === undefined || candidate === null) continue;

    const subjects = group
      .map((resolution) => ({
        kind: resolution.subjectKind,
        key: resolution.subjectKey,
        label: resolution.subjectLabel,
      }))
      .sort((left, right) => compareStable(left.kind, right.kind) || compareStable(left.label, right.label));

    const earliest = Math.min(...group.map((resolution) => resolution.at));
    const verdict = offGoalVerdict(
      organizationId,
      candidate,
      subjects,
      orderedEvidence(group.flatMap((resolution) => resolution.evidenceRefs)),
      Math.max(0, wholeDaysBetween(earliest as Instant, instant)),
      strongest.alignmentClass,
      // The currency of the objective the label would name, read from the
      // hierarchy at resolution time. A non-current objective is the only kind
      // `nonCurrentObjectives` puts in a candidate, so this is `false` — stated
      // explicitly rather than assumed, because the gate refuses anything else.
      false,
    );
    // A null verdict means the gate refused, which is a correct and silent
    // outcome: no label, no fallback, no softer wording that says the same thing.
    if (verdict !== null) verdicts.push(verdict);
  }

  return verdicts;
}

/**
 * The unattributed bucket, as a question.
 *
 * Commits only. A tracker item always has a project and a team, so an unattributed
 * *item* would be a configuration gap rather than a piece of unexplained work, and
 * folding the two together would make the question vaguer than it needs to be.
 *
 * No developer is named, no verdict is stated, and the sentence is interrogative.
 * `assertUnattributedNamesNobody` enforces that rather than trusting this code to
 * keep doing it.
 *
 * `ageDays` is zero rather than measured, and that is a claim rather than an
 * omission: the bucket's membership is recomputed every day from that day's window,
 * so "day 6 of the unattributed bucket" would be an elapsed fact about a set that
 * has no continuous identity to age.
 */
function unattributedVerdict(
  organizationId: string,
  resolutions: readonly AlignmentResolution[],
): AlignmentVerdict | null {
  const orphans = resolutions.filter(
    (resolution) => resolution.subjectKind === 'commit' && resolution.alignmentClass === 'unattributed',
  );
  if (orphans.length === 0) return null;

  const labels = orphans.map((resolution) => resolution.subjectLabel);
  const noun = orphans.length === 1 ? 'commit' : 'commits';
  const best = [...orphans].sort(
    (left, right) => compareNumbers(right.confidence, left.confidence) || compareStable(left.subjectKey, right.subjectKey),
  )[0];
  const bestEvidence = best?.evidence;
  const score = bestEvidence !== undefined && bestEvidence.tier === 'unattributed' ? bestEvidence.score : 0;
  const comparedTextB =
    bestEvidence !== undefined && bestEvidence.tier === 'unattributed' ? bestEvidence.comparedTextB : null;
  const question = `What were ${orphans.length === 1 ? 'this commit' : `these ${orphans.length} commits`} for?`;

  return {
    stableId: stableItemId({
      organizationId,
      entityRef: entityRef('commit', 'unattributed'),
      causeKind: 'unattributed',
    }),
    kind: 'unattributed',
    label: null,
    headline: `${orphans.length} ${noun} could not be tied to a sprint objective`,
    detail:
      `${labels.join(', ')} name no tracker key in a commit message or a branch, and the closest goal wording scored ${score} ` +
      `against a threshold of ${thresholdRef('T17').value / 10_000}. ` +
      `${comparedTextB === null ? 'Nothing in the goal hierarchy shared a word with them.' : `The closest goal was "${comparedTextB}".`}`,
    question,
    confidence: score,
    threshold: thresholdRef('T17'),
    resolvedTier: 'unattributed',
    objectiveNodeId: null,
    objectiveTitle: null,
    subjects: orphans.map((resolution) => ({
      kind: resolution.subjectKind,
      key: resolution.subjectKey,
      label: resolution.subjectLabel,
    })),
    evidence: {
      tier: 'unattributed',
      score,
      threshold: SEMANTIC_CONFIDENCE_THRESHOLD,
      comparedTextA: best?.subjectText ?? '',
      comparedTextB,
      matchedTokens:
        bestEvidence !== undefined && bestEvidence.tier === 'unattributed' ? bestEvidence.matchedTokens : [],
      question,
    },
    evidenceRefs: orderedEvidence(orphans.flatMap((resolution) => resolution.evidenceRefs)),
    ageDays: 0,
  };
}

function coverageOf(resolutions: readonly AlignmentResolution[]): readonly AlignmentCoverageRow[] {
  const rows: AlignmentCoverageRow[] = [];
  for (const subjectKind of ['commit', 'ticket'] as const) {
    for (const alignmentClass of ALIGNMENT_CLASSES) {
      rows.push({
        subjectKind,
        alignmentClass,
        count: resolutions.filter(
          (resolution) => resolution.subjectKind === subjectKind && resolution.alignmentClass === alignmentClass,
        ).length,
      });
    }
  }
  return rows;
}

function coverageStatement(resolutions: readonly AlignmentResolution[], hierarchy: GoalHierarchy): string {
  if (hierarchy.nodes.length === 0) {
    return 'No goal hierarchy has been configured, so Compass has nothing to align this work against and will not guess.';
  }
  const commits = resolutions.filter((resolution) => resolution.subjectKind === 'commit');
  if (commits.length === 0) {
    return `No commit landed in this window, so there is nothing to align against the ${hierarchy.nodes.length} configured goals.`;
  }
  const placed = commits.filter((resolution) => resolution.alignmentClass !== 'unattributed').length;
  return `${placed} of ${commits.length} commits in this window resolve to a goal, and the rest are asked about rather than judged.`;
}

// ---------------------------------------------------------------------------
// The language guard
// ---------------------------------------------------------------------------

export class AccusatoryLanguageError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(
      `An unattributed alignment item reads as an accusation, which Compass does not make:\n${violations
        .map((violation) => `  - ${violation}`)
        .join('\n')}`,
    );
    this.name = 'AccusatoryLanguageError';
    this.violations = violations;
  }
}

/**
 * Words that turn "we could not place this" into "somebody did something wrong".
 *
 * Deliberately short and specific. This is not a sentiment filter; it is a list of
 * the exact ways the unattributed bucket could stop being a question, each of
 * which has been written by somebody at some point.
 */
export const ACCUSATORY_PHRASES: readonly string[] = Object.freeze([
  OFF_GOAL_LABEL.toLowerCase(),
  'off goal',
  'off-goal',
  'misaligned',
  'wasted',
  'unauthorised',
  'unauthorized',
  'should not have',
  'failed to',
  'ignored the',
]);

/**
 * The unattributed bucket names nobody and accuses nobody.
 *
 * Three things are checked, and the third is the one that matters most: no
 * developer's display name may appear anywhere in an unattributed verdict. Low
 * confidence phrased as a verdict against a named person is the single mistake
 * that ends adoption of a product like this, so it is a thrown error in the pure
 * layer rather than a review guideline.
 */
export function assertUnattributedNamesNobody(
  verdicts: readonly AlignmentVerdict[],
  developerNames: readonly string[],
): void {
  const violations: string[] = [];

  for (const verdict of verdicts) {
    if (verdict.kind !== 'unattributed') continue;
    const text = `${verdict.headline} ${verdict.detail} ${verdict.question ?? ''}`;
    const lowered = text.toLowerCase();

    if (verdict.label !== null) {
      violations.push(`\`${verdict.stableId}\` carries the label \`${verdict.label}\`; unattributed work carries none.`);
    }
    if (verdict.question === null || !verdict.question.trim().endsWith('?')) {
      violations.push(`\`${verdict.stableId}\` states no question, so it reads as a finding rather than as an ask.`);
    }
    for (const phrase of ACCUSATORY_PHRASES) {
      if (lowered.includes(phrase)) {
        violations.push(`\`${verdict.stableId}\` says "${phrase}", which is a verdict rather than a question.`);
      }
    }
    for (const name of developerNames) {
      if (name.length > 2 && text.includes(name)) {
        violations.push(
          `\`${verdict.stableId}\` names ${name}. Unattributed work is never attributed to a person — that is the whole point of the bucket.`,
        );
      }
    }
  }

  if (violations.length > 0) throw new AccusatoryLanguageError(violations);
}

/**
 * Every developer display name in the snapshot, for the guard above.
 *
 * @snapshotAccessor a roster lookup for a language check; a person's name does not depend on when you ask.
 */
export function developerDisplayNames(snapshot: AnalysisSnapshot): readonly string[] {
  return entitiesOfKind(snapshot, 'developer')
    .map((developer) => textField(developer, 'displayName'))
    .filter((name): name is string => name !== null)
    .sort(compareStable);
}

export class OffGoalGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffGoalGateError';
  }
}

/**
 * Every emitted OFF-GOAL verdict still satisfies the gate that produced it.
 *
 * Belt and braces over `offGoalVerdict`: the constructor cannot be bypassed, but a
 * future refactor could add a second one, and this assertion runs over the
 * finished assessment rather than over the constructor's arguments. It is called
 * from `generateStructuredReport`, so a bypass fails the report rather than
 * shipping a label.
 */
export function assertOffGoalGate(assessment: AlignmentAssessment): void {
  for (const verdict of assessment.verdicts) {
    const labelled = verdict.label === OFF_GOAL_LABEL || verdict.headline.includes(OFF_GOAL_LABEL);
    if (!labelled) continue;

    if (verdict.kind !== 'off_goal') {
      throw new OffGoalGateError(`\`${verdict.stableId}\` is labelled ${OFF_GOAL_LABEL} but is a ${verdict.kind} verdict.`);
    }
    if (verdict.objectiveNodeId === null) {
      throw new OffGoalGateError(
        `\`${verdict.stableId}\` is labelled ${OFF_GOAL_LABEL} without naming the non-current objective it serves. ` +
          'Positive attribution is a precondition of the label, not a nicety.',
      );
    }
    const threshold = verdict.threshold.value / 10_000;
    if (!(verdict.confidence >= threshold)) {
      throw new OffGoalGateError(
        `\`${verdict.stableId}\` is labelled ${OFF_GOAL_LABEL} at confidence ${verdict.confidence}, below the ${threshold} threshold ${verdict.threshold.id} sets.`,
      );
    }
  }
}

export { ALIGNMENT_TICKET_KEY_PATTERN };
