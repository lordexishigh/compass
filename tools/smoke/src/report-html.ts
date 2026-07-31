import { SECTIONS } from '@compass/analysis';
import { ARTIFACT_ROUTE_KINDS, artifactHref } from '@compass/pipeline';

/**
 * What a cold-start `/` has to contain, checked against the HTML itself.
 *
 * The zero-config criterion is not "the process started" — it is that a manager
 * fetching `/` on a clean container reads a six-section report with links they can
 * follow. That is a statement about bytes, so this checks bytes.
 *
 * The same function is used twice, and that is the point:
 *
 *  1. `apps/web/tests/cold-start.test.tsx` renders the **real** report page to
 *     markup and runs this over it. So the checks are known to pass against the
 *     page as built, not against a hand-written sample of what it might emit.
 *  2. `src/cli.ts` runs this over the **live** HTTP response from a booted
 *     container in CI.
 *
 * If the two were separate assertions, the CI smoke test could pass while
 * asserting the wrong thing, or fail on a page that is actually correct. One
 * function, two callers, no room for the two to disagree.
 *
 * Every constant it reads is imported from the package that owns it: the section
 * list and its order come from `SECTIONS`, and the link shape comes from
 * `artifactHref`. A second literal copy of either here is exactly how the fixed
 * order silently drifts.
 */

/**
 * Markers that mean the reader did not get the report.
 *
 * A login form, a connector wizard or an empty state are each *worse* than an
 * error page, because each looks like the product working. So they are named
 * explicitly and failed on explicitly.
 *
 * The needles are lowercase and matched against lowercased HTML. They are chosen
 * to be things a report page would never say: the report talks about blockers and
 * sprints, never about signing in or connecting a repository.
 */
export const REGRESSION_MARKERS: readonly { readonly needle: string; readonly why: string }[] = Object.freeze([
  { needle: 'type="password"', why: 'the first request was answered with a login form' },
  { needle: 'name="password"', why: 'the first request was answered with a login form' },
  { needle: 'sign in to continue', why: 'the first request was answered with an authentication wall' },
  { needle: 'connect your first', why: 'the first request was answered with a connector wizard' },
  { needle: 'connect a repository', why: 'the first request was answered with a connector wizard' },
  { needle: 'get started by', why: 'the first request was answered with a setup wizard' },
  { needle: 'no data yet', why: 'the first request was answered with an empty state' },
  { needle: 'nothing to show', why: 'the first request was answered with an empty state' },
  { needle: 'no reports yet', why: 'the first request was answered with an empty state' },
]);

/**
 * Anything that would make this page a dashboard instead of a memo.
 *
 * Compass renders prose. A chart element or a charting bundle in the response is a
 * product regression, not merely a style one, so the cold-start check refuses it
 * on the same footing as a missing section.
 */
export const CHART_MARKERS: readonly string[] = Object.freeze([
  '<canvas',
  '<svg',
  'chart.js',
  'recharts',
  'highcharts',
  'echarts',
  'plotly',
  'sparkline',
  'apexcharts',
]);

/**
 * `/artifact/<kind>/<id>` for any kind the route serves.
 *
 * Group 1 is the path itself, not the whole attribute, because the smoke test does
 * not merely count links — it follows one. A dead link satisfies "a link is
 * present" and fails the criterion the link exists for.
 */
const ARTIFACT_HREF_PATTERN = new RegExp(
  `href="((?:${ARTIFACT_ROUTE_KINDS.map((kind) => escapeRegExp(artifactHref(kind, ''))).join('|')})[^"]+)"`,
  'g',
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The landmark a rendered section carries.
 *
 * Checked as well as the heading text because the Six Spine *also* prints all six
 * titles: a page whose left rail rendered but whose report body did not would
 * otherwise pass a title-presence check with no report on it at all. The id is a
 * contract of the report view — `apps/web/tests/view.test.tsx` asserts it too — so
 * requiring it costs nothing and closes that hole.
 */
export const sectionLandmark = (sectionKey: string): string => `id="section-${sectionKey}"`;

export interface ReportHtmlInspection {
  /** The six section titles, in the order they appear in the HTML. */
  readonly headingsFound: readonly string[];
  /** Section titles the page never printed. */
  readonly headingsMissing: readonly string[];
  /** Section keys whose title appeared but whose section body did not render. */
  readonly sectionsNotRendered: readonly string[];
  /** Distinct `/artifact/<kind>/<id>` paths the page links to, sorted. */
  readonly sourceLinks: readonly string[];
  /** One sentence per failed check. Empty means the cold start is honest. */
  readonly problems: readonly string[];
}

/**
 * Reads a report page and says what is wrong with it, in sentences.
 *
 * Returns every problem rather than the first, because a half-diagnosed cold-start
 * failure costs another full container boot to learn the rest.
 */
export function inspectReportHtml(html: string): ReportHtmlInspection {
  const lowered = html.toLowerCase();
  const problems: string[] = [];

  // Order is read from where each title lands, not from whether it is present:
  // six headings in the wrong order is a different bug from five headings, and
  // the fixed order is the one thing a manager is promised never changes.
  const positions = SECTIONS.map((section) => ({
    title: section.title,
    at: html.indexOf(`>${section.title}<`),
  }));

  const headingsMissing = positions.filter((entry) => entry.at < 0).map((entry) => entry.title);
  const headingsFound = positions
    .filter((entry) => entry.at >= 0)
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.title);

  if (headingsMissing.length > 0) {
    problems.push(
      `The page is missing ${headingsMissing.length} of the six section headings: ${headingsMissing.join(', ')}.`,
    );
  } else {
    const expected = SECTIONS.map((section) => section.title);
    if (headingsFound.join('|') !== expected.join('|')) {
      problems.push(
        `The six sections appear as ${headingsFound.join(', ')}, but the fixed order is ${expected.join(', ')}.`,
      );
    }
  }

  const sectionsNotRendered = SECTIONS.filter((section) => !html.includes(sectionLandmark(section.key))).map(
    (section) => section.key,
  );

  if (sectionsNotRendered.length > 0) {
    problems.push(
      `${sectionsNotRendered.length} of the six sections were named but not rendered: ${sectionsNotRendered.join(', ')}.`,
    );
  }

  const sourceLinks = [
    ...new Set([...html.matchAll(ARTIFACT_HREF_PATTERN)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))),
  ].sort();
  if (sourceLinks.length === 0) {
    problems.push(
      'No claim on the page links to an artifact page, so nothing in the report can be checked against its source.',
    );
  }

  for (const marker of REGRESSION_MARKERS) {
    if (lowered.includes(marker.needle)) {
      problems.push(`The response contains \`${marker.needle}\`, which means ${marker.why}.`);
    }
  }

  for (const marker of CHART_MARKERS) {
    if (lowered.includes(marker)) {
      problems.push(`The response contains \`${marker}\`; Compass renders prose, never a chart.`);
    }
  }

  return { headingsFound, headingsMissing, sectionsNotRendered, sourceLinks, problems };
}

export class ColdStartCheckFailed extends Error {
  readonly inspection: ReportHtmlInspection;

  constructor(where: string, inspection: ReportHtmlInspection) {
    super(
      `The cold-start report at ${where} is not what a manager was promised:\n  - ${inspection.problems.join('\n  - ')}`,
    );
    this.name = 'ColdStartCheckFailed';
    this.inspection = inspection;
  }
}

/** Throws with every problem named, or returns the inspection. */
export function assertColdStartHtml(html: string, where = '/'): ReportHtmlInspection {
  const inspection = inspectReportHtml(html);
  if (inspection.problems.length > 0) throw new ColdStartCheckFailed(where, inspection);
  return inspection;
}
