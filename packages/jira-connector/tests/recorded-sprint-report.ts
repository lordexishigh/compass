import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import type {
  AnalysisCollections,
  AnalysisEntity,
  AnalysisSnapshot,
  AnalysisSprintScopeChange,
  FieldValue,
} from '@compass/analysis';
import type { HttpResponse, IssueRecord, SprintRecord, SprintScopeChangeRecord } from '@compass/connector-port';
import { jsonResponse, ReplayHttpClient } from '@compass/connector-port/testkit';
import { sprintMembershipJql, updatedSinceJql } from '@compass/jira-connector';

/**
 * One sprint, recorded twice: as the API the connector reads, and as the sprint report
 * the manager reads.
 *
 * ## Why this is a second recording rather than an extension of `recorded-api.ts`
 *
 * That recording exists to prove the *contract* — two issues, one sprint, one scope
 * addition and one removal, sized so the conformance suite's exact-count assertions say
 * something. Reconciliation needs a different shape: enough items that a wrong
 * denominator is visibly wrong, a mid-sprint addition *and* a punted issue in the same
 * sprint, and a point total that cannot be arrived at by accident. Growing the contract
 * fixture to carry both would have changed the counts the conformance suite asserts, so
 * the two recordings are separate and each is sized for its own question.
 *
 * ## Why the two recordings of this sprint are written out independently
 *
 * `recordedSprintApi()` below is what Jira's *REST API* answers: seven issues, their
 * changelogs, the board, the sprint and its current membership. `JIRA_SPRINT_REPORT` is
 * what Jira's *own sprint report* shows for the same sprint — the panel a manager opens
 * to argue with a completion figure.
 *
 * Every number in both is a hand-written literal. Deriving the sprint report's sums from
 * the issue fixtures would make the comparison circular: the test would be asserting that
 * `5 + 3 + 5 === 13` rather than that Compass's completion arithmetic lands where Jira's
 * does. Two independent statements of the same sprint is the whole point — if the
 * connector drops an issue, mis-reads a custom field, or the analysis core counts a punted
 * item, the two disagree and the reconciliation test fails.
 *
 * ## The sprint, in words
 *
 * `REC` sprint 501 ran from 13 July, is still open at the report instant, and holds six
 * items worth 26 points. Four of them (18 points) were there when it started; REC-5 and
 * REC-6 (8 points) were pulled in afterwards. Three are finished (13 points). REC-7,
 * thirteen points of it, was punted on the second day and belongs to *neither* the
 * commitment nor the current scope — which is the case a naive count gets wrong, because
 * the issue is still in the project and still has a changelog entry naming the sprint.
 */

export const ORGANIZATION_ID = '77777777-7777-4777-8777-777777777777';
export const SOURCE_KEY = 'rec-tracker';
export const CLOUD_ID = 'c0ffee00-1111-2222-3333-444455556666';
export const API_BASE_URL = 'https://api.atlassian.test';
export const PROJECT_KEY = 'REC';
export const TEAM_KEY = 'reconciliation';
export const TIMEZONE = 'Europe/London';

const BOARD_ID = 91;
const SPRINT_ID = 501;

/** The sprint's own bounds, as the agile endpoint reports them. */
const SPRINT_START = '2026-07-13T09:00:00Z';
const SPRINT_END = '2026-07-27T17:00:00Z';

/**
 * The report instant: a Monday inside the sprint.
 *
 * `currentSprint` picks the sprint containing the instant, so this has to sit inside
 * `[SPRINT_START, SPRINT_END)` — a reconciliation against a sprint the report was not
 * about would be comparing two different questions.
 */
export const NOW: Instant = instantFromIso('2026-07-20T09:00:00Z');

/**
 * The ingest window, wide enough to reach the sprint's start.
 *
 * Wider than a daily report window on purpose. The connector filters every record by
 * `windowContains(window, occurredAt)`, and a sprint's `occurredAt` is the instant it
 * started — so a one-day window would return the issues and *not* the sprint they belong
 * to, and there would be nothing to reconcile.
 */
export const INGEST_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-07-01T00:00:00Z'),
  instantFromIso('2026-07-20T12:00:00Z'),
);

const PRIYA = { accountId: '5b10a2844c20165700ede21g', emailAddress: 'priya@example.com', displayName: 'Priya Raman' };
const MARCUS = { accountId: '5b10a2844c20165700ede21h', displayName: 'Marcus Hale' };

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const status = (name: string, category: 'new' | 'indeterminate' | 'done') => ({
  name,
  statusCategory: { key: category, name: category === 'new' ? 'To Do' : category === 'done' ? 'Done' : 'In Progress' },
});

interface IssueSpec {
  readonly identifier: string;
  readonly itemKey: string;
  readonly summary: string;
  readonly status: ReturnType<typeof status>;
  readonly updated: string;
  readonly resolved: string | null;
  readonly points: number;
  /** `false` for the punted issue: its sprint field no longer names this sprint. */
  readonly onSprint: boolean;
}

const issue = (spec: IssueSpec) => ({
  id: spec.identifier,
  key: spec.itemKey,
  fields: {
    summary: spec.summary,
    description: adf(`${spec.itemKey}: recorded for the sprint reconciliation fixture.`),
    status: spec.status,
    issuetype: { name: 'Story' },
    priority: { name: 'Medium' },
    labels: ['reconciliation'],
    assignee: PRIYA,
    reporter: MARCUS,
    created: '2026-07-13T08:00:00Z',
    updated: spec.updated,
    resolutiondate: spec.resolved,
    parent: null,
    customfield_10016: spec.points,
    // The sprint field carries what the issue is on *now*. A punted issue's is empty,
    // which is exactly why the changelog is the only route to "it was in on Monday".
    customfield_10020: spec.onSprint ? [{ id: SPRINT_ID, name: 'Reconciliation 12', state: 'active' }] : [],
    customfield_10021: null,
  },
});

/**
 * The seven issues, with the six that are on the sprint first.
 *
 * Point values are literals here and again, independently, in `JIRA_SPRINT_REPORT`.
 */
const ISSUES = [
  issue({
    identifier: '20501',
    itemKey: 'REC-1',
    summary: 'Move the settlement writer off the shared pool',
    status: status('Done', 'done'),
    updated: '2026-07-17T16:00:00Z',
    resolved: '2026-07-17T16:00:00Z',
    points: 5,
    onSprint: true,
  }),
  issue({
    identifier: '20502',
    itemKey: 'REC-2',
    summary: 'Collapse the duplicate ledger read',
    status: status('Done', 'done'),
    updated: '2026-07-18T11:30:00Z',
    resolved: '2026-07-18T11:30:00Z',
    points: 3,
    onSprint: true,
  }),
  issue({
    identifier: '20503',
    itemKey: 'REC-3',
    summary: 'Split the reconciliation projector',
    status: status('In Progress', 'indeterminate'),
    updated: '2026-07-19T09:15:00Z',
    resolved: null,
    points: 8,
    onSprint: true,
  }),
  issue({
    identifier: '20504',
    itemKey: 'REC-4',
    summary: 'Backfill the settlement audit index',
    status: status('To Do', 'new'),
    updated: '2026-07-13T08:45:00Z',
    resolved: null,
    points: 2,
    onSprint: true,
  }),
  issue({
    identifier: '20505',
    itemKey: 'REC-5',
    summary: 'Retry the nightly settlement sweep',
    status: status('Done', 'done'),
    updated: '2026-07-19T14:00:00Z',
    resolved: '2026-07-19T14:00:00Z',
    points: 5,
    onSprint: true,
  }),
  issue({
    identifier: '20506',
    itemKey: 'REC-6',
    summary: 'Alarm on a stalled settlement batch',
    status: status('In Progress', 'indeterminate'),
    updated: '2026-07-17T09:00:00Z',
    resolved: null,
    points: 3,
    onSprint: true,
  }),
  issue({
    identifier: '20507',
    itemKey: 'REC-7',
    summary: 'Rewrite the legacy settlement adapter',
    status: status('To Do', 'new'),
    updated: '2026-07-14T09:00:00Z',
    resolved: null,
    points: 13,
    onSprint: false,
  }),
] as const;

const changeGroup = (input: {
  readonly id: string;
  readonly at: string;
  readonly author: Record<string, unknown>;
  readonly items: readonly Record<string, unknown>[];
}) => ({ id: input.id, created: input.at, author: input.author, items: input.items });

/** Jira writes the sprint field's change as comma-separated *ids*. */
const sprintItem = (from: string | null, to: string | null) => ({
  field: 'Sprint',
  fieldtype: 'custom',
  from,
  fromString: from === null ? '' : 'Reconciliation 12',
  to,
  toString: to === null ? '' : 'Reconciliation 12',
});

const statusItem = (from: string, to: string) => ({
  field: 'status',
  fieldtype: 'jira',
  from: '20001',
  fromString: from,
  to: '20002',
  toString: to,
});

/** Fifteen minutes *before* the sprint opened: this is the commitment being set. */
const COMMITTED_AT = '2026-07-13T08:45:00Z';

/**
 * Each issue's changelog, keyed by item key.
 *
 * The four committed items joined before `SPRINT_START`, so `afterSprintStart` is false
 * for them and the analysis core counts them as commitment rather than as creep. REC-5 and
 * REC-6 joined after. REC-7 joined and then left.
 */
const CHANGELOGS: Readonly<Record<string, readonly ReturnType<typeof changeGroup>[]>> = {
  'REC-1': [
    changeGroup({ id: '80001', at: COMMITTED_AT, author: PRIYA, items: [sprintItem(null, String(SPRINT_ID))] }),
    // A mixed group, as Jira really records a transition that also resolves an issue. Only the
    // status item is a transition; nothing here may reach the scope-change list.
    changeGroup({
      id: '80002',
      at: '2026-07-17T16:00:00Z',
      author: PRIYA,
      items: [statusItem('In Progress', 'Done'), { field: 'resolution', fromString: null, toString: 'Done' }],
    }),
  ],
  'REC-2': [
    changeGroup({ id: '80011', at: COMMITTED_AT, author: PRIYA, items: [sprintItem(null, String(SPRINT_ID))] }),
    changeGroup({
      id: '80012',
      at: '2026-07-18T11:30:00Z',
      author: MARCUS,
      items: [statusItem('In Progress', 'Done')],
    }),
  ],
  'REC-3': [
    changeGroup({ id: '80021', at: COMMITTED_AT, author: PRIYA, items: [sprintItem(null, String(SPRINT_ID))] }),
  ],
  'REC-4': [
    changeGroup({ id: '80031', at: COMMITTED_AT, author: PRIYA, items: [sprintItem(null, String(SPRINT_ID))] }),
  ],
  'REC-5': [
    changeGroup({
      id: '80041',
      at: '2026-07-15T10:00:00Z',
      author: MARCUS,
      items: [sprintItem(null, String(SPRINT_ID))],
    }),
    changeGroup({
      id: '80042',
      at: '2026-07-19T14:00:00Z',
      author: MARCUS,
      items: [statusItem('In Progress', 'Done')],
    }),
  ],
  'REC-6': [
    changeGroup({
      id: '80051',
      at: '2026-07-16T11:00:00Z',
      author: MARCUS,
      items: [sprintItem(null, String(SPRINT_ID))],
    }),
  ],
  'REC-7': [
    changeGroup({ id: '80061', at: COMMITTED_AT, author: PRIYA, items: [sprintItem(null, String(SPRINT_ID))] }),
    // Punted. `to` is null, so this is a removal.
    changeGroup({
      id: '80062',
      at: '2026-07-14T09:00:00Z',
      author: PRIYA,
      items: [sprintItem(String(SPRINT_ID), null)],
    }),
  ],
};

const SPRINT = {
  id: SPRINT_ID,
  name: 'Reconciliation 12',
  state: 'active',
  goal: 'Settlement stops being the slowest thing in the ledger.',
  startDate: SPRINT_START,
  endDate: SPRINT_END,
  originBoardId: BOARD_ID,
};

/** The membership the board reports *now* — the punted issue is not in it. */
const CURRENT_MEMBERSHIP = ['REC-1', 'REC-2', 'REC-3', 'REC-4', 'REC-5', 'REC-6'] as const;

const ISSUE_FIELDS =
  'summary,description,status,issuetype,priority,labels,assignee,reporter,created,updated,' +
  'resolutiondate,parent,customfield_10016,customfield_10020,customfield_10021';

const base = `${API_BASE_URL}/ex/jira/${CLOUD_ID}`;

const searchUrl = (jql: string, fields: string): string => {
  const query = new URLSearchParams({ jql, fields, maxResults: '100' });
  return `GET ${base}/rest/api/3/search/jql?${query.toString()}`;
};

const pagedUrl = (path: string): string =>
  `GET ${base}${path}${path.includes('?') ? '&' : '?'}startAt=0&maxResults=50`;

/**
 * The response table, keyed exactly as `ReplayHttpClient` keys it.
 *
 * Only the endpoints the three fetches this fixture is used for actually reach. An
 * endpoint the connector asks for without a recording is a loud `UnrecordedRequestError`,
 * which is the property that makes a recording worth trusting — so nothing speculative is
 * added here.
 */
export function recordedSprintApi(): Record<string, HttpResponse> {
  const table: Record<string, HttpResponse> = {};
  const jql = updatedSinceJql(PROJECT_KEY, INGEST_WINDOW);

  table[searchUrl(jql, ISSUE_FIELDS)] = jsonResponse({ issues: ISSUES, isLast: true });
  table[searchUrl(jql, 'key')] = jsonResponse({
    issues: ISSUES.map((entry) => ({ id: entry.id, key: entry.key })),
    isLast: true,
  });

  for (const [itemKey, groups] of Object.entries(CHANGELOGS)) {
    table[pagedUrl(`/rest/api/3/issue/${itemKey}/changelog`)] = jsonResponse({ values: groups, isLast: true });
  }

  table[pagedUrl(`/rest/agile/1.0/board?projectKeyOrId=${PROJECT_KEY}`)] = jsonResponse({
    values: [{ id: BOARD_ID, name: 'REC board', type: 'scrum' }],
    isLast: true,
  });
  table[pagedUrl(`/rest/agile/1.0/board/${BOARD_ID}/sprint`)] = jsonResponse({ values: [SPRINT], isLast: true });

  table[searchUrl(sprintMembershipJql(PROJECT_KEY, SPRINT_ID), 'key')] = jsonResponse({
    issues: CURRENT_MEMBERSHIP.map((key) => ({ key })),
    isLast: true,
  });

  return table;
}

export const recordedSprintClient = (): ReplayHttpClient => new ReplayHttpClient(recordedSprintApi());

// ---------------------------------------------------------------------------
// Jira's own sprint report, recorded separately
// ---------------------------------------------------------------------------

/**
 * The endpoint the recording below came from.
 *
 * `GET /rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=<board>&sprintId=<sprint>`
 * — the request Jira's own Sprint Report screen makes. It is deliberately **not** in
 * `recordedSprintApi()`: `JiraConnector` never calls it, and it must not start to. Compass
 * computes completion from issues, sprint membership and the change history, because those
 * are the artifacts the port already carries for every provider; reading a Jira-only
 * report screen would make the tracker's shape visible above the port. This payload is the
 * *reference* the computation is checked against, which is a different job.
 */
export const JIRA_SPRINT_REPORT_ENDPOINT =
  `/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=${BOARD_ID}&sprintId=${SPRINT_ID}`;

interface SprintReportIssue {
  readonly key: string;
  readonly statusName: string;
  readonly estimateStatistic: { readonly statFieldValue: { readonly value: number } };
}

interface SprintReportSum {
  readonly value: number;
  readonly text: string;
}

export interface JiraSprintReport {
  readonly contents: {
    readonly completedIssues: readonly SprintReportIssue[];
    readonly issuesNotCompletedInCurrentSprint: readonly SprintReportIssue[];
    readonly puntedIssues: readonly SprintReportIssue[];
    readonly issuesCompletedInAnotherSprint: readonly SprintReportIssue[];
    readonly completedIssuesEstimateSum: SprintReportSum;
    readonly issuesNotCompletedEstimateSum: SprintReportSum;
    readonly allIssuesEstimateSum: SprintReportSum;
    readonly puntedIssuesEstimateSum: SprintReportSum;
    /** Jira's own record of scope creep: the keys that entered after the sprint opened. */
    readonly issueKeysAddedDuringSprint: Readonly<Record<string, boolean>>;
  };
  readonly sprint: {
    readonly id: number;
    readonly name: string;
    readonly state: string;
    readonly goal: string;
    readonly startDate: string;
    readonly endDate: string;
  };
}

const reportIssue = (key: string, statusName: string, value: number): SprintReportIssue => ({
  key,
  statusName,
  estimateStatistic: { statFieldValue: { value } },
});

/**
 * What Jira's Sprint Report shows for `REC` sprint 501 at the report instant.
 *
 * Every figure is a literal, written independently of the API recording above. The two
 * only agree if the connector reads the board faithfully and the analysis core counts it
 * correctly — which is the property `sprint-reconciliation.test.ts` asserts.
 *
 * `allIssuesEstimateSum` is completed plus not-completed and excludes the punted issue,
 * matching the totals Jira prints under its two tables. The punted sum is reported on its
 * own line, as Jira reports it.
 */
export const JIRA_SPRINT_REPORT: JiraSprintReport = {
  contents: {
    completedIssues: [
      reportIssue('REC-1', 'Done', 5.0),
      reportIssue('REC-2', 'Done', 3.0),
      reportIssue('REC-5', 'Done', 5.0),
    ],
    issuesNotCompletedInCurrentSprint: [
      reportIssue('REC-3', 'In Progress', 8.0),
      reportIssue('REC-4', 'To Do', 2.0),
      reportIssue('REC-6', 'In Progress', 3.0),
    ],
    puntedIssues: [reportIssue('REC-7', 'To Do', 13.0)],
    issuesCompletedInAnotherSprint: [],
    completedIssuesEstimateSum: { value: 13.0, text: '13.0' },
    issuesNotCompletedEstimateSum: { value: 13.0, text: '13.0' },
    allIssuesEstimateSum: { value: 26.0, text: '26.0' },
    puntedIssuesEstimateSum: { value: 13.0, text: '13.0' },
    issueKeysAddedDuringSprint: { 'REC-5': true, 'REC-6': true },
  },
  sprint: {
    id: SPRINT_ID,
    name: 'Reconciliation 12',
    state: 'ACTIVE',
    goal: 'Settlement stops being the slowest thing in the ledger.',
    startDate: SPRINT_START,
    endDate: SPRINT_END,
  },
};

// ---------------------------------------------------------------------------
// Connector records, projected into the snapshot the analysis core reads
// ---------------------------------------------------------------------------

/**
 * The one piece of plumbing this fixture owns: port records to `AnalysisSnapshot`.
 *
 * The reconciliation has to run over the *same* input production uses, which is the
 * versioned knowledge model rather than a bag of records. `@compass/ingest` plus
 * `@compass/knowledge-model` do that against a real PostgreSQL, and standing one up here
 * would make a connector package's test suite depend on a database to check arithmetic
 * that has nothing to do with persistence.
 *
 * So this projects the records in memory, with the same natural keys and the same field
 * names — `packages/ingest/src/naming.ts` is the reference, and
 * `packages/seed-snapshot/src/index.ts` is the same projection for the seeded dataset.
 * Two facts keep it honest: `packages/pipeline/tests/contract.test.ts` is what proves the
 * real snapshot builder produces this shape, and every number this file feeds the analysis
 * core comes out of `JiraConnector` rather than being written here.
 *
 * The team and the project are *declared* rather than observed, exactly as in production:
 * no connector reports a team, and `resolveScope` needs one to know which board this
 * report is about.
 */
export function snapshotFromRecords(input: {
  readonly issues: readonly IssueRecord[];
  readonly sprints: readonly SprintRecord[];
  readonly scopeChanges: readonly SprintScopeChangeRecord[];
  readonly instant: Instant;
  readonly window: TimeWindow;
}): AnalysisSnapshot {
  const declaredAt = instantFromIso('2026-07-01T00:00:00Z');
  const entities: AnalysisEntity[] = [];

  const observe = (
    kind: string,
    naturalKey: string,
    fields: Readonly<Record<string, FieldValue>>,
    observedAt: number,
  ): void => {
    entities.push({
      kind,
      naturalKey,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      beliefAt: observedAt,
      version: 1,
      elapsed: { ageDays: 0, staleDays: 0, seenToday: true, trail: [] },
      fields,
    });
  };

  /**
   * The roster, declared — a connector reports people but never *who they are*.
   *
   * Keyed by the identity value the tracker publishes, which for one of these two is an
   * address and for the other an opaque account id, because the site hides their email.
   * That is the real shape and it is what `IdentityResolver` resolves in production; an
   * unmapped identity resolves to `null` here too rather than being guessed at by name.
   */
  const roster: Readonly<Record<string, string>> = {
    'priya@example.com': 'priya',
    '5b10a2844c20165700ede21h': 'marcus',
  };
  const developerKeyFor = (identity: { readonly value: string } | null): string | null =>
    identity === null ? null : (roster[identity.value.toLowerCase()] ?? null);

  for (const [identityValue, developerKey] of Object.entries(roster)) {
    observe(
      'developer',
      developerKey,
      {
        displayName: identityValue === 'priya@example.com' ? 'Priya Raman' : 'Marcus Hale',
        teamKey: TEAM_KEY,
        active: true,
      },
      declaredAt,
    );
  }

  observe(
    'team',
    TEAM_KEY,
    {
      name: 'Reconciliation',
      methodology: 'scrum',
      projectKey: PROJECT_KEY,
      objectiveKey: null,
      conversationKey: null,
      timezone: TIMEZONE,
    },
    declaredAt,
  );
  observe(
    'project',
    PROJECT_KEY,
    { name: 'Reconciliation', teamKey: TEAM_KEY, methodology: 'scrum', defaultBranch: 'main' },
    declaredAt,
  );

  /** `<sourceKey>:<sourceRecordId>`, the same composite the knowledge model uses. */
  const sprintKeyOf = (sourceKey: string, ref: string): string => `${sourceKey}:${ref}`;

  const sprintStarts = new Map<string, number>();
  for (const sprint of input.sprints) {
    const naturalKey = sprintKeyOf(sprint.sourceKey, sprint.sourceRecordId);
    sprintStarts.set(naturalKey, sprint.startAt);
    observe(
      'sprint',
      naturalKey,
      {
        projectKey: sprint.projectKey,
        name: sprint.name,
        goal: sprint.goal,
        state: sprint.state,
        startAt: sprint.startAt,
        endAt: sprint.endAt,
        completedAt: sprint.completedAt,
        committedItemKeys: [...sprint.committedItemKeys].sort(),
      },
      sprint.startAt,
    );
  }

  for (const item of input.issues) {
    const sprintRef = item.sprintRefs[0];
    observe(
      'ticket',
      item.itemKey,
      {
        projectKey: item.projectKey,
        featureKey: item.parentItemKey,
        itemKey: item.itemKey,
        title: item.title,
        status: item.status,
        statusCategory: item.statusCategory,
        itemType: item.itemType,
        priority: item.priority,
        estimatePoints: item.estimatePoints,
        labels: [...item.labels].sort(),
        assigneeDeveloperKey: developerKeyFor(item.assigneeIdentity),
        reporterDeveloperKey: developerKeyFor(item.reporterIdentity),
        sprintKey: sprintRef === undefined ? null : sprintKeyOf(item.sourceKey, sprintRef),
        flaggedBlocked: item.flaggedBlocked,
        createdAt: item.createdAt,
        resolvedAt: item.resolvedAt,
      },
      item.updatedAt,
    );
  }

  const scopeChanges: AnalysisSprintScopeChange[] = input.scopeChanges.map((change) => {
    const naturalKey = sprintKeyOf(change.sourceKey, change.sprintRef);
    const startAt = sprintStarts.get(naturalKey);
    return {
      sprintKey: naturalKey,
      ticketKey: change.itemKey,
      sourceKey: change.sourceKey,
      sourceRecordId: change.sourceRecordId,
      change: change.change,
      actorDeveloperKey: developerKeyFor(change.actorIdentity),
      changedAt: change.changedAt,
      // The knowledge model's own rule: strictly after the start is creep; at or before it
      // is the commitment being assembled.
      afterSprintStart: startAt !== undefined && change.changedAt > startAt,
    };
  });

  const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  const ordered = [...entities].sort(
    (left, right) => compare(left.kind, right.kind) || compare(left.naturalKey, right.naturalKey),
  );

  const counts = new Map<string, number>();
  for (const entity of ordered) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);

  const collections: AnalysisCollections = {
    entities: ordered,
    entityCounts: [...counts.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([kind, count]) => ({ kind, count })),
    entityVersions: [],
    ticketTransitions: [],
    sprintScopeChanges: [...scopeChanges].sort(
      (left, right) =>
        compare(left.sprintKey, right.sprintKey) ||
        left.changedAt - right.changedAt ||
        compare(left.sourceRecordId, right.sourceRecordId),
    ),
    corrections: [],
    ingestRuns: [],
  };

  return {
    organizationId: ORGANIZATION_ID,
    scope: { kind: 'team', teamKey: TEAM_KEY },
    instant: input.instant,
    timezone: TIMEZONE,
    window: input.window,
    collections,
  };
}
