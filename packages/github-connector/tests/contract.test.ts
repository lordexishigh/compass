import { ARTIFACT_KINDS, fetchArtifact } from '@compass/connector-port';
import { describeConnectorContract, ThrottledHttpClient } from '@compass/connector-port/testkit';
import { describe, expect, it } from 'vitest';

import {
  EmptyRepositorySelectionError,
  FORBIDDEN_GITHUB_PERMISSIONS,
  GITHUB_SCOPES,
  GithubConnector,
  githubInstallUrl,
  githubPermissionQuery,
} from '@compass/github-connector';

import {
  API_BASE_URL,
  CONTRACT_WINDOW,
  NOW,
  ORGANIZATION_ID,
  OWNER,
  REPO,
  REPOSITORY_KEY,
  SOURCE_KEY,
  recordedClient,
} from './recorded-api.js';

/**
 * The acceptance criterion, as the only test that can prove it:
 *
 * > The GitHub connector passes the ConnectorPort contract test suite unchanged.
 *
 * `describeConnectorContract` is imported and called. It is not copied, not parameterised beyond the
 * factory hook it already offers, and not weakened — the seeded provider runs the identical function.
 * That is what makes "a live provider drops in unchanged" a checked property rather than a claim in an
 * architecture document.
 */

const connectorConfig = (overrides: Record<string, unknown> = {}) => ({
  sourceKey: SOURCE_KEY,
  repositories: [{ repositoryKey: REPOSITORY_KEY, owner: OWNER, name: REPO }],
  token: 'a-test-installation-token',
  http: recordedClient(),
  apiBaseUrl: API_BASE_URL,
  ...overrides,
});

describeConnectorContract({
  name: 'GithubConnector',
  // A fresh connector *and* a fresh transport per call, which is what the "holds no cursor state"
  // property actually demands: a shared client would let one call's pagination leak into the next.
  createConnector: () => new GithubConnector(connectorConfig()),
  organizationId: ORGANIZATION_ID,
  window: CONTRACT_WINDOW,
  now: NOW,
});

// ---------------------------------------------------------------------------
// Scopes, displayed verbatim before consent
// ---------------------------------------------------------------------------

describe('the requested permissions are exactly the documented read-only set', () => {
  it('requests read access and nothing else', () => {
    for (const scope of GITHUB_SCOPES) {
      expect(scope.access, `${scope.permission} must be read-only`).toBe('read');
    }
  });

  it('requests none of the permissions Compass promises never to ask for', () => {
    const requested = GITHUB_SCOPES.map((scope) => scope.permission);

    for (const forbidden of FORBIDDEN_GITHUB_PERMISSIONS) {
      expect(requested, `${forbidden} is a write or admin permission and must never be requested`).not.toContain(
        forbidden,
      );
    }
  });

  it('builds the install URL from the same list the connect screen renders', () => {
    /**
     * The drift this pins: two copies of the permission list — one in the URL, one in the JSX — is the
     * shape where the screen keeps promising read-only after somebody adds a write permission to the
     * request. The URL is *derived*, so the promise and the request cannot disagree.
     */
    const url = githubInstallUrl({ appSlug: 'compass-daily', state: 'a-csrf-token' });

    for (const scope of GITHUB_SCOPES) {
      expect(url).toContain(`${scope.permission}%3A${scope.access}`);
    }
    expect(url).toContain('state=a-csrf-token');
    expect(githubPermissionQuery()).toBe('contents:read,pull_requests:read,issues:read,metadata:read,members:read');
  });

  it('gives every permission a reason a manager can evaluate', () => {
    // A consent screen listing permissions with no justification is a screen nobody can refuse
    // intelligently. Each entry has to say what breaks without it.
    for (const scope of GITHUB_SCOPES) {
      expect(scope.because.length, `${scope.permission} has no stated reason`).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-repository scoping
// ---------------------------------------------------------------------------

describe('only the selected repositories are ever queried', () => {
  it('refuses an empty selection rather than reading everything the token can see', () => {
    /**
     * The failure mode this forbids is the one that is invisible in review: a connector built from an
     * empty selection that "helpfully" reads every repository the installation can reach would put
     * another team's merges in this team's Yesterday, and a manager who selected nothing consented to
     * nothing.
     */
    expect(() => new GithubConnector(connectorConfig({ repositories: [] }))).toThrow(
      EmptyRepositorySelectionError,
    );
  });

  it('never issues a request outside the selected repository path', async () => {
    const http = recordedClient();
    const connector = new GithubConnector(connectorConfig({ http }));

    for (const artifact of ARTIFACT_KINDS) {
      await fetchArtifact(connector, artifact, { organizationId: ORGANIZATION_ID, window: CONTRACT_WINDOW, now: NOW });
    }

    expect(http.requests.length, 'the connector issued no requests at all').toBeGreaterThan(0);
    for (const url of http.urls) {
      expect(url, `${url} reaches outside the selected repository`).toContain(`/repos/${OWNER}/${REPO}`);
    }
  });

  it('never asks the provider to enumerate repositories', async () => {
    // `/user/repos` and `/orgs/{org}/repos` are the two endpoints that turn a scoped connector into a
    // whole-account read. Neither may ever be called.
    const http = recordedClient();
    const connector = new GithubConnector(connectorConfig({ http }));

    for (const artifact of ARTIFACT_KINDS) {
      await fetchArtifact(connector, artifact, { organizationId: ORGANIZATION_ID, window: CONTRACT_WINDOW, now: NOW });
    }

    expect(http.calledAnyMatching(/\/user\/repos|\/orgs\/[^/]+\/repos/)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rate-limit criterion
// ---------------------------------------------------------------------------

describe('a rate limit becomes a stated coverage gap, not a quiet empty day', () => {
  const throttled = () =>
    new GithubConnector(
      connectorConfig({ http: new ThrottledHttpClient(recordedClient(), /\/commits/) }),
    );

  it('reports unavailable coverage naming the source and the reason', async () => {
    const result = await throttled().fetchCommits({
      organizationId: ORGANIZATION_ID,
      window: CONTRACT_WINDOW,
      now: NOW,
    });

    expect(result.status).toBe('unavailable');
    const coverage = result.coverage.find((entry) => entry.sourceKey === SOURCE_KEY);
    expect(coverage?.reason).toBe('rate_limited');
    // The contract requires the sentence to name its own source, because it is shown to a manager
    // as-is in the freshness panel.
    expect(coverage?.detail).toContain(SOURCE_KEY);
    expect(coverage?.coveredWindow, 'nothing was covered, so the covered window must be null').toBeNull();
  });

  it('returns no records rather than the half it managed to read', async () => {
    /**
     * The criterion is "rather than reporting on partial data as complete". Returning the records read
     * before the 429 with a `complete` count is exactly that failure: the report would state a number
     * that is arithmetically wrong and typographically confident.
     */
    const result = await throttled().fetchCommits({
      organizationId: ORGANIZATION_ID,
      window: CONTRACT_WINDOW,
      now: NOW,
    });

    expect(result.records).toEqual([]);
    expect(result.coverage.every((entry) => entry.recordCount === 0)).toBe(true);
  });

  it('says so in the health report the freshness indicator reads', async () => {
    const health = await new GithubConnector(
      connectorConfig({ http: new ThrottledHttpClient(recordedClient(), /\/repos/) }),
    ).reportSourceHealth({ organizationId: ORGANIZATION_ID, window: CONTRACT_WINDOW, now: NOW });

    expect(health.overall).not.toBe('complete');
    const entry = health.sources.find((source) => source.sourceKey === SOURCE_KEY);
    expect(entry?.status).toBe('unavailable');
    expect(entry?.reason).toBe('rate_limited');
  });

  it('does not fabricate a freshness timestamp when it has no journal', async () => {
    // The panel's rule: no invented "last updated". This connector holds no journal, so it reports
    // null and lets the ingest journal be the single source of that fact.
    const health = await new GithubConnector(connectorConfig()).reportSourceHealth({
      organizationId: ORGANIZATION_ID,
      window: CONTRACT_WINDOW,
      now: NOW,
    });

    expect(health.sources[0]?.lastObservedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Branch topology and release tags — the completion ladder's upper rungs
// ---------------------------------------------------------------------------

describe('branch topology and release tags reach the completion ladder', () => {
  const request = { organizationId: ORGANIZATION_ID, window: CONTRACT_WINDOW, now: NOW };

  it('marks the default branch, which is what "merged to main" is computed against', async () => {
    const result = await new GithubConnector(connectorConfig()).fetchBranchRefs(request);

    const main = result.records.find((record) => record.name === 'main');
    expect(main?.isDefault).toBe(true);
    expect(result.records.filter((record) => record.isDefault)).toHaveLength(1);
  });

  it('resolves a tag to a revision rather than to the branch it was cut from', async () => {
    /**
     * `target_commitish` is a *branch name* on most releases. Reading it into `revisionId` would break
     * the "was this change released" comparison for every repository that tags from a branch, and it
     * would break it silently — the field would be populated, just with the wrong kind of thing.
     */
    const result = await new GithubConnector(connectorConfig()).fetchReleaseTags(request);

    const tag = result.records.find((record) => record.name === 'v2.14');
    expect(tag).toBeDefined();
    expect(tag?.revisionId).toMatch(/^[0-9a-f]{40}$/);
    expect(tag?.revisionId).not.toBe('main');
  });

  it('ties a pull request to the tracker key its prose names', async () => {
    const result = await new GithubConnector(connectorConfig()).fetchPullRequests(request);

    expect(result.records[0]?.linkedWorkItemKeys).toEqual(['DEV-501']);
    // The merge revision is what the ladder compares against a release tag.
    expect(result.records[0]?.mergeRevisionId).toMatch(/^[0-9a-f]{40}$/);
    expect(result.records[0]?.state).toBe('merged');
  });

  it('references the pull request by its opaque id, not by its display number', async () => {
    // Two repositories can both have a `#12`; the display number is for humans and the id is for joins.
    const pulls = await new GithubConnector(connectorConfig()).fetchPullRequests(request);
    const reviews = await new GithubConnector(connectorConfig()).fetchReviews(request);

    expect(reviews.records[0]?.pullRequestRef).toBe(pulls.records[0]?.sourceRecordId);
    expect(reviews.records[0]?.pullRequestRef).not.toBe(String(pulls.records[0]?.displayNumber));
  });
});
