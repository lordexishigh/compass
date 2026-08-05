import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { ARTIFACT_KINDS, CompositeConnector, EmptyCompositionError, fetchArtifact } from '../src/index.js';
import type { ConnectorPort, ExternalIdentity } from '../src/index.js';
import { describeConnectorContract, FixtureConnector } from '../src/testkit/index.js';
import type { FixtureDataset } from '../src/testkit/index.js';

/**
 * The composite is a `ConnectorPort`, so it runs the same conformance suite every provider runs.
 *
 * That is the point of the arrangement rather than a nicety. The fan-out from three connectors to one
 * port is the only piece of connector logic the composition root would otherwise contain, and the
 * properties it can quietly break are the subtle ones: canonical ordering *across* two merged result
 * sets, and a `complete` status derived from coverage that arrived from two places. Both are invisible in
 * review and both are caught here.
 */

const ORGANIZATION_ID = '77777777-7777-4777-8777-777777777777';

const WINDOW: TimeWindow = timeWindow(instantFromIso('2026-07-29T00:00:00Z'), instantFromIso('2026-07-31T00:00:00Z'));
const NOW: Instant = instantFromIso('2026-07-31T07:30:00Z');

const at = (iso: string): Instant => instantFromIso(iso);
const HANDLE: ExternalIdentity = { kind: 'handle', value: 'priya', displayName: 'Priya Raman' };

/** A code source, with records on both sides of the midpoint so the partition property is exercised. */
const CODE_DATASET: FixtureDataset = {
  datasetId: 'code',
  sources: [{ sourceKey: 'primary-code', sourceKind: 'code', availability: { status: 'available' } }],
  records: {
    commits: [
      {
        sourceKey: 'primary-code',
        sourceKind: 'code',
        sourceRecordId: 'rev-early',
        occurredAt: at('2026-07-29T15:00:00Z'),
        repositoryKey: 'checkout-web',
        revisionId: 'rev-early',
        parentRevisionIds: [],
        authorIdentity: HANDLE,
        committerIdentity: HANDLE,
        authoredAt: at('2026-07-29T15:00:00Z'),
        message: 'DEV-501 batch the checkout writer',
        changedFileCount: 6,
        branchName: null,
      },
      {
        sourceKey: 'primary-code',
        sourceKind: 'code',
        sourceRecordId: 'rev-late',
        occurredAt: at('2026-07-30T13:40:00Z'),
        repositoryKey: 'checkout-web',
        revisionId: 'rev-late',
        parentRevisionIds: ['rev-early'],
        authorIdentity: HANDLE,
        committerIdentity: HANDLE,
        authoredAt: at('2026-07-30T13:40:00Z'),
        message: 'DEV-501 follow-up',
        changedFileCount: 2,
        branchName: null,
      },
    ],
    pull_requests: [
      {
        sourceKey: 'primary-code',
        sourceKind: 'code',
        sourceRecordId: 'pr-1',
        occurredAt: at('2026-07-30T13:40:00Z'),
        repositoryKey: 'checkout-web',
        displayNumber: 883,
        title: 'Batch the checkout writer',
        description: 'DEV-501',
        authorIdentity: HANDLE,
        state: 'merged',
        createdAt: at('2026-07-29T10:00:00Z'),
        updatedAt: at('2026-07-30T13:40:00Z'),
        mergedAt: at('2026-07-30T13:40:00Z'),
        closedAt: at('2026-07-30T13:40:00Z'),
        sourceBranch: 'feature/DEV-501',
        targetBranch: 'main',
        headRevisionId: 'rev-early',
        mergeRevisionId: 'rev-late',
        requestedReviewerIdentities: [],
        linkedWorkItemKeys: ['DEV-501'],
      },
    ],
    reviews: [
      {
        sourceKey: 'primary-code',
        sourceKind: 'code',
        sourceRecordId: 'review-1',
        occurredAt: at('2026-07-29T18:00:00Z'),
        repositoryKey: 'checkout-web',
        pullRequestRef: 'pr-1',
        reviewerIdentity: HANDLE,
        verdict: 'approved',
        submittedAt: at('2026-07-29T18:00:00Z'),
        commentCount: 0,
      },
    ],
    branch_refs: [
      {
        sourceKey: 'primary-code',
        sourceKind: 'code',
        sourceRecordId: 'checkout-web:main',
        occurredAt: at('2026-07-30T13:40:00Z'),
        repositoryKey: 'checkout-web',
        name: 'main',
        revisionId: 'rev-late',
        isDefault: true,
        observedAt: NOW,
      },
    ],
    release_tags: [
      {
        sourceKey: 'primary-code',
        sourceKind: 'code',
        sourceRecordId: 'checkout-web:v2.14',
        occurredAt: at('2026-07-30T18:00:00Z'),
        repositoryKey: 'checkout-web',
        name: 'v2.14',
        revisionId: 'rev-late',
        releasedAt: at('2026-07-30T18:00:00Z'),
        description: null,
      },
    ],
  },
};

/** A tracker source, answering the four families a code host cannot. */
const TRACKER_DATASET: FixtureDataset = {
  datasetId: 'tracker',
  sources: [{ sourceKey: 'primary-tracker', sourceKind: 'tracker', availability: { status: 'available' } }],
  records: {
    issues: [
      {
        sourceKey: 'primary-tracker',
        sourceKind: 'tracker',
        sourceRecordId: 'DEV-501',
        occurredAt: at('2026-07-29T09:00:00Z'),
        projectKey: 'DEV',
        itemKey: 'DEV-501',
        title: 'Batch the checkout writer',
        description: null,
        status: 'In Progress',
        statusCategory: 'in_progress',
        itemType: 'story',
        priority: 'High',
        estimatePoints: 5,
        labels: [],
        assigneeIdentity: HANDLE,
        reporterIdentity: HANDLE,
        createdAt: at('2026-07-28T09:00:00Z'),
        updatedAt: at('2026-07-29T09:00:00Z'),
        resolvedAt: null,
        parentItemKey: null,
        sprintRefs: ['sprint-14'],
        flaggedBlocked: false,
      },
    ],
    issue_transitions: [
      {
        sourceKey: 'primary-tracker',
        sourceKind: 'tracker',
        sourceRecordId: 'DEV-501:1',
        occurredAt: at('2026-07-30T09:00:00Z'),
        itemKey: 'DEV-501',
        fromStatus: 'To Do',
        toStatus: 'In Progress',
        fromStatusCategory: 'todo',
        toStatusCategory: 'in_progress',
        actorIdentity: HANDLE,
        transitionedAt: at('2026-07-30T09:00:00Z'),
      },
    ],
    sprints: [
      {
        sourceKey: 'primary-tracker',
        sourceKind: 'tracker',
        sourceRecordId: 'sprint-14',
        occurredAt: at('2026-07-29T08:00:00Z'),
        projectKey: 'DEV',
        name: 'Sprint 14',
        goal: 'Ship checkout batching',
        state: 'active',
        startAt: at('2026-07-27T08:00:00Z'),
        endAt: at('2026-08-10T08:00:00Z'),
        completedAt: null,
        committedItemKeys: ['DEV-501'],
      },
    ],
    sprint_scope_changes: [
      {
        sourceKey: 'primary-tracker',
        sourceKind: 'tracker',
        sourceRecordId: 'sprint-14:DEV-501:added',
        occurredAt: at('2026-07-30T11:00:00Z'),
        sprintRef: 'sprint-14',
        itemKey: 'DEV-501',
        change: 'added',
        actorIdentity: HANDLE,
        changedAt: at('2026-07-30T11:00:00Z'),
      },
    ],
  },
};

/** A chat source, answering the one family neither of the others can. */
const CHAT_DATASET: FixtureDataset = {
  datasetId: 'chat',
  sources: [{ sourceKey: 'primary-chat', sourceKind: 'chat', availability: { status: 'available' } }],
  records: {
    messages: [
      {
        sourceKey: 'primary-chat',
        sourceKind: 'chat',
        sourceRecordId: 'C1:1',
        occurredAt: at('2026-07-29T15:30:00Z'),
        conversationKey: 'C1',
        conversationName: '#checkout-eng',
        authorIdentity: HANDLE,
        body: 'DEV-501 blocked on the staging key',
        threadRef: null,
        referencedItemKeys: ['DEV-501'],
        postedAt: at('2026-07-29T15:30:00Z'),
      },
      {
        sourceKey: 'primary-chat',
        sourceKind: 'chat',
        sourceRecordId: 'C1:2',
        occurredAt: at('2026-07-30T09:30:00Z'),
        conversationKey: 'C1',
        conversationName: '#checkout-eng',
        authorIdentity: HANDLE,
        body: 'DEV-501 unblocked',
        threadRef: null,
        referencedItemKeys: ['DEV-501'],
        postedAt: at('2026-07-30T09:30:00Z'),
      },
    ],
  },
};

const threeSources = (): ConnectorPort =>
  new CompositeConnector({
    connectorId: 'composite:code+tracker+chat',
    members: [
      new FixtureConnector(CODE_DATASET),
      new FixtureConnector(TRACKER_DATASET),
      new FixtureConnector(CHAT_DATASET),
    ],
  });

const request = { organizationId: ORGANIZATION_ID, window: WINDOW, now: NOW };

describeConnectorContract({
  name: 'CompositeConnector (code + tracker + chat)',
  createConnector: threeSources,
  organizationId: ORGANIZATION_ID,
  window: WINDOW,
  now: NOW,
});

describe('a composite answers as one source-of-truth rather than as a list', () => {
  it('claims every artifact its members claim between them, and no more', async () => {
    const capabilities = threeSources().capabilities();

    // All ten, because between them the three cover every family. That is the case that matters: a
    // connected organization must not have a family it cannot answer for.
    for (const artifact of ARTIFACT_KINDS) {
      expect(capabilities.artifacts[artifact], `${artifact} is unclaimed`).toBe(true);
    }
  });

  it('describes itself identically whatever order its members were assembled in', () => {
    /**
     * Two deployments composing the same three sources must look the same to everything above the port.
     * Assembly order is not a fact about the organization, so it must not reach `capabilities()`.
     */
    const forwards = new CompositeConnector({
      connectorId: 'composite:x',
      members: [new FixtureConnector(CODE_DATASET), new FixtureConnector(CHAT_DATASET)],
    });
    const backwards = new CompositeConnector({
      connectorId: 'composite:x',
      members: [new FixtureConnector(CHAT_DATASET), new FixtureConnector(CODE_DATASET)],
    });

    expect(backwards.capabilities()).toEqual(forwards.capabilities());
  });

  it('reports a healthy composite as complete rather than as degraded by absent capabilities', async () => {
    /**
     * The regression this pins is the one that would make the product permanently wrong in a way nobody
     * would trace back here. If the composite asked *every* member for `commits`, the tracker and the chat
     * source would each answer with a truthful `capability_absent` coverage record — and `worstStatus`
     * would read the merged coverage as degraded. Every report would then state that its commits were
     * incomplete when they were not, and the freshness line would be confidently wrong on every page.
     */
    const commits = await threeSources().fetchCommits(request);

    expect(commits.status).toBe('complete');
    expect(commits.records.length).toBeGreaterThan(0);
    expect(commits.coverage.map((entry) => entry.sourceKey)).toEqual(['primary-code']);
  });

  it('asks a family only of the members that claim it', async () => {
    const messages = await threeSources().fetchMessages(request);

    // Only the chat source is named. A code host's `capability_absent` for messages is true but useless,
    // and merging it in would degrade the status of a family that was read completely.
    expect(messages.coverage.map((entry) => entry.sourceKey)).toEqual(['primary-chat']);
    expect(messages.status).toBe('complete');
  });

  it('returns merged records in canonical order, not one member after another', async () => {
    /**
     * Each member returns its own ordered list. Two ordered lists appended are not ordered — and the
     * report's determinism hash is computed over the order, so a concatenating composite would change the
     * hash for no semantic reason the moment a second source was connected.
     */
    const composite = new CompositeConnector({
      connectorId: 'composite:two-code-sources',
      members: [
        new FixtureConnector(CODE_DATASET),
        new FixtureConnector({
          ...CODE_DATASET,
          datasetId: 'code-b',
          sources: [{ sourceKey: 'aux-code', sourceKind: 'code', availability: { status: 'available' } }],
          records: {
            commits: (CODE_DATASET.records.commits ?? []).slice(0, 1).map((commit) => ({
              ...commit,
              sourceKey: 'aux-code',
              // Deliberately interleaved with the other member's: that one has 07-29T15:00 and
              // 07-30T13:40, this one sits between them. A concatenating composite would put it after
              // both, which is the ordering bug this test exists to catch.
              occurredAt: at('2026-07-29T20:00:00Z'),
              authoredAt: at('2026-07-29T20:00:00Z'),
              sourceRecordId: `aux-${commit.sourceRecordId}`,
              revisionId: `aux-${commit.revisionId}`,
            })),
          },
        }),
      ],
    });

    const result = await composite.fetchCommits(request);
    const times = result.records.map((record) => record.occurredAt);

    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(result.records.map((record) => record.sourceKey)).toEqual(['primary-code', 'aux-code', 'primary-code']);
  });

  it('takes the worst member status as the whole picture', async () => {
    /**
     * A report built from a healthy code host and a throttled tracker is not a complete picture. A panel
     * that said "complete" because two of three answered would be exactly the confident polish this
     * product refuses.
     */
    const composite = new CompositeConnector({
      connectorId: 'composite:degraded',
      members: [
        new FixtureConnector(CODE_DATASET),
        new FixtureConnector({
          ...TRACKER_DATASET,
          sources: [
            {
              sourceKey: 'primary-tracker',
              sourceKind: 'tracker',
              availability: {
                status: 'unavailable',
                reason: 'rate_limited',
                detail: 'primary-tracker was rate limited, so none of this window was read.',
              },
            },
          ],
        }),
      ],
    });

    const health = await composite.reportSourceHealth(request);

    expect(health.overall).toBe('unavailable');
    expect(health.sources.map((source) => source.sourceKey)).toEqual(['primary-code', 'primary-tracker']);
    expect(health.sources.find((source) => source.sourceKey === 'primary-tracker')?.reason).toBe('rate_limited');
  });

  it('states an unanswerable family as an absent capability, not as an empty day', async () => {
    // A code host on its own cannot answer for messages. The composite has to say so in its own voice,
    // because an empty list with a `complete` status reads as "nobody said anything yesterday".
    const codeOnly = new CompositeConnector({
      connectorId: 'composite:code-only',
      members: [new FixtureConnector(CODE_DATASET)],
    });

    const result = await codeOnly.fetchMessages(request);

    expect(result.records).toEqual([]);
    expect(result.status).not.toBe('complete');
    expect(result.coverage.every((entry) => entry.reason === 'capability_absent')).toBe(true);
    expect(result.coverage[0]?.detail).toContain('no-chat-source');
  });

  it('routes a sourceKeys-restricted request to the member that owns that source', async () => {
    // This is how the incremental ingest tick asks: one window, one source at a time.
    const result = await fetchArtifact(threeSources(), 'messages', { ...request, sourceKeys: ['primary-chat'] });

    expect(result.coverage.map((entry) => entry.sourceKey)).toEqual(['primary-chat']);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it('refuses to be built with no members', () => {
    /**
     * A port that answers every question with an empty list is indistinguishable from one whose sources
     * are all down. The report would state a quiet day rather than an unconfigured deployment, which is
     * the failure honest degradation exists to prevent — so it is refused at construction.
     */
    expect(() => new CompositeConnector({ connectorId: 'composite:empty', members: [] })).toThrow(
      EmptyCompositionError,
    );
  });
});
