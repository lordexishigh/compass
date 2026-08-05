import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import { jsonResponse, ReplayHttpClient } from '@compass/connector-port/testkit';
import type { HttpResponse } from '@compass/connector-port';

/**
 * A recorded conversation with the code host, shaped exactly as the real API answers.
 *
 * ## Why the conformance suite is run against a recording
 *
 * `describeConnectorContract` requires that two identical requests be **deeply equal** and that a
 * *fresh* connector answer identically. Against a live API neither can hold: a repository gains a
 * commit between two calls and the suite fails for a reason that says nothing about the connector. So
 * the contract is proven against a recording, which is precisely what lets the suite run *unchanged*
 * against a provider that has a network in production.
 *
 * The bodies below are the real response shapes — `commit.committer.date`, `merge_commit_sha`,
 * `object.sha` on a git ref — because a fixture in a shape the provider does not produce proves the
 * mapping compiles and nothing more.
 *
 * ## What the window contains, and why every artifact has data in it
 *
 * The suite refuses to pass if a claimed artifact has no records in the contract window: a green run
 * over an empty window proves nothing. So the recording places at least one commit, pull request,
 * review, branch tip and release inside `CONTRACT_WINDOW`, and the split point has records on both
 * sides so the partition property is actually exercised.
 */

export const ORGANIZATION_ID = '55555555-5555-4555-8555-555555555555';
export const SOURCE_KEY = 'primary-code';
export const REPOSITORY_KEY = 'checkout-web';
export const OWNER = 'northwind';
export const REPO = 'checkout-web';

/** Two days wide, so the midpoint split lands between the two commits below. */
export const CONTRACT_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-07-29T00:00:00Z'),
  instantFromIso('2026-07-31T00:00:00Z'),
);

export const NOW: Instant = instantFromIso('2026-07-31T07:30:00Z');

const HEAD_REVISION = '7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
const MERGE_REVISION = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0';

/** Before the midpoint (2026-07-30T00:00Z), so it lands in the first half of the split. */
const EARLY_COMMIT_AT = '2026-07-29T15:00:00Z';
/** After the midpoint, so it lands in the second half. */
const LATE_COMMIT_AT = '2026-07-30T13:40:00Z';

const person = (login: string, email: string, name: string) => ({ login, email, name });
const PRIYA = person('priya-raman', 'priya@example.com', 'Priya Raman');
const MARCUS = person('marcus-hale', 'marcus@example.com', 'Marcus Hale');

const commitSummary = (input: {
  readonly revisionId: string;
  readonly parents: readonly string[];
  readonly at: string;
  readonly message: string;
}) => ({
  sha: input.revisionId,
  parents: input.parents.map((sha) => ({ sha })),
  commit: {
    author: { name: PRIYA.name, email: PRIYA.email, date: input.at },
    committer: { name: PRIYA.name, email: PRIYA.email, date: input.at },
    message: input.message,
  },
  author: { login: PRIYA.login },
  committer: { login: PRIYA.login },
});

const EARLY_COMMIT = commitSummary({
  revisionId: HEAD_REVISION,
  parents: [],
  at: EARLY_COMMIT_AT,
  message: 'DEV-501 batch the checkout writer',
});

const LATE_COMMIT = commitSummary({
  revisionId: MERGE_REVISION,
  parents: [HEAD_REVISION],
  at: LATE_COMMIT_AT,
  message: 'Merge pull request #883 — DEV-501 batch the checkout writer',
});

/** A detail response: the list endpoint carries no file count, so each commit is read once more. */
const commitDetail = (summary: ReturnType<typeof commitSummary>, fileCount: number) => ({
  ...summary,
  files: Array.from({ length: fileCount }, (_unused, index) => ({ filename: `src/file-${index}.ts` })),
});

const PULL_REQUEST = {
  id: 9_201_883,
  number: 883,
  title: 'Batch the checkout writer',
  body: 'DEV-501: one write per basket instead of one per line.',
  user: { login: PRIYA.login, name: PRIYA.name },
  draft: false,
  created_at: '2026-07-28T10:00:00Z',
  updated_at: LATE_COMMIT_AT,
  merged_at: LATE_COMMIT_AT,
  closed_at: LATE_COMMIT_AT,
  head: { ref: 'feature/DEV-501-batch-writer', sha: HEAD_REVISION },
  base: { ref: 'main' },
  merge_commit_sha: MERGE_REVISION,
  requested_reviewers: [{ login: MARCUS.login }],
};

const REVIEW = {
  id: 5_512_001,
  user: { login: MARCUS.login },
  state: 'APPROVED',
  submitted_at: '2026-07-30T12:30:00Z',
};

const RELEASE = {
  tag_name: 'v2.14',
  published_at: '2026-07-30T18:00:00Z',
  body: 'Checkout batching',
  target_commitish: 'main',
};

const path = (suffix: string): string => `https://api.github.test/repos/${OWNER}/${REPO}${suffix}`;

/** Paged endpoints are keyed with the explicit `per_page`/`page` the connector sends. */
const paged = (suffix: string, page = 1): string =>
  `${path(suffix)}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`;

export const API_BASE_URL = 'https://api.github.test';

/**
 * The full response table.
 *
 * Keyed `METHOD url` exactly as `ReplayHttpClient` keys it, so an endpoint the connector reaches for
 * without a recording is a loud `UnrecordedRequestError` rather than a silent empty answer.
 */
export function recordedResponses(): Record<string, HttpResponse> {
  const since = encodeURIComponent('2026-07-29T00:00:00.000Z');
  const until = encodeURIComponent('2026-07-31T00:00:00.000Z');

  const table: Record<string, HttpResponse> = {
    // The repository itself, for the default branch and as the health probe.
    [`GET ${path('')}`]: jsonResponse({ default_branch: 'main' }),

    // Commits across the whole contract window, plus each half the partition test asks for.
    [`GET ${paged(`/commits?since=${since}&until=${until}`)}`]: jsonResponse([LATE_COMMIT, EARLY_COMMIT]),
    [`GET ${path(`/commits/${HEAD_REVISION}`)}`]: jsonResponse(commitDetail(EARLY_COMMIT, 6)),
    [`GET ${path(`/commits/${MERGE_REVISION}`)}`]: jsonResponse(commitDetail(LATE_COMMIT, 6)),

    // Pull requests and reviews.
    [`GET ${paged('/pulls?state=all&sort=updated&direction=desc')}`]: jsonResponse([PULL_REQUEST]),
    [`GET ${paged('/pulls/883/reviews')}`]: jsonResponse([REVIEW]),

    // Branch tips.
    [`GET ${paged('/branches')}`]: jsonResponse([
      { name: 'main', commit: { sha: MERGE_REVISION } },
      { name: 'feature/DEV-501-batch-writer', commit: { sha: HEAD_REVISION } },
    ]),

    // Releases, and the git ref that resolves the tag to a revision.
    [`GET ${paged('/releases')}`]: jsonResponse([RELEASE]),
    [`GET ${path('/git/ref/tags/v2.14')}`]: jsonResponse({ object: { sha: MERGE_REVISION } }),
  };

  /**
   * The window-scoped commit queries the suite issues for each half of the split, and for the empty
   * window. Recorded explicitly rather than pattern-matched, because the point of the replay client is
   * that an unexpected URL fails loudly — a matcher would quietly accept a window the connector
   * computed wrongly.
   */
  const windows: readonly (readonly [string, string, readonly unknown[]])[] = [
    // First half: [start, midpoint) — the early commit only.
    ['2026-07-29T00:00:00.000Z', '2026-07-30T00:00:00.000Z', [EARLY_COMMIT]],
    // Second half: [midpoint, end) — the late commit only.
    ['2026-07-30T00:00:00.000Z', '2026-07-31T00:00:00.000Z', [LATE_COMMIT]],
    // The empty window the suite probes with.
    ['2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', []],
  ];

  for (const [from, to, rows] of windows) {
    table[`GET ${paged(`/commits?since=${encodeURIComponent(from)}&until=${encodeURIComponent(to)}`)}`] =
      jsonResponse(rows);
  }

  return table;
}

export const recordedClient = (): ReplayHttpClient => new ReplayHttpClient(recordedResponses());
