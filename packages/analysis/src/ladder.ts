import {
  branchEvidence,
  commitEvidence,
  orderedEvidence,
  pullRequestEvidence,
  releaseEvidence,
  ticketEvidence,
  type EvidenceRef,
} from './evidence.js';
import { compareNumbers, compareStable, type Instant } from './instant.js';
import {
  entitiesOfKind,
  instantField,
  isDone,
  textField,
  textListField,
  type AnalysisEntity,
  type AnalysisSnapshot,
} from './snapshot.js';

/**
 * The Completion Ladder.
 *
 * "Done" is the most overloaded word in engineering management, so Compass
 * refuses to use it as a single bit. Every Yesterday item ends with five notches
 * and a rung label, and each rung is decided by one **deterministic detector over
 * ingested data, with no inference beyond the stated rule**:
 *
 *  - **R1 accepted** — the tracker has this work item in a done-category status,
 *    or a transition into one was observed inside the window. A person's
 *    judgement that the work is finished.
 *  - **R2 merged** — a pull request the *forge* linked to this item carries a
 *    merge instant. Not "closed": a closed-unmerged pull request is abandoned
 *    work.
 *  - **R3 integrated** — the merge commit is **reachable from the repository's
 *    default-branch tip by following declared parent edges**. This is the rung
 *    that cannot be faked, and it is deliberately not the same question as R2:
 *    a pull request can be merged into a release branch, into a fork, or into a
 *    line that was later rewritten, and in each of those cases the merge state
 *    says yes while the topology says the code is not on the branch everyone
 *    builds from. Merge state alone is explicitly not sufficient here.
 *  - **R4 released** — a tag or release whose own revision reaches the merge
 *    commit through the same parent edges. Again topology, not timestamps: a tag
 *    cut five minutes after a merge on a different branch does not contain it,
 *    and comparing instants would say it did.
 *  - **R5 deployed** — never inferred. See below.
 *
 * R1 sits *below* R2 on purpose. A tracker transition is the cheapest event in
 * the chain to produce and the least connected to reality — it is one click, and
 * it is common for it to arrive with no code at all, which is exactly the
 * pathology `done-with-no-pull-request-INS-204` exists to catch. Putting it at the
 * bottom means "accepted with nothing above it" is visible as a one-notch meter
 * rather than being smoothed into a high rung.
 *
 * R5 is usually unreachable, and says so. Compass has no deploy signal unless a
 * connector supplies one, and inventing one from a merge would be the single most
 * damaging lie the product could tell. The notch renders hollow and the label
 * reads, literally, `no deploy signal available`.
 */
export const LADDER_RUNGS = ['R1', 'R2', 'R3', 'R4', 'R5'] as const;

export type LadderRungId = (typeof LADDER_RUNGS)[number];

/** `R0` is the honest floor: nothing has been crossed. */
export type HighestRung = 'R0' | LadderRungId;

export const RUNG_LABELS: Readonly<Record<LadderRungId, string>> = Object.freeze({
  R1: 'accepted',
  R2: 'merged',
  R3: 'integrated',
  R4: 'released',
  R5: 'deployed',
});

/**
 * The detector behind each rung, in one place, as prose a reviewer can check
 * against the code below it.
 *
 * `tests/completion-ladder.test.ts` asserts that every rung has one and that each
 * one names the ingested field it reads, so a rung cannot quietly acquire an
 * inference nobody documented.
 */
export const RUNG_DETECTORS: readonly {
  readonly rung: LadderRungId;
  readonly detector: string;
  readonly inferable: boolean;
}[] = Object.freeze([
  Object.freeze({
    rung: 'R1' as const,
    detector:
      'ticket.statusCategory === "done", or an observed ticket_status_transition into a done category (doneAt)',
    inferable: true,
  }),
  Object.freeze({
    rung: 'R2' as const,
    detector: 'a pull request whose linkedItemKeys names this item carries a non-null mergedAt',
    inferable: true,
  }),
  Object.freeze({
    rung: 'R3' as const,
    detector:
      'the pull request mergeRevisionId is reachable from the repository default branch_ref revisionId by commit.parentRevisionIds edges',
    inferable: true,
  }),
  Object.freeze({
    rung: 'R4' as const,
    detector:
      'a release_tag revisionId reaches the merge commit by commit.parentRevisionIds edges; the earliest qualifying tag is cited',
    inferable: true,
  }),
  Object.freeze({
    rung: 'R5' as const,
    detector: 'a deploy record from a CI/CD connector; never inferred from a merge, a tag or a timestamp',
    inferable: false,
  }),
]);

/** The words the UI must print for an unreachable R5. Asserted by a test. */
export const NO_DEPLOY_SIGNAL_STATEMENT = 'no deploy signal available';

export interface LadderNotch {
  readonly rung: LadderRungId;
  readonly label: string;
  readonly crossed: boolean;
  /**
   * Whether this rung *could* be crossed given the sources Compass has. False
   * only for R5 without a deploy signal, and then `statement` says why.
   */
  readonly reachable: boolean;
  readonly crossedAt: number | null;
  readonly evidence: readonly EvidenceRef[];
  readonly statement: string | null;
}

export interface LadderResult {
  readonly notches: readonly LadderNotch[];
  /** The highest rung crossed, gaps and all. What the notches display. */
  readonly highestCrossed: HighestRung;
  readonly highestCrossedLabel: string | null;
  /**
   * The highest rung reached with *nothing skipped below it*.
   *
   * The two differ exactly when there is a gap, and the gap is the interesting
   * part. A ticket marked done with no branch and no merge has
   * `highestCrossed: 'R1'` and `highestContiguous: 'R1'`; a pull request that
   * merged with no tracker item behind it has `highestCrossed: 'R3'` and
   * `highestContiguous: 'R0'` — the notches show the hole, and any rule that
   * means "this actually shipped" reads the contiguous value. That is the
   * difference between reporting a completion and reporting a claim of one.
   */
  readonly highestContiguous: HighestRung;
  readonly deploySignalAvailable: boolean;
  /**
   * The furthest reached rung as a phrase, for the Yesterday suffix:
   * `merged, not yet released`. Never empty — `nothing reached a completion rung`
   * is the honest floor.
   */
  readonly rungSuffix: string;
}

/** Everything about one unit of work the ladder needs, already resolved. */
export interface LadderInput {
  readonly ticket: AnalysisEntity | null;
  readonly pullRequests: readonly AnalysisEntity[];
  readonly commits: readonly AnalysisEntity[];
  readonly releaseTags: readonly AnalysisEntity[];
  readonly doneAt: Instant | null;
}

export interface LadderOptions {
  /**
   * Whether any configured connector reports a deploy signal. Supplied by the
   * caller from the connector's declared capabilities — analysis cannot ask.
   */
  readonly deploySignalAvailable: boolean;
  /** The parent-edge graph R3 and R4 walk. Built once per report. */
  readonly graph: CommitGraph;
}

// ---------------------------------------------------------------------------
// Branch topology
// ---------------------------------------------------------------------------

/**
 * The commit graph, as the connectors reported it.
 *
 * Nodes are keyed `<repositoryKey>@<revisionId>` — the same natural key
 * `packages/ingest/src/naming.ts` gives a Commit — so a revision id that happens
 * to be reused across two repositories cannot make one repository's history
 * reachable from another's.
 *
 * `defaultBranchTips` is read from the default `branch_ref` a connector reported.
 * When no ref was ingested for a repository the fallback is the newest observed
 * commit whose `branchName` equals the repository's declared default branch —
 * weaker, and stated as such, but still topology rather than a timestamp
 * comparison. A repository with neither has no tip, and then **R3 is not
 * awarded**: Compass does not know where that repository's trunk is, and
 * awarding integration on a guess is exactly what the rung exists to refuse.
 */
export interface CommitGraph {
  /** Parent edges, keyed by commit natural key. */
  readonly parents: ReadonlyMap<string, readonly string[]>;
  /** Repository key → the commit natural key its default branch points at. */
  readonly defaultBranchTips: ReadonlyMap<string, string>;
  /** The default `branch_ref` entity per repository, for evidence. */
  readonly defaultBranches: ReadonlyMap<string, AnalysisEntity>;
  /** Commits Compass actually holds, so a dangling parent id is visibly absent. */
  readonly commits: ReadonlyMap<string, AnalysisEntity>;
}

export const commitNodeKey = (repositoryKey: string, revisionId: string): string => `${repositoryKey}@${revisionId}`;

/**
 * @snapshotAccessor reshapes the already-materialized commit and branch collections into a graph; a parent edge is not a fact about any particular moment, and the detectors that consume it are the ones told the instant.
 */
export function indexCommitGraph(snapshot: AnalysisSnapshot): CommitGraph {
  const parents = new Map<string, readonly string[]>();
  const commits = new Map<string, AnalysisEntity>();
  const newestOnDefaultBranch = new Map<string, { key: string; at: number }>();

  const defaultBranchNames = new Map<string, string>();
  for (const repository of entitiesOfKind(snapshot, 'repository')) {
    const branch = textField(repository, 'defaultBranch');
    if (branch !== null) defaultBranchNames.set(repository.naturalKey, branch);
  }

  for (const commit of entitiesOfKind(snapshot, 'commit')) {
    const repositoryKey = textField(commit, 'repositoryKey');
    const revisionId = textField(commit, 'revisionId');
    if (repositoryKey === null || revisionId === null) continue;

    const key = commitNodeKey(repositoryKey, revisionId);
    commits.set(key, commit);
    parents.set(
      key,
      textListField(commit, 'parentRevisionIds').map((parent) => commitNodeKey(repositoryKey, parent)),
    );

    if (textField(commit, 'branchName') !== defaultBranchNames.get(repositoryKey)) continue;
    const authoredAt = instantField(commit, 'authoredAt') ?? (commit.firstSeenAt as Instant);
    const known = newestOnDefaultBranch.get(repositoryKey);
    // Ties broken by key, never by iteration order: a repository whose two newest
    // trunk commits share an instant must resolve to the same tip on every run.
    if (known === undefined || authoredAt > known.at || (authoredAt === known.at && compareStable(key, known.key) > 0)) {
      newestOnDefaultBranch.set(repositoryKey, { key, at: authoredAt });
    }
  }

  const defaultBranchTips = new Map<string, string>();
  const defaultBranches = new Map<string, AnalysisEntity>();

  for (const branch of entitiesOfKind(snapshot, 'branch_ref')) {
    if (branch.fields['isDefault'] !== true) continue;
    const repositoryKey = textField(branch, 'repositoryKey');
    const revisionId = textField(branch, 'revisionId');
    if (repositoryKey === null || revisionId === null) continue;
    defaultBranches.set(repositoryKey, branch);
    const key = commitNodeKey(repositoryKey, revisionId);
    // A ref pointing at a revision Compass never ingested is a shallow clone, not
    // a tip it can walk from. The observed-commit fallback below is the honest
    // answer there, and it is what keeps a partial pull from silently voiding R3
    // for a whole repository.
    if (commits.has(key)) defaultBranchTips.set(repositoryKey, key);
  }

  for (const [repositoryKey, newest] of newestOnDefaultBranch) {
    if (!defaultBranchTips.has(repositoryKey)) defaultBranchTips.set(repositoryKey, newest.key);
  }

  return { parents, defaultBranchTips, defaultBranches, commits };
}

/** The empty graph, for callers with no repository data at all. */
export const emptyCommitGraph = (): CommitGraph => ({
  parents: new Map(),
  defaultBranchTips: new Map(),
  defaultBranches: new Map(),
  commits: new Map(),
});

/**
 * Whether `target` is `from` or an ancestor of it, by declared parent edges.
 *
 * A plain breadth-first walk with a visited set, so a merge commit's two parents
 * are both followed and a cycle — which no code host can produce, but a corrupted
 * ingest could — terminates instead of hanging. Nothing here looks at an instant:
 * reachability is a fact about the graph, which is why a ladder computed for a
 * past day is identical whether it runs today or next year.
 */
export function reachesCommit(graph: CommitGraph, from: string | undefined, target: string): boolean {
  if (from === undefined) return false;
  if (from === target) return true;

  const seen = new Set<string>([from]);
  const queue: string[] = [from];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const parent of graph.parents.get(current) ?? []) {
      if (parent === target) return true;
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The detectors
// ---------------------------------------------------------------------------

const notch = (
  rung: LadderRungId,
  crossed: boolean,
  crossedAt: Instant | null,
  evidence: readonly EvidenceRef[],
  reachable = true,
  statement: string | null = null,
): LadderNotch => ({
  rung,
  label: RUNG_LABELS[rung],
  crossed,
  reachable,
  crossedAt,
  evidence: orderedEvidence(evidence),
  statement,
});

/**
 * Assesses one unit of work against the five rungs.
 *
 * Pure, and takes no instant: a rung is crossed by an event that already
 * happened, so nothing here depends on when the question is asked.
 */
export function assessLadder(input: LadderInput, options: LadderOptions): LadderResult {
  const graph = options.graph;

  const merged = input.pullRequests
    .map((pullRequest) => ({ pullRequest, mergedAt: instantField(pullRequest, 'mergedAt') }))
    .filter((entry): entry is { pullRequest: AnalysisEntity; mergedAt: Instant } => entry.mergedAt !== null)
    .sort(
      (left, right) =>
        compareNumbers(left.mergedAt, right.mergedAt) ||
        compareStable(left.pullRequest.naturalKey, right.pullRequest.naturalKey),
    );

  const firstMerge = merged[0] ?? null;

  // ---- R1: the tracker says it is finished --------------------------------
  const acceptedAt = input.doneAt;
  const accepted = acceptedAt !== null || (input.ticket !== null && isDone(input.ticket));
  const ticketRefs = input.ticket === null ? [] : [ticketEvidence(input.ticket)];

  // ---- R3: the merge commit is on the trunk -------------------------------
  //
  // Every merge is tried, not only the first: a unit of work spread over two
  // repositories is integrated once *any* of its merges is on a trunk, and
  // reporting it as not integrated because the earliest merge sat on a release
  // branch would be a false negative about work that is demonstrably shipped.
  const integrations = merged
    .map((entry) => {
      const repositoryKey = textField(entry.pullRequest, 'repositoryKey');
      const mergeRevisionId = textField(entry.pullRequest, 'mergeRevisionId');
      if (repositoryKey === null || mergeRevisionId === null) return null;
      const mergeNode = commitNodeKey(repositoryKey, mergeRevisionId);
      if (!reachesCommit(graph, graph.defaultBranchTips.get(repositoryKey), mergeNode)) return null;
      return { entry, repositoryKey, mergeNode };
    })
    .filter((candidate): candidate is { entry: typeof merged[number]; repositoryKey: string; mergeNode: string } =>
      candidate !== null,
    );

  const integration = integrations[0] ?? null;
  const integrationCommit = integration === null ? null : (graph.commits.get(integration.mergeNode) ?? null);

  // ---- R4: a tag whose revision reaches the merge -------------------------
  //
  // Decided **independently of R3**, and that is deliberate. A fix merged to a
  // release branch and tagged there really is released; it is simply not on the
  // trunk. Gating R4 on R3 would report that item as neither integrated nor
  // released, which is false, and would hide the shape the ladder exists to show:
  // the notches come out `R2 R4` with a hole at R3, `highestCrossed` is R4 and
  // `highestContiguous` is R2, so the win rule still refuses it while the meter
  // shows a reader exactly what happened.
  //
  // Topology, and the *earliest* qualifying tag, so the claim is "this work was
  // inside this release" — the weaker and defensible reading. Never a timestamp
  // comparison: a tag cut five minutes after a merge on another branch does not
  // contain it, and comparing instants would say it did.
  const mergeNodes = merged
    .map((entry) => {
      const repositoryKey = textField(entry.pullRequest, 'repositoryKey');
      const mergeRevisionId = textField(entry.pullRequest, 'mergeRevisionId');
      return repositoryKey === null || mergeRevisionId === null
        ? null
        : { repositoryKey, node: commitNodeKey(repositoryKey, mergeRevisionId), mergedAt: entry.mergedAt };
    })
    .filter((entry): entry is { repositoryKey: string; node: string; mergedAt: Instant } => entry !== null);

  const releasedIn =
    input.releaseTags
      .map((tag) => ({
        tag,
        releasedAt: instantField(tag, 'releasedAt'),
        repositoryKey: textField(tag, 'repositoryKey'),
        revisionId: textField(tag, 'revisionId'),
      }))
      .filter(
        (
          candidate,
        ): candidate is { tag: AnalysisEntity; releasedAt: Instant; repositoryKey: string; revisionId: string } =>
          candidate.releasedAt !== null && candidate.repositoryKey !== null && candidate.revisionId !== null,
      )
      .filter((candidate) =>
        mergeNodes.some(
          (merge) =>
            merge.repositoryKey === candidate.repositoryKey &&
            reachesCommit(graph, commitNodeKey(candidate.repositoryKey, candidate.revisionId), merge.node),
        ),
      )
      .sort(
        (left, right) =>
          compareNumbers(left.releasedAt, right.releasedAt) ||
          compareStable(left.tag.naturalKey, right.tag.naturalKey),
      )[0] ?? null;

  const trunkRef = integration === null ? undefined : graph.defaultBranches.get(integration.repositoryKey);

  const notches: readonly LadderNotch[] = [
    notch('R1', accepted, acceptedAt, ticketRefs),
    notch(
      'R2',
      firstMerge !== null,
      firstMerge?.mergedAt ?? null,
      firstMerge === null ? [] : [pullRequestEvidence(firstMerge.pullRequest)],
    ),
    notch(
      'R3',
      integration !== null,
      integration === null ? null : integration.entry.mergedAt,
      integration === null
        ? []
        : [
            ...(integrationCommit === null ? [] : [commitEvidence(integrationCommit)]),
            ...(trunkRef === undefined ? [] : [branchEvidence(trunkRef)]),
          ],
      true,
      integration === null && firstMerge !== null
        ? 'merged, but the merge commit is not reachable from the default branch'
        : null,
    ),
    notch(
      'R4',
      releasedIn !== null,
      releasedIn?.releasedAt ?? null,
      releasedIn === null ? [] : [releaseEvidence(releasedIn.tag)],
    ),
    options.deploySignalAvailable
      ? notch('R5', false, null, [])
      : notch('R5', false, null, [], false, NO_DEPLOY_SIGNAL_STATEMENT),
  ];

  // The highest rung *actually crossed*, not the highest contiguous one. A
  // tracker-only R1 with no code is a real and interesting state, and so is a
  // merge with no tracker item above it; presenting either as R0 would hide the
  // pathology.
  const crossed = notches.filter((entry) => entry.crossed);
  const highest = crossed.length === 0 ? null : (crossed[crossed.length - 1] as LadderNotch);

  // The first gap stops the contiguous count. Everything above it was reached
  // without the rungs below being reached, which is a claim rather than a chain.
  let contiguous: HighestRung = 'R0';
  for (const entry of notches) {
    if (!entry.crossed) break;
    contiguous = entry.rung;
  }

  return {
    notches,
    highestCrossed: highest?.rung ?? 'R0',
    highestCrossedLabel: highest?.label ?? null,
    highestContiguous: contiguous,
    deploySignalAvailable: options.deploySignalAvailable,
    rungSuffix: rungSuffixFor(notches, highest),
  };
}

/**
 * The Yesterday suffix: the furthest rung reached, and the next one it has not.
 *
 * `merged, not yet released` rather than `R2` alone, because the interesting half
 * of a completion is what has *not* happened to it yet — that is the sentence a
 * manager acts on, and it is why the suffix names the first uncrossed reachable
 * rung above the one that was reached.
 */
function rungSuffixFor(notches: readonly LadderNotch[], highest: LadderNotch | null): string {
  if (highest === null) return 'nothing reached a completion rung';

  const above = notches.slice(LADDER_RUNGS.indexOf(highest.rung) + 1);
  const nextReachable = above.find((entry) => entry.reachable && !entry.crossed);

  if (nextReachable === undefined) {
    const blocked = above.find((entry) => !entry.reachable);
    return blocked === undefined
      ? `${highest.label}`
      : `${highest.label}, and ${blocked.statement ?? NO_DEPLOY_SIGNAL_STATEMENT}`;
  }
  return `${highest.label}, not yet ${nextReachable.label}`;
}

export const rungIndex = (rung: HighestRung): number => (rung === 'R0' ? 0 : LADDER_RUNGS.indexOf(rung) + 1);

/** True when `rung` is at or above `minimum` — the comparison the win rule uses. */
export const rungAtOrAbove = (rung: HighestRung, minimum: LadderRungId): boolean =>
  rungIndex(rung) >= rungIndex(minimum);

// ---------------------------------------------------------------------------
// Resolving a unit of work out of the snapshot
// ---------------------------------------------------------------------------

/**
 * The artifacts that belong to one ticket.
 *
 * Every link here is one the *source* declared: a pull request's
 * `linkedItemKeys`, a commit's ticket key read off its own message. Compass never
 * groups artifacts because they look related, were authored by the same person,
 * or landed at a similar time — a false link would attribute someone's merge to
 * work it has nothing to do with, and the report would state that as fact.
 */
export interface WorkUnitArtifacts {
  readonly pullRequests: readonly AnalysisEntity[];
  readonly commits: readonly AnalysisEntity[];
}

/** @snapshotAccessor follows source-declared links between artifacts; no threshold and no age is computed here. */
export function indexArtifactsByTicket(snapshot: AnalysisSnapshot): ReadonlyMap<string, WorkUnitArtifacts> {
  const byTicket = new Map<string, { pullRequests: AnalysisEntity[]; commits: AnalysisEntity[] }>();

  const bucket = (ticketKey: string) => {
    const existing = byTicket.get(ticketKey);
    if (existing !== undefined) return existing;
    const created = { pullRequests: [] as AnalysisEntity[], commits: [] as AnalysisEntity[] };
    byTicket.set(ticketKey, created);
    return created;
  };

  for (const pullRequest of snapshot.collections.entities) {
    if (pullRequest.kind !== 'pull_request') continue;
    for (const ticketKey of textListField(pullRequest, 'linkedItemKeys')) {
      bucket(ticketKey).pullRequests.push(pullRequest);
    }
  }

  for (const commit of snapshot.collections.entities) {
    if (commit.kind !== 'commit') continue;
    const ticketKey = textField(commit, 'ticketKey');
    if (ticketKey === null) continue;
    bucket(ticketKey).commits.push(commit);
  }

  return byTicket;
}
