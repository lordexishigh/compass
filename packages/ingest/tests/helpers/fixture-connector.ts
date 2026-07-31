import { windowContains, type Instant } from '@compass/clock';
import {
  ARTIFACT_KINDS,
  ARTIFACT_SOURCE_KIND,
  completeCoverage,
  connectorResult,
  sortRecords,
  type ArtifactKind,
  type ConnectorCapabilities,
  type ConnectorPort,
  type ConnectorRecordEnvelope,
  type ConnectorRequest,
  type ConnectorResult,
  type SourceHealthReport,
} from '@compass/connector-port';

/**
 * A hand-written connector over an in-test record set.
 *
 * Deliberately not the seeded provider: the ingest layer must be *designed*
 * against the port rather than against the shape of whatever dataset happens to be
 * checked in, and `tools/quality-gates` fails the build if this package names a
 * seed module in either `src` or `tests`.
 *
 * It behaves the way the port's conformance contract requires — half-open window
 * filtering, canonical ordering, no cursor state — so an idempotency result here
 * transfers to a live provider.
 */
export type FixtureRecords = Partial<Record<ArtifactKind, readonly ConnectorRecordEnvelope[]>>;

export class FixtureConnector implements ConnectorPort {
  readonly connectorId = 'fixture:knowledge-model';
  readonly #records: FixtureRecords;

  constructor(records: FixtureRecords) {
    this.#records = records;
  }

  capabilities(): ConnectorCapabilities {
    return {
      connectorId: this.connectorId,
      artifacts: Object.fromEntries(ARTIFACT_KINDS.map((artifact) => [artifact, true])) as Record<
        ArtifactKind,
        boolean
      >,
      deploySignal: false,
      chatScope: 'opted_in_conversations',
      sources: [
        { sourceKey: 'primary-code', sourceKind: 'code' },
        { sourceKey: 'primary-tracker', sourceKind: 'tracker' },
        { sourceKey: 'team-chat', sourceKind: 'chat' },
      ],
    };
  }

  #query(artifact: ArtifactKind, request: ConnectorRequest): Promise<ConnectorResult<never>> {
    const sourceKind = ARTIFACT_SOURCE_KIND[artifact];
    const sourceKey =
      sourceKind === 'code' ? 'primary-code' : sourceKind === 'tracker' ? 'primary-tracker' : 'team-chat';
    const matched = (this.#records[artifact] ?? []).filter((record) =>
      windowContains(request.window, record.occurredAt),
    );

    return Promise.resolve(
      connectorResult(artifact, request.window, sortRecords(matched) as never[], [
        completeCoverage({
          sourceKey,
          sourceKind,
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          recordCount: matched.length,
        }),
      ]),
    );
  }

  fetchCommits(request: ConnectorRequest) {
    return this.#query('commits', request) as never;
  }
  fetchPullRequests(request: ConnectorRequest) {
    return this.#query('pull_requests', request) as never;
  }
  fetchReviews(request: ConnectorRequest) {
    return this.#query('reviews', request) as never;
  }
  fetchBranchRefs(request: ConnectorRequest) {
    return this.#query('branch_refs', request) as never;
  }
  fetchReleaseTags(request: ConnectorRequest) {
    return this.#query('release_tags', request) as never;
  }
  fetchIssues(request: ConnectorRequest) {
    return this.#query('issues', request) as never;
  }
  fetchIssueTransitions(request: ConnectorRequest) {
    return this.#query('issue_transitions', request) as never;
  }
  fetchSprints(request: ConnectorRequest) {
    return this.#query('sprints', request) as never;
  }
  fetchSprintScopeChanges(request: ConnectorRequest) {
    return this.#query('sprint_scope_changes', request) as never;
  }
  fetchMessages(request: ConnectorRequest) {
    return this.#query('messages', request) as never;
  }

  reportSourceHealth(request: ConnectorRequest): Promise<SourceHealthReport> {
    return Promise.resolve({
      connectorId: this.connectorId,
      window: request.window,
      observedAt: request.now,
      overall: 'complete',
      sources: this.capabilities().sources.map((source) => ({
        sourceKey: source.sourceKey,
        sourceKind: source.sourceKind,
        status: 'complete' as const,
        reason: 'ok' as const,
        detail: `${source.sourceKey} is reachable and answering.`,
        lastObservedAt: this.#lastObservedAt(source.sourceKey),
      })),
    });
  }

  #lastObservedAt(sourceKey: string): Instant | null {
    let latest: Instant | null = null;
    for (const artifact of ARTIFACT_KINDS) {
      for (const record of this.#records[artifact] ?? []) {
        if (record.sourceKey !== sourceKey) continue;
        if (latest === null || record.occurredAt > latest) latest = record.occurredAt;
      }
    }
    return latest;
  }
}
