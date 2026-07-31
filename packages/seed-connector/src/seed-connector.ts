import { windowContains, type Instant } from '@compass/clock';
import {
  ARTIFACT_KINDS,
  ARTIFACT_SOURCE_KIND,
  completeCoverage,
  connectorResult,
  sortRecords,
  unavailableCoverage,
  worstCoverageStatus,
  type ArtifactKind,
  type BranchRefRecord,
  type CommitRecord,
  type ConnectorCapabilities,
  type ConnectorPort,
  type ConnectorRecordEnvelope,
  type ConnectorRecordFor,
  type ConnectorRequest,
  type ConnectorResult,
  type IssueRecord,
  type IssueTransitionRecord,
  type MessageRecord,
  type PullRequestRecord,
  type ReleaseTagRecord,
  type ReviewRecord,
  type SourceCoverage,
  type SourceHealthEntry,
  type SourceHealthReport,
  type SprintRecord,
  type SprintScopeChangeRecord,
} from '@compass/connector-port';

import type { SeedDataset, SeedSource } from './dataset.js';
import { foundationDataset } from './foundation-dataset.js';

/**
 * A ConnectorPort backed by checked-in fixtures.
 *
 * It answers any window against the dataset, reports honest coverage for
 * sources the fixture declares as down, and holds no cursor state — so it
 * passes the same conformance suite a live GitHub or Jira provider will have to
 * pass. Nothing downstream can tell the difference, which is the point.
 */
export class SeedConnector implements ConnectorPort {
  readonly connectorId: string;
  readonly #dataset: SeedDataset;

  constructor(dataset: SeedDataset = foundationDataset) {
    this.#dataset = dataset;
    this.connectorId = `seed:${dataset.datasetId}`;
  }

  capabilities(): ConnectorCapabilities {
    const artifacts = Object.fromEntries(ARTIFACT_KINDS.map((artifact) => [artifact, true])) as Record<
      ArtifactKind,
      boolean
    >;
    return {
      connectorId: this.connectorId,
      artifacts,
      // No CI/CD source exists, so R5 renders as 'no deploy signal available'.
      deploySignal: this.#dataset.deploySignal,
      chatScope: 'opted_in_conversations',
      sources: this.#dataset.sources.map((source) => ({
        sourceKey: source.sourceKey,
        sourceKind: source.sourceKind,
      })),
    };
  }

  fetchCommits(request: ConnectorRequest): Promise<ConnectorResult<CommitRecord>> {
    return this.#query('commits', request);
  }

  fetchPullRequests(request: ConnectorRequest): Promise<ConnectorResult<PullRequestRecord>> {
    return this.#query('pull_requests', request);
  }

  fetchReviews(request: ConnectorRequest): Promise<ConnectorResult<ReviewRecord>> {
    return this.#query('reviews', request);
  }

  fetchBranchRefs(request: ConnectorRequest): Promise<ConnectorResult<BranchRefRecord>> {
    return this.#query('branch_refs', request);
  }

  fetchReleaseTags(request: ConnectorRequest): Promise<ConnectorResult<ReleaseTagRecord>> {
    return this.#query('release_tags', request);
  }

  fetchIssues(request: ConnectorRequest): Promise<ConnectorResult<IssueRecord>> {
    return this.#query('issues', request);
  }

  fetchIssueTransitions(request: ConnectorRequest): Promise<ConnectorResult<IssueTransitionRecord>> {
    return this.#query('issue_transitions', request);
  }

  fetchSprints(request: ConnectorRequest): Promise<ConnectorResult<SprintRecord>> {
    return this.#query('sprints', request);
  }

  fetchSprintScopeChanges(request: ConnectorRequest): Promise<ConnectorResult<SprintScopeChangeRecord>> {
    return this.#query('sprint_scope_changes', request);
  }

  fetchMessages(request: ConnectorRequest): Promise<ConnectorResult<MessageRecord>> {
    return this.#query('messages', request);
  }

  async reportSourceHealth(request: ConnectorRequest): Promise<SourceHealthReport> {
    const sources: SourceHealthEntry[] = this.#dataset.sources.map((source) => {
      const lastObservedAt = this.#lastObservedAt(source.sourceKey);
      if (source.availability.status === 'unavailable') {
        return {
          sourceKey: source.sourceKey,
          sourceKind: source.sourceKind,
          status: 'unavailable',
          reason: source.availability.reason,
          detail: source.availability.detail,
          lastObservedAt,
        };
      }
      return {
        sourceKey: source.sourceKey,
        sourceKind: source.sourceKind,
        status: 'complete',
        reason: 'ok',
        detail: `${source.sourceKey} is reachable and answering.`,
        lastObservedAt,
      };
    });

    return {
      connectorId: this.connectorId,
      window: request.window,
      observedAt: request.now,
      overall: worstCoverageStatus(sources.map((source) => source.status)),
      sources,
    };
  }

  /** Sources considered for this request, in declaration order. */
  #sourcesFor(request: ConnectorRequest): readonly (SeedSource | { readonly unknownSourceKey: string })[] {
    if (!request.sourceKeys) return this.#dataset.sources;
    return request.sourceKeys.map(
      (sourceKey) =>
        this.#dataset.sources.find((source) => source.sourceKey === sourceKey) ?? { unknownSourceKey: sourceKey },
    );
  }

  #lastObservedAt(sourceKey: string): Instant | null {
    let latestSeen: Instant | null = null;
    for (const artifact of ARTIFACT_KINDS) {
      for (const record of this.#recordsFor(artifact)) {
        if (record.sourceKey !== sourceKey) continue;
        if (latestSeen === null || record.occurredAt > latestSeen) latestSeen = record.occurredAt;
      }
    }
    return latestSeen;
  }

  /**
   * The dataset is a mapped type keyed by artifact kind; reading it through a
   * generic key needs one widening step, done here so the fetchers stay typed.
   */
  #recordsFor(artifact: ArtifactKind): readonly ConnectorRecordEnvelope[] {
    return this.#dataset.records[artifact] as readonly ConnectorRecordEnvelope[];
  }

  async #query<TKind extends ArtifactKind>(
    artifact: TKind,
    request: ConnectorRequest,
  ): Promise<ConnectorResult<ConnectorRecordFor<TKind>>> {
    const { window, now } = request;
    const expectedKind = ARTIFACT_SOURCE_KIND[artifact];
    const explicitlyRequested = request.sourceKeys !== undefined;

    const coverage: SourceCoverage[] = [];
    const records: ConnectorRecordEnvelope[] = [];

    for (const source of this.#sourcesFor(request)) {
      if ('unknownSourceKey' in source) {
        coverage.push(
          unavailableCoverage({
            sourceKey: source.unknownSourceKey,
            sourceKind: expectedKind,
            artifact,
            requestedWindow: window,
            observedAt: now,
            reason: 'not_configured',
            detail: `${source.unknownSourceKey} is not a configured source for this organization.`,
          }),
        );
        continue;
      }

      if (source.availability.status === 'unavailable') {
        coverage.push(
          unavailableCoverage({
            sourceKey: source.sourceKey,
            sourceKind: source.sourceKind,
            artifact,
            requestedWindow: window,
            observedAt: now,
            reason: source.availability.reason,
            detail: source.availability.detail,
          }),
        );
        continue;
      }

      if (source.sourceKind !== expectedKind) {
        // Only worth saying when the caller named this source explicitly;
        // otherwise a tracker simply has no opinion about commits.
        if (explicitlyRequested) {
          coverage.push(
            unavailableCoverage({
              sourceKey: source.sourceKey,
              sourceKind: source.sourceKind,
              artifact,
              requestedWindow: window,
              observedAt: now,
              reason: 'capability_absent',
              detail: `${source.sourceKey} is a ${source.sourceKind} source and cannot answer for ${artifact}.`,
            }),
          );
        }
        continue;
      }

      const matched = this.#recordsFor(artifact).filter(
        (record) => record.sourceKey === source.sourceKey && windowContains(window, record.occurredAt),
      );
      records.push(...matched);
      coverage.push(
        completeCoverage({
          sourceKey: source.sourceKey,
          sourceKind: source.sourceKind,
          artifact,
          requestedWindow: window,
          observedAt: now,
          recordCount: matched.length,
        }),
      );
    }

    if (coverage.length === 0) {
      // No source of the right kind is configured at all. Say so, rather than
      // returning an empty array that reads as a quiet day.
      coverage.push(
        unavailableCoverage({
          sourceKey: `no-${expectedKind}-source`,
          sourceKind: expectedKind,
          artifact,
          requestedWindow: window,
          observedAt: now,
          reason: 'not_configured',
          detail: `no-${expectedKind}-source: this organization has no ${expectedKind} source configured, so ${artifact} could not be read.`,
        }),
      );
    }

    return connectorResult(
      artifact,
      window,
      sortRecords(records) as readonly ConnectorRecordFor<TKind>[],
      coverage,
    );
  }
}
