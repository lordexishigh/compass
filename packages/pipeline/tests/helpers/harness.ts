import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import type {
  BranchRefRecord,
  CommitRecord,
  ExternalIdentity,
  IssueRecord,
  IssueTransitionRecord,
  MessageRecord,
  PullRequestRecord,
  ReleaseTagRecord,
  ReviewRecord,
  SprintRecord,
  SprintScopeChangeRecord,
} from '@compass/connector-port';
import { FixtureConnector, type FixtureDataset } from '@compass/connector-port/testkit';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { KnowledgeStore, provisionRoster, type OrgRoster } from '@compass/knowledge-model';

/**
 * A real PostgreSQL behind the pipeline, and a fixture behind the port.
 *
 * The pipeline is the one layer that genuinely does I/O, so its tests run against
 * a real engine: real migrations, real unique constraints, real append-only
 * triggers. A mocked query builder would accept the writes this suite exists to
 * check the shape of.
 *
 * The connector is `FixtureConnector` from `@compass/connector-port/testkit` —
 * *not* the seeded provider. That is not a stylistic choice: an architecture gate
 * reads the imports of every layer below the port and fails the build if any of
 * them names the seed package, because "the pipeline cannot tell seeded data from
 * a live API" stops being checkable the moment the pipeline's own tests are
 * written against seeded shapes. The dataset below is therefore declared here, in
 * the port's own provider-neutral vocabulary, and the pipeline sees exactly what
 * a GitHub/Jira connector would hand it.
 *
 * The fixture is small and every record in it is load-bearing:
 *
 *  - **DEV-501** is accepted and merged inside the report window, so Yesterday and
 *    Wins have something real to say.
 *  - **DEV-522** carries the tracker's own blocked flag, so Blockers comes from a
 *    source that said so rather than from an inference.
 *  - **DEV-530** enters the sprint after it started, so Risks has a scope change.
 *  - **legacy-code** is configured and down, so the report has to degrade honestly
 *    instead of presenting itself as complete.
 */

export const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';
export const TEAM_KEY = 'platform';
export const TIMEZONE = 'Europe/London';
export const PROJECT_KEY = 'DEV';
export const REPOSITORY_KEY = 'checkout-web';

/** The source that is configured and unreachable, named by the coverage tests. */
export const UNAVAILABLE_SOURCE_KEY = 'legacy-code';

/** Inside the fixture window, the morning after DEV-501 merged. */
export const NOW: Instant = instantFromIso('2026-07-31T07:30:00Z');

/** The report window: the team's previous civil day, in Europe/London. */
export const REPORT_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-07-29T23:00:00Z'),
  instantFromIso('2026-07-30T23:00:00Z'),
);

/** Wide enough to reach the sprint start, which the report window does not. */
export const INGEST_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-06-01T00:00:00Z'),
  instantFromIso('2026-07-31T07:30:00Z'),
);

const at = (iso: string): Instant => instantFromIso(iso);

const CODE = 'primary-code';
const TRACKER = 'primary-tracker';
const CHAT = 'team-chat';

const email = (value: string, displayName: string): ExternalIdentity => ({ kind: 'email', value, displayName });
const account = (value: string, displayName: string): ExternalIdentity => ({ kind: 'account', value, displayName });
const handle = (value: string, displayName: string): ExternalIdentity => ({ kind: 'handle', value, displayName });

const PRIYA_GIT = email('priya@example.com', 'Priya Raman');
const MARCUS_GIT = email('marcus@example.com', 'Marcus Hale');
const PRIYA_TRACKER = account('acct-priya', 'Priya Raman');
const MARCUS_TRACKER = account('acct-marcus', 'Marcus Hale');
const MARCUS_CHAT = handle('handle-marcus', 'Marcus Hale');

const HEAD_REVISION = '7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
const MERGE_REVISION = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0';

const SPRINT_41: SprintRecord = {
  sourceKey: TRACKER,
  sourceKind: 'tracker',
  sourceRecordId: 'sprint-41',
  occurredAt: at('2026-06-08T09:00:00Z'),
  projectKey: PROJECT_KEY,
  name: 'Sprint 41',
  goal: 'Cut checkout latency',
  state: 'closed',
  startAt: at('2026-06-08T09:00:00Z'),
  endAt: at('2026-06-22T17:00:00Z'),
  completedAt: at('2026-06-22T17:00:00Z'),
  committedItemKeys: ['DEV-410'],
};

const SPRINT_42: SprintRecord = {
  sourceKey: TRACKER,
  sourceKind: 'tracker',
  sourceRecordId: 'sprint-42',
  occurredAt: at('2026-06-22T09:00:00Z'),
  projectKey: PROJECT_KEY,
  name: 'Sprint 42',
  goal: 'Cut checkout latency',
  state: 'closed',
  startAt: at('2026-06-22T09:00:00Z'),
  endAt: at('2026-07-06T17:00:00Z'),
  completedAt: at('2026-07-06T17:00:00Z'),
  committedItemKeys: ['DEV-455'],
};

const SPRINT_43: SprintRecord = {
  sourceKey: TRACKER,
  sourceKind: 'tracker',
  sourceRecordId: 'sprint-43',
  occurredAt: at('2026-07-20T09:00:00Z'),
  projectKey: PROJECT_KEY,
  name: 'Sprint 43',
  goal: 'Cut checkout latency',
  state: 'active',
  startAt: at('2026-07-20T09:00:00Z'),
  endAt: at('2026-08-03T17:00:00Z'),
  completedAt: null,
  committedItemKeys: ['DEV-501', 'DEV-522'],
};

interface IssueSpec {
  readonly itemKey: string;
  readonly title: string;
  readonly status: string;
  readonly statusCategory: IssueRecord['statusCategory'];
  readonly points: number;
  readonly assignee: ExternalIdentity;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
  readonly sprintRef: string;
  readonly flaggedBlocked?: boolean;
}

const issue = (spec: IssueSpec): IssueRecord => ({
  sourceKey: TRACKER,
  sourceKind: 'tracker',
  sourceRecordId: `issue-${spec.itemKey}`,
  occurredAt: at(spec.updatedAt),
  projectKey: PROJECT_KEY,
  itemKey: spec.itemKey,
  title: spec.title,
  description: null,
  status: spec.status,
  statusCategory: spec.statusCategory,
  itemType: 'story',
  priority: 'medium',
  estimatePoints: spec.points,
  labels: [],
  assigneeIdentity: spec.assignee,
  reporterIdentity: PRIYA_TRACKER,
  createdAt: at(spec.createdAt),
  updatedAt: at(spec.updatedAt),
  resolvedAt: spec.resolvedAt === undefined ? null : at(spec.resolvedAt),
  parentItemKey: null,
  sprintRefs: [spec.sprintRef],
  flaggedBlocked: spec.flaggedBlocked ?? false,
});

const ISSUES: readonly IssueRecord[] = [
  issue({
    itemKey: 'DEV-410',
    title: 'Cache the pricing table',
    status: 'Done',
    statusCategory: 'done',
    points: 5,
    assignee: PRIYA_TRACKER,
    createdAt: '2026-06-08T09:00:00Z',
    updatedAt: '2026-06-19T15:00:00Z',
    resolvedAt: '2026-06-19T15:00:00Z',
    sprintRef: 'sprint-41',
  }),
  issue({
    itemKey: 'DEV-455',
    title: 'Collapse the address lookup round trips',
    status: 'Done',
    statusCategory: 'done',
    points: 8,
    assignee: MARCUS_TRACKER,
    createdAt: '2026-06-22T09:00:00Z',
    updatedAt: '2026-07-03T11:00:00Z',
    resolvedAt: '2026-07-03T11:00:00Z',
    sprintRef: 'sprint-42',
  }),
  issue({
    itemKey: 'DEV-501',
    title: 'Batch the checkout writer',
    status: 'Done',
    statusCategory: 'done',
    points: 8,
    assignee: PRIYA_TRACKER,
    createdAt: '2026-07-20T09:00:00Z',
    updatedAt: '2026-07-30T14:05:00Z',
    resolvedAt: '2026-07-30T14:00:00Z',
    sprintRef: 'sprint-43',
  }),
  issue({
    itemKey: 'DEV-522',
    title: 'Retry storm on the payment callback',
    status: 'In Progress',
    statusCategory: 'in_progress',
    points: 5,
    assignee: MARCUS_TRACKER,
    createdAt: '2026-07-20T09:00:00Z',
    updatedAt: '2026-07-30T09:00:00Z',
    sprintRef: 'sprint-43',
    flaggedBlocked: true,
  }),
  issue({
    itemKey: 'DEV-530',
    title: 'Warm the edge cache on deploy',
    status: 'In Progress',
    statusCategory: 'in_progress',
    points: 3,
    assignee: PRIYA_TRACKER,
    createdAt: '2026-07-27T09:00:00Z',
    updatedAt: '2026-07-30T09:05:00Z',
    sprintRef: 'sprint-43',
  }),
];

const transition = (
  itemKey: string,
  fromStatus: string | null,
  toStatus: string,
  fromCategory: IssueTransitionRecord['fromStatusCategory'],
  toCategory: IssueTransitionRecord['toStatusCategory'],
  transitionedAt: string,
  actor: ExternalIdentity,
): IssueTransitionRecord => ({
  sourceKey: TRACKER,
  sourceKind: 'tracker',
  sourceRecordId: `transition-${itemKey}-${toStatus.replace(/\s+/g, '-').toLowerCase()}`,
  occurredAt: at(transitionedAt),
  itemKey,
  fromStatus,
  toStatus,
  fromStatusCategory: fromCategory,
  toStatusCategory: toCategory,
  actorIdentity: actor,
  transitionedAt: at(transitionedAt),
});

const TRANSITIONS: readonly IssueTransitionRecord[] = [
  transition('DEV-410', 'To Do', 'In Progress', 'todo', 'in_progress', '2026-06-09T09:00:00Z', PRIYA_TRACKER),
  transition('DEV-410', 'In Progress', 'Done', 'in_progress', 'done', '2026-06-19T15:00:00Z', PRIYA_TRACKER),
  transition('DEV-455', 'To Do', 'In Progress', 'todo', 'in_progress', '2026-06-23T09:00:00Z', MARCUS_TRACKER),
  transition('DEV-455', 'In Progress', 'Done', 'in_progress', 'done', '2026-07-03T11:00:00Z', MARCUS_TRACKER),
  transition('DEV-501', 'To Do', 'In Progress', 'todo', 'in_progress', '2026-07-22T09:00:00Z', PRIYA_TRACKER),
  // The one transition inside the report window: this is what puts DEV-501 in
  // Yesterday rather than merely in the sprint.
  transition('DEV-501', 'In Progress', 'Done', 'in_progress', 'done', '2026-07-30T14:00:00Z', PRIYA_TRACKER),
  transition('DEV-522', 'To Do', 'In Progress', 'todo', 'in_progress', '2026-07-21T09:00:00Z', MARCUS_TRACKER),
  transition('DEV-530', 'To Do', 'In Progress', 'todo', 'in_progress', '2026-07-27T10:05:00Z', PRIYA_TRACKER),
];

const SCOPE_CHANGES: readonly SprintScopeChangeRecord[] = [
  {
    sourceKey: TRACKER,
    sourceKind: 'tracker',
    sourceRecordId: 'scope-530',
    occurredAt: at('2026-07-27T10:00:00Z'),
    sprintRef: 'sprint-43',
    itemKey: 'DEV-530',
    change: 'added',
    actorIdentity: PRIYA_TRACKER,
    changedAt: at('2026-07-27T10:00:00Z'),
  },
];

const PULL_REQUESTS: readonly PullRequestRecord[] = [
  {
    sourceKey: CODE,
    sourceKind: 'code',
    sourceRecordId: 'pr-883',
    occurredAt: at('2026-07-30T13:40:00Z'),
    repositoryKey: REPOSITORY_KEY,
    displayNumber: 883,
    title: 'Batch the checkout writer',
    description: 'DEV-501: one write per basket instead of one per line.',
    authorIdentity: PRIYA_GIT,
    state: 'merged',
    createdAt: at('2026-07-28T10:00:00Z'),
    updatedAt: at('2026-07-30T13:40:00Z'),
    mergedAt: at('2026-07-30T13:40:00Z'),
    closedAt: at('2026-07-30T13:40:00Z'),
    sourceBranch: 'feature/DEV-501-batch-writer',
    targetBranch: 'main',
    headRevisionId: HEAD_REVISION,
    mergeRevisionId: MERGE_REVISION,
    requestedReviewerIdentities: [MARCUS_GIT],
    linkedWorkItemKeys: ['DEV-501'],
  },
];

const REVIEWS: readonly ReviewRecord[] = [
  {
    sourceKey: CODE,
    sourceKind: 'code',
    sourceRecordId: 'review-883-1',
    occurredAt: at('2026-07-30T12:30:00Z'),
    repositoryKey: REPOSITORY_KEY,
    pullRequestRef: 'pr-883',
    reviewerIdentity: MARCUS_GIT,
    verdict: 'approved',
    submittedAt: at('2026-07-30T12:30:00Z'),
    commentCount: 2,
  },
];

const COMMITS: readonly CommitRecord[] = [
  {
    sourceKey: CODE,
    sourceKind: 'code',
    sourceRecordId: 'commit-head',
    occurredAt: at('2026-07-29T15:00:00Z'),
    repositoryKey: REPOSITORY_KEY,
    revisionId: HEAD_REVISION,
    parentRevisionIds: [],
    authorIdentity: PRIYA_GIT,
    committerIdentity: PRIYA_GIT,
    authoredAt: at('2026-07-29T15:00:00Z'),
    message: 'DEV-501 batch the checkout writer',
    changedFileCount: 6,
    branchName: 'feature/DEV-501-batch-writer',
  },
  {
    sourceKey: CODE,
    sourceKind: 'code',
    sourceRecordId: 'commit-merge',
    occurredAt: at('2026-07-30T13:40:00Z'),
    repositoryKey: REPOSITORY_KEY,
    revisionId: MERGE_REVISION,
    parentRevisionIds: [HEAD_REVISION],
    authorIdentity: PRIYA_GIT,
    committerIdentity: PRIYA_GIT,
    authoredAt: at('2026-07-30T13:40:00Z'),
    message: 'Merge pull request #883 — DEV-501 batch the checkout writer',
    changedFileCount: 6,
    branchName: 'main',
  },
];

const BRANCH_REFS: readonly BranchRefRecord[] = [
  {
    sourceKey: CODE,
    sourceKind: 'code',
    sourceRecordId: 'branch-main',
    occurredAt: at('2026-07-30T13:45:00Z'),
    repositoryKey: REPOSITORY_KEY,
    name: 'main',
    revisionId: MERGE_REVISION,
    isDefault: true,
    observedAt: at('2026-07-30T13:45:00Z'),
  },
];

const RELEASE_TAGS: readonly ReleaseTagRecord[] = [
  {
    sourceKey: CODE,
    sourceKind: 'code',
    sourceRecordId: 'tag-v2-14',
    occurredAt: at('2026-07-30T18:00:00Z'),
    repositoryKey: REPOSITORY_KEY,
    name: 'v2.14',
    revisionId: MERGE_REVISION,
    releasedAt: at('2026-07-30T18:00:00Z'),
    description: 'Checkout batching',
  },
];

const MESSAGES: readonly MessageRecord[] = [
  {
    sourceKey: CHAT,
    sourceKind: 'chat',
    sourceRecordId: 'message-1',
    occurredAt: at('2026-07-30T09:30:00Z'),
    conversationKey: 'conversation-platform',
    conversationName: 'platform',
    authorIdentity: MARCUS_CHAT,
    body: 'DEV-522 is still waiting on the payments team to confirm the retry budget.',
    threadRef: null,
    referencedItemKeys: ['DEV-522'],
    postedAt: at('2026-07-30T09:30:00Z'),
  },
];

export const FIXTURE_DATASET: FixtureDataset = {
  datasetId: 'pipeline-northwind',
  deploySignal: false,
  sources: [
    { sourceKey: CODE, sourceKind: 'code', availability: { status: 'available' } },
    { sourceKey: TRACKER, sourceKind: 'tracker', availability: { status: 'available' } },
    { sourceKey: CHAT, sourceKind: 'chat', availability: { status: 'available' } },
    {
      sourceKey: UNAVAILABLE_SOURCE_KEY,
      sourceKind: 'code',
      availability: {
        status: 'unavailable',
        reason: 'rate_limited',
        detail: `${UNAVAILABLE_SOURCE_KEY} returned 429 after exhausting its hourly quota, so none of its history was read.`,
      },
    },
  ],
  records: {
    commits: COMMITS,
    pull_requests: PULL_REQUESTS,
    reviews: REVIEWS,
    branch_refs: BRANCH_REFS,
    release_tags: RELEASE_TAGS,
    issues: ISSUES,
    issue_transitions: TRANSITIONS,
    sprints: [SPRINT_41, SPRINT_42, SPRINT_43],
    sprint_scope_changes: SCOPE_CHANGES,
    messages: MESSAGES,
  },
};

/**
 * The roster the fixture implies.
 *
 * Provisioned rather than observed, because a team and its people are
 * *configuration*: no connector reports them, and the alternative — inferring a
 * team from who commits together — would put someone else's merge in this team's
 * Yesterday. `projectKey: 'DEV'` is what makes `resolveScope` find the fixture's
 * tickets; without it the report is honestly empty, which is a different test.
 */
export function foundationRoster(declaredAt: Instant): OrgRoster {
  return {
    company: { key: 'northwind', name: 'Northwind', timezone: TIMEZONE },
    objectives: [
      {
        key: 'OBJ-Q3',
        kind: 'quarter',
        parentKey: null,
        title: 'Cut checkout latency by a third',
        effectiveFrom: instantFromIso('2026-07-01T00:00:00Z'),
        effectiveUntil: instantFromIso('2026-10-01T00:00:00Z'),
        isCurrent: true,
      },
    ],
    teams: [
      {
        key: TEAM_KEY,
        name: 'Platform',
        methodology: 'scrum',
        projectKey: PROJECT_KEY,
        objectiveKey: 'OBJ-Q3',
        conversationKey: 'conversation-platform',
        timezone: TIMEZONE,
      },
    ],
    developers: [
      {
        key: 'priya',
        displayName: 'Priya Raman',
        teamKey: TEAM_KEY,
        active: true,
        gitEmails: ['priya@example.com'],
        trackerAccounts: ['acct-priya'],
        chatHandles: ['handle-priya'],
      },
      {
        key: 'marcus',
        displayName: 'Marcus Hale',
        teamKey: TEAM_KEY,
        active: true,
        gitEmails: ['marcus@example.com'],
        trackerAccounts: ['acct-marcus'],
        chatHandles: ['handle-marcus'],
      },
    ],
    absences: [],
    declaredAt,
  };
}

export interface PipelineHarness {
  readonly database: TestDatabase;
  readonly connector: FixtureConnector;
  close(): Promise<void>;
}

export async function createPipelineHarness(): Promise<PipelineHarness> {
  const database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind',
    slug: 'northwind',
    timezone: TIMEZONE,
    at: new Date(Date.parse('2026-05-18T00:00:00.000Z')),
  });

  const store = new KnowledgeStore(database.scopedFor(ORGANIZATION_ID));
  await provisionRoster(store, foundationRoster(instantFromIso('2026-05-18T00:00:00Z')));

  return {
    database,
    connector: new FixtureConnector(FIXTURE_DATASET),
    close: () => database.close(),
  };
}
