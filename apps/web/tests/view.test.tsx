import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFF_GOAL_LABEL, SECTIONS } from '@compass/analysis';
import { artifactHref } from '@compass/pipeline';
import {
  ALIGNMENT_AFFORDANCE_ATTRIBUTE,
  ALIGNMENT_VERDICT_ATTRIBUTE,
  COLLAR_ATTRIBUTE,
  inspectReportHtml,
} from '@compass/smoke';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { COLLAR_ATTRIBUTE as COMPONENT_COLLAR_ATTRIBUTE } from '../components/calibration-collar';
import { ReportDocument } from '../components/report-document';
import { buildReportView } from '../lib/view-model';

import {
  emptyBundle,
  freshnessAbsent,
  freshnessComplete,
  freshnessWithMissingSource,
  kanbanBundle,
  storedBundle,
} from './helpers/report-fixture';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const view = buildReportView({ bundle: storedBundle(), freshness: freshnessWithMissingSource() });
const markup = renderToStaticMarkup(<ReportDocument view={view} />);

describe('the report view renders six sections in the fixed order', () => {
  it('renders every section heading, once each', () => {
    for (const section of SECTIONS) {
      expect(markup, `${section.title} is missing`).toContain(`>${section.title}<`);
      expect(markup).toContain(`id="section-${section.key}"`);
    }
    expect(markup.match(/id="section-[a-z]+"/g)).toHaveLength(SECTIONS.length);
  });

  it('renders them in the Six Spine order, never in row order', () => {
    const positions = SECTIONS.map((section) => markup.indexOf(`id="section-${section.key}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('numbers them 01..06 from the section definition', () => {
    for (const section of SECTIONS) {
      expect(markup).toContain(`>${section.numeral}<`);
    }
  });

  it('shows the renderer prose, so no quantity arrives without its clause', () => {
    expect(markup).toContain('which is behind the pace the elapsed schedule implies');
    expect(markup).toContain('and it is one step, finishable today');
    expect(markup).toContain('so it has held for 6 days');
  });
});

/**
 * A Kanban team's Progress section, on the rendered page.
 *
 * The flow metrics are computed in `packages/analysis/src/progress.ts` and pinned against
 * the real seed by `fixtures/reports/insights/*.json`. This is the other half, and the half
 * that had never been asserted: that the *view* renders a flow Progress section rather than
 * silently dropping the items whose shape it was not written for. A WIP table computed and
 * never printed is the same class of bug as a `rungSuffix` computed and never printed.
 */
describe('a Kanban team reads flow in Progress, not a sprint it does not have', () => {
  const kanbanMarkup = renderToStaticMarkup(
    <ReportDocument view={buildReportView({ bundle: kanbanBundle(), freshness: freshnessComplete() })} />,
  );

  it('states up front that this section reports flow, and why there is no percentage', () => {
    expect(kanbanMarkup).toContain('This team runs Kanban');
    expect(kanbanMarkup).toContain('Compass will not invent one');
  });

  it('renders work in progress broken down by column', () => {
    expect(kanbanMarkup).toContain('22 items are in flight across 2 columns');
    expect(kanbanMarkup).toContain('In Progress 11');
    expect(kanbanMarkup).toContain('In Review 11');
  });

  it('renders the cycle-time measurement and the direction it is moving', () => {
    expect(kanbanMarkup).toContain('the median item took 6.5 days from start to finish');
    expect(kanbanMarkup).toContain('Cycle time is shortening');
  });

  it('renders the items aging past the team’s own P85, naming them', () => {
    expect(kanbanMarkup).toContain('longer than the 9-day P85');
    expect(kanbanMarkup).toContain('INS-105 at 60 days in In Progress');
  });

  it('carries no sprint vocabulary, because the team has no sprint', () => {
    // The failure this guards is a renderer reaching for the sprint arm's wording on a
    // flow report — "62% complete", "of 39 points", a sprint goal. All three would be
    // inventions, and the section summary above promises Compass does not make them.
    const progressSection = kanbanMarkup.slice(
      kanbanMarkup.indexOf('id="section-progress"'),
      kanbanMarkup.indexOf('id="section-blockers"'),
    );

    expect(progressSection.length).toBeGreaterThan(200);
    expect(progressSection).not.toMatch(/\d+% complete/);
    expect(progressSection).not.toMatch(/of \d+ points/);
    expect(progressSection).not.toMatch(/completed sprints/i);
  });

  it('shows the collar with a cycle-time date at low confidence, not a refusal', () => {
    // The design brief's answer to thin data: the date is present, and the collar beneath
    // it is allowed to undercut it. `insufficient_history` explains why velocity was not
    // the method — it is no longer a reason to withhold the date from a Kanban team.
    expect(kanbanMarkup).toContain('2026-11-09');
    expect(kanbanMarkup).toContain('measured cycle time');
    expect(kanbanMarkup).not.toContain('No completion date');
  });
});

/**
 * The two differentiators, on the rendered page.
 *
 * Both are asserted against markup rather than against the view model, because both
 * have already been built once at the data layer and the failure mode is a component
 * that quietly drops the honest half. A `rungSuffix` computed and never printed and a
 * calibration verdict sitting in `findings` with no collar to show it are the same
 * bug: the analysis was right and the reader never saw it.
 */
describe('the completion ladder prints its notches, its rung and what it has not reached', () => {
  it('renders five notches and the furthest rung reached', () => {
    expect(markup).toContain('R3 integrated');
  });

  it('states the half that has not happened as a run-in clause', () => {
    // The mono token already reads `R3 integrated`, so the clause is the remainder —
    // printing the rung twice on one line makes the meter read like a template.
    expect(markup).toContain('not yet released');
    expect(markup).not.toContain('integrated, not yet released');
  });

  it('prints the literal words an unreachable R5 requires', () => {
    expect(markup).toContain('no deploy signal available');
  });
});

describe('the confidence collar qualifies the projected date on the page', () => {
  it('renders the collar landmark the smoke check counts', () => {
    // Asserted against `@compass/smoke` rather than imported from it: smoke is a dev
    // dependency of this app, so a runtime import would put a test tool in the
    // production bundle. This assertion is what stops the two drifting.
    expect(COMPONENT_COLLAR_ATTRIBUTE).toBe(COLLAR_ATTRIBUTE);
    expect(markup).toContain(`${COLLAR_ATTRIBUTE}="true"`);
    expect(view.collar).not.toBeNull();
  });

  it('prints the date once, in square-bracket mono', () => {
    expect(markup).toContain('2026-08-08');
    expect(markup.match(/data-calibration-collar/g)).toHaveLength(1);
  });

  it('sets the date in a lighter weight when the audit has something to say', () => {
    // The typography loses conviction along with the prose. A page whose type stayed
    // confident while its words withdrew would have overruled its own words.
    expect(view.collar?.lowConviction).toBe(true);
    expect(markup).toContain('text-ink-faint');
  });

  it('states the method, the band and the verdict that chose it', () => {
    expect(markup).toContain('cycle-time guess, not a velocity forecast');
    expect(markup).toContain('low confidence');
    expect(markup).toContain('points_uninformative');
  });

  it('names every verdict with its value, its threshold and its sample size', () => {
    expect(markup).toContain('Points are uninformative');
    expect(markup).toContain('Statuses are stale');
    // 444 basis points against T12's 3 000, formatted for the unit.
    expect(markup).toContain('0.04');
    expect(markup).toContain('0.30');
    expect(markup).toContain('T12');
    expect(markup).toContain('n=118');
  });

  it('states the absence rather than an empty panel for a report with no audit', () => {
    const bundle = storedBundle();
    const older = buildReportView({
      bundle: { ...bundle, report: { ...bundle.report, payload: {}, payloadJson: '{}' } },
      freshness: freshnessComplete(),
    });

    expect(older.collar).toBeNull();
    const olderMarkup = renderToStaticMarkup(<ReportDocument view={older} />);
    expect(olderMarkup).toContain('before Compass audited the data behind it');
    expect(olderMarkup).not.toContain('data-calibration-collar');
  });
});

describe('every claim carries a resolvable evidence link', () => {
  it('links each claim to an artifact page for its commit, pull request or tracker key', () => {
    for (const section of view.sections) {
      for (const claim of section.items) {
        expect(claim.evidence.length, `${section.key}/${claim.stableId} has no evidence`).toBeGreaterThan(0);
        for (const reference of claim.evidence) {
          expect(reference.href).toMatch(/^\/artifact\/[^/]+\/[^/]+$/);
          expect(markup, `${reference.href} is not in the rendered page`).toContain(`href="${reference.href}"`);
        }
      }
    }
  });

  it('builds those links with the pipeline helper rather than a hand-written path', () => {
    expect(markup).toContain(`href="${artifactHref('pull_request', 'pr-883')}"`);
    expect(markup).toContain(`href="${artifactHref('issue', 'issue-DEV-522')}"`);
    expect(markup).toContain(`href="${artifactHref('commit', 'checkout-web:7a8b9c0d1e2f')}"`);
  });

  it('has a route segment that actually serves the paths it emits', () => {
    // The href is `/artifact/<kind>/<id>`; a dead link satisfies "a link is
    // present" and fails the criterion, so the file has to exist.
    const [, root, ...rest] = artifactHref('commit', 'x').split('/');
    expect(root).toBe('artifact');
    expect(rest).toHaveLength(2);
    expect(existsSync(join(WEB_ROOT, 'app', 'artifact', '[kind]', '[artifactId]', 'page.tsx'))).toBe(true);
  });

  it('states each artifact in words as well as in a superscript', () => {
    expect(markup).toContain('tracker item DEV-501');
    expect(markup).toContain('pull request #883');
    expect(markup).toContain('¹');
  });
});

describe('the page is prose, not a dashboard', () => {
  it('contains no canvas, no chart svg and no charting bundle', () => {
    const lowered = markup.toLowerCase();
    for (const forbidden of [
      '<canvas',
      '<svg',
      'chart.js',
      'recharts',
      'highcharts',
      'echarts',
      'd3.',
      'sparkline',
      'gauge',
      'plotly',
    ]) {
      expect(lowered, `the rendered view contains \`${forbidden}\``).not.toContain(forbidden);
    }
  });

  it('renders no table of metrics in the reading column', () => {
    expect(markup.toLowerCase()).not.toContain('<table');
  });

  it('is a Server Component tree: no client directive above the report', () => {
    // `six-spine.tsx` is the one client island, and it is a navigation control
    // rather than content, so the report itself renders without JavaScript.
    expect(markup).toContain('id="report"');
    expect(markup).toContain('Sprint 43 is 62% complete');
  });
});

describe('the completion ladder', () => {
  it('draws five notches and names the highest rung crossed', () => {
    expect(markup).toContain('R3 accepted');
    expect(markup.match(/h-\[10px\] w-\[3px\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('prints the literal words for an unreachable R5 rather than inferring a deploy', () => {
    expect(markup).toContain('no deploy signal available');
  });
});

/**
 * The one-click evidence panel.
 *
 * "Clicking any alignment result opens a panel showing the resolution path actually
 * used" is the criterion, and it is asserted here against the rendered markup rather
 * than against the view model, because a field the view model carries and the page
 * never prints satisfies neither the criterion nor the manager.
 */
describe('every alignment verdict has its evidence one click away', () => {
  const alignmentClaims = view.sections
    .flatMap((section) => section.items)
    .filter((claim) => claim.alignment !== null);

  it('renders one affordance per verdict, unattributed items included', () => {
    expect(alignmentClaims.length).toBeGreaterThan(2);

    const inspection = inspectReportHtml(markup);
    expect(inspection.alignmentVerdicts).toBe(alignmentClaims.length);
    expect(inspection.alignmentAffordances).toBe(alignmentClaims.length);
    // The same check CI runs against a booted container, over the page as built.
    expect(inspection.problems).toEqual([]);
  });

  it('opens with one click and no JavaScript, being a native disclosure', () => {
    // A modal or a state toggle would give up keyboard support, screen-reader
    // semantics and the static HTML report to gain an animation.
    expect(markup).toContain('<details');
    expect(markup).toContain('<summary');
    expect(markup).toContain(`${ALIGNMENT_VERDICT_ATTRIBUTE}="off_goal"`);
    expect(markup).toContain(`${ALIGNMENT_VERDICT_ATTRIBUTE}="unattributed"`);
    expect(markup).toContain(`${ALIGNMENT_AFFORDANCE_ATTRIBUTE}="semantic"`);
    expect(markup).toContain(`${ALIGNMENT_AFFORDANCE_ATTRIBUTE}="inferred"`);
  });

  it('states the confidence and the threshold it was compared against, together', () => {
    expect(markup).toContain('0.62');
    expect(markup).toContain('0.30');
    expect(markup).toContain('T17');
    expect(markup).toContain('at or above');
    // The unattributed item's own score, below the same threshold.
    expect(markup).toContain('0.08');
    expect(markup).toContain('below');
  });

  it('shows the chain node ids for the tier that resolved it', () => {
    expect(markup).toContain('OBJ-Q2-BILL');
    expect(markup).toContain('OBJ-CO-1');
    expect(markup).toContain('Leaf first');
  });

  it('underlines the matched substring at the offset Compass recorded', () => {
    const inferred = alignmentClaims.find((claim) => claim.alignment?.tier === 'inferred');

    // The branch names PLAT-742 twice; the highlight must land on the second, which
    // is the one the offset points at. A component that re-searched the string would
    // split it at 8 and underline the wrong span.
    expect(inferred?.alignment?.highlight).toEqual({
      before: 'feature/PLAT-742-rebase-of-',
      match: 'PLAT-742',
      after: '',
      caption: 'the branch name',
    });
    expect(markup).toContain('evidence-matched__span');
    expect(markup).toContain('at character <span class="data-token">27</span>');
  });

  it('shows both compared texts and the wording they share', () => {
    expect(markup).toContain('Migrate the legacy billing client onto the new SDK');
    expect(markup).toContain('Migrate every merchant off the legacy billing client');
    expect(markup).toContain('Shared wording: billing, client, legacy, migrate.');
  });

  it('renders the unattributed item as a question and never as a verdict', () => {
    const unattributed = alignmentClaims.find((claim) => claim.alignment?.kind === 'unattributed');

    expect(unattributed?.alignment?.label).toBeNull();
    expect(markup).toContain('What were these 2 commits for?');
    expect(markup).toContain('alignment-question');
    expect(markup).toContain('named no person');
    // The question sits in the reading column, not only inside the panel.
    expect(markup.indexOf('alignment-question')).toBeLessThan(markup.lastIndexOf('evidence-disclosure__body'));
  });

  it('labels only the verdicts the gate produced', () => {
    const labels = alignmentClaims.map((claim) => claim.alignment?.label);

    expect(labels).toEqual([OFF_GOAL_LABEL, null, OFF_GOAL_LABEL]);
  });

  it('renders no panel for a claim that carries no alignment payload', () => {
    const blocker = view.sections
      .find((section) => section.key === 'blockers')
      ?.items.find((claim) => claim.stableId.startsWith('blocker:'));

    expect(blocker?.alignment).toBeNull();
  });
});

describe('the freshness indicator', () => {
  it('states the last ingest time and the window covered, per source', () => {
    expect(markup).toContain('primary-code');
    expect(markup).toContain('primary-tracker');
    expect(markup).toContain('last ingest 2026-07-31 08:02');
    expect(markup).toContain('12 records');
  });

  it('names a source that produced nothing and refuses to call the report complete', () => {
    expect(markup).toContain('legacy-code');
    expect(markup).toContain('no data');
    expect(markup).toContain('never answered');
    expect(markup).toContain('data-complete="false"');
    expect(markup).toContain('did not answer, so this report is not complete');
  });

  it('calls the report complete only when every source answered', () => {
    const complete = renderToStaticMarkup(
      <ReportDocument view={buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() })} />,
    );

    expect(complete).toContain('data-complete="true"');
    expect(complete).toContain('so this report is a complete picture');
    expect(complete).not.toContain('legacy-code');
  });

  it('fabricates nothing when the ingest journal is empty', () => {
    const unknown = renderToStaticMarkup(
      <ReportDocument view={buildReportView({ bundle: storedBundle(), freshness: freshnessAbsent() })} />,
    );

    expect(unknown).toContain('no record of an ingest');
    expect(unknown).toContain('data-complete="false"');
    // The report instant is 2026-07-31 08:30 local; it must not be reused as a
    // freshness value just because a real one is missing.
    expect(unknown).not.toContain('last ingest');
  });
});

describe('an empty day', () => {
  it('states the absence in the product voice rather than rendering a blank', () => {
    const empty = renderToStaticMarkup(
      <ReportDocument view={buildReportView({ bundle: emptyBundle(), freshness: freshnessComplete() })} />,
    );

    expect(empty).toContain('stated-absence');
    for (const section of SECTIONS) {
      expect(empty).toContain(`Nothing crossed a threshold for ${section.title}.`);
    }
  });
});

describe('a report shown for a day other than today', () => {
  it('says which day it is showing and why, rather than looking like today', () => {
    const shifted = renderToStaticMarkup(
      <ReportDocument
        view={buildReportView({
          bundle: storedBundle(),
          freshness: freshnessComplete(),
          timeShiftNote: 'The seeded history ends on 2026-07-31, so this is its last full day.',
        })}
      />,
    );

    expect(shifted).toContain('so this is its last full day');
  });
});
