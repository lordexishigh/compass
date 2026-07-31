import { type Instant, type TimeWindow, isInstant, timeWindow } from '@compass/clock';
import { z } from 'zod';

/**
 * Provider-neutral record shapes.
 *
 * Every record carries the same envelope — which configured source it came
 * from, that source's own opaque id for it, and the single event time the
 * window filter applies to. Connectors translate their provider's vocabulary
 * into this shape; nothing downstream of the port ever sees the original.
 */

export const InstantSchema = z.custom<Instant>((value) => isInstant(value), {
  message: 'expected an Instant (whole milliseconds since the epoch)',
});

export const TimeWindowSchema = z
  .object({ start: InstantSchema, end: InstantSchema })
  .transform((value): TimeWindow => timeWindow(value.start, value.end));

/** What a configured source is, independent of who provides it. */
export const SourceKindSchema = z.enum(['code', 'tracker', 'chat']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** The ten artifact families the port can be asked for. */
export const ARTIFACT_KINDS = [
  'commits',
  'pull_requests',
  'reviews',
  'branch_refs',
  'release_tags',
  'issues',
  'issue_transitions',
  'sprints',
  'sprint_scope_changes',
  'messages',
] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Which kind of source can answer for each artifact family. A tracker is never
 * asked for commits, and a chat source is only ever asked for messages.
 */
export const ARTIFACT_SOURCE_KIND = {
  commits: 'code',
  pull_requests: 'code',
  reviews: 'code',
  branch_refs: 'code',
  release_tags: 'code',
  issues: 'tracker',
  issue_transitions: 'tracker',
  sprints: 'tracker',
  sprint_scope_changes: 'tracker',
  messages: 'chat',
} as const satisfies Record<ArtifactKind, z.infer<typeof SourceKindSchema>>;

/**
 * A person as the source knows them. Compass resolves these to Developers
 * through the IdentityLink roster; a connector never guesses at identity.
 */
export const ExternalIdentitySchema = z.strictObject({
  kind: z.enum(['email', 'account', 'handle']),
  value: z.string().min(1),
  displayName: z.string().nullable(),
});
export type ExternalIdentity = z.infer<typeof ExternalIdentitySchema>;

const envelope = {
  /** The configured source this came from, e.g. `primary-code`. */
  sourceKey: z.string().min(1),
  sourceKind: SourceKindSchema,
  /** The source's own opaque identifier — never parsed, only compared. */
  sourceRecordId: z.string().min(1),
  /** The single event time the half-open window filter is applied to. */
  occurredAt: InstantSchema,
};

export const CommitRecordSchema = z.strictObject({
  ...envelope,
  repositoryKey: z.string().min(1),
  revisionId: z.string().min(1),
  parentRevisionIds: z.array(z.string().min(1)),
  authorIdentity: ExternalIdentitySchema,
  committerIdentity: ExternalIdentitySchema.nullable(),
  authoredAt: InstantSchema,
  message: z.string(),
  changedFileCount: z.number().int().nonnegative(),
  branchName: z.string().nullable(),
});
export type CommitRecord = z.infer<typeof CommitRecordSchema>;

export const PullRequestRecordSchema = z.strictObject({
  ...envelope,
  repositoryKey: z.string().min(1),
  /** The number a human would say out loud ("PR #883"). */
  displayNumber: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  authorIdentity: ExternalIdentitySchema,
  state: z.enum(['draft', 'open', 'merged', 'closed']),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  mergedAt: InstantSchema.nullable(),
  closedAt: InstantSchema.nullable(),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  headRevisionId: z.string().min(1),
  mergeRevisionId: z.string().nullable(),
  requestedReviewerIdentities: z.array(ExternalIdentitySchema),
  linkedWorkItemKeys: z.array(z.string().min(1)),
});
export type PullRequestRecord = z.infer<typeof PullRequestRecordSchema>;

export const ReviewRecordSchema = z.strictObject({
  ...envelope,
  repositoryKey: z.string().min(1),
  /** `sourceRecordId` of the pull request under review. */
  pullRequestRef: z.string().min(1),
  reviewerIdentity: ExternalIdentitySchema,
  verdict: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']),
  submittedAt: InstantSchema,
  commentCount: z.number().int().nonnegative(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const BranchRefRecordSchema = z.strictObject({
  ...envelope,
  repositoryKey: z.string().min(1),
  name: z.string().min(1),
  revisionId: z.string().min(1),
  isDefault: z.boolean(),
  observedAt: InstantSchema,
});
export type BranchRefRecord = z.infer<typeof BranchRefRecordSchema>;

export const ReleaseTagRecordSchema = z.strictObject({
  ...envelope,
  repositoryKey: z.string().min(1),
  name: z.string().min(1),
  revisionId: z.string().min(1),
  releasedAt: InstantSchema,
  description: z.string().nullable(),
});
export type ReleaseTagRecord = z.infer<typeof ReleaseTagRecordSchema>;

export const WorkItemStatusCategorySchema = z.enum(['todo', 'in_progress', 'done']);
export type WorkItemStatusCategory = z.infer<typeof WorkItemStatusCategorySchema>;

export const IssueRecordSchema = z.strictObject({
  ...envelope,
  projectKey: z.string().min(1),
  /** The human-facing key, e.g. `DEV-501`. Opaque to Compass. */
  itemKey: z.string().min(1),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string().min(1),
  statusCategory: WorkItemStatusCategorySchema,
  itemType: z.string().min(1),
  priority: z.string().nullable(),
  estimatePoints: z.number().nullable(),
  labels: z.array(z.string()),
  assigneeIdentity: ExternalIdentitySchema.nullable(),
  reporterIdentity: ExternalIdentitySchema.nullable(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  resolvedAt: InstantSchema.nullable(),
  parentItemKey: z.string().nullable(),
  sprintRefs: z.array(z.string().min(1)),
  /** The tracker's own "this is blocked" marker, if it has one. */
  flaggedBlocked: z.boolean(),
});
export type IssueRecord = z.infer<typeof IssueRecordSchema>;

export const IssueTransitionRecordSchema = z.strictObject({
  ...envelope,
  itemKey: z.string().min(1),
  fromStatus: z.string().nullable(),
  toStatus: z.string().min(1),
  fromStatusCategory: WorkItemStatusCategorySchema.nullable(),
  toStatusCategory: WorkItemStatusCategorySchema,
  actorIdentity: ExternalIdentitySchema.nullable(),
  transitionedAt: InstantSchema,
});
export type IssueTransitionRecord = z.infer<typeof IssueTransitionRecordSchema>;

export const SprintRecordSchema = z.strictObject({
  ...envelope,
  projectKey: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().nullable(),
  state: z.enum(['future', 'active', 'closed']),
  startAt: InstantSchema,
  endAt: InstantSchema,
  completedAt: InstantSchema.nullable(),
  committedItemKeys: z.array(z.string().min(1)),
});
export type SprintRecord = z.infer<typeof SprintRecordSchema>;

export const SprintScopeChangeRecordSchema = z.strictObject({
  ...envelope,
  /** `sourceRecordId` of the sprint whose scope changed. */
  sprintRef: z.string().min(1),
  itemKey: z.string().min(1),
  change: z.enum(['added', 'removed']),
  actorIdentity: ExternalIdentitySchema.nullable(),
  changedAt: InstantSchema,
});
export type SprintScopeChangeRecord = z.infer<typeof SprintScopeChangeRecordSchema>;

export const MessageRecordSchema = z.strictObject({
  ...envelope,
  /** Opaque id of the opted-in conversation. Chat ingest is never workspace-wide. */
  conversationKey: z.string().min(1),
  conversationName: z.string().min(1),
  authorIdentity: ExternalIdentitySchema,
  body: z.string(),
  threadRef: z.string().nullable(),
  referencedItemKeys: z.array(z.string().min(1)),
  postedAt: InstantSchema,
});
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

/** Every record type, keyed by the artifact family it belongs to. */
export const ARTIFACT_SCHEMAS = {
  commits: CommitRecordSchema,
  pull_requests: PullRequestRecordSchema,
  reviews: ReviewRecordSchema,
  branch_refs: BranchRefRecordSchema,
  release_tags: ReleaseTagRecordSchema,
  issues: IssueRecordSchema,
  issue_transitions: IssueTransitionRecordSchema,
  sprints: SprintRecordSchema,
  sprint_scope_changes: SprintScopeChangeRecordSchema,
  messages: MessageRecordSchema,
} as const satisfies Record<ArtifactKind, z.ZodType>;

/** The shared envelope every record carries, whatever its family. */
export interface ConnectorRecordEnvelope {
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly sourceRecordId: string;
  readonly occurredAt: Instant;
}

export type ConnectorRecordFor<TKind extends ArtifactKind> = z.infer<(typeof ARTIFACT_SCHEMAS)[TKind]>;

export type AnyConnectorRecord =
  | CommitRecord
  | PullRequestRecord
  | ReviewRecord
  | BranchRefRecord
  | ReleaseTagRecord
  | IssueRecord
  | IssueTransitionRecord
  | SprintRecord
  | SprintScopeChangeRecord
  | MessageRecord;
