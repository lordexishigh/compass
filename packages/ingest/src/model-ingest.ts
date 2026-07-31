import { earliest, type Instant, type TimeWindow } from '@compass/clock';
import type {
  ArtifactKind,
  BranchRefRecord,
  CommitRecord,
  ConnectorPort,
  ConnectorRecordFor,
  ExternalIdentity,
  IssueRecord,
  IssueTransitionRecord,
  PullRequestRecord,
  ReleaseTagRecord,
  ReviewRecord,
  SprintRecord,
  SprintScopeChangeRecord,
} from '@compass/connector-port';
import { fromDatabaseInstant, historyRowId, insertIngestRun, type EntityKind } from '@compass/db';
import {
  IdentityResolver,
  detectBlockedButDone,
  detectBlockedButMerged,
  detectDoneButReopened,
  identityNaturalKey,
  recordContradiction,
  type ContradictionCandidate,
  type EvidenceRef,
  type FieldValue,
  type KnowledgeStore,
  type ObserveOutcome,
} from '@compass/knowledge-model';

import { ingestWindow, type IngestArtifactBatch, type IngestRunSummary } from './ingest-window.js';
import {
  branchRefNaturalKey,
  commitNaturalKey,
  featureNaturalKey,
  firstTicketKey,
  judgementNaturalKey,
  projectNaturalKey,
  pullRequestNaturalKey,
  releaseTagNaturalKey,
  repositoryNaturalKey,
  reviewNaturalKey,
  sprintNaturalKey,
  ticketNaturalKey,
} from './naming.js';
import { ArchivalFilter, loadTrackingDecisions, type SkippedByArchival } from './tracking.js';

/**
 * Ingest: one half-open window, from the port into the versioned model.
 *
 * The stage is incremental and idempotent, and those two words carry the design:
 *
 *  - **Incremental** — the window is a parameter, so a backfill and a live pull are
 *    the same code path. Windows may overlap and may arrive out of order; the store
 *    handles both, widening sighting bounds without letting an older record
 *    overwrite a newer belief.
 *  - **Idempotent** — every write is keyed by something the source owns, and every
 *    instant written comes from a record's own event time rather than the run
 *    clock. Ingest the same window three times and the knowledge tables are
 *    byte-identical after the second and third; only the `ingest_runs` journal
 *    grows, because a run genuinely did happen.
 *
 * Nothing here reads a clock — `now` arrives as a parameter and lint enforces it —
 * and nothing here knows whether the connector behind the port is seeded or live.
 */

export interface ModelIngestRequest {
  readonly organizationId: string;
  readonly window: TimeWindow;
  /** The ingest instant, resolved at the process edge and threaded down. */
  readonly now: Instant;
  /** The IngestRun's id, supplied by the edge. One run, one row, always. */
  readonly runId: string;
  readonly sourceKeys?: readonly string[];
  /**
   * When false, contradictions are detected and returned but no Correction row is
   * written — for a dry run over historical windows that should not restate old
   * news as today's correction.
   */
  readonly recordCorrections?: boolean;
}

export interface ObservationTally {
  readonly created: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly superseded: number;
}

export interface ModelIngestResult {
  readonly summary: IngestRunSummary;
  readonly runId: string;
  readonly totals: ObservationTally;
  /** Per entity kind, in the order the kinds were first observed. */
  readonly perKind: readonly ({ readonly kind: EntityKind } & ObservationTally)[];
  readonly transitionsObserved: number;
  readonly scopeChangesObserved: number;
  /** Contradictions found, whether or not they were written. */
  readonly contradictions: readonly ContradictionCandidate[];
  readonly correctionIds: readonly string[];
  readonly unmatchedIdentityKeys: readonly string[];
  /** What archival declined to observe. Stated so an empty run is never a mystery. */
  readonly skippedByArchival: SkippedByArchival;
}

const EMPTY_TALLY: ObservationTally = { created: 0, changed: 0, unchanged: 0, superseded: 0 };

/** Accumulates observe outcomes so the caller can assert "nothing changed". */
class Tally {
  readonly #byKind = new Map<EntityKind, ObservationTally>();
  #totals: ObservationTally = EMPTY_TALLY;

  add(kind: EntityKind, outcome: ObserveOutcome): void {
    this.#totals = bump(this.#totals, outcome);
    this.#byKind.set(kind, bump(this.#byKind.get(kind) ?? EMPTY_TALLY, outcome));
  }

  get totals(): ObservationTally {
    return this.#totals;
  }

  get perKind(): readonly ({ readonly kind: EntityKind } & ObservationTally)[] {
    return [...this.#byKind.entries()].map(([kind, tally]) => ({ kind, ...tally }));
  }
}

function bump(tally: ObservationTally, outcome: ObserveOutcome): ObservationTally {
  return { ...tally, [outcome]: tally[outcome] + 1 };
}

/**
 * The typed view of one artifact batch.
 *
 * `ingestWindow` returns records as `unknown[]` because it walks every artifact
 * family through one generic fetcher. The batch for a given kind was produced by
 * that kind's port method, so this narrowing is sound; it is done here, once, so
 * the projection below stays typed.
 */
function recordsFor<TKind extends ArtifactKind>(
  batches: readonly IngestArtifactBatch[],
  kind: TKind,
): readonly ConnectorRecordFor<TKind>[] {
  const batch = batches.find((candidate) => candidate.artifact === kind);
  return (batch?.records ?? []) as readonly ConnectorRecordFor<TKind>[];
}

/**
 * A connector identity as the resolver wants it.
 *
 * `displayName` is carried across so the unmatched-identity queue can show a
 * manager something recognisable. It is not, and must never be, part of matching.
 */
const actorOf = (identity: ExternalIdentity) => ({
  kind: identity.kind,
  value: identity.value,
  displayName: identity.displayName,
});

/** An evidence reference as plain JSON, for an `evidence` jsonb column. */
const evidenceJson = (evidence: EvidenceRef): Record<string, string> => ({
  kind: evidence.kind,
  label: evidence.label,
  sourceKey: evidence.sourceKey,
  sourceRecordId: evidence.sourceRecordId,
});

/**
 * Pulls a window through the port, projects it into the knowledge model,
 * reconciles contradictions and writes the IngestRun.
 */
export async function ingestWindowIntoModel(
  connector: ConnectorPort,
  store: KnowledgeStore,
  request: ModelIngestRequest,
): Promise<ModelIngestResult> {
  const { batches, summary } = await ingestWindow(connector, {
    organizationId: request.organizationId,
    window: request.window,
    now: request.now,
    ...(request.sourceKeys ? { sourceKeys: request.sourceKeys } : {}),
  });

  const resolver = new IdentityResolver(store);
  await resolver.load();

  // Archival is honoured here, at the one boundary where "exclude it from future
  // windows" can actually be true. Nothing is deleted and no version is appended —
  // records for an archived repository are simply not observed, and the count of what
  // was declined is reported so a run that ingested nothing says why.
  const archival = new ArchivalFilter(await loadTrackingDecisions(store));

  const tally = new Tally();
  const unmatched = new Set<string>();
  const contradictions: ContradictionCandidate[] = [];
  const correctionIds: string[] = [];

  const observe = async (
    kind: EntityKind,
    naturalKey: string,
    fields: Readonly<Record<string, FieldValue>>,
    observedAt: Instant,
    evidence: EvidenceRef | null,
  ) => {
    const result = await store.observe({ kind, naturalKey, fields, observedAt, evidence });
    tally.add(kind, result.outcome);
    return result;
  };

  /**
   * Who an artifact belongs to, and — always — which identifier said so.
   *
   * `identityKey` is returned whether or not a link matched, and stored on the
   * artifact. That is what lets attribution be *re-resolved* when a report is
   * generated: a merge or an un-merge changes which Developer the identifier maps to,
   * and the next report follows the new mapping with no re-ingest. Storing only
   * `developerKey` would freeze the answer at ingest time, and un-merge could then
   * only approximate the attribution it was meant to restore exactly.
   */
  const resolveOwner = async (
    identity: ExternalIdentity | null,
    artifactKind: string,
    sourceKey: string,
    sourceRecordId: string,
    observedAt: Instant,
  ): Promise<{
    readonly developerKey: string | null;
    readonly unmatchedKey: string | null;
    readonly identityKey: string | null;
  }> => {
    if (identity === null) return { developerKey: null, unmatchedKey: null, identityKey: null };

    const actor = actorOf(identity);
    const identityKey = identityNaturalKey(actor.kind, actor.value);
    const resolution = await resolver.resolve(actor, {
      artifactKind,
      sourceKey,
      sourceRecordId,
      observedAt,
    });

    if (resolution.matched) {
      return { developerKey: resolution.developerKey, unmatchedKey: null, identityKey };
    }
    unmatched.add(resolution.unmatchedIdentityKey);
    return { developerKey: null, unmatchedKey: resolution.unmatchedIdentityKey, identityKey };
  };

  // ---- sprints first: tickets and scope changes both refer to them -----------
  const sprintRecords = recordsFor(batches, 'sprints');
  const sprintStartByKey = new Map<string, Instant>();

  for (const sprint of sprintRecords as readonly SprintRecord[]) {
    if (archival.skipsProject(sprint.projectKey)) continue;
    const naturalKey = sprintNaturalKey(sprint.sourceKey, sprint.sourceRecordId);
    sprintStartByKey.set(naturalKey, sprint.startAt);
    await observe(
      'sprint',
      naturalKey,
      {
        projectKey: sprint.projectKey,
        name: sprint.name,
        goal: sprint.goal,
        state: sprint.state,
        startAt: sprint.startAt,
        endAt: sprint.endAt,
        completedAt: sprint.completedAt,
        committedItemKeys: [...sprint.committedItemKeys].sort(),
      },
      sprint.occurredAt,
      { kind: 'issue', label: sprint.name, sourceKey: sprint.sourceKey, sourceRecordId: sprint.sourceRecordId },
    );

    await observeProject(observe, sprint.projectKey, sprint.occurredAt);
  }

  // ---- issues -> features and tickets ---------------------------------------
  const issueRecords = recordsFor(batches, 'issues') as readonly IssueRecord[];

  for (const issue of issueRecords) {
    if (archival.skipsProject(issue.projectKey)) continue;
    await observeProject(observe, issue.projectKey, issue.occurredAt);

    const evidence: EvidenceRef = {
      kind: 'issue',
      label: issue.itemKey,
      sourceKey: issue.sourceKey,
      sourceRecordId: issue.sourceRecordId,
    };

    // A Feature is a parent work item the tracker itself declares — either through
    // an explicit parent link, or because the item's own type is a parent type.
    // Compass never invents one by grouping tickets that look related.
    if (issue.parentItemKey !== null) {
      await observe(
        'feature',
        featureNaturalKey(issue.parentItemKey),
        { projectKey: issue.projectKey, title: issue.parentItemKey, status: null, statusCategory: null },
        issue.occurredAt,
        evidence,
      );
    }
    if (PARENT_ITEM_TYPES.has(issue.itemType.toLowerCase())) {
      await observe(
        'feature',
        featureNaturalKey(issue.itemKey),
        {
          projectKey: issue.projectKey,
          title: issue.title,
          status: issue.status,
          statusCategory: issue.statusCategory,
        },
        issue.occurredAt,
        evidence,
      );
    }

    const assignee = await resolveOwner(
      issue.assigneeIdentity,
      'issues',
      issue.sourceKey,
      issue.sourceRecordId,
      issue.occurredAt,
    );
    const reporter = await resolveOwner(
      issue.reporterIdentity,
      'issues',
      issue.sourceKey,
      issue.sourceRecordId,
      issue.occurredAt,
    );

    const naturalKey = ticketNaturalKey(issue.itemKey);
    const priorTicket = await store.read('ticket', naturalKey);

    // Reconciliation happens against the belief already on disk, before it moves.
    if (priorTicket !== null) {
      for (const candidate of [
        detectBlockedButDone(
          priorTicket,
          { status: issue.status, statusCategory: issue.statusCategory },
          evidence,
          issue.occurredAt,
        ),
        detectDoneButReopened(
          priorTicket,
          { status: issue.status, statusCategory: issue.statusCategory },
          evidence,
          issue.occurredAt,
        ),
      ]) {
        if (candidate === null) continue;
        contradictions.push(candidate);
        if (request.recordCorrections !== false) {
          correctionIds.push(await recordContradiction(store, candidate, priorTicket.version, request.now));
        }
      }
    }

    const sprintRef = issue.sprintRefs[0];
    await observe(
      'ticket',
      naturalKey,
      {
        projectKey: issue.projectKey,
        featureKey: issue.parentItemKey === null ? null : featureNaturalKey(issue.parentItemKey),
        itemKey: issue.itemKey,
        title: issue.title,
        status: issue.status,
        statusCategory: issue.statusCategory,
        itemType: issue.itemType,
        priority: issue.priority,
        estimatePoints: issue.estimatePoints,
        labels: [...issue.labels].sort(),
        assigneeDeveloperKey: assignee.developerKey,
        reporterDeveloperKey: reporter.developerKey,
        sprintKey: sprintRef === undefined ? null : sprintNaturalKey(issue.sourceKey, sprintRef),
        flaggedBlocked: issue.flaggedBlocked,
        createdAt: issue.createdAt,
        resolvedAt: issue.resolvedAt,
      },
      issue.occurredAt,
      evidence,
    );
  }

  // ---- tracker history ------------------------------------------------------
  const transitionRecords = recordsFor(batches, 'issue_transitions') as readonly IssueTransitionRecord[];
  for (const transition of transitionRecords) {
    const actor =
      transition.actorIdentity === null ? null : resolver.resolveWithoutWitness(actorOf(transition.actorIdentity));
    await store.recordTicketTransition({
      ticketKey: ticketNaturalKey(transition.itemKey),
      sourceKey: transition.sourceKey,
      sourceRecordId: transition.sourceRecordId,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      fromStatusCategory: transition.fromStatusCategory,
      toStatusCategory: transition.toStatusCategory,
      actorDeveloperKey: actor,
      transitionedAt: transition.transitionedAt,
    });
  }

  const scopeChangeRecords = recordsFor(batches, 'sprint_scope_changes') as readonly SprintScopeChangeRecord[];
  for (const change of scopeChangeRecords) {
    const actor = change.actorIdentity === null ? null : resolver.resolveWithoutWitness(actorOf(change.actorIdentity));

    // Only what the source said. Whether this landed after the sprint started is
    // derived later, against the sprint row — which a backfill may not have
    // reached yet, and which append-only history could never be corrected for.
    await store.recordSprintScopeChange({
      sprintKey: sprintNaturalKey(change.sourceKey, change.sprintRef),
      ticketKey: ticketNaturalKey(change.itemKey),
      sourceKey: change.sourceKey,
      sourceRecordId: change.sourceRecordId,
      change: change.change,
      actorDeveloperKey: actor,
      changedAt: change.changedAt,
    });
  }

  // ---- code artifacts -------------------------------------------------------
  for (const pullRequest of recordsFor(batches, 'pull_requests') as readonly PullRequestRecord[]) {
    if (archival.skipsRepository(pullRequest.repositoryKey)) continue;
    await observeRepository(observe, pullRequest.repositoryKey, pullRequest.occurredAt);

    const evidence: EvidenceRef = {
      kind: 'pull_request',
      label: `#${pullRequest.displayNumber}`,
      sourceKey: pullRequest.sourceKey,
      sourceRecordId: pullRequest.sourceRecordId,
    };
    const author = await resolveOwner(
      pullRequest.authorIdentity,
      'pull_requests',
      pullRequest.sourceKey,
      pullRequest.sourceRecordId,
      pullRequest.occurredAt,
    );

    await observe(
      'pull_request',
      pullRequestNaturalKey(pullRequest.sourceKey, pullRequest.sourceRecordId),
      {
        repositoryKey: pullRequest.repositoryKey,
        displayNumber: pullRequest.displayNumber,
        title: pullRequest.title,
        state: pullRequest.state,
        authorDeveloperKey: author.developerKey,
        authorIdentityKey: author.identityKey,
        createdAt: pullRequest.createdAt,
        mergedAt: pullRequest.mergedAt,
        closedAt: pullRequest.closedAt,
        sourceBranch: pullRequest.sourceBranch,
        targetBranch: pullRequest.targetBranch,
        headRevisionId: pullRequest.headRevisionId,
        mergeRevisionId: pullRequest.mergeRevisionId,
        linkedItemKeys: [...pullRequest.linkedWorkItemKeys].sort(),
        requestedReviewerKeys: [
          ...new Set(
            pullRequest.requestedReviewerIdentities
              .map((identity) => resolver.resolveWithoutWitness(actorOf(identity)))
              .filter((key): key is string => key !== null),
          ),
        ].sort(),
      },
      pullRequest.occurredAt,
      evidence,
    );

    // "Reported blocked yesterday, actually merged": the belief on disk is a
    // blocked ticket, and a merged pull request names it.
    if (pullRequest.mergedAt !== null) {
      for (const itemKey of pullRequest.linkedWorkItemKeys) {
        const ticket = await store.read('ticket', ticketNaturalKey(itemKey));
        if (ticket === null) continue;
        const candidate = detectBlockedButMerged(ticket, {
          ticketKey: itemKey,
          mergedAt: pullRequest.mergedAt,
          evidence,
        });
        if (candidate === null) continue;
        contradictions.push(candidate);
        if (request.recordCorrections !== false) {
          correctionIds.push(await recordContradiction(store, candidate, ticket.version, request.now));
        }
      }
    }
  }

  for (const review of recordsFor(batches, 'reviews') as readonly ReviewRecord[]) {
    if (archival.skipsRepository(review.repositoryKey)) continue;
    await observeRepository(observe, review.repositoryKey, review.occurredAt);
    const reviewer = await resolveOwner(
      review.reviewerIdentity,
      'reviews',
      review.sourceKey,
      review.sourceRecordId,
      review.occurredAt,
    );

    await observe(
      'review',
      reviewNaturalKey(review.sourceKey, review.sourceRecordId),
      {
        pullRequestKey: pullRequestNaturalKey(review.sourceKey, review.pullRequestRef),
        reviewerDeveloperKey: reviewer.developerKey,
        verdict: review.verdict,
        submittedAt: review.submittedAt,
        commentCount: review.commentCount,
      },
      review.occurredAt,
      {
        kind: 'pull_request',
        label: review.verdict,
        sourceKey: review.sourceKey,
        sourceRecordId: review.sourceRecordId,
      },
    );
  }

  for (const commit of recordsFor(batches, 'commits') as readonly CommitRecord[]) {
    if (archival.skipsRepository(commit.repositoryKey)) continue;
    await observeRepository(observe, commit.repositoryKey, commit.occurredAt);
    const author = await resolveOwner(
      commit.authorIdentity,
      'commits',
      commit.sourceKey,
      commit.sourceRecordId,
      commit.occurredAt,
    );

    await observe(
      'commit',
      commitNaturalKey(commit.repositoryKey, commit.revisionId),
      {
        repositoryKey: commit.repositoryKey,
        revisionId: commit.revisionId,
        authorDeveloperKey: author.developerKey,
        unmatchedIdentityKey: author.unmatchedKey,
        authorIdentityKey: author.identityKey,
        authoredAt: commit.authoredAt,
        message: commit.message,
        changedFileCount: commit.changedFileCount,
        branchName: commit.branchName,
        parentRevisionIds: [...commit.parentRevisionIds],
        // Read off the message, never inferred from timing or authorship.
        ticketKey: firstTicketKey(commit.message),
      },
      commit.occurredAt,
      {
        kind: 'commit',
        label: commit.revisionId.slice(0, 7),
        sourceKey: commit.sourceKey,
        sourceRecordId: commit.sourceRecordId,
      },
    );
  }

  for (const branch of recordsFor(batches, 'branch_refs') as readonly BranchRefRecord[]) {
    if (archival.skipsRepository(branch.repositoryKey)) continue;
    await observeRepository(observe, branch.repositoryKey, branch.occurredAt);
    await observe(
      'branch_ref',
      branchRefNaturalKey(branch.repositoryKey, branch.name),
      {
        repositoryKey: branch.repositoryKey,
        name: branch.name,
        revisionId: branch.revisionId,
        isDefault: branch.isDefault,
      },
      branch.occurredAt,
      { kind: 'branch', label: branch.name, sourceKey: branch.sourceKey, sourceRecordId: branch.sourceRecordId },
    );
  }

  for (const tag of recordsFor(batches, 'release_tags') as readonly ReleaseTagRecord[]) {
    if (archival.skipsRepository(tag.repositoryKey)) continue;
    await observeRepository(observe, tag.repositoryKey, tag.occurredAt);
    await observe(
      'release_tag',
      releaseTagNaturalKey(tag.repositoryKey, tag.name),
      {
        repositoryKey: tag.repositoryKey,
        name: tag.name,
        revisionId: tag.revisionId,
        releasedAt: tag.releasedAt,
        description: tag.description,
      },
      tag.occurredAt,
      { kind: 'release', label: tag.name, sourceKey: tag.sourceKey, sourceRecordId: tag.sourceRecordId },
    );
  }

  // ---- judgements a source states outright ----------------------------------
  await observeBlockers(store, observe, issueRecords);
  await observeScopeCreepRisks(store, observe);

  // ---- the run journal ------------------------------------------------------
  await insertIngestRun(
    store.scoped,
    {
      id: request.runId,
      connectorId: summary.connectorId,
      window: summary.window,
      startedAt: summary.startedAt,
      completedAt: request.now,
      status: summary.status,
      totalRecords: summary.totalRecords,
      artifactCounts: summary.artifactCounts,
    },
    summary.coverage.map((coverage) => ({
      // Derived from the run and the source, so a replay with the same run id
      // lands on the same row rather than duplicating it, and the journal stays
      // comparable. `insertIngestRun` upserts on that id: a re-ingest of the same
      // window records the later observation instead of failing the run.
      id: historyRowId(
        store.organizationId,
        'ingest_source_coverage',
        request.runId,
        `${coverage.sourceKey}:${coverage.artifact}`,
      ),
      coverage,
    })),
  );

  return {
    summary,
    runId: request.runId,
    totals: tally.totals,
    perKind: tally.perKind,
    transitionsObserved: transitionRecords.length,
    scopeChangesObserved: scopeChangeRecords.length,
    contradictions,
    correctionIds,
    unmatchedIdentityKeys: [...unmatched].sort(),
    skippedByArchival: archival.skipped,
  };
}

type ObserveFn = (
  kind: EntityKind,
  naturalKey: string,
  fields: Readonly<Record<string, FieldValue>>,
  observedAt: Instant,
  evidence: EvidenceRef | null,
) => Promise<{ readonly outcome: ObserveOutcome }>;

/** Item types a tracker uses for parent work. Matched case-insensitively. */
const PARENT_ITEM_TYPES = new Set(['epic', 'feature', 'initiative', 'theme']);

/**
 * A Project exists because artifacts refer to it. Its name is its key until a
 * manager configures something better — Compass does not invent a prettier one.
 */
async function observeProject(observe: ObserveFn, projectKey: string, observedAt: Instant): Promise<void> {
  await observe(
    'project',
    projectNaturalKey(projectKey),
    { name: projectKey, teamKey: null, methodology: null, defaultBranch: null },
    observedAt,
    null,
  );
}

async function observeRepository(observe: ObserveFn, repositoryKey: string, observedAt: Instant): Promise<void> {
  await observe(
    'repository',
    repositoryNaturalKey(repositoryKey),
    { name: repositoryKey, projectKey: null, defaultBranch: null },
    observedAt,
    null,
  );
}

async function sprintStartFromStore(store: KnowledgeStore, sprintKey: string): Promise<Instant | null> {
  const sprint = await store.read('sprint', sprintKey);
  const startAt = sprint?.fields['startAt'];
  return typeof startAt === 'number' ? (startAt as Instant) : null;
}

/**
 * Blockers, from the tracker's own marker.
 *
 * This is an *observation*, not an analysis: the tracker said blocked, so Compass
 * records a blocker. Inferring blockage from silence or from a stalled review is
 * the analysis core's job and lands with it.
 *
 * `detectedAt` is pinned to the earliest evidence — a blocked status transition if
 * one has been observed, otherwise the first sighting — and then never moves, so a
 * re-ingest cannot make an old blocker look new. Its `first_seen_at` is what "day
 * 6" is counted from.
 */
async function observeBlockers(
  store: KnowledgeStore,
  observe: ObserveFn,
  issues: readonly IssueRecord[],
): Promise<void> {
  if (issues.length === 0) return;
  const transitions = await store.ticketTransitions();
  const blockedSince = new Map<string, Instant>();

  for (const transition of transitions) {
    if (!/blocked/i.test(transition.toStatus)) continue;
    const at = fromDatabaseInstant(transition.transitionedAt);
    const existing = blockedSince.get(transition.ticketKey);
    blockedSince.set(transition.ticketKey, existing === undefined ? at : earliest(existing, at));
  }

  for (const issue of issues) {
    const ticketKey = ticketNaturalKey(issue.itemKey);
    const naturalKey = judgementNaturalKey('ticket', ticketKey, 'tracker_blocked');
    const isBlocked = issue.statusCategory !== 'done' && (issue.flaggedBlocked || /blocked/i.test(issue.status));
    const prior = await store.read('blocker', naturalKey);

    // Nothing to say: not blocked, and never was.
    if (!isBlocked && prior === null) continue;

    const evidence: EvidenceRef = {
      kind: 'issue',
      label: issue.itemKey,
      sourceKey: issue.sourceKey,
      sourceRecordId: issue.sourceRecordId,
    };

    // `detectedAt` only ever moves earlier: a later window may reveal the blocked
    // transition that a first pass could not see. Monotone in one direction means
    // it converges and a replay cannot disturb it.
    const candidates = [
      prior === null ? null : (prior.fields['detectedAt'] as number | null),
      blockedSince.get(ticketKey) ?? null,
      issue.occurredAt,
    ].filter((value): value is number => value !== null);
    const detectedAt = Math.min(...candidates) as Instant;
    const priorResolvedAt = prior === null ? null : (prior.fields['resolvedAt'] as number | null);

    await observe(
      'blocker',
      naturalKey,
      {
        subjectKind: 'ticket',
        subjectKey: ticketKey,
        teamKey: null,
        summary: isBlocked
          ? `${issue.itemKey} is blocked: ${issue.title}`
          : `${issue.itemKey} is no longer blocked: ${issue.title}`,
        state: isBlocked ? 'open' : 'resolved',
        cause: issue.flaggedBlocked ? 'tracker_flag' : 'status_name',
        detectedAt,
        // Pinned once it is known, so a later sighting of a cleared blocker cannot
        // restate when it cleared.
        resolvedAt: isBlocked ? null : (priorResolvedAt ?? issue.occurredAt),
        evidence: [evidenceJson(evidence)],
      },
      issue.occurredAt,
      evidence,
    );
  }
}

/**
 * Scope creep, from observed sprint scope changes.
 *
 * Also an observation rather than a judgement of severity: the source said an item
 * entered a sprint after it had started. The count rises only when a genuinely new
 * scope change is seen, because the underlying history is append-only and keyed by
 * the source's own record id.
 */
async function observeScopeCreepRisks(store: KnowledgeStore, observe: ObserveFn): Promise<void> {
  const changes = await store.sprintScopeChanges();
  const bySprint = new Map<string, { readonly added: string[]; detectedAt: Instant; lastAt: Instant; refs: string[] }>();

  // The sprint start is read here rather than at append time, so a scope change
  // ingested before its sprint is classified correctly once the sprint arrives.
  const sprintStarts = new Map<string, Instant | null>();
  for (const sprintKey of new Set(changes.map((change) => change.sprintKey))) {
    sprintStarts.set(sprintKey, await sprintStartFromStore(store, sprintKey));
  }

  for (const change of changes) {
    if (change.change !== 'added') continue;
    const sprintStart = sprintStarts.get(change.sprintKey) ?? null;
    const at = fromDatabaseInstant(change.changedAt);
    if (sprintStart === null || at <= sprintStart) continue;
    const existing = bySprint.get(change.sprintKey);
    if (existing === undefined) {
      bySprint.set(change.sprintKey, {
        added: [change.ticketKey],
        detectedAt: at,
        lastAt: at,
        refs: [`${change.sourceKey}:${change.sourceRecordId}`],
      });
      continue;
    }
    existing.added.push(change.ticketKey);
    existing.refs.push(`${change.sourceKey}:${change.sourceRecordId}`);
    if (at < existing.detectedAt) existing.detectedAt = at;
    if (at > existing.lastAt) existing.lastAt = at;
  }

  for (const [sprintKey, group] of [...bySprint.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const sprint = await store.read('sprint', sprintKey);
    const sprintName = sprint === null ? sprintKey : String(sprint.fields['name']);
    const added = [...new Set(group.added)].sort();

    await observe(
      'risk',
      judgementNaturalKey('sprint', sprintKey, 'scope_added_after_start'),
      {
        subjectKind: 'sprint',
        subjectKey: sprintKey,
        teamKey: null,
        summary: `${added.length} item${added.length === 1 ? '' : 's'} entered ${sprintName} after it started: ${added.join(', ')}.`,
        state: 'open',
        cause: 'scope_added_after_start',
        severity: added.length >= 3 ? 'high' : 'medium',
        detectedAt: group.detectedAt,
        resolvedAt: null,
        evidence: [...new Set(group.refs)].sort().map((ref) =>
          evidenceJson({
            kind: 'issue',
            label: ref,
            sourceKey: ref.slice(0, ref.indexOf(':')),
            sourceRecordId: ref.slice(ref.indexOf(':') + 1),
          }),
        ),
      },
      group.lastAt,
      null,
    );
  }
}
