import type { Instant, TimeWindow } from '@compass/clock';

import type { SourceCoverage, CoverageStatus, SourceHealthReport } from './coverage.js';
import { worstStatus } from './coverage.js';
import type {
  ArtifactKind,
  BranchRefRecord,
  CommitRecord,
  IssueRecord,
  IssueTransitionRecord,
  MessageRecord,
  PullRequestRecord,
  ReleaseTagRecord,
  ReviewRecord,
  SourceKind,
  SprintRecord,
  SprintScopeChangeRecord,
} from './records.js';

/**
 * Every port method takes exactly one of these. The window is the shared
 * half-open `[start, end)` type from @compass/clock — not a loose pair of
 * instants — so the boundary convention cannot drift between implementations.
 *
 * `now` is passed in as well: a connector may need to describe *when* it
 * observed something (coverage records carry `observedAt`), and it must not
 * read the host clock to find out.
 */
export interface ConnectorRequest {
  readonly organizationId: string;
  readonly window: TimeWindow;
  readonly now: Instant;
  /** Restricts the query to specific configured sources; all of them when absent. */
  readonly sourceKeys?: readonly string[];
}

/**
 * The result type that makes honest degradation unavoidable.
 *
 * `coverage` is required and `status` is derived from it, so a caller reading
 * only `records` still has `status` staring at it. An unavailable source
 * produces `status: 'unavailable'` with zero records — never a silent empty
 * array that reads as "nothing happened".
 */
export interface ConnectorResult<TRecord> {
  readonly artifact: ArtifactKind;
  readonly window: TimeWindow;
  readonly status: CoverageStatus;
  readonly records: readonly TRecord[];
  readonly coverage: readonly SourceCoverage[];
}

export function connectorResult<TRecord>(
  artifact: ArtifactKind,
  window: TimeWindow,
  records: readonly TRecord[],
  coverage: readonly SourceCoverage[],
): ConnectorResult<TRecord> {
  return Object.freeze({
    artifact,
    window,
    status: worstStatus(coverage),
    records: Object.freeze([...records]),
    coverage: Object.freeze([...coverage]),
  });
}

/** Sources that could not answer, with the reason a manager would be told. */
export function degradedCoverage(result: ConnectorResult<unknown>): readonly SourceCoverage[] {
  return result.coverage.filter((coverage) => coverage.status !== 'complete');
}

export function isFullyCovered(result: ConnectorResult<unknown>): boolean {
  return result.status === 'complete';
}

/** What a provider can and cannot answer. Honest absence, never a silent zero. */
export interface ConnectorCapabilities {
  readonly connectorId: string;
  /** Which artifact families this provider can produce at all. */
  readonly artifacts: Readonly<Record<ArtifactKind, boolean>>;
  /**
   * R5 of the Completion Ladder. False everywhere until a CI/CD connector
   * exists; the report then says "no deploy signal available" rather than
   * inferring a deploy.
   */
  readonly deploySignal: boolean;
  /** Chat ingest is opt-in per named conversation, never workspace-wide. */
  readonly chatScope: 'none' | 'opted_in_conversations';
  readonly sources: readonly { readonly sourceKey: string; readonly sourceKind: SourceKind }[];
}

/**
 * The time-windowed query port every data source implements.
 *
 * The seeded provider and a live GitHub/Jira/Slack provider implement exactly
 * this and pass exactly the same conformance suite, which is what makes "no code
 * path knows whether data is seeded" a mechanically checked property.
 *
 * Contract, asserted by `describeConnectorContract`:
 *  - a record is returned iff its `occurredAt` lies in `[window.start, window.end)`
 *  - results are in canonical order (see `compareRecords`)
 *  - the same request twice returns deeply equal results (idempotent, no cursor state)
 *  - unavailability is reported as coverage, never thrown
 */
export interface ConnectorPort {
  readonly connectorId: string;

  capabilities(): ConnectorCapabilities;

  fetchCommits(request: ConnectorRequest): Promise<ConnectorResult<CommitRecord>>;
  fetchPullRequests(request: ConnectorRequest): Promise<ConnectorResult<PullRequestRecord>>;
  fetchReviews(request: ConnectorRequest): Promise<ConnectorResult<ReviewRecord>>;
  fetchBranchRefs(request: ConnectorRequest): Promise<ConnectorResult<BranchRefRecord>>;
  fetchReleaseTags(request: ConnectorRequest): Promise<ConnectorResult<ReleaseTagRecord>>;
  fetchIssues(request: ConnectorRequest): Promise<ConnectorResult<IssueRecord>>;
  fetchIssueTransitions(request: ConnectorRequest): Promise<ConnectorResult<IssueTransitionRecord>>;
  fetchSprints(request: ConnectorRequest): Promise<ConnectorResult<SprintRecord>>;
  fetchSprintScopeChanges(request: ConnectorRequest): Promise<ConnectorResult<SprintScopeChangeRecord>>;
  fetchMessages(request: ConnectorRequest): Promise<ConnectorResult<MessageRecord>>;

  /** Per-source health and freshness, for the report's coverage indicator. */
  reportSourceHealth(request: ConnectorRequest): Promise<SourceHealthReport>;
}

/** Maps an artifact family to the port method that answers it. */
export const ARTIFACT_FETCHERS = {
  commits: 'fetchCommits',
  pull_requests: 'fetchPullRequests',
  reviews: 'fetchReviews',
  branch_refs: 'fetchBranchRefs',
  release_tags: 'fetchReleaseTags',
  issues: 'fetchIssues',
  issue_transitions: 'fetchIssueTransitions',
  sprints: 'fetchSprints',
  sprint_scope_changes: 'fetchSprintScopeChanges',
  messages: 'fetchMessages',
} as const satisfies Record<ArtifactKind, keyof ConnectorPort>;

export type ArtifactFetcherName = (typeof ARTIFACT_FETCHERS)[ArtifactKind];

/** Calls the fetcher for `artifact` without the caller switching on the kind. */
export function fetchArtifact(
  connector: ConnectorPort,
  artifact: ArtifactKind,
  request: ConnectorRequest,
): Promise<ConnectorResult<unknown>> {
  const method = ARTIFACT_FETCHERS[artifact];
  return (connector[method] as (request: ConnectorRequest) => Promise<ConnectorResult<unknown>>).call(
    connector,
    request,
  );
}
