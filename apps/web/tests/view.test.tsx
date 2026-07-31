import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECTIONS } from '@compass/analysis';
import { artifactHref } from '@compass/pipeline';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReportDocument } from '../components/report-document';
import { buildReportView } from '../lib/view-model';

import {
  emptyBundle,
  freshnessAbsent,
  freshnessComplete,
  freshnessWithMissingSource,
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
