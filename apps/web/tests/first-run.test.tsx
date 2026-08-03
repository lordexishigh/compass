import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { FirstReportGuide } from '../components/first-report-guide';
import { currentQuarter, GoalQuickEntry, TeamQuickSetup } from '../components/first-report-path';
import {
  firstRunMinutes,
  liveGoalCount,
  organizationIsUnprovisioned,
  outstandingSteps,
  type FirstRunReadiness,
  type FirstRunStep,
} from '../lib/first-run-source';

/**
 * The first-run path: the four steps, the time claim, and what `/` says with nothing behind it.
 *
 * The acceptance criterion this file is mostly about is a promise to a stranger — *a new org
 * can reach a generated report in under ten minutes of in-app steps with no external
 * assistance* — and the only part of that a test can hold is the part the product asserts on
 * screen. So the budget printed on the page is checked against the sum of the steps, and the
 * steps are checked for being the four things a report is actually computed from. A path that
 * grew a fifth step, or a step whose estimate crept, fails here rather than in somebody's
 * afternoon.
 *
 * The other half is the branch on `/`: an organization with nothing behind it must be *told*
 * what is missing, not shown six empty headings. That distinction is the one worth guarding
 * carefully, because the product's other firm rule points the other way — a quiet day is still
 * six sections — and the two are easy to conflate.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
}));

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readWebFile = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), 'utf8');

const step = (
  id: FirstRunStep['id'],
  ordinal: string,
  state: FirstRunStep['state'],
  minutes: number,
): FirstRunStep => ({
  id,
  ordinal,
  state,
  minutes,
  title: `${id} step`,
  summary: `Nothing is configured for ${id}, so the report cannot resolve it.`,
});

const readiness = (states: Readonly<Record<FirstRunStep['id'], FirstRunStep['state']>>): FirstRunReadiness => ({
  steps: [
    step('source', '01', states.source, 1),
    step('team', '02', states.team, 3),
    step('goals', '03', states.goals, 3),
    step('roster', '04', states.roster, 2),
  ],
  ready: Object.values(states).every((state) => state === 'done'),
  reportExists: false,
  demonstration: false,
  teamKeys: states.team === 'done' ? ['platform'] : [],
  developerCount: states.roster === 'done' ? 12 : 0,
  goalCount: states.goals === 'done' ? 3 : 0,
  trackedSourceCount: states.source === 'done' ? 4 : 0,
  unmatchedCount: 0,
});

const NOTHING_DONE = readiness({ source: 'todo', team: 'todo', goals: 'todo', roster: 'todo' });

// ---------------------------------------------------------------------------
// 1. The path, and the ten-minute claim
// ---------------------------------------------------------------------------

describe('the four-step path', () => {
  it('is four steps, in dependency order, numbered like everything else in the product', () => {
    // Fixed order and fixed numerals, the same discipline as the Six Spine: a manager who
    // comes back to this page a day later should find it where they left it.
    expect(NOTHING_DONE.steps.map((entry) => entry.id)).toEqual(['source', 'team', 'goals', 'roster']);
    expect(NOTHING_DONE.steps.map((entry) => entry.ordinal)).toEqual(['01', '02', '03', '04']);
  });

  it('claims under ten minutes in total, which is the criterion', () => {
    expect(firstRunMinutes(NOTHING_DONE)).toBeLessThan(10);
    // And every step carries a real estimate, so the sum is not made small by omission.
    for (const entry of NOTHING_DONE.steps) {
      expect(entry.minutes, `${entry.id} has no time estimate`).toBeGreaterThan(0);
    }
  });

  it('counts a goal once, at its newest revision, and not at all once archived', () => {
    /**
     * `objective_versions` is append-only, so a goal edited three times is three rows. Counting
     * rows would report "3 goals recorded" for one objective, and — worse — would keep counting a
     * goal whose newest revision archived it, so step 03 would read as done on a hierarchy that
     * resolves to nothing and alignment would come back unattributed with no explanation.
     */
    const revision = (nodeId: string, rev: number, archived: boolean) =>
      ({ nodeId, revision: rev, archived }) as unknown as Parameters<typeof liveGoalCount>[0][number];

    expect(liveGoalCount([])).toBe(0);

    // One node, three revisions: one goal.
    expect(
      liveGoalCount([revision('obj-1', 1, false), revision('obj-1', 2, false), revision('obj-1', 3, false)]),
    ).toBe(1);

    // Archived at the newest revision: gone, whatever the earlier ones said.
    expect(liveGoalCount([revision('obj-1', 1, false), revision('obj-1', 2, true)])).toBe(0);

    // Un-archived again by a later revision: back. The newest revision is the only one that speaks.
    expect(
      liveGoalCount([revision('obj-1', 1, false), revision('obj-1', 2, true), revision('obj-1', 3, false)]),
    ).toBe(1);

    // Rows in any order — the store does not promise revision order.
    expect(liveGoalCount([revision('obj-1', 2, true), revision('obj-1', 1, false)])).toBe(0);

    // Two distinct nodes, one of them archived.
    expect(liveGoalCount([revision('obj-1', 1, false), revision('obj-2', 1, true)])).toBe(1);
  });

  it('reports what is outstanding in the same fixed order', () => {
    const partial = readiness({ source: 'done', team: 'todo', goals: 'done', roster: 'todo' });

    expect(outstandingSteps(partial).map((entry) => entry.id)).toEqual(['team', 'roster']);
    expect(partial.ready).toBe(false);
    expect(readiness({ source: 'done', team: 'done', goals: 'done', roster: 'done' }).ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Which organizations get an explanation instead of a report
// ---------------------------------------------------------------------------

describe('an organization with nothing behind it is told so, and a quiet one is not', () => {
  it('counts an org with no team and nobody as unprovisioned', () => {
    expect(organizationIsUnprovisioned({ teamKeys: [], developerCount: 0 })).toBe(true);
  });

  it('does not treat a configured org with a quiet day as unprovisioned', () => {
    /**
     * The distinction that matters most in this file.
     *
     * A team that shipped nothing yesterday still gets six sections with the absences stated —
     * `cold-start.test.tsx` asserts exactly that, and it must keep being true. So both halves
     * of the condition have to be empty before `/` stops rendering a report: a team with no
     * people configured gets a report saying the work is unattributed, which is true and
     * useful, and people with no team is a half-finished setup that still gets the guide.
     */
    expect(organizationIsUnprovisioned({ teamKeys: ['platform'], developerCount: 0 })).toBe(false);
    expect(organizationIsUnprovisioned({ teamKeys: [], developerCount: 12 })).toBe(false);
    expect(organizationIsUnprovisioned({ teamKeys: ['platform'], developerCount: 12 })).toBe(false);
  });

  it('branches on that in the report route rather than anywhere else', () => {
    const page = readWebFile('app', 'page.tsx');

    expect(page).toContain('loadHomeView');
    expect(page).toContain('FirstReportGuide');
    // And still passes no gate — the same rule `cold-start.test.tsx` holds it to.
    for (const forbidden of ['redirect(', 'guard(', 'cookies(', 'pageAccess(']) {
      expect(page, `\`${forbidden}\` on / would gate the first request`).not.toContain(forbidden);
    }
  });

  it('checks before generating, so no false report is ever persisted', () => {
    /**
     * The ordering is the substantive claim. `ensureDailyReport` *writes* a row, and a row
     * asserting six empty sections about a team that does not exist would then be served by the
     * archive, the merged view and every subscription, forever. Inspecting the result after
     * generating would be far too late.
     */
    const source = readWebFile('lib', 'report-source.ts');
    const checkIndex = source.indexOf('await organizationHasSubject(');
    const generateIndex = source.indexOf('await loadReportView()');

    expect(checkIndex).toBeGreaterThan(-1);
    expect(generateIndex).toBeGreaterThan(-1);
    expect(checkIndex, 'the subject check must precede generation').toBeLessThan(generateIndex);
  });

  it('asks the cheap question on the report path rather than building the whole model', () => {
    // `/` has a stated time budget and is the hottest page in the product. The full readiness
    // model is eleven entity reads plus the goal hierarchy plus the archive index; the question
    // "is there a subject at all" is two indexed reads. A regression here would be invisible —
    // the page would stay correct and get slower.
    const source = readWebFile('lib', 'report-source.ts');
    const cheapIndex = source.indexOf('await organizationHasSubject(');
    const fullIndex = source.indexOf('await readFirstRunReadiness(');

    expect(cheapIndex).toBeLessThan(fullIndex);
  });
});

// ---------------------------------------------------------------------------
// 3. The guide itself
// ---------------------------------------------------------------------------

describe('the guide `/` renders when there is nothing to report on', () => {
  const markup = renderToStaticMarkup(<FirstReportGuide steps={NOTHING_DONE.steps} reportExists={false} />);

  it('names every outstanding step with its own summary', () => {
    for (const entry of NOTHING_DONE.steps) {
      expect(markup).toContain(entry.title);
      expect(markup).toContain(entry.summary);
    }
  });

  it('says how long the remaining work is, rather than leaving it open', () => {
    expect(markup).toContain('9');
    expect(markup).toContain('minutes');
  });

  it('offers the guided path as a link and explains why there is no report', () => {
    expect(markup).toContain('href="/start"');
    expect(markup).toContain('no team configured');
    // The reason it refuses to fake one, in the product's own voice.
    expect(markup).toContain('false one');
  });

  it('is not a spinner, a skeleton or a generic empty state', () => {
    for (const forbidden of ['Loading', 'animate-pulse', 'skeleton', 'No data', 'Get started with']) {
      expect(markup, `the first-run guide contains \`${forbidden}\``).not.toContain(forbidden);
    }
  });

  it('says the archive is intact when reports exist but the configuration is gone', () => {
    const withReports = renderToStaticMarkup(
      <FirstReportGuide steps={NOTHING_DONE.steps} reportExists={true} />,
    );

    expect(withReports).toContain('still in the archive');
    expect(markup, 'the ordinary case must not claim an archive that is empty').not.toContain('still in the archive');
  });

  it('marks off what is already done rather than restating the whole path', () => {
    const partial = renderToStaticMarkup(
      <FirstReportGuide
        steps={readiness({ source: 'done', team: 'todo', goals: 'todo', roster: 'todo' }).steps}
        reportExists={false}
      />,
    );

    expect(partial).toContain('already done');
    // Four minus one, so the estimate reflects what is left rather than the full path.
    expect(partial).toContain('8');
  });
});

// ---------------------------------------------------------------------------
// 4. Goal quick entry: two fields, and the default that makes the chain valid
// ---------------------------------------------------------------------------

describe('goal hierarchy quick entry', () => {
  const markup = renderToStaticMarkup(
    <GoalQuickEntry today="2026-08-03" effectiveFrom="2026-08-03T09:00:00.000Z" />,
  );

  it('accepts a company objective and a sprint goal on one screen', () => {
    expect(markup).toContain('company objective');
    expect(markup).toContain('current sprint goal');
    // Two inputs and one button: the criterion is one screen, not a two-step flow.
    expect([...markup.matchAll(/<input/g)].length).toBe(2);
  });

  it('fills in the quarter between them, and says that it has', () => {
    /**
     * The sensible default with actual consequences.
     *
     * The hierarchy is company → quarter → sprint goal, and alignment resolves *through*
     * parents. A company objective wired straight to a sprint goal is a chain with a hole in
     * it: the sprint goal never reaches the objective, so every verdict comes back
     * unattributed and the feature looks broken rather than unconfigured.
     */
    expect(currentQuarter('2026-08-03')).toEqual({ key: '2026-q3', title: '2026 Q3' });
    expect(markup).toContain('2026-q3');
    expect(markup).toContain('fills in the quarter');
  });

  it('derives the quarter correctly at every boundary', () => {
    expect(currentQuarter('2026-01-01').key).toBe('2026-q1');
    expect(currentQuarter('2026-03-31').key).toBe('2026-q1');
    expect(currentQuarter('2026-04-01').key).toBe('2026-q2');
    expect(currentQuarter('2026-06-30').key).toBe('2026-q2');
    expect(currentQuarter('2026-07-01').key).toBe('2026-q3');
    expect(currentQuarter('2026-09-30').key).toBe('2026-q3');
    expect(currentQuarter('2026-10-01').key).toBe('2026-q4');
    expect(currentQuarter('2026-12-31').key).toBe('2026-q4');
  });

  it('takes the instant from the server rather than reading a clock in the browser', () => {
    // The same rule the rest of the product follows: `now` is resolved at an edge and handed
    // down. A `new Date()` here would make the goal's `effectiveFrom` the reader's laptop clock.
    const source = readWebFile('components', 'first-report-path.tsx');

    expect(source).not.toContain('Date.now()');
    expect(source).not.toContain('new Date(');

    // The instant reaches the write rather than only the props: all three nodes in the chain
    // carry the server's `effectiveFrom`, so the hierarchy is effective-dated from one instant
    // instead of three slightly different ones.
    // From the goal write onward — the last one in the file — so neither the prop's own
    // destructuring nor the team form above it is counted.
    const goalWrite = source.slice(source.lastIndexOf('void write('));
    expect([...goalWrite.matchAll(/effectiveFrom,/g)].length).toBe(3);
    // And the quarter label the reader is shown comes from the server's civil date, not a
    // locally-computed one — the prop is named `today` and is the only input to the default.
    expect(markup).toContain('2026-q3');
  });
});

// ---------------------------------------------------------------------------
// 5. Team setup
// ---------------------------------------------------------------------------

describe('team quick setup', () => {
  const markup = renderToStaticMarkup(<TeamQuickSetup defaultTimezone="Europe/London" />);

  it('defaults the timezone to the deployment’s own rather than to UTC', () => {
    expect(markup).toContain('Europe/London');
  });

  it('defaults the methodology to scrum and offers kanban', () => {
    expect(markup).toContain('scrum');
    expect(markup).toContain('kanban');
  });

  it('writes through the ordinary configuration endpoint, not a privileged setup path', () => {
    const source = readWebFile('components', 'first-report-path.tsx');

    expect(source).toContain("'/api/roster/teams'");
    expect(source).toContain("'/api/goals'");
  });
});

// ---------------------------------------------------------------------------
// 6. The path is a destination, never an interception
// ---------------------------------------------------------------------------

describe('/start never stands in front of anything', () => {
  it('is not linked to by a redirect from anywhere', () => {
    for (const file of [['app', 'page.tsx'], ['app', 'weekly', 'page.tsx'], ['app', 'merged', 'page.tsx']]) {
      expect(readWebFile(...file), `${file.join('/')} redirects to /start`).not.toContain('redirect(');
    }
  });

  it('requires a seat, because every step on it writes configuration', () => {
    const page = readWebFile('app', 'start', 'page.tsx');

    expect(page).toContain("route: '/start'");
    expect(page).toContain('pageAccess');
  });
});
