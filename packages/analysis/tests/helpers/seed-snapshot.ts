import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MILLIS_PER_DAY,
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
  for (const project of projects) {
    observe(
      builder,
      'team',
      project.teamKey,
      {
        name: project.name,
        methodology: project.methodology,
        projectKey: project.key,
        objectiveKey: null,
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
