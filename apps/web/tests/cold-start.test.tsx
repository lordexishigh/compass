import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECTIONS } from '@compass/analysis';
import { assertColdStartHtml, inspectReportHtml } from '@compass/smoke';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReportDocument } from '../components/report-document';
import { buildReportView } from '../lib/view-model';

import { emptyBundle, freshnessComplete, freshnessWithMissingSource, storedBundle } from './helpers/report-fixture';

/**
 * The zero-config criterion, asserted against the page that will serve it.
 *
 * The CI smoke test boots a clean container and runs `assertColdStartHtml` over the
 * live response from `/`. This runs the *same function* over the markup the real
 * `ReportDocument` produces. That pairing is the point: without it the smoke test
 * could be green while checking the wrong thing, or red on a page that is in fact
 * correct, and nobody would know which until they read the workflow file.
 *
 * The other half of the criterion — no authentication redirect, no setup wizard, no
 * empty state on the first request — is a claim about the *route*, so it is checked
 * by reading the route: a page with no auth gate is a page with nothing in it that
 * could redirect, and that is a property of the source, not of one response.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readWebFile = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), 'utf8');

/**
 * The file's code with its comments removed.
 *
 * These assertions are about what the route *does*, and every file on the report
 * path explains in prose why it does not gate the request — `page.tsx` says the
 * words "use client" in order to say it has none. Scanning the raw text would fail
 * on the documentation and pass on a file that said nothing.
 */
const codeOf = (...parts: string[]): string =>
  readWebFile(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const view = buildReportView({ bundle: storedBundle(), freshness: freshnessWithMissingSource() });
const markup = renderToStaticMarkup(<ReportDocument view={view} />);

describe('the checks CI runs against a container pass against the real page', () => {
  it('renders a page the cold-start smoke test accepts', () => {
    const inspection = assertColdStartHtml(markup, 'the rendered ReportDocument');

    expect(inspection.problems).toEqual([]);
    expect(inspection.headingsFound).toEqual(SECTIONS.map((section) => section.title));
    expect(inspection.sectionsNotRendered).toEqual([]);
  });

  it('gives the smoke test more than one source link to find', () => {
    // "At least one source link" is the criterion; a report whose only link were
    // incidental would satisfy it while telling a manager nothing.
    const { sourceLinks } = inspectReportHtml(markup);

    expect(sourceLinks.length).toBeGreaterThan(1);
    for (const link of sourceLinks) {
      // A bare path the smoke test can resolve against the page URL and follow.
      expect(link).toMatch(/^\/artifact\/[^/]+\/[^/"]+$/);
      expect(markup).toContain(`href="${link}"`);
    }
  });

  it('still passes when a source is missing, because the report degrades rather than emptying', () => {
    // The seeded dataset has a rate-limited source on purpose. A cold start must
    // still deliver six sections and links; it says what is missing in prose.
    expect(() => assertColdStartHtml(markup)).not.toThrow();
    expect(markup).toContain('data-complete="false"');
  });

  it('accepts a complete-coverage report too, so the check is not passing by accident', () => {
    const complete = renderToStaticMarkup(
      <ReportDocument view={buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() })} />,
    );

    expect(() => assertColdStartHtml(complete)).not.toThrow();
  });
});

describe('a genuinely empty day is still six sections, never an empty state', () => {
  const empty = renderToStaticMarkup(
    <ReportDocument view={buildReportView({ bundle: emptyBundle(), freshness: freshnessComplete() })} />,
  );
  const inspection = inspectReportHtml(empty);

  it('renders all six headings and all six sections', () => {
    expect(inspection.headingsMissing).toEqual([]);
    expect(inspection.sectionsNotRendered).toEqual([]);
  });

  it('states the absence in the product voice rather than tripping an empty-state check', () => {
    // The only complaint an empty day may draw is the absent source link — there
    // is genuinely nothing to link to. Any *other* problem would mean the page had
    // fallen back to a generic empty state, which the product never shows.
    expect(inspection.problems).toEqual([
      'No claim on the page links to an artifact page, so nothing in the report can be checked against its source.',
    ]);
    expect(empty).toContain('stated-absence');
  });
});

describe('the first request to / passes no gate', () => {
  const page = codeOf('app', 'page.tsx');

  it('is a Server Component: no client directive on the route', () => {
    expect(page).not.toContain("'use client'");
    expect(page).not.toContain('"use client"');
  });

  it('is a Server Component all the way down: no client island renders the report', () => {
    // The one client component in the tree is the Six Spine, which is navigation
    // rather than content — so the prose renders with JavaScript switched off.
    for (const file of ['components/report-document.tsx', 'components/report-section.tsx']) {
      expect(codeOf(...file.split('/')), `${file} must stay a Server Component`).not.toContain('use client');
    }
  });

  it('holds no redirect, no auth check and no session lookup', () => {
    for (const forbidden of ['redirect(', 'notFound(', 'getSession', 'requireUser', 'auth(', 'signIn', 'cookies(']) {
      expect(page, `\`${forbidden}\` on / would gate the first request`).not.toContain(forbidden);
    }
  });

  it('has no middleware that could redirect the first request', () => {
    // Next.js middleware is the one thing that can gate `/` without appearing in
    // `page.tsx`, so its absence is asserted rather than assumed.
    for (const candidate of ['middleware.ts', 'middleware.tsx', 'middleware.js', join('app', 'middleware.ts')]) {
      expect(existsSync(join(WEB_ROOT, candidate)), `${candidate} exists and could gate /`).toBe(false);
    }
  });

  it('serves / and nothing else as the report route: no /login, /setup or /onboarding', () => {
    const routes = readdirSync(join(WEB_ROOT, 'app'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const gate of ['login', 'signin', 'sign-in', 'setup', 'onboarding', 'connect', 'welcome']) {
      expect(routes, `app/${gate} would be a gate on the way to the report`).not.toContain(gate);
    }
  });

  it('reads its data on the server, with no client-side fetch on the report path', () => {
    for (const file of ['app/page.tsx', 'components/report-document.tsx', 'components/report-section.tsx']) {
      const source = codeOf(...file.split('/'));
      expect(source, `${file} must not fetch on the client`).not.toContain('useEffect');
      expect(source, `${file} must not fetch on the client`).not.toContain('fetch(');
    }
  });
});

describe('the report is readable on a 375px viewport', () => {
  const document_ = readWebFile('components', 'report-document.tsx');
  const spine = readWebFile('components', 'six-spine.tsx');

  it('lays out as one column by default and only widens at a breakpoint', () => {
    expect(document_).toContain('grid-cols-1');
    // The rail and the evidence gutter are `lg:` only, so a phone gets the prose.
    expect(document_).toMatch(/lg:grid-cols-\[/);
    expect(document_).toContain('lg:block');
  });

  it('collapses the Six Spine to a 44px sticky strip with the same six counts', () => {
    expect(spine).toContain('h-11');
    expect(spine).toContain('lg:hidden');
    expect(spine).toContain('hidden lg:sticky');
  });

  it('sets no fixed width or minimum wider than 375px anywhere on the report path', () => {
    const widths: string[] = [];
    for (const file of [
      'components/report-document.tsx',
      'components/report-section.tsx',
      'components/six-spine.tsx',
      'components/freshness-panel.tsx',
      'components/completion-ladder.tsx',
      'components/evidence-markers.tsx',
    ]) {
      const source = readWebFile(...file.split('/'));
      for (const match of source.matchAll(/\b(?:min-w|w)-\[(\d+)px\]/g)) {
        if (Number.parseInt(match[1] ?? '0', 10) > 375) widths.push(`${file}: ${match[0]}`);
      }
    }

    expect(widths, 'these would force a horizontal scroll on a phone').toEqual([]);
  });

  it('renders the prose in a measure token rather than an unbounded line', () => {
    // 66ch on `.prose-narration`, plus a max-width on the grid — the reading
    // column is bounded by a token, so it cannot be widened per component.
    const styles = readWebFile('app', 'globals.css');

    expect(styles).toContain('--measure:');
    expect(styles).toContain('max-width: 66ch');
    expect(document_).toContain('var(--measure)');
  });
});
