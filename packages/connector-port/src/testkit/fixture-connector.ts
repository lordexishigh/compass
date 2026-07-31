import { windowContains, type Instant } from '@compass/clock';

import { completeCoverage, unavailableCoverage, worstCoverageStatus } from '../coverage.js';
import type { CoverageReason, SourceCoverage, SourceHealthEntry, SourceHealthReport } from '../coverage.js';
import { sortRecords } from '../ordering.js';
import { connectorResult } from '../port.js';
import type { ConnectorCapabilities, ConnectorPort, ConnectorRequest, ConnectorResult } from '../port.js';
import { ARTIFACT_KINDS, ARTIFACT_SOURCE_KIND } from '../records.js';
import type {
  ArtifactKind,
  BranchRefRecord,
  CommitRecord,
  ConnectorRecordEnvelope,
  ConnectorRecordFor,
  IssueRecord,
  IssueTransitionRecord,
  MessageRecord,
  PullRequestRecord,
  ReleaseTagRecord,
  ReviewRecord,
  SourceKind,
  SprintRecord,
  SprintScopeChangeRecord,
} from '../records.js';

/**
 * The port's own test double.
 *
 * Layers below the port must not know that a seeded provider exists — an
 * architecture gate reads their imports and fails the build if they do — yet
 * those same layers have to be tested against *something* that speaks the port.
 * Hand-rolling a connector per package is how that ends badly: five doubles, five
 * subtly different ideas of what a half-open window means, and a suite that
 * passes against behaviour no real provider has.
 *
 * So the double lives here, beside the conformance kit that defines correct
 * behaviour, and it is the same object shape the seeded provider serves: a list
 * of declared sources (any of which may be pretending to be down) and a record
 * set keyed by artifact family. Callers supply the records; the window filter,
 * the source routing and the coverage bookkeeping are this class's job and are
 * written once.
 *
 * It holds no cursor state and reads no clock, so it passes
 * `describeConnectorContract` unmodified given a fixture with data in the window.
 */

export interface FixtureSource {
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly availability:
    | { readonly status: 'available' }
    | { readonly status: 'unavailable'; readonly reason: CoverageReason; readonly detail: string };
}

export type FixtureRecords = { readonly [TKind in ArtifactKind]?: readonly ConnectorRecordFor<TKind>[] };

export interface FixtureDataset {
  readonly datasetId: string;
  readonly sources: readonly FixtureSource[];
  readonly records: FixtureRecords;
  /** R5 of the Completion Ladder is only ever true when a CI/CD source says so. */
  readonly deploySignal?: boolean;
}

const EMPTY: readonly ConnectorRecordEnvelope[] = Object.freeze([]);

export class FixtureConnector implements ConnectorPort {
  readonly connectorId: string;
  readonly #dataset: FixtureDataset;

  constructor(dataset: FixtureDataset) {
    this.#dataset = dataset;
    this.connectorId = `fixture:${dataset.datasetId}`;
  }

  capabilities(): ConnectorCapabilities {
    const kinds = new Set(this.#dataset.sources.map((source) => source.sourceKind));
    const artifacts = Object.fromEntries(
      ARTIFACT_KINDS.map((artifact) => [artifact, kinds.has(ARTIFACT_SOURCE_KIND[artifact])]),
    ) as Record<ArtifactKind, boolean>;

    return {
      connectorId: this.connectorId,
      artifacts,
      deploySignal: this.#dataset.deploySignal ?? false,
      chatScope: kinds.has('chat') ? 'opted_in_conversations' : 'none',
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
    const sources: SourceHealthEntry[] = this.#dataset.sources.map((source) =>
      source.availability.status === 'unavailable'
        ? {
            sourceKey: source.sourceKey,
            sourceKind: source.sourceKind,
            status: 'unavailable',
            reason: source.availability.reason,
            detail: source.availability.detail,
            lastObservedAt: this.#lastObservedAt(source.sourceKey),
          }
        : {
            sourceKey: source.sourceKey,
            sourceKind: source.sourceKind,
            status: 'complete',
            reason: 'ok',
            detail: `${source.sourceKey} is reachable and answering.`,
            lastObservedAt: this.#lastObservedAt(source.sourceKey),
          },
    );

    return {
      connectorId: this.connectorId,
      window: request.window,
      observedAt: request.now,
      overall: worstCoverageStatus(sources.map((source) => source.status)),
      sources,
    };
  }

  #sourcesFor(request: ConnectorRequest): readonly (FixtureSource | { readonly unknownSourceKey: string })[] {
    if (!request.sourceKeys) return this.#dataset.sources;
    return request.sourceKeys.map(
      (sourceKey) =>
        this.#dataset.sources.find((source) => source.sourceKey === sourceKey) ?? { unknownSourceKey: sourceKey },
    );
  }

  #recordsFor(artifact: ArtifactKind): readonly ConnectorRecordEnvelope[] {
    return (this.#dataset.records[artifact] as readonly ConnectorRecordEnvelope[] | undefined) ?? EMPTY;
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
        // Unavailability is reported for every artifact the source would have
        // answered, including the ones it does not serve, so a manager sees the
        // source named once per family rather than silently dropped.
        if (source.sourceKind === expectedKind || explicitlyRequested) {
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
        }
        continue;
      }

      if (source.sourceKind !== expectedKind) {
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

    return connectorResult(artifact, window, sortRecords(records) as readonly ConnectorRecordFor<TKind>[], coverage);
  }
}
