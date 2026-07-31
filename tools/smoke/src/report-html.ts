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

/**
 * The attributes an alignment verdict and its evidence affordance carry.
 *
 * There are two render paths for a Compass report — the Next.js view and anything
 * else that reads the structured payload — and the one-click evidence criterion is
 * exactly the kind of thing that gets built in one of them. So the check is stated
 * in bytes and run over the real page: **every alignment verdict on the page has an
 * evidence affordance, and the counts match.**
 *
 * Matching counts rather than "at least one" is the load-bearing part. A page with
 * three verdicts and one affordance would satisfy any weaker check while leaving two
 * flags unfalsifiable, which is the precise failure the criterion exists to prevent.
 */
export const ALIGNMENT_VERDICT_ATTRIBUTE = 'data-alignment-evidence';
export const ALIGNMENT_AFFORDANCE_ATTRIBUTE = 'data-alignment-affordance';

/**
 * The narration-fallback disclosure, if the page is showing one.
 *
 * Counted rather than required: a fallback is a legitimate state and so is its
 * absence, so there is nothing here to fail on. What *is* checked is that the two do
 * not contradict each other — a page carrying the marker has to carry the sentence,
 * because a disclosure attribute with no disclosure text is a fallback that was
 * recorded and then not actually disclosed to the reader.
 */
export const FALLBACK_NOTE_ATTRIBUTE = 'data-narration-fallback';

/** The sentence the disclosure must actually say. Design brief's wording. */
export const FALLBACK_NOTE_SENTENCE = 'narration unavailable';

/**
 * The confidence collar's landmark.
 *
 * Checked in bytes for the same reason the alignment affordance is: a projected date
 * with no collar under it is the single most dangerous object this product can put on
 * a page, because it looks exactly like a commitment. The collar is what makes it a
 * guess with a stated method, so a page that renders the date and drops the collar is
 * a product regression rather than a layout one.
 */
export const COLLAR_ATTRIBUTE = 'data-calibration-collar';

/**
 * The words an unreachable R5 must print, literally.
 *
 * `packages/analysis/src/ladder.ts` owns the string and the analysis tests assert the
 * detector emits it; this asserts it *survives to the page*. Inferring a deploy from
 * a merge would be the most damaging claim Compass could make, and the way that ships
 * is not a wrong detector — it is a correct detector whose honest sentence a
 * component quietly dropped because it looked like clutter.
 */
export const NO_DEPLOY_SIGNAL_SENTENCE = 'no deploy signal available';

const countOccurrences = (html: string, needle: string): number =>
  html.split(needle).length - 1;

export interface ReportHtmlInspection {
  /** The six section titles, in the order they appear in the HTML. */
  readonly headingsFound: readonly string[];
  /** Section titles the page never printed. */
  readonly headingsMissing: readonly string[];
  /** Section keys whose title appeared but whose section body did not render. */
  readonly sectionsNotRendered: readonly string[];
  /** Distinct `/artifact/<kind>/<id>` paths the page links to, sorted. */
  readonly sourceLinks: readonly string[];
  /** Alignment verdicts rendered on the page. Zero is a legitimate quiet day. */
  readonly alignmentVerdicts: number;
  /** Evidence affordances beside them. Must equal `alignmentVerdicts`. */
  readonly alignmentAffordances: number;
  /** Whether the page discloses that narration fell back. Either is legitimate. */
  readonly narrationFallbackDisclosed: boolean;
  /** Whether the confidence collar rendered. */
  readonly hasCalibrationCollar: boolean;
  /** Whether an unreachable R5 stated itself in the words the design requires. */
  readonly statesNoDeploySignal: boolean;
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

  const alignmentVerdicts = countOccurrences(html, ALIGNMENT_VERDICT_ATTRIBUTE);
  const alignmentAffordances = countOccurrences(html, ALIGNMENT_AFFORDANCE_ATTRIBUTE);

  if (alignmentAffordances !== alignmentVerdicts) {
    problems.push(
      `The page renders ${alignmentVerdicts} alignment verdict${alignmentVerdicts === 1 ? '' : 's'} but ` +
        `${alignmentAffordances} evidence affordance${alignmentAffordances === 1 ? '' : 's'}. Every alignment verdict, ` +
        'including an unattributed one, must have its resolution path reachable in one click — a flag a manager cannot ' +
        'check before repeating it to a person is the one output this product must never produce.',
    );
  }

  const hasCalibrationCollar = html.includes(COLLAR_ATTRIBUTE);
  if (!hasCalibrationCollar) {
    problems.push(
      'The page carries no confidence collar. The projected completion date must never appear without the band, the ' +
        'method and the calibration verdict that qualify it — a date on its own reads as a commitment, which is the one ' +
        'thing Compass never states.',
    );
  }

  // Only meaningful where the ladder rendered at all: a report with no completions
  // has no notches, and demanding the sentence there would fail an honest quiet day.
  const statesNoDeploySignal = lowered.includes(NO_DEPLOY_SIGNAL_SENTENCE);
  if (html.includes('id="section-yesterday"') && html.includes('R5') && !statesNoDeploySignal) {
    problems.push(
      `The page renders the completion ladder without the words "${NO_DEPLOY_SIGNAL_SENTENCE}". With no CI/CD ` +
        'connector R5 is unreachable, and it must say so rather than render as an ordinary uncrossed notch — a reader ' +
        'who cannot tell "not deployed" from "Compass cannot tell" has been misled about the only rung that matters.',
    );
  }

  // A recorded fallback that the page does not actually say out loud is the exact
  // "confident polish over honest degradation" failure the design brief forbids, and
  // it is invisible to every other check here.
  const narrationFallbackDisclosed = html.includes(FALLBACK_NOTE_ATTRIBUTE);
  if (narrationFallbackDisclosed && !lowered.includes(FALLBACK_NOTE_SENTENCE)) {
    problems.push(
      `The page carries \`${FALLBACK_NOTE_ATTRIBUTE}\` but never says "${FALLBACK_NOTE_SENTENCE}". A report whose ` +
        'prose was written by the fallback renderer must state that in the reading column, not only in a data ' +
        'attribute — a manager about to repeat a sentence to their team is entitled to know who wrote it.',
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

  return {
    headingsFound,
    headingsMissing,
    sectionsNotRendered,
    sourceLinks,
    hasCalibrationCollar,
    statesNoDeploySignal,
    alignmentVerdicts,
    alignmentAffordances,
    narrationFallbackDisclosed,
    problems,
  };
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
