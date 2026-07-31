import { instantFromIso, type Instant } from '@compass/clock';
import type {
  CommitRecord,
  IssueRecord,
  IssueTransitionRecord,
  PullRequestRecord,
  SprintRecord,
  SprintScopeChangeRecord,
} from '@compass/connector-port';

/**
 * A small hand-written org, shaped like the pathologies the product is built to
 * catch: a ticket reported blocked that quietly merged, a sprint that grew after
 * it started, and commits from an address nobody has claimed.
 */
export const at = (iso: string): Instant => instantFromIso(iso);

const CODE = { sourceKey: 'primary-code', sourceKind: 'code' } as const;
const TRACKER = { sourceKey: 'primary-tracker', sourceKind: 'tracker' } as const;

export const SPRINT: SprintRecord = {
  ...TRACKER,
  sourceRecordId: 'sprint-CHK-3',
  occurredAt: at('2026-07-27T09:00:00Z'),
  projectKey: 'CHK',
  name: 'Sprint 17',
  goal: 'Cut guest-checkout abandonment',
  state: 'active',
  startAt: at('2026-07-27T09:00:00Z'),
  endAt: at('2026-08-10T09:00:00Z'),
  completedAt: null,
  committedItemKeys: ['CHK-701', 'CHK-703'],
};

export const SPRINT_KEY = 'primary-tracker:sprint-CHK-3';

const issue = (overrides: Partial<IssueRecord> & Pick<IssueRecord, 'sourceRecordId' | 'itemKey'>): IssueRecord => ({
  ...TRACKER,
  occurredAt: at('2026-07-28T09:00:00Z'),
  projectKey: 'CHK',
  title: 'Guest checkout retries a declined card twice on slow networks',
  description: null,
  status: 'In Progress',
  statusCategory: 'in_progress',
  itemType: 'Bug',
  priority: 'High',
  estimatePoints: 5,
  labels: ['checkout'],
  assigneeIdentity: { kind: 'account', value: 'acct-naomi-chen', displayName: 'Naomi Chen' },
  reporterIdentity: { kind: 'account', value: 'acct-naomi-chen', displayName: 'Naomi Chen' },
  createdAt: at('2026-07-28T09:00:00Z'),
  updatedAt: at('2026-07-28T09:00:00Z'),
  resolvedAt: null,
  parentItemKey: null,
  sprintRefs: ['sprint-CHK-3'],
  flaggedBlocked: false,
  ...overrides,
});

/** Day one: the ticket is flagged blocked at the morning stand-up. */
export const BLOCKED_ISSUE: IssueRecord = issue({
  sourceRecordId: 'issue-CHK-701',
  itemKey: 'CHK-701',
  status: 'Blocked',
  flaggedBlocked: true,
  occurredAt: at('2026-07-30T08:15:00Z'),
  updatedAt: at('2026-07-30T08:15:00Z'),
});

export const BLOCKED_TRANSITION: IssueTransitionRecord = {
  ...TRACKER,
  sourceRecordId: 'transition-CHK-701-2',
  occurredAt: at('2026-07-30T08:15:00Z'),
  itemKey: 'CHK-701',
  fromStatus: 'In Progress',
  toStatus: 'Blocked',
  fromStatusCategory: 'in_progress',
  toStatusCategory: 'in_progress',
  actorIdentity: { kind: 'account', value: 'acct-naomi-chen', displayName: 'Naomi Chen' },
  transitionedAt: at('2026-07-30T08:15:00Z'),
};

/** A second ticket that was never blocked, so the blocker projection has a control. */
export const PLAIN_ISSUE: IssueRecord = issue({
  sourceRecordId: 'issue-CHK-703',
  itemKey: 'CHK-703',
  title: 'Address form loses focus on the postcode field',
  occurredAt: at('2026-07-30T09:00:00Z'),
});

/** An item pulled into the sprint eight days after it started. */
export const LATE_SCOPE_CHANGE: SprintScopeChangeRecord = {
  ...TRACKER,
  sourceRecordId: 'scope-change-CHK-3-1',
  occurredAt: at('2026-08-04T10:00:00Z'),
  sprintRef: 'sprint-CHK-3',
  itemKey: 'CHK-712',
  change: 'added',
  actorIdentity: null,
  changedAt: at('2026-08-04T10:00:00Z'),
};

/** Day two: the work that was reported blocked has, in fact, merged. */
export const MERGED_PULL_REQUEST: PullRequestRecord = {
  ...CODE,
  sourceRecordId: 'pull-request-9201',
  occurredAt: at('2026-07-30T18:40:00Z'),
  repositoryKey: 'checkout-web',
  displayNumber: 9201,
  title: 'CHK-701 stop retrying a declined card on a slow network',
  description: null,
  authorIdentity: { kind: 'email', value: 'naomi.chen@northwind.example', displayName: 'Naomi Chen' },
  state: 'merged',
  createdAt: at('2026-07-29T18:40:00Z'),
  updatedAt: at('2026-07-30T18:40:00Z'),
  mergedAt: at('2026-07-30T18:40:00Z'),
  closedAt: at('2026-07-30T18:40:00Z'),
  sourceBranch: 'feature/CHK-701-declined-card-retry',
  targetBranch: 'main',
  headRevisionId: '6a7b8c9',
  mergeRevisionId: '7a8b9c0',
  requestedReviewerIdentities: [{ kind: 'email', value: 'rafael.lima@northwind.example', displayName: 'Rafael Lima' }],
  linkedWorkItemKeys: ['CHK-701'],
};

const commit = (
  overrides: Partial<CommitRecord> & Pick<CommitRecord, 'sourceRecordId' | 'revisionId'>,
): CommitRecord => ({
  ...CODE,
  occurredAt: at('2026-07-30T16:40:00Z'),
  repositoryKey: 'checkout-web',
  parentRevisionIds: [],
  authorIdentity: { kind: 'email', value: 'naomi.chen@northwind.example', displayName: 'Naomi Chen' },
  committerIdentity: null,
  authoredAt: at('2026-07-30T16:40:00Z'),
  message: 'CHK-701 stop retrying a declined card on a slow network',
  changedFileCount: 3,
  branchName: 'feature/CHK-701-declined-card-retry',
  ...overrides,
});

export const AUTHORED_COMMIT: CommitRecord = commit({
  sourceRecordId: 'commit-6a7b8c9',
  revisionId: '6a7b8c9',
});

/**
 * A commit whose author looks like a developer on the roster and is not.
 * `p.raman@personal.example` with the display name "P. Raman" must never be
 * attributed to Priya Raman.
 */
export const LOOKALIKE_COMMIT: CommitRecord = commit({
  sourceRecordId: 'commit-lookalike-1',
  revisionId: 'ab12cd3',
  occurredAt: at('2026-07-30T17:10:00Z'),
  authoredAt: at('2026-07-30T17:10:00Z'),
  authorIdentity: { kind: 'email', value: 'p.raman@personal.example', displayName: 'P. Raman' },
  message: 'Tidy the retry helper',
  branchName: 'main',
});

export const ROBOT_COMMIT: CommitRecord = commit({
  sourceRecordId: 'commit-robot-1',
  revisionId: 'ff00ee1',
  occurredAt: at('2026-07-30T19:00:00Z'),
  authoredAt: at('2026-07-30T19:00:00Z'),
  authorIdentity: { kind: 'email', value: 'ci-bot@build.northwind.example', displayName: 'northwind-ci' },
  message: 'Merge pull request #9201',
  parentRevisionIds: ['6a7b8c9'],
  branchName: 'main',
});
