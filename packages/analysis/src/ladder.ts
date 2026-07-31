import {
  commitEvidence,
  orderedEvidence,
  pullRequestEvidence,
  releaseEvidence,
  ticketEvidence,
  type EvidenceRef,
} from './evidence.js';
import { compareNumbers, type Instant } from './instant.js';
import {
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
 * and a rung label, and the rungs are ordered by how much of the world has
 * actually changed:
 *
 *  - **R1 committed** — code exists that names this work.
 *  - **R2 merged** — it is on the target branch, so it affects everyone.
 *  - **R3 accepted** — the tracker says the work item is finished.
 *  - **R4 released** — it is inside something that was tagged and cut.
 *  - **R5 deployed** — it is running where users are.
 *
 * R3 sits *above* R2 deliberately. A merge is a fact about a repository; a
 * tracker transition is a person's judgement, and it is common for it to lag or
 * to arrive without any code at all — which is exactly the pathology
 * `done-with-no-pull-request-INS-204` exists to catch. Ordering them this way
 * means "R3 with no R1" is visible as a gap in the notches rather than being
 * smoothed over.
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
  R1: 'committed',
  R2: 'merged',
  R3: 'accepted',
  R4: 'released',
  R5: 'deployed',
});

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
   * `highestCrossed: 'R3'` and `highestContiguous: 'R0'` — the notches show the
   * hole, and any rule that means "this actually shipped" reads the contiguous
   * value. That is the difference between reporting a completion and reporting a
   * claim of one.
   */
  readonly highestContiguous: HighestRung;
  readonly deploySignalAvailable: boolean;
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
}

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
 * happened, so nothing here depends on when the question is asked. That is why
 * a ladder result for a past day is identical whether it is computed today or
 * next year.
 */
export function assessLadder(input: LadderInput, options: LadderOptions): LadderResult {
  const merged = input.pullRequests
    .map((pullRequest) => ({ pullRequest, mergedAt: instantField(pullRequest, 'mergedAt') }))
    .filter((entry): entry is { pullRequest: AnalysisEntity; mergedAt: Instant } => entry.mergedAt !== null)
    .sort((left, right) => compareNumbers(left.mergedAt, right.mergedAt));

  const firstMerge = merged[0] ?? null;

  // R1 — code exists that names this work. A commit that resolved to the ticket
  // through its message, or a pull request whose branch carries the key.
  const committedAt = input.commits
    .map((commit) => instantField(commit, 'authoredAt'))
    .filter((value): value is Instant => value !== null)
    .sort(compareNumbers)[0];
  const hasCode = input.commits.length > 0 || input.pullRequests.length > 0;
  const r1At = committedAt ?? (input.pullRequests.length > 0 ? earliestCreation(input.pullRequests) : null);

  // R4 — the first release cut at or after the merge, in a repository the merge
  // landed in.
  //
  // Time comparison rather than branch ancestry, and the reason is a real limit
  // rather than convenience: the connector port carries a commit's declared
  // parents but no guarantee of a complete ancestry walk for a shallow or
  // partial pull, so a topology answer would be right on some connectors and
  // silently wrong on others. The tag that is cited is always the *earliest*
  // qualifying one, so the claim is "this work was inside this release", which is
  // the weaker and defensible reading.
  const releasedIn =
    firstMerge === null
      ? null
      : (input.releaseTags
          .map((tag) => ({ tag, releasedAt: instantField(tag, 'releasedAt') }))
          .filter((entry): entry is { tag: AnalysisEntity; releasedAt: Instant } => entry.releasedAt !== null)
          .filter(
            (entry) =>
              entry.releasedAt >= firstMerge.mergedAt &&
              textField(entry.tag, 'repositoryKey') === textField(firstMerge.pullRequest, 'repositoryKey'),
          )
          .sort((left, right) => compareNumbers(left.releasedAt, right.releasedAt))[0] ?? null);

  const ticketEvidenceRefs = input.ticket === null ? [] : [ticketEvidence(input.ticket)];

  const notches: readonly LadderNotch[] = [
    notch(
      'R1',
      hasCode,
      r1At,
      input.commits.map(commitEvidence).concat(input.pullRequests.map(pullRequestEvidence)),
    ),
    notch('R2', firstMerge !== null, firstMerge?.mergedAt ?? null, firstMerge === null ? [] : [pullRequestEvidence(firstMerge.pullRequest)]),
    notch('R3', input.doneAt !== null || (input.ticket !== null && isDone(input.ticket)), input.doneAt, ticketEvidenceRefs),
    notch('R4', releasedIn !== null, releasedIn?.releasedAt ?? null, releasedIn === null ? [] : [releaseEvidence(releasedIn.tag)]),
    options.deploySignalAvailable
      ? notch('R5', false, null, [])
      : notch('R5', false, null, [], false, NO_DEPLOY_SIGNAL_STATEMENT),
  ];

  // The highest rung *actually crossed*, not the highest contiguous one. A
  // tracker-only R3 with no code is a real and interesting state; presenting it
  // as R0 because R1 is missing would hide the pathology.
  const crossed = notches.filter((entry) => entry.crossed);
  const highest = crossed.length === 0 ? null : crossed[crossed.length - 1];

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
  };
}

function earliestCreation(pullRequests: readonly AnalysisEntity[]): Instant | null {
  return (
    pullRequests
      .map((pullRequest) => instantField(pullRequest, 'createdAt'))
      .filter((value): value is Instant => value !== null)
      .sort(compareNumbers)[0] ?? null
  );
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
