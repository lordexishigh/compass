import {
  assessProgress,
  generateStructuredReport,
  resolveScope,
  type AnalysisSnapshot,
  type SprintCompletion,
} from '@compass/analysis';
import type { ReplayHttpClient } from '@compass/connector-port/testkit';
import { JiraConnector } from '@compass/jira-connector';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  API_BASE_URL,
  CLOUD_ID,
  INGEST_WINDOW,
  JIRA_SPRINT_REPORT,
  JIRA_SPRINT_REPORT_ENDPOINT,
  NOW,
  ORGANIZATION_ID,
  PROJECT_KEY,
  SOURCE_KEY,
  recordedSprintClient,
  snapshotFromRecords,
} from './recorded-sprint-report.js';

/**
 * The acceptance criterion, as the only test that can prove it:
 *
 * > Sprint completion math reconcilable against the Jira board.
 *
 * "Reconcilable" is not "plausible". A manager who disagrees with a completion figure opens
 * their tracker's own Sprint Report and reads two tables and four totals off it. If
 * Compass's numbers do not equal those numbers, every other figure in the report is
 * worthless — which is why this suite asserts **equality**, field by field, rather than
 * checking that the arithmetic is internally consistent. Internal consistency is already
 * covered by `packages/analysis/tests/progress.test.ts`; a wrong denominator is perfectly
 * self-consistent.
 *
 * ## What is being compared, and why it is a real comparison
 *
 * Left-hand side: `JiraConnector` reads a recorded Jira REST API, and the records it
 * produces are projected into an `AnalysisSnapshot` and handed to `assessProgress` — the
 * same function the pipeline calls. Nothing about the numbers is authored by this test.
 *
 * Right-hand side: `JIRA_SPRINT_REPORT`, a separately recorded payload from Jira's own
 * `sprintreport` endpoint for the same sprint, with every figure written out as a literal.
 * The connector never requests that endpoint and must not start to — see
 * `JIRA_SPRINT_REPORT_ENDPOINT`.
 *
 * Because the two recordings are independent, a connector that drops an issue, mis-reads
 * the story-point custom field, or an analysis core that counts a punted issue makes them
 * disagree.
 *
 * ## The field mapping, stated in full
 *
 * This is the table a reviewer needs, and it is here rather than in a document because a
 * mapping that lives away from its assertions is a mapping that drifts from them.
 *
 * | Jira Sprint Report | Compass `SprintCompletion` |
 * | --- | --- |
 * | `contents.completedIssues` — keys | `completed.ticketKeys` |
 * | `contents.completedIssues.length` | `completed.tickets` |
 * | `contents.completedIssuesEstimateSum.value` | `completed.points` |
 * | `contents.issuesNotCompletedInCurrentSprint` — keys | `remaining.ticketKeys` |
 * | `contents.issuesNotCompletedInCurrentSprint.length` | `remaining.tickets` |
 * | `contents.issuesNotCompletedEstimateSum.value` | `remaining.points` |
 * | completed ∪ not-completed — keys, count | `currentScope.ticketKeys`, `.tickets` |
 * | `contents.allIssuesEstimateSum.value` | `currentScope.points` |
 * | `Object.keys(contents.issueKeysAddedDuringSprint)` | `addedMidSprint.ticketKeys`, `.tickets` |
 * | Σ estimates of those keys | `addedMidSprint.points` |
 * | current scope less the keys added during the sprint | `committed.ticketKeys`, `.tickets` |
 * | `allIssuesEstimateSum` less the added estimates | `committed.points` |
 * | `contents.puntedIssues` | absent from **every** line |
 * | `completedIssuesEstimateSum ÷ allIssuesEstimateSum` | `completionPercent` |
 * | `completedIssuesEstimateSum ÷ committed points` | `completionPercentOfCommitment` |
 * | `sprint.name`, `.goal`, `.state`, `.startDate`, `.endDate` | `sprintName`, `goal`, `state`, `startAt`, `endAt` |
 *
 * Two entries deserve their reason stated.
 *
 * **`allIssuesEstimateSum` excludes punted work.** It is the total under Jira's two tables
 * — completed plus not-completed — and Jira reports `puntedIssuesEstimateSum` on its own
 * line. Compass's `currentScope` is the same set for the same reason: an item pulled out of
 * the sprint is not work the team is carrying, and leaving it in the denominator would make
 * a team look slower every time a manager descoped something.
 *
 * **The commitment is derived, not read.** Jira has no "committed" total; it has
 * `issueKeysAddedDuringSprint`, and the commitment is what is left after removing those.
 * Compass arrives at the same set from the other direction — the sprint-field change history
 * — so agreement here is agreement between two different routes to the same fact, which is
 * the strongest form this comparison takes.
 */

const connector = (http: ReplayHttpClient): JiraConnector =>
  new JiraConnector({
    sourceKey: SOURCE_KEY,
    projects: [{ projectKey: PROJECT_KEY }],
    accessToken: 'a-test-access-token',
    cloudId: CLOUD_ID,
    http,
    apiBaseUrl: API_BASE_URL,
  });

const request = { organizationId: ORGANIZATION_ID, window: INGEST_WINDOW, now: NOW };

/** The three reads sprint completion is computed from, over one recorded transport. */
async function readBoard(http: ReplayHttpClient): Promise<AnalysisSnapshot> {
  const source = connector(http);
  const [issues, sprints, scopeChanges] = await Promise.all([
    source.fetchIssues(request),
    source.fetchSprints(request),
    source.fetchSprintScopeChanges(request),
  ]);

  // Every read must have succeeded outright. A rate-limited read returns an empty record
  // list with stated coverage, and reconciling against nothing would pass vacuously.
  for (const [label, result] of [
    ['issues', issues],
    ['sprints', sprints],
    ['sprint scope changes', scopeChanges],
  ] as const) {
    expect(result.coverage.every((entry) => entry.status === 'complete'), `${label} was not read completely`).toBe(true);
  }

  return snapshotFromRecords({
    issues: issues.records,
    sprints: sprints.records,
    scopeChanges: scopeChanges.records,
    instant: NOW,
    window: INGEST_WINDOW,
  });
}

const report = JIRA_SPRINT_REPORT.contents;

/** Jira's own figures, reduced to the shape the mapping table above names. */
const jira = {
  completedKeys: report.completedIssues.map((entry) => entry.key).slice().sort(),
  completedTickets: report.completedIssues.length,
  completedPoints: report.completedIssuesEstimateSum.value,
  remainingKeys: report.issuesNotCompletedInCurrentSprint.map((entry) => entry.key).slice().sort(),
  remainingTickets: report.issuesNotCompletedInCurrentSprint.length,
  remainingPoints: report.issuesNotCompletedEstimateSum.value,
  scopeKeys: [...report.completedIssues, ...report.issuesNotCompletedInCurrentSprint]
    .map((entry) => entry.key)
    .slice()
    .sort(),
  scopePoints: report.allIssuesEstimateSum.value,
  addedKeys: Object.keys(report.issueKeysAddedDuringSprint).slice().sort(),
  puntedKeys: report.puntedIssues.map((entry) => entry.key).slice().sort(),
};

/** Σ of the estimates Jira attributes to the keys that entered after the sprint opened. */
const addedPoints = [...report.completedIssues, ...report.issuesNotCompletedInCurrentSprint]
  .filter((entry) => jira.addedKeys.includes(entry.key))
  .reduce((sum, entry) => sum + entry.estimateStatistic.statFieldValue.value, 0);

const committedKeys = jira.scopeKeys.filter((key) => !jira.addedKeys.includes(key));
const committedPoints = jira.scopePoints - addedPoints;

const transport = recordedSprintClient();
let snapshot: AnalysisSnapshot;
let sprint: SprintCompletion;

beforeAll(async () => {
  snapshot = await readBoard(transport);

  const progress = assessProgress(snapshot, NOW, resolveScope(snapshot));
  if (progress.mode !== 'sprint') {
    throw new Error(`expected sprint semantics for the recorded board, got \`${progress.mode}\``);
  }
  sprint = progress.sprint;
});

describe('the recording is of the sprint the report is about', () => {
  it('reports on the sprint Jira reported on, by name, goal, state and bounds', () => {
    expect(sprint.sprintName).toBe(JIRA_SPRINT_REPORT.sprint.name);
    expect(sprint.goal).toBe(JIRA_SPRINT_REPORT.sprint.goal);
    // Jira's sprint report shouts its state; the API does not. Compared case-insensitively
    // rather than by mapping one onto the other, which would be a mapping nothing checks.
    expect(sprint.state.toLowerCase()).toBe(JIRA_SPRINT_REPORT.sprint.state.toLowerCase());
    expect(sprint.startAt).toBe(Date.parse(JIRA_SPRINT_REPORT.sprint.startDate));
    expect(sprint.endAt).toBe(Date.parse(JIRA_SPRINT_REPORT.sprint.endDate));
  });

  it('does not read the sprint report endpoint, which stays a reference and not a source', () => {
    /**
     * Asserted at the transport seam, where it is observable. Compass computes completion
     * from artifacts the port already carries for every provider; if it ever read Jira's own
     * report screen instead, the figures would agree here and the seeded connector — which
     * has no such screen — would silently stop being able to answer the Progress section.
     */
    expect(JIRA_SPRINT_REPORT_ENDPOINT).toContain('sprintreport');
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(transport.calledAnyMatching(/sprintreport/)).toBe(false);
    expect(transport.calledAnyMatching(/greenhopper/)).toBe(false);
  });
});

describe('completed reconciles against Jira’s Completed Issues table', () => {
  it('names the same keys', () => {
    expect([...sprint.completed.ticketKeys].sort()).toEqual(jira.completedKeys);
  });

  it('counts the same tickets and sums the same points', () => {
    expect(sprint.completed.tickets).toBe(jira.completedTickets);
    expect(sprint.completed.points).toBe(jira.completedPoints);
  });
});

describe('remaining reconciles against Jira’s Issues Not Completed table', () => {
  it('names the same keys', () => {
    expect([...sprint.remaining.ticketKeys].sort()).toEqual(jira.remainingKeys);
  });

  it('counts the same tickets and sums the same points', () => {
    expect(sprint.remaining.tickets).toBe(jira.remainingTickets);
    expect(sprint.remaining.points).toBe(jira.remainingPoints);
  });
});

describe('current scope reconciles against Jira’s own total', () => {
  it('is completed plus not-completed, in both units', () => {
    expect([...sprint.currentScope.ticketKeys].sort()).toEqual(jira.scopeKeys);
    expect(sprint.currentScope.tickets).toBe(jira.completedTickets + jira.remainingTickets);
    expect(sprint.currentScope.points).toBe(jira.scopePoints);
  });

  it('excludes the punted issue from every line, rather than counting it as unfinished', () => {
    /**
     * The case a naive count gets wrong. REC-7 is still in the project, still has a
     * changelog entry naming this sprint, and is not done — so anything that reads
     * "issues that ever touched sprint 501" puts thirteen points into the denominator
     * and reports the team as a third slower than they are.
     */
    expect(jira.puntedKeys).not.toEqual([]);

    for (const [label, line] of [
      ['currentScope', sprint.currentScope],
      ['committed', sprint.committed],
      ['completed', sprint.completed],
      ['remaining', sprint.remaining],
      ['addedMidSprint', sprint.addedMidSprint],
    ] as const) {
      for (const punted of jira.puntedKeys) {
        expect(line.ticketKeys, `${punted} was punted and must not appear in ${label}`).not.toContain(punted);
      }
    }

    const rowKeys = sprint.reconciliation.map((row) => row.ticketKey);
    for (const punted of jira.puntedKeys) {
      expect(rowKeys, `${punted} was punted and must not have a reconciliation row`).not.toContain(punted);
    }
  });
});

describe('the commitment reconciles against Jira’s issueKeysAddedDuringSprint', () => {
  it('names the same items as scope creep, in both units', () => {
    expect([...sprint.addedMidSprint.ticketKeys].sort()).toEqual(jira.addedKeys);
    expect(sprint.addedMidSprint.tickets).toBe(jira.addedKeys.length);
    expect(sprint.addedMidSprint.points).toBe(addedPoints);
  });

  it('leaves the same commitment behind, in both units', () => {
    expect([...sprint.committed.ticketKeys].sort()).toEqual(committedKeys);
    expect(sprint.committed.tickets).toBe(committedKeys.length);
    expect(sprint.committed.points).toBe(committedPoints);
  });

  it('reaches that commitment from the change history rather than from the report', () => {
    // Both routes have to be non-trivial for the agreement above to mean anything: Jira
    // named two additions, and the analysis core found them in the sprint-field changelog.
    expect(jira.addedKeys.length).toBeGreaterThan(0);
    expect(sprint.committed.tickets).toBeLessThan(sprint.currentScope.tickets);
    expect(sprint.committed.points).toBeLessThan(sprint.currentScope.points);
  });
});

describe('the percentages are the ones Jira’s totals imply', () => {
  it('completion against current scope is completed ÷ all issues', () => {
    expect(sprint.basis).toBe('story_points');
    expect(sprint.completionPercent).toBe(Math.round((jira.completedPoints * 100) / jira.scopePoints));
  });

  it('completion against the commitment is completed ÷ committed', () => {
    expect(sprint.completionPercentOfCommitment).toBe(Math.round((jira.completedPoints * 100) / committedPoints));
  });

  it('reports the two differently, because scope was added', () => {
    // If these were equal the pair would be decoration. Scope creep has to be visible as a
    // larger denominator rather than as a mysteriously slower burn.
    expect(sprint.completionPercentOfCommitment).toBeGreaterThan(sprint.completionPercent);
  });
});

describe('every in-scope item is accounted for once, against the same two tables', () => {
  it('has one reconciliation row per item, on the line Jira puts it on', () => {
    const rows = sprint.reconciliation;

    expect(rows).toHaveLength(jira.scopeKeys.length);
    expect(rows.map((row) => row.ticketKey).sort()).toEqual(jira.scopeKeys);
    expect(
      rows
        .filter((row) => row.countedIn === 'completed')
        .map((row) => row.ticketKey)
        .sort(),
    ).toEqual(jira.completedKeys);
    expect(
      rows
        .filter((row) => row.countedIn === 'remaining')
        .map((row) => row.ticketKey)
        .sort(),
    ).toEqual(jira.remainingKeys);
    expect(
      rows
        .filter((row) => row.addedMidSprint)
        .map((row) => row.ticketKey)
        .sort(),
    ).toEqual(jira.addedKeys);
  });

  it('carries the estimate Jira carries, item by item', () => {
    const jiraEstimates = new Map(
      [...report.completedIssues, ...report.issuesNotCompletedInCurrentSprint].map((entry) => [
        entry.key,
        entry.estimateStatistic.statFieldValue.value,
      ]),
    );

    for (const row of sprint.reconciliation) {
      expect(row.points, `${row.ticketKey} carries a different estimate than Jira reports`).toBe(
        jiraEstimates.get(row.ticketKey),
      );
    }
  });
});

describe('the Progress section a manager reads states both counts', () => {
  /**
   * The other half of the criterion. Reconciling the payload is necessary and not
   * sufficient: the figures have to be *in the sentence*, because a number a manager cannot
   * see is a number they cannot check. The claim states completed in both units and the
   * detail states the commitment in both, so the two lines that Jira's own report puts side
   * by side are both readable off the page.
   */
  it('states completed tickets and points, and the commitment in both units', () => {
    const structured = generateStructuredReport(snapshot, NOW);

    const progressSection = structured.sections.find((section) => section.key === 'progress');
    const claim = progressSection?.items.find((item) => item.headline.includes(JIRA_SPRINT_REPORT.sprint.name));

    expect(claim, 'the Progress section must carry a claim about this sprint').toBeDefined();
    expect(claim?.headline).toContain(`${jira.completedTickets} of ${jira.scopeKeys.length} tickets`);
    expect(claim?.headline).toContain(`${jira.completedPoints} of ${jira.scopePoints} points`);
    // Which quantity produced the percentage, said out loud — otherwise a reader who
    // divides the other pair gets a different answer and cannot tell why.
    expect(claim?.headline).toContain('by story points');
    expect(claim?.detail).toContain(`${committedKeys.length} tickets and ${committedPoints} points were committed`);
  });
});
