import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import type { HttpResponse } from '@compass/connector-port';
import { ReplayHttpClient, jsonResponse } from '@compass/connector-port/testkit';

/**
 * A recorded conversation with a live code host and a live chat provider.
 *
 * ## Why this fixture exists beside the connectors' own
 *
 * Each connector package already has a recording, and each proves *that connector's* contract
 * conformance. This one proves something different and one layer up: that the **pipeline** — ingest,
 * knowledge model, analysis, renderers — produces a report from live connectors that is
 * indistinguishable in kind from the one it produces from the seeded provider. So the records it yields
 * are deliberately shaped to describe the *same day at the same organization* as
 * `provider-swap.test.ts`'s neutral dataset: same repository key, same tracker key in the prose, same
 * people, same merge, same release.
 *
 * It lives in `apps/worker/tests` because the worker is the composition root — the one place allowed to
 * name a provider. A fixture like this inside `packages/pipeline/tests` would be a layer violation, and
 * `provider-neutrality.test.ts` exists to catch exactly that.
 *
 * ## The window
 *
 * One civil day in Europe/London, which is the report window, plus enough history either side that the
 * ingest window has something to reconcile.
 */

export const ORGANIZATION_ID = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
export const TEAM_KEY = 'platform';
export const TIMEZONE = 'Europe/London';
export const PROJECT_KEY = 'DEV';
export const REPOSITORY_KEY = 'checkout-web';

export const CODE_SOURCE_KEY = 'primary-code';
export const CHAT_SOURCE_KEY = 'primary-chat';

export const OWNER = 'northwind';
export const REPO = 'checkout-web';
export const CHANNEL_KEY = 'C04AB12CD34';
export const CHANNEL_NAME = '#platform';

export const GITHUB_API_BASE_URL = 'https://api.github.test';
export const SLACK_API_BASE_URL = 'https://slack.test/api';

/** The morning after the day the report is about. */
export const NOW: Instant = instantFromIso('2026-07-31T07:30:00Z');

/** The report window: the team's previous civil day, in Europe/London. */
export const REPORT_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-07-29T23:00:00Z'),
  instantFromIso('2026-07-30T23:00:00Z'),
);

const HEAD_REVISION = '7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
const MERGE_REVISION = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0';

const PRIYA = { login: 'priya-raman', email: 'priya@example.com', name: 'Priya Raman' };
const MARCUS = { login: 'marcus-hale', email: 'marcus@example.com', name: 'Marcus Hale' };

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
  at: '2026-07-30T09:15:00Z',
  message: 'DEV-501 batch the checkout writer',
});

const MERGE_COMMIT = commitSummary({
  revisionId: MERGE_REVISION,
  parents: [HEAD_REVISION],
  at: '2026-07-30T13:40:00Z',
  message: 'Merge pull request #883 — DEV-501 batch the checkout writer',
});

/** The list endpoint carries no file count, so the connector reads each commit once more for its detail. */
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
  updated_at: '2026-07-30T13:40:00Z',
  merged_at: '2026-07-30T13:40:00Z',
  closed_at: '2026-07-30T13:40:00Z',
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

const path = (suffix: string): string => `${GITHUB_API_BASE_URL}/repos/${OWNER}/${REPO}${suffix}`;

const paged = (suffix: string, page = 1): string =>
  `${path(suffix)}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`;

/**
 * Every window the pipeline asks the code host for, recorded explicitly.
 *
 * The pipeline issues one ingest window and the report a narrower one, and a replayed client raises on an
 * unrecorded URL rather than inventing an empty answer — which is what makes a connector that computed the
 * wrong window fail loudly here instead of producing a quietly thin report.
 */
const COMMIT_WINDOWS: readonly (readonly [string, string, readonly unknown[]])[] = [
  // The ingest window the swap test uses, and the report window inside it.
  ['2026-06-01T00:00:00.000Z', '2026-07-31T07:30:00.000Z', [MERGE_COMMIT, EARLY_COMMIT]],
  ['2026-07-29T23:00:00.000Z', '2026-07-30T23:00:00.000Z', [MERGE_COMMIT, EARLY_COMMIT]],
];

export function recordedGithubResponses(): Record<string, HttpResponse> {
  const table: Record<string, HttpResponse> = {
    [`GET ${path('')}`]: jsonResponse({ default_branch: 'main' }),
    [`GET ${path(`/commits/${HEAD_REVISION}`)}`]: jsonResponse(commitDetail(EARLY_COMMIT, 6)),
    [`GET ${path(`/commits/${MERGE_REVISION}`)}`]: jsonResponse(commitDetail(MERGE_COMMIT, 6)),
    [`GET ${paged('/pulls?state=all&sort=updated&direction=desc')}`]: jsonResponse([PULL_REQUEST]),
    [`GET ${paged('/pulls/883/reviews')}`]: jsonResponse([REVIEW]),
    [`GET ${paged('/branches')}`]: jsonResponse([
      { name: 'main', commit: { sha: MERGE_REVISION } },
      { name: 'feature/DEV-501-batch-writer', commit: { sha: HEAD_REVISION } },
    ]),
    [`GET ${paged('/releases')}`]: jsonResponse([RELEASE]),
    [`GET ${path('/git/ref/tags/v2.14')}`]: jsonResponse({ object: { sha: MERGE_REVISION } }),
  };

  for (const [from, to, rows] of COMMIT_WINDOWS) {
    table[`GET ${paged(`/commits?since=${encodeURIComponent(from)}&until=${encodeURIComponent(to)}`)}`] =
      jsonResponse(rows);
  }

  return table;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const message = (input: { readonly stamp: string; readonly authorId: string; readonly text: string }) => ({
  type: 'message',
  ts: input.stamp,
  user: input.authorId,
  text: input.text,
});

const PRIYA_CHAT_ID = 'U04PRIYA001';
const MARCUS_CHAT_ID = 'U04MARCUS02';

/** 2026-07-30T09:30:00Z and 2026-07-30T16:00:00Z, as epoch seconds with a six-digit fraction. */
const BLOCKER_MESSAGE = message({
  stamp: '1785403800.000100',
  authorId: MARCUS_CHAT_ID,
  text: 'DEV-522 is still waiting on the payments team to confirm the retry budget.',
});

const WIN_MESSAGE = message({
  stamp: '1785427200.000200',
  authorId: PRIYA_CHAT_ID,
  text: 'DEV-501 is merged and out in v2.14.',
});

const history = (messages: readonly unknown[]): HttpResponse =>
  jsonResponse({ ok: true, messages, has_more: false, response_metadata: { next_cursor: '' } });

const chatHistoryUrl = (oldest: string, latest: string): string =>
  `${SLACK_API_BASE_URL}/conversations.history?channel=${CHANNEL_KEY}&oldest=${oldest}&latest=${latest}` +
  `&inclusive=true&limit=200`;

export function recordedSlackResponses(): Record<string, HttpResponse> {
  return {
    [`GET ${SLACK_API_BASE_URL}/users.info?user=${PRIYA_CHAT_ID}`]: jsonResponse({
      ok: true,
      user: { id: PRIYA_CHAT_ID, name: 'priya', profile: { real_name: PRIYA.name } },
    }),
    [`GET ${SLACK_API_BASE_URL}/users.info?user=${MARCUS_CHAT_ID}`]: jsonResponse({
      ok: true,
      user: { id: MARCUS_CHAT_ID, name: 'marcus', profile: { real_name: MARCUS.name } },
    }),
    // The health probe.
    [`GET ${SLACK_API_BASE_URL}/conversations.history?channel=${CHANNEL_KEY}&limit=1`]: history([WIN_MESSAGE]),
    // The ingest window: 2026-06-01T00:00:00Z less one second, through 2026-07-31T07:30:00Z.
    [`GET ${chatHistoryUrl('1780271999.000000', '1785483000.000000')}`]: history([BLOCKER_MESSAGE, WIN_MESSAGE]),
    // The report window: 2026-07-29T23:00:00Z less one second, through 2026-07-30T23:00:00Z.
    [`GET ${chatHistoryUrl('1785365999.000000', '1785452400.000000')}`]: history([BLOCKER_MESSAGE, WIN_MESSAGE]),
  };
}

export const recordedGithubClient = (): ReplayHttpClient => new ReplayHttpClient(recordedGithubResponses());
export const recordedSlackClient = (): ReplayHttpClient => new ReplayHttpClient(recordedSlackResponses());
