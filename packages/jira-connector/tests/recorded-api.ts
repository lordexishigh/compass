import { instantFromIso, splitWindow, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import type { HttpResponse } from '@compass/connector-port';
import { jsonResponse, ReplayHttpClient } from '@compass/connector-port/testkit';
import { sprintMembershipJql, updatedSinceJql } from '@compass/jira-connector';

/**
 * A recorded conversation with the tracker, shaped exactly as the real API answers.
 *
 * ## Why the conformance suite is run against a recording
 *
 * `describeConnectorContract` requires that two identical requests be **deeply equal** and that a *fresh*
 * connector answer identically. Against a live API neither can hold: an issue gains a comment between two
 * calls and the suite fails for a reason that says nothing about the connector. So the contract is proven
 * against a recording, which is precisely what lets the suite run *unchanged* against a provider that has
 * a network in production.
 *
 * The bodies below are the real response shapes — `fields.status.statusCategory.key`, a description as an
 * Atlassian Document Format tree, `nextPageToken` on the search response, `values`/`isLast` on the agile
 * ones, and a changelog whose `Sprint` item carries comma-separated ids in `from`/`to` — because a fixture
 * in a shape the provider does not produce proves the mapping compiles and nothing more.
 *
 * ## Why the query strings are imported rather than written out
 *
 * `updatedSinceJql` and `sprintMembershipJql` are the connector's own. A fixture that hand-wrote the JQL
 * would be keyed on what the fixture author believed the connector sends, so a connector that changed its
 * query would fail with `UnrecordedRequestError` — which is the correct outcome — but a connector whose
 * query was *always* wrong would pass against a recording that was wrong in the same way. Importing them
 * keeps the recording about the response bodies, which is the part that has to be faithful.
 */

export const ORGANIZATION_ID = '66666666-6666-4666-8666-666666666666';
export const SOURCE_KEY = 'primary-tracker';
export const CLOUD_ID = 'a1b2c3d4-5566-7788-99aa-bbccddeeff00';
export const API_BASE_URL = 'https://api.atlassian.test';

/** The selected project. */
export const PROJECT_KEY = 'DEV';
/** A second selected project, for the two-project scoping test. Deliberately quiet. */
export const SECOND_PROJECT_KEY = 'PLAT';
/** Selected by nobody. Its key must never appear in a request. */
export const UNSELECTED_PROJECT_KEY = 'OPS';

/** Two days wide, so the midpoint split lands between the two issues below. */
export const CONTRACT_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-07-29T00:00:00Z'),
  instantFromIso('2026-07-31T00:00:00Z'),
);

export const NOW: Instant = instantFromIso('2026-07-31T07:30:00Z');

const SPRINT_ID = 42;
const BOARD_ID = 17;

/** Before the midpoint (2026-07-30T00:00Z), so it lands in the first half of the split. */
const EARLY_AT = '2026-07-29T15:00:00Z';
/** After the midpoint, so it lands in the second half. */
const LATE_AT = '2026-07-30T13:40:00Z';
/** Before the window opens, so the local window filter has something real to exclude. */
const BEFORE_WINDOW_AT = '2026-07-28T10:00:00Z';

const PRIYA = { accountId: '5b10a2844c20165700ede21g', emailAddress: 'priya@example.com', displayName: 'Priya Raman' };
/** No published address: a site with any profile privacy at all produces this, and it is the common case. */
const MARCUS = { accountId: '5b10a2844c20165700ede21h', displayName: 'Marcus Hale' };

/** A description as the v3 API returns it: a document tree, never a string. */
const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const status = (name: string, category: 'new' | 'indeterminate' | 'done') => ({
  name,
  statusCategory: { key: category, name: category === 'new' ? 'To Do' : category === 'done' ? 'Done' : 'In Progress' },
});

const issue = (input: {
  readonly identifier: string;
  readonly itemKey: string;
  readonly summary: string;
  readonly status: ReturnType<typeof status>;
  readonly updated: string;
  readonly resolved: string | null;
  readonly points: number | null;
  readonly flagged: boolean;
}) => ({
  id: input.identifier,
  key: input.itemKey,
  fields: {
    summary: input.summary,
    description: adf(`${input.itemKey}: one write per basket instead of one per line.`),
    status: input.status,
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    labels: ['checkout', 'performance'],
    assignee: PRIYA,
    reporter: MARCUS,
    created: '2026-07-27T09:15:00Z',
    updated: input.updated,
    resolutiondate: input.resolved,
    parent: { key: 'DEV-400' },
    customfield_10016: input.points,
    customfield_10020: [{ id: SPRINT_ID, name: 'Checkout hardening', state: 'active' }],
    customfield_10021: input.flagged ? [{ value: 'Impediment' }] : null,
  },
});

const EARLY_ISSUE = issue({
  identifier: '10501',
  itemKey: 'DEV-501',
  summary: 'Batch the checkout writer',
  status: status('In Progress', 'indeterminate'),
  updated: EARLY_AT,
  resolved: null,
  points: 5,
  flagged: false,
});

const LATE_ISSUE = issue({
  identifier: '10502',
  itemKey: 'DEV-502',
  summary: 'Retry the basket reconciler',
  status: status('Done', 'done'),
  updated: LATE_AT,
  resolved: LATE_AT,
  points: 3,
  // The tracker's own "this is blocked" marker, which Blockers reads.
  flagged: true,
});

/** One changelog entry. `items` is where the actual change lives. */
const changeGroup = (input: {
  readonly id: string;
  readonly at: string;
  readonly author: Record<string, unknown>;
  readonly items: readonly Record<string, unknown>[];
}) => ({ id: input.id, created: input.at, author: input.author, items: input.items });

const statusItem = (from: string | null, to: string) => ({
  field: 'status',
  fieldtype: 'jira',
  from: from === null ? null : '10001',
  fromString: from,
  to: '10002',
  toString: to,
});

/** Jira writes the sprint field's change as comma-separated *ids*, with names in the `*String` pair. */
const sprintItem = (from: string | null, to: string | null) => ({
  field: 'Sprint',
  fieldtype: 'custom',
  from,
  fromString: from === null ? '' : 'Checkout hardening',
  to,
  fromStringAbsent: false,
  toString: to === null ? '' : 'Checkout hardening',
});

const EARLY_CHANGELOG = [
  // Outside the window entirely: proves the local filter excludes rather than the API being trusted.
  changeGroup({
    id: '90001',
    at: BEFORE_WINDOW_AT,
    author: PRIYA,
    items: [statusItem(null, 'To Do')],
  }),
  changeGroup({
    id: '90002',
    at: '2026-07-29T09:00:00Z',
    author: PRIYA,
    // Added to the sprint mid-window, which is the scope change sprint reconciliation is about.
    items: [sprintItem(null, String(SPRINT_ID))],
  }),
  changeGroup({
    id: '90003',
    at: EARLY_AT,
    author: PRIYA,
    items: [statusItem('To Do', 'In Progress')],
  }),
];

const LATE_CHANGELOG = [
  changeGroup({
    id: '90101',
    at: '2026-07-30T11:00:00Z',
    author: MARCUS,
    // Pulled back out of the sprint. `to` is null, so this is a removal.
    items: [sprintItem(String(SPRINT_ID), null)],
  }),
  changeGroup({
    id: '90102',
    at: LATE_AT,
    author: MARCUS,
    // Two changes in one group, as Jira really records a transition that also resolves an issue. Only
    // the status item produces a record; the resolution is read off the issue itself.
    items: [statusItem('In Progress', 'Done'), { field: 'resolution', fromString: null, toString: 'Done' }],
  }),
];

const SPRINT = {
  id: SPRINT_ID,
  name: 'Checkout hardening',
  state: 'active',
  goal: 'Checkout writes stop being the slowest thing in the basket.',
  // Starts inside the first half, so the sprint record's own event time sits in the window.
  startDate: '2026-07-29T09:00:00Z',
  endDate: '2026-08-12T09:00:00Z',
  originBoardId: BOARD_ID,
};

/**
 * A sprint that exists but was never scheduled, which the connector must skip rather than date.
 *
 * A real backlog has these — somebody creates "Sprint 4" months early and never sets dates. Both
 * `startAt` and `endAt` are required, so the only alternatives to skipping were inventing a range or
 * making the field nullable and pushing the problem into analysis.
 */
const UNSCHEDULED_SPRINT = { id: 43, name: 'Sprint 4', state: 'future', goal: null };

const ISSUE_FIELDS =
  'summary,description,status,issuetype,priority,labels,assignee,reporter,created,updated,' +
  'resolutiondate,parent,customfield_10016,customfield_10020,customfield_10021';

const base = `${API_BASE_URL}/ex/jira/${CLOUD_ID}`;

/** The search URL, keyed exactly as the connector builds it. */
const searchUrl = (jql: string, fields: string): string => {
  const query = new URLSearchParams({ jql, fields, maxResults: '100' });
  return `GET ${base}/rest/api/3/search/jql?${query.toString()}`;
};

/** A `startAt`-paginated URL — the agile endpoints and the changelog. */
const pagedUrl = (path: string): string =>
  `GET ${base}${path}${path.includes('?') ? '&' : '?'}startAt=0&maxResults=50`;

/** Every status the project defines, with its category. This is how a transition gets a category. */
const projectStatuses = () =>
  jsonResponse([
    {
      id: '10001',
      name: 'Story',
      statuses: [status('To Do', 'new'), status('In Progress', 'indeterminate'), status('Done', 'done')].map(
        (entry, index) => ({ id: String(10_001 + index), ...entry }),
      ),
    },
  ]);

/**
 * The full response table.
 *
 * Keyed `METHOD url` exactly as `ReplayHttpClient` keys it, so an endpoint the connector reaches for
 * without a recording is a loud `UnrecordedRequestError` rather than a silent empty answer.
 *
 * Every window the contract suite probes with is recorded explicitly rather than pattern-matched: the
 * point of the replay client is that an unexpected URL fails loudly, and a matcher would quietly accept a
 * window the connector had computed wrongly.
 */
export function recordedResponses(): Record<string, HttpResponse> {
  const [firstHalf, secondHalf] = splitWindow(CONTRACT_WINDOW, instantFromIso('2026-07-30T00:00:00Z'));
  const emptyWindow = timeWindow(CONTRACT_WINDOW.start, CONTRACT_WINDOW.start);

  const table: Record<string, HttpResponse> = {};

  /**
   * The same issue set for every window the suite asks about.
   *
   * That is not a shortcut: the connector's JQL bound is deliberately a day wider than the window (see
   * `updatedSinceJql`), so a real tracker *would* answer these four queries with the same two issues, and
   * the half-open partition is produced by the local filter rather than by the server. Recording
   * different sets per window would be recording a server that filters more precisely than JQL can.
   */
  for (const window of [CONTRACT_WINDOW, firstHalf, secondHalf, emptyWindow]) {
    const jql = updatedSinceJql(PROJECT_KEY, window);
    table[searchUrl(jql, ISSUE_FIELDS)] = jsonResponse({ issues: [EARLY_ISSUE, LATE_ISSUE], isLast: true });
    table[searchUrl(jql, 'key')] = jsonResponse({
      issues: [{ id: '10501', key: 'DEV-501' }, { id: '10502', key: 'DEV-502' }],
      isLast: true,
    });

    // The quiet second project, for the scoping test. Answering with nothing is itself a case worth
    // recording: a selected project with no movement must not become an error.
    const quiet = updatedSinceJql(SECOND_PROJECT_KEY, window);
    table[searchUrl(quiet, ISSUE_FIELDS)] = jsonResponse({ issues: [], isLast: true });
    table[searchUrl(quiet, 'key')] = jsonResponse({ issues: [], isLast: true });
  }

  // Per-issue changelogs, which is where transitions and sprint scope changes both come from.
  table[pagedUrl('/rest/api/3/issue/DEV-501/changelog')] = jsonResponse({ values: EARLY_CHANGELOG, isLast: true });
  table[pagedUrl('/rest/api/3/issue/DEV-502/changelog')] = jsonResponse({ values: LATE_CHANGELOG, isLast: true });

  // The status catalogue, per project.
  table[`GET ${base}/rest/api/3/project/${PROJECT_KEY}/statuses`] = projectStatuses();
  table[`GET ${base}/rest/api/3/project/${SECOND_PROJECT_KEY}/statuses`] = projectStatuses();

  // Boards, reached only by naming a project — never by enumerating the site.
  table[pagedUrl(`/rest/agile/1.0/board?projectKeyOrId=${PROJECT_KEY}`)] = jsonResponse({
    values: [{ id: BOARD_ID, name: 'DEV board', type: 'scrum' }],
    isLast: true,
  });
  table[pagedUrl(`/rest/agile/1.0/board?projectKeyOrId=${SECOND_PROJECT_KEY}`)] = jsonResponse({
    values: [],
    isLast: true,
  });

  table[pagedUrl(`/rest/agile/1.0/board/${BOARD_ID}/sprint`)] = jsonResponse({
    values: [SPRINT, UNSCHEDULED_SPRINT],
    isLast: true,
  });

  // The sprint's committed items, asked for with a project-scoped query so a multi-project board cannot
  // leak an unselected project's issue into the commitment.
  table[searchUrl(sprintMembershipJql(PROJECT_KEY, SPRINT_ID), 'key')] = jsonResponse({
    issues: [{ key: 'DEV-501' }, { key: 'DEV-502' }],
    isLast: true,
  });

  // The health probe.
  table[`GET ${base}/rest/api/3/project/${PROJECT_KEY}`] = jsonResponse({ key: PROJECT_KEY, name: 'Checkout' });
  table[`GET ${base}/rest/api/3/project/${SECOND_PROJECT_KEY}`] = jsonResponse({
    key: SECOND_PROJECT_KEY,
    name: 'Platform',
  });

  return table;
}

export const recordedClient = (): ReplayHttpClient => new ReplayHttpClient(recordedResponses());
