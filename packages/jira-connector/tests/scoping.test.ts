import { ARTIFACT_KINDS, fetchArtifact } from '@compass/connector-port';
import { EmptyProjectSelectionError, JiraConnector } from '@compass/jira-connector';
import { describe, expect, it } from 'vitest';

import {
  API_BASE_URL,
  CLOUD_ID,
  CONTRACT_WINDOW,
  NOW,
  ORGANIZATION_ID,
  PROJECT_KEY,
  SECOND_PROJECT_KEY,
  SOURCE_KEY,
  UNSELECTED_PROJECT_KEY,
  recordedClient,
} from './recorded-api.js';

/**
 * The per-project scoping criterion, as an assertion about which requests left the process.
 *
 * > Jira ingest is scoped to selected projects; unselected projects are never queried.
 *
 * Two projects are configured and every artifact kind is requested, because a leak is most likely on the
 * path nobody thought about — the health probe, the status catalogue, the board lookup, the sprint
 * membership query. `ReplayHttpClient` throws on any URL it has no recording for, so an escape is a loud
 * failure rather than a green run with zero records, which reads identically to a correctly-scoped query
 * on a quiet day.
 */

const twoProjects = (http = recordedClient()) =>
  new JiraConnector({
    sourceKey: SOURCE_KEY,
    projects: [{ projectKey: PROJECT_KEY }, { projectKey: SECOND_PROJECT_KEY }],
    accessToken: 'a-test-access-token',
    cloudId: CLOUD_ID,
    http,
    apiBaseUrl: API_BASE_URL,
  });

const request = { organizationId: ORGANIZATION_ID, window: CONTRACT_WINDOW, now: NOW };

/** Every artifact kind plus the health probe — the full outbound surface of one ingest tick. */
async function exerciseEverything(http: ReturnType<typeof recordedClient>): Promise<void> {
  const connector = twoProjects(http);
  for (const artifact of ARTIFACT_KINDS) {
    await fetchArtifact(connector, artifact, request);
  }
  await connector.reportSourceHealth(request);
}

describe('only the selected projects are ever queried', () => {
  it('refuses an empty selection rather than reading everything the token can see', () => {
    /**
     * The failure mode this forbids is the one that is invisible in review: a connector built from an
     * empty selection that "helpfully" reads every project the token can reach would put another team's
     * issues in this team's Progress, and a manager who selected nothing consented to nothing.
     */
    expect(
      () =>
        new JiraConnector({
          sourceKey: SOURCE_KEY,
          projects: [],
          accessToken: 'a-test-access-token',
          cloudId: CLOUD_ID,
          http: recordedClient(),
          apiBaseUrl: API_BASE_URL,
        }),
    ).toThrow(EmptyProjectSelectionError);
  });

  it('never mentions an unselected project key in any request', async () => {
    const http = recordedClient();
    await exerciseEverything(http);

    expect(http.requests.length, 'the connector issued no requests at all').toBeGreaterThan(0);
    for (const url of http.urls) {
      expect(url, `${url} names a project nobody selected`).not.toContain(UNSELECTED_PROJECT_KEY);
    }
  });

  it('names one of the selected projects in every request that is about project data', async () => {
    /**
     * The stronger form of the assertion. "No unselected key appears" is satisfied vacuously by a request
     * that names no project at all — which is exactly what a site-wide read looks like. So every request
     * has to *positively* carry a selected key, with the sprint endpoints as the one stated exception: a
     * sprint is addressed by its own id, and it was reached from a board that was itself reached by naming
     * a project.
     */
    const http = recordedClient();
    await exerciseEverything(http);

    const addressedByDiscoveredId = /\/rest\/agile\/1\.0\/board\/\d+\//;
    const projectScoped = http.urls.filter((url) => !addressedByDiscoveredId.test(url));

    expect(projectScoped.length).toBeGreaterThan(0);
    for (const url of projectScoped) {
      expect(
        url.includes(PROJECT_KEY) || url.includes(SECOND_PROJECT_KEY),
        `${url} carries no selected project key, so its scope is not observable`,
      ).toBe(true);
    }
  });

  it('never asks the tracker to enumerate projects, boards or sprints site-wide', async () => {
    /**
     * These are the endpoints that turn a scoped connector into a whole-site read:
     *
     *  - `/rest/api/3/project/search` and a bare `/rest/api/3/project` list every project on the site.
     *  - `/rest/agile/1.0/board` with no `projectKeyOrId` lists every board, including other teams'.
     *  - `/rest/agile/1.0/sprint` with no board is the same for sprints.
     *
     * None may ever be called. This is asserted rather than left to the recording's completeness because
     * a future recording that *did* include one would make the leak silently pass.
     */
    const http = recordedClient();
    await exerciseEverything(http);

    expect(http.calledAnyMatching(/\/rest\/api\/3\/project\/search/)).toBe(false);
    expect(http.calledAnyMatching(/\/rest\/api\/3\/project(\?|$)/)).toBe(false);
    expect(http.calledAnyMatching(/\/rest\/agile\/1\.0\/board\?startAt/)).toBe(false);
    expect(http.calledAnyMatching(/\/rest\/agile\/1\.0\/sprint\?/)).toBe(false);
  });

  it('scopes the sprint membership query by project, so a shared board cannot leak an issue', async () => {
    /**
     * A board's filter can span several projects, so the agile "issues in this sprint" endpoint would
     * return issues from projects the manager never selected. The membership query names the project
     * instead, which makes the scoping structural rather than a hope that the board was configured tidily.
     */
    const http = recordedClient();
    await exerciseEverything(http);

    expect(http.calledAnyMatching(/\/rest\/agile\/1\.0\/sprint\/\d+\/issue/)).toBe(false);
    const membership = http.urls.filter((url) => url.includes('sprint+%3D+42'));
    expect(membership.length).toBeGreaterThan(0);
    for (const url of membership) {
      expect(url).toContain(`project+%3D+%22${PROJECT_KEY}%22`);
    }
  });

  it('sends the query where a test can see it, not in a request body', async () => {
    /**
     * The search endpoint accepts the JQL in a POST body too, and that choice would make every assertion
     * in this file vacuous: the URL would be identical for a correctly-scoped and a site-wide query, so a
     * URL-watching test would pass either way. Every request this connector makes is a GET with its scope
     * in the URL, on purpose.
     */
    const http = recordedClient();
    await exerciseEverything(http);

    expect(http.requests.every((entry) => entry.method === 'GET')).toBe(true);
    expect(http.requests.every((entry) => entry.body === undefined || entry.body === null)).toBe(true);
  });

  it('reads a selected project with no movement as empty rather than as a failure', async () => {
    // The second project answers with nothing. A selected source that had a quiet day must report complete
    // coverage of zero records, not a gap — otherwise every quiet team looks like a broken integration.
    const http = recordedClient();
    const result = await twoProjects(http).fetchIssues(request);

    expect(result.status).toBe('complete');
    expect(result.records.every((record) => record.projectKey === PROJECT_KEY)).toBe(true);
    expect(http.urls.some((url) => url.includes(SECOND_PROJECT_KEY))).toBe(true);
  });
});
