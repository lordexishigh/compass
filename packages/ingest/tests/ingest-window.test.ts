import { instantFromIso, timeWindow, type TimeWindow } from '@compass/clock';
import {
  ARTIFACT_KINDS,
  completeCoverage,
  connectorResult,
  unavailableCoverage,
  type ArtifactKind,
  type ConnectorPort,
  type ConnectorRequest,
} from '@compass/connector-port';
import { describe, expect, it } from 'vitest';

import { ingestWindow, isCompleteRun } from '@compass/ingest';

const organizationId = '11111111-1111-4111-8111-111111111111';
const window: TimeWindow = timeWindow(instantFromIso('2026-07-29T00:00:00Z'), instantFromIso('2026-07-30T00:00:00Z'));
const now = instantFromIso('2026-07-30T08:00:00Z');

const commit = (sourceRecordId: string) => ({
  sourceKey: 'primary-code',
  sourceKind: 'code' as const,
  sourceRecordId,
  occurredAt: instantFromIso('2026-07-29T10:00:00Z'),
});

/**
 * A hand-written double rather than the seed connector: ingest must not be able
 * to import a provider, and an architecture test enforces exactly that.
 */
function fakeConnector(
  overrides: {
    readonly records?: Partial<Record<ArtifactKind, readonly unknown[]>>;
    readonly unavailable?: readonly ArtifactKind[];
    readonly throwsOn?: readonly ArtifactKind[];
  } = {},
): ConnectorPort {
  const answer = (artifact: ArtifactKind) => (request: ConnectorRequest) => {
    if (overrides.throwsOn?.includes(artifact)) {
      throw new Error('socket hang up');
    }
    if (overrides.unavailable?.includes(artifact)) {
      return Promise.resolve(
        connectorResult(artifact, request.window, [], [
          unavailableCoverage({
            sourceKey: 'primary-code',
            sourceKind: 'code',
            artifact,
            requestedWindow: request.window,
            observedAt: request.now,
            reason: 'rate_limited',
            detail: 'primary-code is rate limited until 08:45.',
          }),
        ]),
      );
    }
    const records = overrides.records?.[artifact] ?? [];
    return Promise.resolve(
      connectorResult(artifact, request.window, records, [
        completeCoverage({
          sourceKey: 'primary-code',
          sourceKind: 'code',
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          recordCount: records.length,
        }),
      ]),
    );
  };

  const port = {
    connectorId: 'fake',
    capabilities: () => ({
      connectorId: 'fake',
      artifacts: Object.fromEntries(ARTIFACT_KINDS.map((artifact) => [artifact, true])) as Record<
        ArtifactKind,
        boolean
      >,
      deploySignal: false,
      chatScope: 'none' as const,
      sources: [{ sourceKey: 'primary-code', sourceKind: 'code' as const }],
    }),
    reportSourceHealth: (request: ConnectorRequest) =>
      Promise.resolve({
        connectorId: 'fake',
        window: request.window,
        observedAt: request.now,
        overall: 'complete' as const,
        sources: [],
      }),
    fetchCommits: answer('commits'),
    fetchPullRequests: answer('pull_requests'),
    fetchReviews: answer('reviews'),
    fetchBranchRefs: answer('branch_refs'),
    fetchReleaseTags: answer('release_tags'),
    fetchIssues: answer('issues'),
    fetchIssueTransitions: answer('issue_transitions'),
    fetchSprints: answer('sprints'),
    fetchSprintScopeChanges: answer('sprint_scope_changes'),
    fetchMessages: answer('messages'),
  };

  return port as unknown as ConnectorPort;
}

describe('ingestWindow', () => {
  it('pulls every artifact family and counts them per kind', async () => {
    const { summary, batches } = await ingestWindow(
      fakeConnector({ records: { commits: [commit('c1'), commit('c2')], issues: [commit('i1')] } }),
      { organizationId, window, now },
    );

    expect(batches.map((batch) => batch.artifact)).toEqual([...ARTIFACT_KINDS]);
    expect(summary.artifactCounts.commits).toBe(2);
    expect(summary.artifactCounts.issues).toBe(1);
    expect(summary.artifactCounts.messages).toBe(0);
    expect(summary.totalRecords).toBe(3);
    expect(summary.status).toBe('complete');
    expect(isCompleteRun(summary)).toBe(true);
  });

  it('takes the instant it is given and records it on the run', async () => {
    const { summary } = await ingestWindow(fakeConnector(), { organizationId, window, now });

    expect(summary.startedAt).toBe(now);
    expect(summary.window).toEqual(window);
    expect(summary.organizationId).toBe(organizationId);
    expect(summary.connectorId).toBe('fake');
  });

  it('records a degraded source instead of failing the run', async () => {
    const { summary } = await ingestWindow(fakeConnector({ unavailable: ['messages'] }), {
      organizationId,
      window,
      now,
    });

    expect(summary.status).toBe('unavailable');
    expect(isCompleteRun(summary)).toBe(false);
    expect(summary.unavailableSources).toEqual(['primary-code']);
    expect(summary.degradedDetails).toEqual(['primary-code is rate limited until 08:45.']);
  });

  it('survives a connector that throws, naming the source and the artifact', async () => {
    const { summary, batches } = await ingestWindow(fakeConnector({ throwsOn: ['reviews'] }), {
      organizationId,
      window,
      now,
    });

    const reviews = batches.find((batch) => batch.artifact === 'reviews');
    expect(reviews?.status).toBe('unavailable');
    expect(reviews?.records).toEqual([]);
    expect(summary.status).toBe('unavailable');
    expect(summary.degradedDetails.join(' ')).toContain('failed while reading reviews');
    expect(summary.degradedDetails.join(' ')).toContain('socket hang up');
    // Every other family still came back.
    expect(batches).toHaveLength(ARTIFACT_KINDS.length);
  });

  it('passes an explicit source restriction straight through', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const connector = fakeConnector();
    const spy: ConnectorPort = {
      ...connector,
      fetchCommits: (request) => {
        seen.push(request.sourceKeys);
        return connector.fetchCommits(request);
      },
    };

    await ingestWindow(spy, { organizationId, window, now, sourceKeys: ['primary-code'] });

    expect(seen[0]).toEqual(['primary-code']);
  });

  it('is deterministic: the same window twice produces the same summary', async () => {
    const connector = fakeConnector({ records: { commits: [commit('c1')] } });

    const first = await ingestWindow(connector, { organizationId, window, now });
    const second = await ingestWindow(connector, { organizationId, window, now });

    expect(JSON.stringify(second.summary)).toBe(JSON.stringify(first.summary));
  });
});
