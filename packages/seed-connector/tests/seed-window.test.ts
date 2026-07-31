import { addMillis, MILLIS_PER_DAY, instantFromIso, timeWindow, windowContains } from '@compass/clock';
import { ARTIFACT_FETCHERS, ARTIFACT_KINDS, fetchArtifact, recordIdentity, type ArtifactKind } from '@compass/connector-port';
import { describe, expect, it } from 'vitest';

import { SeedConnector, loadSeedBundle, resolveSeedDirectory } from '@compass/seed-connector';

/**
 * Window behaviour on the real seed, beyond what the shared contract asserts.
 *
 * The contract proves the half-open rule and the partition property on one
 * window. These add the two cases ingest will actually produce against a live
 * provider: windows arriving out of order, and windows that overlap each other.
 * A connector that quietly holds a cursor passes the first suite and fails here.
 */
const bundle = loadSeedBundle(resolveSeedDirectory());
const connector = new SeedConnector(bundle.dataset);
const request = (start: string, end: string) => ({
  organizationId: bundle.organizationId,
  window: timeWindow(instantFromIso(start), instantFromIso(end)),
  now: bundle.now,
});

describe('the seed connector answers any window, in any order', () => {
  it.each([...ARTIFACT_KINDS])('returns only %s whose event time is inside the half-open window', async (artifact) => {
    // Wide enough to catch a sprint boundary (they land on 13 and 27 July), so
    // every one of the ten families really has something to filter.
    const query = request('2026-07-13T00:00:00Z', '2026-07-28T00:00:00Z');
    const result = await fetchArtifact(connector, artifact, query);

    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records as readonly { occurredAt: number; sourceRecordId: string }[]) {
      expect(
        windowContains(query.window, record.occurredAt as never),
        `${artifact} record ${record.sourceRecordId} is outside the requested window`,
      ).toBe(true);
    }
  });

  it('excludes a record sitting exactly on the window end and includes one on the start', async () => {
    const merge = instantFromIso('2026-07-30T18:40:00Z');
    const upToTheMerge = await connector.fetchCommits({
      ...request('2026-07-30T00:00:00Z', '2026-07-30T18:40:00Z'),
    });
    const fromTheMerge = await connector.fetchCommits({
      ...request('2026-07-30T18:40:00Z', '2026-07-31T00:00:00Z'),
    });

    const mergeRevision = bundle.dataset.records.commits.find((commit) => commit.occurredAt === merge)?.revisionId;

    expect(mergeRevision, 'the seeded merge commit is missing').toBeDefined();
    expect(upToTheMerge.records.map((commit) => commit.revisionId)).not.toContain(mergeRevision);
    expect(fromTheMerge.records.map((commit) => commit.revisionId)).toContain(mergeRevision);
  });

  it('answers a later window and then an earlier one identically to the reverse order', async () => {
    const early = request('2026-06-01T00:00:00Z', '2026-06-15T00:00:00Z');
    const late = request('2026-07-15T00:00:00Z', '2026-07-29T00:00:00Z');

    const forwards = [await connector.fetchIssues(early), await connector.fetchIssues(late)];
    const backwards = [await connector.fetchIssues(late), await connector.fetchIssues(early)];

    expect(backwards[1]).toEqual(forwards[0]);
    expect(backwards[0]).toEqual(forwards[1]);
  });

  it.each([...ARTIFACT_KINDS])('returns %s in overlapping windows without inventing or dropping any', async (artifact: ArtifactKind) => {
    const whole = request('2026-07-06T00:00:00Z', '2026-07-27T00:00:00Z');
    const left = request('2026-07-06T00:00:00Z', '2026-07-20T00:00:00Z');
    const right = request('2026-07-13T00:00:00Z', '2026-07-27T00:00:00Z');

    const identities = async (query: ReturnType<typeof request>): Promise<readonly string[]> =>
      (await fetchArtifact(connector, artifact, query)).records.map((record) =>
        recordIdentity(record as never),
      );

    const [all, first, second] = [await identities(whole), await identities(left), await identities(right)];
    const union = [...new Set([...first, ...second])].sort();

    expect(union).toEqual([...all].sort());
  });

  it('really does return the same records twice in the shared week, so the union above is not vacuous', async () => {
    // Release tags are sparse enough that some families have nothing in the
    // overlap, which is why the union test cannot assert this per family. One
    // dense family is enough to prove the overlap is exercised at all.
    const left = await connector.fetchCommits(request('2026-07-06T00:00:00Z', '2026-07-20T00:00:00Z'));
    const right = await connector.fetchCommits(request('2026-07-13T00:00:00Z', '2026-07-27T00:00:00Z'));
    const rightRevisions = new Set(right.records.map((commit) => commit.revisionId));

    const shared = left.records.filter((commit) => rightRevisions.has(commit.revisionId));

    expect(shared.length).toBeGreaterThan(0);
    for (const commit of shared) {
      expect(commit.occurredAt).toBeGreaterThanOrEqual(instantFromIso('2026-07-13T00:00:00Z'));
      expect(commit.occurredAt).toBeLessThan(instantFromIso('2026-07-20T00:00:00Z'));
    }
  });

  it('holds no state between calls: the same window answers the same twice', async () => {
    const query = request('2026-07-27T00:00:00Z', '2026-07-31T00:00:00Z');

    const first = await connector.fetchPullRequests(query);
    await connector.fetchPullRequests(request('2026-05-18T00:00:00Z', '2026-06-01T00:00:00Z'));
    const second = await connector.fetchPullRequests(query);

    expect(second).toEqual(first);
  });

  it('reports a window entirely outside the dataset as empty, with coverage intact', async () => {
    const query = request('2027-01-01T00:00:00Z', '2027-01-02T00:00:00Z');

    for (const artifact of ARTIFACT_KINDS) {
      const result = await fetchArtifact(connector, artifact, query);
      expect(result.records).toEqual([]);
      expect(result.coverage.length).toBeGreaterThan(0);
    }
  });

  it('degrades honestly when the archived source is asked for anything', async () => {
    const downSource = bundle.unavailableSourceKey;
    expect(downSource, 'the seed declares no unavailable source').not.toBeNull();

    const result = await connector.fetchCommits({
      ...request('2026-07-27T00:00:00Z', '2026-07-31T00:00:00Z'),
      sourceKeys: [downSource ?? ''],
    });

    expect(result.records).toEqual([]);
    expect(result.status).toBe('unavailable');
    expect(result.coverage[0]?.reason).toBe('rate_limited');
    expect(result.coverage[0]?.detail).toContain(downSource ?? '');
  });

  it('implements every fetcher the port names', () => {
    for (const method of Object.values(ARTIFACT_FETCHERS)) {
      expect(typeof connector[method], `${method} is not implemented`).toBe('function');
    }
  });

  it('covers the whole dataset when asked for the whole dataset window', async () => {
    const query = {
      organizationId: bundle.organizationId,
      window: timeWindow(bundle.window.start, addMillis(bundle.window.end, MILLIS_PER_DAY)),
      now: bundle.now,
    };

    for (const artifact of ARTIFACT_KINDS) {
      const result = await fetchArtifact(connector, artifact, query);
      expect(result.records.length, `${artifact} lost records in a wider window`).toBe(
        (bundle.dataset.records[artifact] as readonly unknown[]).length,
      );
    }
  });
});
