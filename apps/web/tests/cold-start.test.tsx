import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECTIONS } from '@compass/analysis';
import { assertColdStartHtml, inspectReportHtml } from '@compass/smoke';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReportDocument } from '../components/report-document';
import { TimeTravelScrubber } from '../components/time-travel-scrubber';
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
    for (const file of [
      'components/report-document.tsx',
      'components/report-section.tsx',
      // The evidence panel is a native `<details>` for exactly this reason: one
      // click has to open it with JavaScript switched off.
      'components/alignment-evidence.tsx',
    ]) {
      expect(codeOf(...file.split('/')), `${file} must stay a Server Component`).not.toContain('use client');
    }
  });

  it('holds no redirect, no auth check and no session lookup', () => {
    for (const forbidden of ['redirect(', 'notFound(', 'getSession', 'requireUser', 'auth(', 'signIn', 'cookies(']) {
      expect(page, `\`${forbidden}\` on / would gate the first request`).not.toContain(forbidden);
    }
  });

  /**
   * The middleware cannot gate the first request.
   *
   * ## What this assertion used to say, and why it changed
   *
   * It used to say *no middleware file exists*. That was the right rule for as long as there was
   * nothing a middleware was needed for: middleware runs before `/`, so an authorization check
   * there would need an exception for the zero-config report — an exception in the one layer no
   * test can see the inside of — and Argon2id cannot load on the Edge runtime.
   *
   * Then `beta-security-hardening` needed a per-response CSP nonce, which has no other home:
   * `next.config.ts`'s `headers()` is evaluated once at build time and cannot vary per response,
   * and a `<meta>` CSP is ignored for `frame-ancestors`. So the file exists.
   *
   * The rule it replaces is the *property* the old one was standing in for, asserted directly: the
   * middleware has no database, no session lookup, no redirect, no rewrite, and no branch on the
   * path at all. A file that cannot decide anything cannot gate `/`, and that is now checked rather
   * than inferred from the file's absence.
   */
  it('has a middleware that sets headers and cannot gate anything', () => {
    const middlewarePath = join(WEB_ROOT, 'middleware.ts');
    expect(existsSync(middlewarePath), 'the security headers have to come from somewhere').toBe(true);

    // No other spelling of it, so there is exactly one file with this power.
    for (const candidate of ['middleware.tsx', 'middleware.js', join('app', 'middleware.ts')]) {
      expect(existsSync(join(WEB_ROOT, candidate)), `${candidate} is a second middleware`).toBe(false);
    }

    const source = codeOf('middleware.ts');

    for (const forbidden of [
      'redirect',
      'rewrite',
      'NextResponse.json',
      'getSession',
      'resolveIdentity',
      'authorize',
      'guard',
      'cookies',
      'database',
      // A branch on the path is how an exception for `/` would be written.
      'pathname',
    ]) {
      expect(source, `\`${forbidden}\` in middleware could gate the first request`).not.toContain(forbidden);
    }

    // `NextResponse.next()` on every request, unconditionally — the only exit it has.
    expect(source).toContain('NextResponse.next(');
    expect(source).not.toContain('if (');
  });

  it('lets its matcher cover `/`, which is safe only because it cannot gate', () => {
    // Stated as a pair on purpose. Matching `/` is what gives the report its CSP; it is harmless
    // only in combination with the assertion above, and reading them together is the point.
    const source = readWebFile('middleware.ts');
    const matcher = /matcher: \[\s*'([^']+)'/.exec(source)?.[1];

    expect(matcher, 'the middleware must declare which paths it runs on').toBeDefined();
    expect(new RegExp(`^${matcher!}$`).test('/'), '`/` must receive the security headers').toBe(true);
  });

  it('serves / as the report route, with no setup or onboarding screen in front of it', () => {
    /**
     * No *screen* may stand between a cold container and the report.
     *
     * This used to forbid the `app/login` directory outright. `/login` now exists as the
     * short POST address published in `.nous/demo_account.json` for a verification harness,
     * and the rule is asserted where it actually lives instead: it must be a `route.ts` with
     * no `page.tsx`, so it cannot grow a form and become a wall. Its GET is a 303 to
     * `/account`.
     *
     * The guided first-report path is at `/start`, which is a screen a reader *chooses* from
     * a report that has explained why it is empty. It is not on this list because it is not
     * an interception — and `/` cannot redirect to it, having no `redirect(` at all, which
     * the assertion above pins.
     *
     * `app/connect` is the same shape and came off the list for the same reason: an owner-only
     * screen that says in its own opening paragraph that nothing on it is required to read a
     * report. The zero-config promise is broken by a *wizard in the way*, not by a page an
     * owner can choose to open, so what is asserted here is that nothing in front of the
     * report names it.
     */
    const routes = readdirSync(join(WEB_ROOT, 'app'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const gate of ['signin', 'sign-in', 'setup', 'onboarding', 'welcome']) {
      expect(routes, `app/${gate} would be a gate on the way to the report`).not.toContain(gate);
    }

    for (const file of ['app/page.tsx', 'app/layout.tsx', 'middleware.ts']) {
      expect(
        codeOf(...file.split('/')),
        `${file} names /connect, which would put a connector screen in front of the report`,
      ).not.toContain('/connect');
    }

    expect(existsSync(join(WEB_ROOT, 'app', 'login', 'route.ts'))).toBe(true);
    expect(
      existsSync(join(WEB_ROOT, 'app', 'login', 'page.tsx')),
      'app/login/page.tsx would be a sign-in wall on the way to the report',
    ).toBe(false);
  });

  it('reads its data on the server, with no client-side fetch on the report path', () => {
    for (const file of [
      'app/page.tsx',
      'components/report-document.tsx',
      'components/report-section.tsx',
      'components/alignment-evidence.tsx',
    ]) {
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
      'components/alignment-evidence.tsx',
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

/**
 * The date control is on the report page.
 *
 * The blueprint states the criterion as a location, not as a capability: *"A date control on the
 * report page; stepping from sprint day 6 to day 11 produces five distinct stored reports … and the
 * archive lists all five."* The control existed and worked, and was mounted only on
 * `/archive/[reportId]` — which made the product circular. Stepping is the only thing that generates
 * a day other than today, so the archive listed exactly one day; and the only page offering a step
 * was a permalink you could reach only *through* the archive. A reader landing on `/` met a report
 * frozen on one date with no way to move, which is precisely what the review found.
 *
 * So the assertion is about where it is mounted. The gate, the route's refusals and the day-by-day
 * walk through the pipeline are covered by `tests/time-travel.test.ts` and
 * `apps/worker/tests/time-travel.test.ts`; none of them can see that `/` does not offer it.
 */
describe('the report page carries the date control', () => {
  const page = codeOf('app', 'page.tsx');

  it('mounts the scrubber on `/`, not only on the permalink', () => {
    expect(page).toContain('TimeTravelScrubber');
    // Fed from the loader rather than computed in the component: the bounds are time arithmetic
    // over the seeded history, and this route renders rather than computes.
    expect(page).toContain('home.timeTravel');
  });

  const bounds = {
    available: true,
    earliestDate: '2026-07-22',
    latestDate: '2026-07-31',
    timezone: 'Europe/Berlin',
    currentDate: '2026-07-31',
  } as const;

  it('offers day-step buttons and a date jump, bounded by the seeded history', () => {
    const control = renderToStaticMarkup(<TimeTravelScrubber bounds={bounds} teamKey="platform" />);

    // The blueprint's two gestures: the day-by-day walk that shows continuity, and the jump.
    expect(control).toContain('aria-label="Step back one day"');
    expect(control).toContain('aria-label="Step forward one day"');
    expect(control).toContain('type="date"');

    // Bounded, so the control cannot ask for a day the fixture has no data for.
    expect(control).toContain(`min="${bounds.earliestDate}"`);
    expect(control).toContain(`max="${bounds.latestDate}"`);
    expect(control).toContain(`value="${bounds.currentDate}"`);

    // At the latest day the forward step is disabled rather than absent, so the bound is legible —
    // and the backward step is not, because the reader is at one end of the history and not both.
    // Matched inside each button's own tag: an alternation over the whole document would let the
    // wrong button's `disabled` satisfy this.
    const buttonWith = (label: string): string => {
      const found = [...control.matchAll(/<button\b[^>]*>/g)].find((tag) => tag[0].includes(label));
      if (found === undefined) throw new Error(`no button labelled ${label}`);
      return found[0];
    };

    expect(buttonWith('Step forward one day')).toContain('disabled');
    expect(buttonWith('Step back one day')).not.toContain('disabled');
  });

  /**
   * `/` performs no session lookup — the assertions above in this file hold it to that — so the
   * control cannot hide itself from a reader who has no seat. Stepping is a write and the role
   * matrix admits owners and managers only, so the alternative to saying so is a reader clicking a
   * control, receiving a 401 in a status line, and concluding the feature is broken.
   */
  it('says up front that stepping needs a seat, and where the credentials are', () => {
    const control = renderToStaticMarkup(<TimeTravelScrubber bounds={bounds} teamKey="platform" />);

    expect(control).toContain('needs a seat');
    expect(control).toContain('href="/account"');
  });

  it('renders nothing at all where stepping `now` is not a meaningful act', () => {
    // A live organization. Absent rather than disabled: a disabled control is an invitation to ask
    // why it is disabled, and this one would never become enabled.
    const control = renderToStaticMarkup(
      <TimeTravelScrubber bounds={{ ...bounds, available: false }} teamKey="platform" />,
    );

    expect(control).toBe('');
  });
});
