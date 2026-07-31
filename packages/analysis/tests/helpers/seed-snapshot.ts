import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MILLIS_PER_DAY,
  MILLIS_PER_HOUR,
  addDaysInZone,
  instantFromIso,
  startOfDayInZone,
  timeWindow,
  type Instant,
  type TimeWindow,
} from '@compass/clock';

import type {
  AnalysisCollections,
  AnalysisEntity,
  AnalysisScope,
  AnalysisSnapshot,
  AnalysisSprintScopeChange,
  AnalysisTicketTransition,
  FieldValue,
} from '@compass/analysis';

/**
 * The seeded organization, projected into an `AnalysisSnapshot` in memory.
 *
 * The analysis core's tests must run against the real dataset — a hand-rolled
 * fixture would quietly avoid the hard cases the seed plants on purpose (the
 * review bottleneck, the blocked-then-merged ticket, the Kanban team with no
 * points, the rising debt curve). But they must also stay fast and pure: spinning
 * up PostgreSQL to test a pure function would make the suite slow and would test
 * the wrong thing.
 *
 * So this helper does what ingest plus the snapshot builder do, in memory, with
 * the same field names and the same natural keys — `packages/ingest/src/naming.ts`
 * is the reference for both. It is a *test double for two layers*, and it is
 * honest about that: `tests/contract.test.ts` in `packages/pipeline` is what
 * proves the real snapshot builder produces this shape.
 *
 * Reading files here is fine. The gate is that the analysis *package* is pure;
 * its tests are allowed to load fixtures, and `tools/quality-gates` scans `src`
 * rather than `tests` for exactly that reason.
 */
const SEED_DIRECTORY = new URL('../../../../seed/generated/', import.meta.url);

/**
 * The roster and the project map come from the *fixtures* rather than the
 * generated records, and that mirrors production exactly: developers, teams and
 * projects are `declared` entities in the registry — a manager configures them —
 * while everything under `seed/generated/` is `observed`. Reading the roster from
 * a connector record would be the analysis core inventing a person out of an
 * email address, which is the one thing identity resolution refuses to do.
 */
const FIXTURE_DIRECTORY = new URL('../../../../seed/fixtures/', import.meta.url);

export const SEED_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
export const SEED_TIMEZONE = 'Europe/London';

/** The seeded `now`, from `seed/MANIFEST.md`. */
export const SEED_NOW: Instant = instantFromIso('2026-07-31T09:00:00.000Z');

/** The one daily report window the manifest documents, half-open. */
export const SEED_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-07-30T00:00:00.000Z'),
  instantFromIso('2026-07-31T00:00:00.000Z'),
);

interface SeedIdentity {
  readonly kind: string;
  readonly value: string;
  readonly displayName: string | null;
}

interface SeedIssue {
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly projectKey: string;
  readonly itemKey: string;
  readonly parentItemKey: string | null;
  readonly title: string;
  readonly itemType: string;
  readonly status: string;
  readonly statusCategory: string;
  readonly priority: string | null;
  readonly estimatePoints: number | null;
  readonly labels: readonly string[];
  readonly assigneeIdentity: SeedIdentity | null;
  readonly reporterIdentity: SeedIdentity | null;
  readonly sprintRefs: readonly string[];
  readonly flaggedBlocked: boolean;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly occurredAt: string;
}

interface SeedSprint {
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly projectKey: string;
  readonly name: string;
  readonly goal: string | null;
  readonly state: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly completedAt: string | null;
  readonly committedItemKeys: readonly string[];
  readonly occurredAt: string;
}

interface SeedPullRequest {
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly repositoryKey: string;
  readonly displayNumber: number;
  readonly title: string;
  readonly state: string;
  readonly authorIdentity: SeedIdentity | null;
  readonly requestedReviewerIdentities: readonly SeedIdentity[];
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headRevisionId: string;
  readonly mergeRevisionId: string | null;
  readonly linkedWorkItemKeys: readonly string[];
  readonly occurredAt: string;
}

interface SeedReview {
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly pullRequestRef: string;
  readonly reviewerIdentity: SeedIdentity | null;
  readonly verdict: string;
  readonly submittedAt: string;
  readonly commentCount: number;
  readonly occurredAt: string;
}

interface SeedCommit {
  readonly repositoryKey: string;
  readonly revisionId: string;
  readonly authorIdentity: SeedIdentity | null;
  readonly authoredAt: string;
  readonly message: string;
  readonly changedFileCount: number;
  readonly branchName: string;
  readonly parentRevisionIds: readonly string[];
  readonly occurredAt: string;
}

interface SeedBranchRef {
  readonly repositoryKey: string;
  readonly name: string;
  readonly revisionId: string;
  readonly isDefault: boolean;
  readonly observedAt: string;
  readonly occurredAt: string;
}

interface SeedReleaseTag {
  readonly repositoryKey: string;
  readonly name: string;
  readonly revisionId: string;
  readonly releasedAt: string;
  readonly description: string | null;
  readonly occurredAt: string;
}

interface SeedTransition {
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly itemKey: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly fromStatusCategory: string | null;
  readonly toStatusCategory: string;
  readonly actorIdentity: SeedIdentity | null;
  readonly transitionedAt: string;
}

interface SeedScopeChange {
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly sprintRef: string;
  readonly itemKey: string;
  readonly change: string;
  readonly actorIdentity: SeedIdentity | null;
  readonly changedAt: string;
}

interface SeedDeveloper {
  readonly key: string;
  readonly displayName: string;
  readonly teamKey: string;
  readonly gitEmails?: readonly string[];
  readonly trackerAccount?: string;
  readonly chatHandle?: string;
}

interface SeedProject {
  readonly key: string;
  readonly name: string;
  readonly teamKey: string;
  readonly methodology: string;
  readonly repositories: readonly string[];
  readonly defaultBranch: string;
}

/**
 * The declared goal hierarchy, from `seed/fixtures/organization.json`.
 *
 * Read from the fixtures rather than from the generated records for the same reason
 * the roster is: an Objective is a `declared` entity that a manager configures, and
 * no connector reports one. Without these rows every commit in the seeded window
 * would resolve to nothing and the alignment section would be one large
 * unattributed bucket — which is precisely the failure the seed exists to make
 * visible rather than to reproduce.
 */
interface SeedObjective {
  readonly key: string;
  readonly kind: string;
  readonly parentKey: string | null;
  readonly current: boolean;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly title: string;
}

interface SeedTeam {
  readonly key: string;
  readonly objectiveKey: string;
}

/**
 * Parsed seed files, cached per path.
 *
 * The generated dataset is a couple of megabytes of JSON, and a single test file
 * builds the snapshot for several teams — re-parsing all of it per call turned a
 * fast suite into one that times out. Only the *parse* is shared: every caller
 * still gets a freshly constructed snapshot, which matters because the
 * determinism test deliberately builds two and compares them, and a shared object
 * would let a mutation hide. Nothing below mutates a parsed record; every field
 * that reaches the snapshot is copied.
 */
const parsed = new Map<string, unknown>();

function readJson<T>(url: URL): T {
  const path = fileURLToPath(url);
  if (!parsed.has(path)) parsed.set(path, JSON.parse(readFileSync(path, 'utf8')));
  return parsed.get(path) as T;
}

const readSeed = <T>(name: string): readonly T[] => readJson<readonly T[]>(new URL(name, SEED_DIRECTORY));

const readFixture = <T>(name: string): T => readJson<T>(new URL(name, FIXTURE_DIRECTORY));

const at = (iso: string | null): number | null => (iso === null ? null : instantFromIso(iso));

/** Present so a missing seed produces one clear failure rather than twenty. */
export function seedIsAvailable(): boolean {
  try {
    readSeed('issues.json');
    return true;
  } catch {
    return false;
  }
}

interface Builder {
  readonly entities: Map<string, AnalysisEntity>;
  readonly transitions: AnalysisTicketTransition[];
  readonly scopeChanges: AnalysisSprintScopeChange[];
}

function observe(
  builder: Builder,
  kind: string,
  naturalKey: string,
  fields: Readonly<Record<string, FieldValue>>,
  observedAt: number,
): void {
  const id = `${kind} ${naturalKey}`;
  const existing = builder.entities.get(id);

  if (existing === undefined) {
    builder.entities.set(id, {
      kind,
      naturalKey,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      beliefAt: observedAt,
      version: 1,
      elapsed: { ageDays: 0, staleDays: 0, seenToday: false, trail: [] },
      fields,
    });
    return;
  }

  // Mirrors the store: sighting bounds widen, but an older observation never
  // overwrites a newer belief.
  const newerBelief = observedAt >= existing.beliefAt;
  builder.entities.set(id, {
    ...existing,
    firstSeenAt: Math.min(existing.firstSeenAt, observedAt),
    lastSeenAt: Math.max(existing.lastSeenAt, observedAt),
    beliefAt: newerBelief ? observedAt : existing.beliefAt,
    version: existing.version + 1,
    fields: newerBelief ? fields : existing.fields,
  });
}

/**
 * The identity roster, from the manifest. Every git email, tracker account and
 * chat handle a person holds maps to the same developer key — which is what the
 * real `IdentityResolver` does, and why an unmapped address resolves to `null`
 * here too rather than being guessed at by name.
 */
function buildRoster(people: readonly SeedDeveloper[]): ReadonlyMap<string, string> {
  const byIdentity = new Map<string, string>();
  for (const person of people) {
    for (const email of person.gitEmails ?? []) byIdentity.set(email.toLowerCase(), person.key);
    if (person.trackerAccount !== undefined) byIdentity.set(person.trackerAccount.toLowerCase(), person.key);
    if (person.chatHandle !== undefined) byIdentity.set(person.chatHandle.toLowerCase(), person.key);
  }
  return byIdentity;
}

export interface SeedSnapshotOptions {
  readonly scope?: AnalysisScope;
  readonly instant?: Instant;
  readonly window?: TimeWindow;
}

/**
 * Builds the analysis snapshot for the seeded organization.
 *
 * Deterministic: the same options produce the same object, with every collection
 * sorted by the key the real snapshot builder sorts by.
 */
export function buildSeedSnapshot(options: SeedSnapshotOptions = {}): AnalysisSnapshot {
  const instant = options.instant ?? SEED_NOW;
  const window = options.window ?? SEED_WINDOW;
  const scope = options.scope ?? { kind: 'team', teamKey: 'platform' };

  const people = readFixture<{ readonly developers: readonly SeedDeveloper[] }>('people.json').developers;
  const projects = readFixture<{ readonly projects: readonly SeedProject[] }>('projects.json').projects;
  const organization = readFixture<{
    readonly objectives: readonly SeedObjective[];
    readonly teams: readonly SeedTeam[];
  }>('organization.json');
  const objectiveByTeam = new Map(organization.teams.map((team) => [team.key, team.objectiveKey]));
  const roster = buildRoster(people);
  const resolve = (identity: SeedIdentity | null): string | null =>
    identity === null ? null : (roster.get(identity.value.toLowerCase()) ?? null);

  const repositoryOwner = new Map<string, SeedProject>();
  for (const project of projects) {
    for (const repository of project.repositories) repositoryOwner.set(repository, project);
  }

  const builder: Builder = { entities: new Map(), transitions: [], scopeChanges: [] };
  const declaredAt = instantFromIso('2026-05-18T00:00:00.000Z');

  for (const person of people) {
    observe(
      builder,
      'developer',
      person.key,
      { displayName: person.displayName, teamKey: person.teamKey, active: true },
      declaredAt,
    );
  }
  for (const objective of organization.objectives) {
    observe(
      builder,
      'objective',
      objective.key,
      {
        objectiveKind: objective.kind,
        parentObjectiveKey: objective.parentKey,
        title: objective.title,
        effectiveFrom: instantFromIso(objective.effectiveFrom),
        effectiveUntil: instantFromIso(objective.effectiveUntil),
        isCurrent: objective.current,
      },
      declaredAt,
    );
  }
  for (const project of projects) {
    observe(
      builder,
      'team',
      project.teamKey,
      {
        name: project.name,
        methodology: project.methodology,
        projectKey: project.key,
        objectiveKey: objectiveByTeam.get(project.teamKey) ?? null,
        conversationKey: null,
        timezone: SEED_TIMEZONE,
      },
      declaredAt,
    );
    observe(
      builder,
      'project',
      project.key,
      {
        name: project.name,
        teamKey: project.teamKey,
        methodology: project.methodology,
        defaultBranch: project.defaultBranch,
      },
      declaredAt,
    );
    for (const repository of project.repositories) {
      observe(
        builder,
        'repository',
        repository,
        { name: repository, projectKey: project.key, defaultBranch: project.defaultBranch },
        declaredAt,
      );
    }
  }

  const sprintKey = (sourceKey: string, ref: string): string => `${sourceKey}:${ref}`;

  /**
   * Observing a project or repository that the roster already declared must not
   * blank the configured fields. The real store versions a change of belief; here
   * the declared row simply wins, which is the same outcome and far less code.
   */
  const observeDiscovered = (kind: 'project' | 'repository', key: string, occurredAt: number): void => {
    if (builder.entities.has(`${kind} ${key}`)) return;
    observe(
      builder,
      kind,
      key,
      kind === 'project'
        ? { name: key, teamKey: null, methodology: null, defaultBranch: null }
        : { name: key, projectKey: repositoryOwner.get(key)?.key ?? null, defaultBranch: null },
      occurredAt,
    );
  };

  for (const sprint of readSeed<SeedSprint>('sprints.json')) {
    observe(
      builder,
      'sprint',
      sprintKey(sprint.sourceKey, sprint.sourceRecordId),
      {
        projectKey: sprint.projectKey,
        name: sprint.name,
        goal: sprint.goal,
        state: sprint.state,
        startAt: at(sprint.startAt),
        endAt: at(sprint.endAt),
        completedAt: at(sprint.completedAt),
        committedItemKeys: [...sprint.committedItemKeys].sort(),
      },
      instantFromIso(sprint.occurredAt),
    );
    observeDiscovered('project', sprint.projectKey, instantFromIso(sprint.occurredAt));
  }

  for (const issue of readSeed<SeedIssue>('issues.json')) {
    const occurredAt = instantFromIso(issue.occurredAt);
    observeDiscovered('project', issue.projectKey, occurredAt);

    const sprintRef = issue.sprintRefs[0];
    observe(
      builder,
      'ticket',
      issue.itemKey,
      {
        projectKey: issue.projectKey,
        featureKey: issue.parentItemKey,
        itemKey: issue.itemKey,
        title: issue.title,
        status: issue.status,
        statusCategory: issue.statusCategory,
        itemType: issue.itemType,
        priority: issue.priority,
        estimatePoints: issue.estimatePoints,
        labels: [...issue.labels].sort(),
        assigneeDeveloperKey: resolve(issue.assigneeIdentity),
        reporterDeveloperKey: resolve(issue.reporterIdentity),
        sprintKey: sprintRef === undefined ? null : sprintKey(issue.sourceKey, sprintRef),
        flaggedBlocked: issue.flaggedBlocked,
        createdAt: at(issue.createdAt),
        resolvedAt: at(issue.resolvedAt),
      },
      occurredAt,
    );
  }

  for (const pullRequest of readSeed<SeedPullRequest>('pull_requests.json')) {
    const occurredAt = instantFromIso(pullRequest.occurredAt);
    observeDiscovered('repository', pullRequest.repositoryKey, occurredAt);
    observe(
      builder,
      'pull_request',
      `${pullRequest.sourceKey}:${pullRequest.sourceRecordId}`,
      {
        repositoryKey: pullRequest.repositoryKey,
        displayNumber: pullRequest.displayNumber,
        title: pullRequest.title,
        state: pullRequest.state,
        authorDeveloperKey: resolve(pullRequest.authorIdentity),
        createdAt: at(pullRequest.createdAt),
        mergedAt: at(pullRequest.mergedAt),
        closedAt: at(pullRequest.closedAt),
        sourceBranch: pullRequest.sourceBranch,
        targetBranch: pullRequest.targetBranch,
        headRevisionId: pullRequest.headRevisionId,
        mergeRevisionId: pullRequest.mergeRevisionId,
        linkedItemKeys: [...pullRequest.linkedWorkItemKeys].sort(),
        requestedReviewerKeys: [
          ...new Set(
            pullRequest.requestedReviewerIdentities
              .map((identity) => resolve(identity))
              .filter((key): key is string => key !== null),
          ),
        ].sort(),
      },
      occurredAt,
    );
  }

  for (const review of readSeed<SeedReview>('reviews.json')) {
    observe(
      builder,
      'review',
      `${review.sourceKey}:${review.sourceRecordId}`,
      {
        pullRequestKey: `${review.sourceKey}:${review.pullRequestRef}`,
        reviewerDeveloperKey: resolve(review.reviewerIdentity),
        verdict: review.verdict,
        submittedAt: at(review.submittedAt),
        commentCount: review.commentCount,
      },
      instantFromIso(review.occurredAt),
    );
  }

  for (const commit of readSeed<SeedCommit>('commits.json')) {
    const occurredAt = instantFromIso(commit.occurredAt);
    observeDiscovered('repository', commit.repositoryKey, occurredAt);
    observe(
      builder,
      'commit',
      `${commit.repositoryKey}@${commit.revisionId}`,
      {
        repositoryKey: commit.repositoryKey,
        revisionId: commit.revisionId,
        authorDeveloperKey: resolve(commit.authorIdentity),
        unmatchedIdentityKey: null,
        authoredAt: at(commit.authoredAt),
        message: commit.message,
        changedFileCount: commit.changedFileCount,
        branchName: commit.branchName,
        parentRevisionIds: [...commit.parentRevisionIds],
        ticketKey: firstTicketKey(commit.message),
      },
      occurredAt,
    );
  }

  /**
   * Branch refs, which the R3 detector needs to know where a repository's trunk
   * is.
   *
   * This helper stood in for two layers for a long time without building them at
   * all, and nothing noticed — because until the Completion Ladder started
   * deciding R3 by branch topology, no analysis module read a `branch_ref`. The
   * omission would have been invisible and expensive: every merge would have
   * fallen back to "newest commit on the default branch", the fallback would have
   * been right often enough to look fine here, and production — where the ref *is*
   * ingested — would have been answering a different question.
   * `packages/ingest/src/model-ingest.ts` is the reference for the field names.
   */
  for (const branch of readSeed<SeedBranchRef>('branch_refs.json')) {
    observe(
      builder,
      'branch_ref',
      `${branch.repositoryKey}:${branch.name}`,
      {
        repositoryKey: branch.repositoryKey,
        name: branch.name,
        revisionId: branch.revisionId,
        isDefault: branch.isDefault,
      },
      instantFromIso(branch.occurredAt),
    );
  }

  for (const tag of readSeed<SeedReleaseTag>('release_tags.json')) {
    observe(
      builder,
      'release_tag',
      `${tag.repositoryKey}:${tag.name}`,
      {
        repositoryKey: tag.repositoryKey,
        name: tag.name,
        revisionId: tag.revisionId,
        releasedAt: at(tag.releasedAt),
        description: tag.description,
      },
      instantFromIso(tag.occurredAt),
    );
  }

  for (const transition of readSeed<SeedTransition>('issue_transitions.json')) {
    builder.transitions.push({
      ticketKey: transition.itemKey,
      sourceKey: transition.sourceKey,
      sourceRecordId: transition.sourceRecordId,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      fromStatusCategory: transition.fromStatusCategory,
      toStatusCategory: transition.toStatusCategory,
      actorDeveloperKey: resolve(transition.actorIdentity),
      transitionedAt: instantFromIso(transition.transitionedAt),
    });
  }

  const sprintStarts = new Map<string, number>();
  for (const entity of builder.entities.values()) {
    if (entity.kind !== 'sprint') continue;
    const startAt = entity.fields['startAt'];
    if (typeof startAt === 'number') sprintStarts.set(entity.naturalKey, startAt);
  }

  for (const change of readSeed<SeedScopeChange>('sprint_scope_changes.json')) {
    const key = sprintKey(change.sourceKey, change.sprintRef);
    const changedAt = instantFromIso(change.changedAt);
    const startAt = sprintStarts.get(key);
    builder.scopeChanges.push({
      sprintKey: key,
      ticketKey: change.itemKey,
      sourceKey: change.sourceKey,
      sourceRecordId: change.sourceRecordId,
      change: change.change,
      actorDeveloperKey: resolve(change.actorIdentity),
      changedAt,
      afterSprintStart: startAt !== undefined && changedAt > startAt,
    });
  }

  return sealed(builder, { organizationId: SEED_ORGANIZATION_ID, scope, instant, window });
}

/**
 * A minimal organization whose only signal is one pull request nobody was asked
 * to review.
 *
 * Constructed rather than seeded, and deliberately so. Every pull request in the
 * generated dataset names at least one requested reviewer — which is realistic,
 * and which would leave the `no_reviewer` (T2) branch of `detectBlockers` the one
 * path in the file with no test. "Nobody was asked" and "somebody was asked and
 * ignored it" are different findings with different fixes, and the detector
 * distinguishes them, so both need a fixture.
 *
 * It is kept as small as a snapshot can be while still resolving: a team, the
 * project it owns, that project's one repository, the author, and #4242. In
 * particular it holds **no tickets**, so the tracker-flag and status-dwell
 * detectors have nothing to find and the assertion can be an exact
 * `toEqual(['no_reviewer'])` rather than a filter — a filter would still pass if
 * the T2 branch stopped firing entirely.
 *
 * #4242 opens on Monday 2026-07-27 and `SEED_NOW` is Friday 2026-07-31, so it has
 * been waiting four working days: comfortably past T2 at one, and clear of the
 * weekend arithmetic in `workingDaysBetween` so the count cannot be an artefact of
 * where the fixture happened to land in the week.
 */
export function orphanPullRequestSnapshot(): AnalysisSnapshot {
  const builder: Builder = { entities: new Map(), transitions: [], scopeChanges: [] };
  const declaredAt = instantFromIso('2026-05-18T00:00:00.000Z');
  const openedAt = instantFromIso('2026-07-27T09:00:00.000Z');

  observe(
    builder,
    'developer',
    'nadia-farouk',
    { displayName: 'Nadia Farouk', teamKey: 'orphans', active: true },
    declaredAt,
  );
  observe(
    builder,
    'team',
    'orphans',
    {
      name: 'Orphans',
      methodology: 'scrum',
      projectKey: 'ORPH',
      objectiveKey: null,
      conversationKey: null,
      timezone: SEED_TIMEZONE,
    },
    declaredAt,
  );
  observe(
    builder,
    'project',
    'ORPH',
    { name: 'Orphans', teamKey: 'orphans', methodology: 'scrum', defaultBranch: 'main' },
    declaredAt,
  );
  observe(
    builder,
    'repository',
    'orphan-service',
    { name: 'orphan-service', projectKey: 'ORPH', defaultBranch: 'main' },
    declaredAt,
  );

  observe(
    builder,
    'pull_request',
    'code:4242',
    {
      repositoryKey: 'orphan-service',
      displayNumber: 4242,
      title: 'Retire the legacy settlement adapter',
      state: 'open',
      authorDeveloperKey: 'nadia-farouk',
      createdAt: openedAt,
      mergedAt: null,
      closedAt: null,
      sourceBranch: 'nadia/retire-settlement-adapter',
      targetBranch: 'main',
      headRevisionId: '0f3c9a1d4b7e2c5a8f60d3b1e9c47a2d8b5e6f01',
      mergeRevisionId: null,
      linkedItemKeys: [],
      // The whole point of the fixture: nobody was ever asked.
      requestedReviewerKeys: [],
    },
    openedAt,
  );

  return sealed(builder, {
    organizationId: SEED_ORGANIZATION_ID,
    scope: { kind: 'team', teamKey: 'orphans' },
    instant: SEED_NOW,
    window: SEED_WINDOW,
  });
}

/**
 * One ticket that has been carried across two sprints.
 *
 * Also constructed, and for the same reason as the orphan pull request: the
 * generated dataset holds eighteen sprint scope changes and no item appears in
 * more than one of them, so `resequenced` — the one elapsed fact whose interesting
 * number is an *occurrence count* rather than an age — has nothing to fire on.
 *
 * It is the sharpest available demonstration that elapsed facts are read from
 * stored history rather than diffed between two reports: nothing about `FLUX-1`
 * as it stands today says it has been deferred. That fact exists only in the
 * append-only scope-change log, and if `computeElapsedFacts` were reading current
 * belief it could not produce it at all.
 */
export function resequencedTicketSnapshot(): AnalysisSnapshot {
  const builder: Builder = { entities: new Map(), transitions: [], scopeChanges: [] };
  const declaredAt = instantFromIso('2026-05-18T00:00:00.000Z');
  const firstSprintStart = instantFromIso('2026-06-01T09:00:00.000Z');
  const secondSprintStart = instantFromIso('2026-06-15T09:00:00.000Z');
  const committedAt = instantFromIso('2026-06-02T10:00:00.000Z');
  const deferredAt = instantFromIso('2026-06-16T10:00:00.000Z');

  observe(builder, 'developer', 'iris-mensah', { displayName: 'Iris Mensah', teamKey: 'flux', active: true }, declaredAt);
  observe(
    builder,
    'team',
    'flux',
    {
      name: 'Flux',
      methodology: 'scrum',
      projectKey: 'FLUX',
      objectiveKey: null,
      conversationKey: null,
      timezone: SEED_TIMEZONE,
    },
    declaredAt,
  );
  observe(
    builder,
    'project',
    'FLUX',
    { name: 'Flux', teamKey: 'flux', methodology: 'scrum', defaultBranch: 'main' },
    declaredAt,
  );

  for (const [recordId, name, startAt, endAt] of [
    ['s1', 'Sprint 1', firstSprintStart, secondSprintStart],
    ['s2', 'Sprint 2', secondSprintStart, instantFromIso('2026-06-29T09:00:00.000Z')],
  ] as const) {
    observe(
      builder,
      'sprint',
      `tracker:${recordId}`,
      {
        projectKey: 'FLUX',
        name,
        goal: null,
        state: 'closed',
        startAt,
        endAt,
        completedAt: endAt,
        committedItemKeys: ['FLUX-1'],
      },
      startAt,
    );
  }

  observe(
    builder,
    'ticket',
    'FLUX-1',
    {
      projectKey: 'FLUX',
      featureKey: null,
      itemKey: 'FLUX-1',
      title: 'Split the ledger writer from the projector',
      status: 'In Progress',
      statusCategory: 'in_progress',
      itemType: 'task',
      priority: 'medium',
      estimatePoints: 5,
      labels: [],
      assigneeDeveloperKey: 'iris-mensah',
      reporterDeveloperKey: 'iris-mensah',
      sprintKey: 'tracker:s2',
      flaggedBlocked: false,
      createdAt: committedAt,
      resolvedAt: null,
    },
    committedAt,
  );

  // The append-only log is the only place the deferral is recorded.
  builder.scopeChanges.push(
    {
      sprintKey: 'tracker:s1',
      ticketKey: 'FLUX-1',
      sourceKey: 'tracker',
      sourceRecordId: 'sc-1',
      change: 'added',
      actorDeveloperKey: 'iris-mensah',
      changedAt: committedAt,
      afterSprintStart: committedAt > firstSprintStart,
    },
    {
      sprintKey: 'tracker:s2',
      ticketKey: 'FLUX-1',
      sourceKey: 'tracker',
      sourceRecordId: 'sc-2',
      change: 'added',
      actorDeveloperKey: 'iris-mensah',
      changedAt: deferredAt,
      afterSprintStart: deferredAt > secondSprintStart,
    },
  );

  return sealed(builder, {
    organizationId: SEED_ORGANIZATION_ID,
    scope: { kind: 'team', teamKey: 'flux' },
    instant: SEED_NOW,
    window: SEED_WINDOW,
  });
}

/**
 * The seeded organization with the estimation noise taken out.
 *
 * The manifest's `estimation-noise-plat` pathology exists to make the seeded team's
 * points uninformative, and the bulk of the generated backlog reinforces it: point
 * values are drawn independently of the duration the ticket actually took. That
 * makes `points_uninformative` the seeded verdict — and it also means a test that
 * only ever sees the seed cannot tell the difference between "the audit detected an
 * uninformative correlation" and "the audit always says that".
 *
 * So this is the same snapshot with one field rewritten: every completed ticket's
 * `estimatePoints` becomes its own measured elapsed working days, plus a fixed
 * two-value wobble so the relationship is strong rather than synthetic-perfect. The
 * *durations are untouched* — this is a team that estimates the same work well, not
 * a team that did different work — and `points_uninformative` must clear.
 */
export function seedSnapshotWithoutEstimationNoise(options: SeedSnapshotOptions = {}): AnalysisSnapshot {
  const snapshot = buildSeedSnapshot(options);
  const instant = options.instant ?? SEED_NOW;

  const transitions = new Map<string, { startedAt: number | null; finishedAt: number | null }>();
  for (const transition of snapshot.collections.ticketTransitions) {
    const known = transitions.get(transition.ticketKey) ?? { startedAt: null, finishedAt: null };
    if (transition.toStatusCategory === 'in_progress' && known.startedAt === null) {
      known.startedAt = transition.transitionedAt;
    }
    if (transition.toStatusCategory === 'done') known.finishedAt = transition.transitionedAt;
    transitions.set(transition.ticketKey, known);
  }

  let wobble = 0;
  const entities = snapshot.collections.entities.map((entity) => {
    if (entity.kind !== 'ticket') return entity;
    // Only tickets that already carried an estimate. Adding one where the team gave
    // none would grow the correlation's sample rather than correct it, and then the
    // "same n, better correlation" assertion would be comparing two different
    // populations.
    const existing = entity.fields['estimatePoints'];
    if (typeof existing !== 'number' || existing <= 0) return entity;

    const key = typeof entity.fields['itemKey'] === 'string' ? entity.fields['itemKey'] : entity.naturalKey;
    const history = transitions.get(key);
    if (history === undefined || history.startedAt === null || history.finishedAt === null) return entity;
    if (history.finishedAt <= history.startedAt || history.finishedAt > instant) return entity;

    const elapsed = workingDaysBetweenInstants(history.startedAt, history.finishedAt);
    wobble = (wobble + 1) % 2;
    return { ...entity, fields: { ...entity.fields, estimatePoints: Math.max(1, elapsed + wobble) } };
  });

  return { ...snapshot, collections: { ...snapshot.collections, entities } };
}

/** The same UTC Monday-to-Friday count `@compass/analysis` applies. */
function workingDaysBetweenInstants(earlier: number, later: number): number {
  if (later <= earlier) return 0;
  let working = 0;
  for (let day = Math.floor(earlier / MILLIS_PER_DAY); day < Math.floor(later / MILLIS_PER_DAY); day += 1) {
    const weekday = (((day + 4) % 7) + 7) % 7;
    if (weekday !== 0 && weekday !== 6) working += 1;
  }
  return working;
}

/**
 * A merged pull request whose merge commit is **not** reachable from the default
 * branch.
 *
 * The case that separates the R3 detector from a merge-state check, and it cannot
 * be seeded: the generated dataset threads every trunk commit onto one history, so
 * every merge in it *is* reachable. Here `main` points at `aaa1111`, the feature
 * branch merged into `release/2.1` at `ccc3333`, and no parent edge connects the
 * two — which is exactly what happens when a fix is merged to a release branch and
 * nobody forward-ports it. The tracker says done, the forge says merged, and the
 * code is not on the branch anyone builds from.
 */
export function mergedButUnreachableSnapshot(): AnalysisSnapshot {
  const builder: Builder = { entities: new Map(), transitions: [], scopeChanges: [] };
  const declaredAt = instantFromIso('2026-05-18T00:00:00.000Z');
  const trunkAt = instantFromIso('2026-07-29T09:00:00.000Z');
  const featureAt = instantFromIso('2026-07-30T09:00:00.000Z');
  const mergedAt = instantFromIso('2026-07-30T14:00:00.000Z');

  observe(builder, 'developer', 'sasha-ivanov', { displayName: 'Sasha Ivanov', teamKey: 'strand', active: true }, declaredAt);
  observe(
    builder,
    'team',
    'strand',
    {
      name: 'Strand',
      methodology: 'scrum',
      projectKey: 'STR',
      objectiveKey: null,
      conversationKey: null,
      timezone: SEED_TIMEZONE,
    },
    declaredAt,
  );
  observe(
    builder,
    'project',
    'STR',
    { name: 'Strand', teamKey: 'strand', methodology: 'scrum', defaultBranch: 'main' },
    declaredAt,
  );
  observe(
    builder,
    'repository',
    'strand-api',
    { name: 'strand-api', projectKey: 'STR', defaultBranch: 'main' },
    declaredAt,
  );

  // Trunk: one commit, and the ref that points at it.
  observe(
    builder,
    'commit',
    'strand-api@aaa1111',
    {
      repositoryKey: 'strand-api',
      revisionId: 'aaa1111',
      authorDeveloperKey: 'sasha-ivanov',
      unmatchedIdentityKey: null,
      authoredAt: trunkAt,
      message: 'STR-1 raise the connection ceiling',
      changedFileCount: 2,
      branchName: 'main',
      parentRevisionIds: [],
      ticketKey: 'STR-1',
    },
    trunkAt,
  );
  observe(
    builder,
    'branch_ref',
    'strand-api:main',
    { repositoryKey: 'strand-api', name: 'main', revisionId: 'aaa1111', isDefault: true },
    trunkAt,
  );

  // The release line: a feature head and a merge commit, connected to each other
  // and to nothing else.
  observe(
    builder,
    'commit',
    'strand-api@bbb2222',
    {
      repositoryKey: 'strand-api',
      revisionId: 'bbb2222',
      authorDeveloperKey: 'sasha-ivanov',
      unmatchedIdentityKey: null,
      authoredAt: featureAt,
      message: 'STR-2 stop the retry storm on a cold pool',
      changedFileCount: 3,
      branchName: 'fix/STR-2-retry-storm',
      parentRevisionIds: [],
      ticketKey: 'STR-2',
    },
    featureAt,
  );
  observe(
    builder,
    'commit',
    'strand-api@ccc3333',
    {
      repositoryKey: 'strand-api',
      revisionId: 'ccc3333',
      authorDeveloperKey: 'sasha-ivanov',
      unmatchedIdentityKey: null,
      authoredAt: mergedAt,
      message: 'STR-2 merge pull request #77 from fix/STR-2-retry-storm',
      changedFileCount: 3,
      branchName: 'release/2.1',
      parentRevisionIds: ['bbb2222'],
      ticketKey: 'STR-2',
    },
    mergedAt,
  );

  observe(
    builder,
    'pull_request',
    'code:77',
    {
      repositoryKey: 'strand-api',
      displayNumber: 77,
      title: 'STR-2 stop the retry storm on a cold pool',
      state: 'merged',
      authorDeveloperKey: 'sasha-ivanov',
      createdAt: featureAt,
      mergedAt,
      closedAt: mergedAt,
      sourceBranch: 'fix/STR-2-retry-storm',
      targetBranch: 'release/2.1',
      headRevisionId: 'bbb2222',
      mergeRevisionId: 'ccc3333',
      linkedItemKeys: ['STR-2'],
      requestedReviewerKeys: ['sasha-ivanov'],
    },
    mergedAt,
  );

  // A tag on the release line, cut after the merge and containing it — so the test
  // can also show that R4 is not awarded while R3 is missing.
  observe(
    builder,
    'release_tag',
    'strand-api:v2.1.1',
    {
      repositoryKey: 'strand-api',
      name: 'v2.1.1',
      revisionId: 'ccc3333',
      releasedAt: instantFromIso('2026-07-30T16:00:00.000Z'),
      description: 'Retry storm patch, on the release line only.',
    },
    instantFromIso('2026-07-30T16:00:00.000Z'),
  );

  observe(
    builder,
    'ticket',
    'STR-2',
    {
      projectKey: 'STR',
      featureKey: null,
      itemKey: 'STR-2',
      title: 'Stop the retry storm on a cold pool',
      status: 'Done',
      statusCategory: 'done',
      itemType: 'bug',
      priority: 'high',
      estimatePoints: 3,
      labels: [],
      assigneeDeveloperKey: 'sasha-ivanov',
      reporterDeveloperKey: 'sasha-ivanov',
      sprintKey: null,
      flaggedBlocked: false,
      createdAt: featureAt,
      resolvedAt: mergedAt,
    },
    mergedAt,
  );
  builder.transitions.push(
    {
      ticketKey: 'STR-2',
      sourceKey: 'tracker',
      sourceRecordId: 'transition-STR-2-1',
      fromStatus: 'To Do',
      toStatus: 'In Progress',
      fromStatusCategory: 'todo',
      toStatusCategory: 'in_progress',
      actorDeveloperKey: 'sasha-ivanov',
      transitionedAt: featureAt,
    },
    {
      ticketKey: 'STR-2',
      sourceKey: 'tracker',
      sourceRecordId: 'transition-STR-2-2',
      fromStatus: 'In Progress',
      toStatus: 'Done',
      fromStatusCategory: 'in_progress',
      toStatusCategory: 'done',
      actorDeveloperKey: 'sasha-ivanov',
      transitionedAt: mergedAt,
    },
  );

  return sealed(builder, {
    organizationId: SEED_ORGANIZATION_ID,
    scope: { kind: 'team', teamKey: 'strand' },
    instant: SEED_NOW,
    window: SEED_WINDOW,
  });
}

// ---------------------------------------------------------------------------
// The well-run team, and the one thing wrong with it
// ---------------------------------------------------------------------------

/**
 * What has to be wrong with the team, if anything.
 *
 * Every option is off by default, and with all of them off the Process Calibration
 * Audit must return **no verdicts at all**. That is what makes this fixture worth
 * having: it is the negative control for five of the six verdicts at once, and it
 * fails loudly if a threshold is ever mis-signed — a comparison written `<=` where
 * it should be `<` turns a clean team into a team with four findings, and there is
 * no seeded dataset in which that mistake is visible.
 */
export interface WellRunTeamOptions {
  /** Completed sprints. One is below T7, which is the `insufficient_history` case. */
  readonly completedSprints?: number;
  /** Strip the estimate from three items in four, taking coverage to 25%. */
  readonly sparseEstimates?: boolean;
  /** Leave half of each sprint's baseline unfinished at close, finishing it later. */
  readonly carryover?: boolean;
  /** Rewrite the last sprint's scope after it started. */
  readonly churn?: boolean;
  /** In-progress items with no commit and no pull request behind them. */
  readonly staleTickets?: number;
  /** Widen the In Progress dwell past T22's multiple of its own median. */
  readonly wideDwell?: boolean;
}

const WELL_RUN_SPRINT_DAYS = 7;
const WELL_RUN_TICKETS_PER_SPRINT = 4;
/** Hours in `In Progress`, cycled per ticket. Spread stays well inside T22. */
const CONSISTENT_DWELL_HOURS = [48, 60, 72, 84] as const;
/** Spread ÷ median of 2.15, comfortably past T22's 1.5. */
const INCONSISTENT_DWELL_HOURS = [4, 8, 100, 120] as const;

/**
 * A team whose data means something: sprints that closed on their commitments,
 * estimates that tracked the work, statuses that held items for a consistent
 * length of time, and nothing sitting still.
 *
 * Constructed rather than seeded, and that is the point. The seeded organization is
 * deliberately pathological — it exists to make every detector fire — so it can
 * only ever demonstrate the positive half of a threshold. A verdict that fires on
 * the seed and also fires here would be a verdict that fires on everything.
 *
 * The sprints end before the report instant and start inside the estimate-coverage
 * window, so every statistic has a real sample rather than an empty one.
 */
export function wellRunTeamSnapshot(options: WellRunTeamOptions = {}): AnalysisSnapshot {
  const sprintCount = options.completedSprints ?? 3;
  const dwellHours = options.wideDwell === true ? INCONSISTENT_DWELL_HOURS : CONSISTENT_DWELL_HOURS;

  const builder: Builder = { entities: new Map(), transitions: [], scopeChanges: [] };
  const declaredAt = instantFromIso('2026-05-18T00:00:00.000Z');

  observe(builder, 'developer', 'lena-ostrom', { displayName: 'Lena Ostrom', teamKey: 'ward', active: true }, declaredAt);
  observe(
    builder,
    'team',
    'ward',
    {
      name: 'Ward',
      methodology: 'scrum',
      projectKey: 'WRD',
      objectiveKey: null,
      conversationKey: null,
      timezone: SEED_TIMEZONE,
    },
    declaredAt,
  );
  observe(
    builder,
    'project',
    'WRD',
    { name: 'Ward', teamKey: 'ward', methodology: 'scrum', defaultBranch: 'main' },
    declaredAt,
  );
  observe(
    builder,
    'repository',
    'ward-api',
    { name: 'ward-api', projectKey: 'WRD', defaultBranch: 'main' },
    declaredAt,
  );

  // The last sprint closes on 2026-07-27, four days before the report instant, so
  // every sprint sits inside the trailing-sprint window and every ticket inside the
  // 28-day estimate-coverage window.
  const lastSprintEnd = instantFromIso('2026-07-27T09:00:00.000Z');
  const sprintSpan = WELL_RUN_SPRINT_DAYS * MILLIS_PER_DAY;
  let ticketNumber = 1;

  for (let index = 0; index < sprintCount; index += 1) {
    const endAt = lastSprintEnd - (sprintCount - 1 - index) * sprintSpan;
    const startAt = endAt - sprintSpan;
    const sprintKey = `tracker:wrd-${index + 1}`;
    const isLast = index === sprintCount - 1;

    const committedItemKeys: string[] = [];
    for (let position = 0; position < WELL_RUN_TICKETS_PER_SPRINT; position += 1) {
      const itemKey = `WRD-${ticketNumber}`;
      ticketNumber += 1;
      committedItemKeys.push(itemKey);

      const createdAt = startAt + MILLIS_PER_HOUR;
      const startedAt = startAt + 2 * MILLIS_PER_HOUR;
      // Carried items are still in progress when the sprint closes, and finish in
      // the following week — so they are carryover without also being stale.
      const carried = options.carryover === true && position < WELL_RUN_TICKETS_PER_SPRINT / 2;
      const finishedAt = carried
        ? endAt + MILLIS_PER_DAY
        : startedAt + (dwellHours[position % dwellHours.length] as number) * MILLIS_PER_HOUR;

      const elapsedWorkingDays = workingDaysBetweenInstants(startedAt, finishedAt);
      const estimated = options.sparseEstimates !== true || position % WELL_RUN_TICKETS_PER_SPRINT === 0;

      observe(
        builder,
        'ticket',
        itemKey,
        {
          projectKey: 'WRD',
          featureKey: null,
          itemKey,
          title: `Ward work item ${itemKey}`,
          status: 'Done',
          statusCategory: 'done',
          itemType: 'task',
          priority: 'medium',
          // Points that track the measured duration: the whole reason this team's
          // correlation clears T12.
          estimatePoints: estimated ? Math.max(1, elapsedWorkingDays) : null,
          labels: [],
          assigneeDeveloperKey: 'lena-ostrom',
          reporterDeveloperKey: 'lena-ostrom',
          sprintKey,
          flaggedBlocked: false,
          createdAt,
          resolvedAt: finishedAt,
        },
        finishedAt,
      );

      builder.transitions.push(
        {
          ticketKey: itemKey,
          sourceKey: 'tracker',
          sourceRecordId: `transition-${itemKey}-1`,
          fromStatus: 'To Do',
          toStatus: 'In Progress',
          fromStatusCategory: 'todo',
          toStatusCategory: 'in_progress',
          actorDeveloperKey: 'lena-ostrom',
          transitionedAt: startedAt,
        },
        {
          ticketKey: itemKey,
          sourceKey: 'tracker',
          sourceRecordId: `transition-${itemKey}-2`,
          fromStatus: 'In Progress',
          toStatus: 'Done',
          fromStatusCategory: 'in_progress',
          toStatusCategory: 'done',
          actorDeveloperKey: 'lena-ostrom',
          transitionedAt: finishedAt,
        },
      );
    }

    observe(
      builder,
      'sprint',
      sprintKey,
      {
        projectKey: 'WRD',
        name: `Ward ${index + 1}`,
        goal: 'Keep the ward boundary honest',
        state: 'closed',
        startAt,
        endAt,
        completedAt: endAt,
        committedItemKeys: [...committedItemKeys].sort(),
      },
      startAt,
    );

    // Churn is scoped to the last completed sprint: two items swapped in and one
    // out after it started, which takes it past T21 without touching carryover.
    if (isLast && options.churn === true) {
      const [swappedIn, alsoIn, swappedOut] = committedItemKeys;
      const changedAt = startAt + 2 * MILLIS_PER_DAY;
      for (const [ticketKey, change, ordinal] of [
        [swappedIn, 'added', 1],
        [alsoIn, 'added', 2],
        [swappedOut, 'removed', 3],
      ] as const) {
        if (ticketKey === undefined) continue;
        builder.scopeChanges.push({
          sprintKey,
          ticketKey,
          sourceKey: 'tracker',
          sourceRecordId: `scope-change-${sprintKey}-${ordinal}`,
          change,
          actorDeveloperKey: 'lena-ostrom',
          changedAt,
          afterSprintStart: true,
        });
      }
    }
  }

  // Items sitting in an in-progress status with nothing behind them.
  for (let index = 0; index < (options.staleTickets ?? 0); index += 1) {
    const itemKey = `WRD-STALE-${index + 1}`;
    const startedAt = instantFromIso('2026-07-20T10:00:00.000Z');
    observe(
      builder,
      'ticket',
      itemKey,
      {
        projectKey: 'WRD',
        featureKey: null,
        itemKey,
        title: `Ward stalled item ${index + 1}`,
        status: 'In Progress',
        statusCategory: 'in_progress',
        itemType: 'task',
        priority: 'medium',
        estimatePoints: 3,
        labels: [],
        assigneeDeveloperKey: 'lena-ostrom',
        reporterDeveloperKey: 'lena-ostrom',
        sprintKey: null,
        flaggedBlocked: false,
        createdAt: instantFromIso('2026-07-17T10:00:00.000Z'),
        resolvedAt: null,
      },
      startedAt,
    );
    builder.transitions.push({
      ticketKey: itemKey,
      sourceKey: 'tracker',
      sourceRecordId: `transition-${itemKey}-1`,
      fromStatus: 'To Do',
      toStatus: 'In Progress',
      fromStatusCategory: 'todo',
      toStatusCategory: 'in_progress',
      actorDeveloperKey: 'lena-ostrom',
      transitionedAt: startedAt,
    });
  }

  return sealed(builder, {
    organizationId: SEED_ORGANIZATION_ID,
    scope: { kind: 'team', teamKey: 'ward' },
    instant: SEED_NOW,
    window: SEED_WINDOW,
  });
}

const TICKET_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/;

/** Mirrors `packages/ingest/src/naming.ts`: read off the message, never inferred. */
function firstTicketKey(message: string): string | null {
  return TICKET_KEY_PATTERN.exec(message)?.[0] ?? null;
}

function sealed(
  builder: Builder,
  envelope: {
    readonly organizationId: string;
    readonly scope: AnalysisScope;
    readonly instant: Instant;
    readonly window: TimeWindow;
  },
): AnalysisSnapshot {
  const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

  // The fourteen-day trail's day boundaries are the same for every entity, and
  // each one costs a timezone conversion. Computed once here rather than once per
  // entity, which is the difference between a snapshot that builds in two seconds
  // and one that builds in twenty milliseconds.
  const trailDays = trailDayBounds(envelope.instant);

  const entities = [...builder.entities.values()]
    .map((entity) => ({ ...entity, elapsed: elapsedFor(entity, envelope.instant, trailDays) }))
    .sort((left, right) => compare(left.kind, right.kind) || compare(left.naturalKey, right.naturalKey));

  const counts = new Map<string, number>();
  for (const entity of entities) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);

  const collections: AnalysisCollections = {
    entities,
    entityCounts: [...counts.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([kind, count]) => ({ kind, count })),
    entityVersions: [],
    ticketTransitions: [...builder.transitions].sort(
      (left, right) =>
        compare(left.ticketKey, right.ticketKey) ||
        left.transitionedAt - right.transitionedAt ||
        compare(left.sourceRecordId, right.sourceRecordId),
    ),
    sprintScopeChanges: [...builder.scopeChanges].sort(
      (left, right) =>
        compare(left.sprintKey, right.sprintKey) ||
        left.changedAt - right.changedAt ||
        compare(left.sourceRecordId, right.sourceRecordId),
    ),
    corrections: [],
    ingestRuns: [],
  };

  return { ...envelope, timezone: SEED_TIMEZONE, collections };
}

interface DayBounds {
  readonly start: number;
  readonly end: number;
}

/** The fourteen trail days ending on `instant`'s local day, oldest first. */
function trailDayBounds(instant: Instant): readonly DayBounds[] {
  const today = startOfDayInZone(instant, SEED_TIMEZONE);
  const bounds: DayBounds[] = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    bounds.push({
      start: addDaysInZone(today, SEED_TIMEZONE, -offset),
      end: addDaysInZone(today, SEED_TIMEZONE, -offset + 1),
    });
  }
  return bounds;
}

/** The same arithmetic `@compass/knowledge-model`'s `elapsedFactsFor` applies. */
function elapsedFor(
  entity: AnalysisEntity,
  instant: Instant,
  trailDays: readonly DayBounds[],
): AnalysisEntity['elapsed'] {
  return {
    ageDays: Math.max(0, Math.floor((instant - entity.firstSeenAt) / MILLIS_PER_DAY)),
    staleDays: Math.max(0, Math.floor((instant - entity.lastSeenAt) / MILLIS_PER_DAY)),
    seenToday: instant - entity.lastSeenAt < MILLIS_PER_DAY,
    trail: trailDays.map((day) => entity.firstSeenAt < day.end && entity.lastSeenAt >= day.start),
  };
}
