import { SECTIONS } from '@compass/analysis';
import { artifactHref } from '@compass/pipeline';
import { describe, expect, it } from 'vitest';

import {
  ALIGNMENT_AFFORDANCE_ATTRIBUTE,
  ALIGNMENT_VERDICT_ATTRIBUTE,
  CHART_MARKERS,
  COLLAR_ATTRIBUTE,
  ColdStartCheckFailed,
  FALLBACK_NOTE_ATTRIBUTE,
  FALLBACK_NOTE_SENTENCE,
  NO_DEPLOY_SIGNAL_SENTENCE,
  REGRESSION_MARKERS,
  assertColdStartHtml,
  inspectReportHtml,
  sectionLandmark,
} from '@compass/smoke';

/**
 * The checker's own tests: every way a cold start can be dishonest, refused.
 *
 * `apps/web/tests/cold-start.test.tsx` proves the positive case against the real
 * rendered page. This file proves the negatives, which that test cannot: it would
 * have to break the page to produce a page with five headings.
 */

/** A minimal page shaped like the real one, so a test can then damage it. */
function pageHtml(
  options: {
    readonly sections?: readonly { readonly key: string; readonly title: string }[];
    readonly links?: readonly string[];
    readonly extra?: string;
    /** Drop the confidence collar, to prove the check notices. */
    readonly withoutCollar?: boolean;
  } = {},
): string {
  const sections = options.sections ?? SECTIONS.map((section) => ({ key: section.key, title: section.title }));
  const links = options.links ?? [artifactHref('pull_request', 'pr-883')];

  return [
    '<main id="report">',
    ...sections.map(
      (section) =>
        `<section ${sectionLandmark(section.key)}>` +
        `<h2 class="section-label"><span>${section.title}</span></h2><p>Prose about it.</p></section>`,
    ),
    ...links.map((href) => `<a href="${href}">DEV-501</a>`),
    // The collar is part of the shape of a correct page, not an extra: a projected
    // date with nothing qualifying it is the one object this product must never ship.
    options.withoutCollar === true ? '' : `<section ${COLLAR_ATTRIBUTE}="true"><p>[2026-08-08]</p></section>`,
    options.extra ?? '',
    '</main>',
  ].join('');
}

const allSections = SECTIONS.map((section) => ({ key: section.key, title: section.title }));

describe('the narration-fallback disclosure', () => {
  it('reports no disclosure on a page that did not fall back', () => {
    const inspection = assertColdStartHtml(pageHtml());
    expect(inspection.narrationFallbackDisclosed).toBe(false);
  });

  it('accepts a fallback that actually says so in the reading column', () => {
    const inspection = assertColdStartHtml(
      pageHtml({
        extra: `<p ${FALLBACK_NOTE_ATTRIBUTE}="true">Rendered from template — ${FALLBACK_NOTE_SENTENCE}.</p>`,
      }),
    );

    expect(inspection.problems).toEqual([]);
    expect(inspection.narrationFallbackDisclosed).toBe(true);
  });

  /**
   * The failure this check exists for: the flag is set, the attribute is on the page,
   * and the reader is told nothing. Every other check here passes on such a page —
   * six headings, links, a collar — which is exactly why it needs its own.
   */
  it('refuses a marker with no sentence beside it', () => {
    const inspection = inspectReportHtml(
      pageHtml({ extra: `<p ${FALLBACK_NOTE_ATTRIBUTE}="true">Something happened.</p>` }),
    );

    expect(inspection.narrationFallbackDisclosed).toBe(true);
    expect(inspection.problems).toHaveLength(1);
    expect(inspection.problems[0]).toContain(FALLBACK_NOTE_SENTENCE);
    expect(inspection.problems[0]).toContain('entitled to know who wrote it');
  });
});

describe('a cold start that delivered what it promised', () => {
  it('finds the six sections in the fixed order and says nothing is wrong', () => {
    const inspection = assertColdStartHtml(pageHtml());

    expect(inspection.problems).toEqual([]);
    expect(inspection.headingsFound).toEqual(SECTIONS.map((section) => section.title));
    expect(inspection.headingsMissing).toEqual([]);
    expect(inspection.sourceLinks).toHaveLength(1);
  });

  it('counts every artifact kind the route serves as a source link', () => {
    const inspection = inspectReportHtml(
      pageHtml({
        links: [
          artifactHref('commit', 'checkout-web:7a8b9c0d1e2f'),
          artifactHref('issue', 'issue-DEV-522'),
          artifactHref('pull_request', 'pr-883'),
        ],
      }),
    );

    expect(inspection.problems).toEqual([]);
    // The bare paths, not the whole attribute: the smoke test follows one of them.
    expect(inspection.sourceLinks).toEqual([
      artifactHref('commit', 'checkout-web:7a8b9c0d1e2f'),
      artifactHref('issue', 'issue-DEV-522'),
      artifactHref('pull_request', 'pr-883'),
    ]);
    // Sorted, so the diagnosis reads the same on every run.
    expect(inspection.sourceLinks).toEqual([...inspection.sourceLinks].sort());
  });
});

describe('a page missing part of the report', () => {
  it('names every missing heading rather than only the first', () => {
    const inspection = inspectReportHtml(pageHtml({ sections: allSections.slice(0, 3) }));

    expect(inspection.headingsMissing).toEqual(SECTIONS.slice(3).map((section) => section.title));
    expect(inspection.problems[0]).toContain('missing 3 of the six section headings');
  });

  it('fails a page whose sections arrived out of the fixed order', () => {
    const reordered = [allSections[1]!, allSections[0]!, ...allSections.slice(2)];
    const inspection = inspectReportHtml(pageHtml({ sections: reordered }));

    expect(inspection.headingsMissing).toEqual([]);
    expect(inspection.problems.join(' ')).toContain('the fixed order is');
  });

  it('refuses a left rail that lists six sections the body never rendered', () => {
    // The Six Spine prints all six titles, so title presence alone is not proof a
    // report was rendered. This is the shape of that failure.
    const spineOnly = [
      '<nav>',
      ...allSections.map((section) => `<a href="#section-${section.key}"><span>${section.title}</span></a>`),
      '</nav><main id="report"></main>',
      `<a href="${artifactHref('issue', 'issue-DEV-501')}">DEV-501</a>`,
    ].join('');

    const inspection = inspectReportHtml(spineOnly);

    expect(inspection.headingsMissing).toEqual([]);
    expect(inspection.sectionsNotRendered).toEqual(SECTIONS.map((section) => section.key));
    expect(inspection.problems.join(' ')).toContain('named but not rendered');
  });

  it('fails a page whose claims link to nothing', () => {
    const inspection = inspectReportHtml(pageHtml({ links: [] }));

    expect(inspection.sourceLinks).toEqual([]);
    expect(inspection.problems.join(' ')).toContain('nothing in the report can be checked against its source');
  });

  it('does not count an unrelated in-app link as evidence', () => {
    const inspection = inspectReportHtml(pageHtml({ links: [], extra: '<a href="/api/health">Readiness</a>' }));

    expect(inspection.sourceLinks).toEqual([]);
    expect(inspection.problems.join(' ')).toContain('No claim on the page links to an artifact page');
  });
});

describe('a projected date with nothing qualifying it', () => {
  it('accepts a page whose collar rendered', () => {
    const inspection = inspectReportHtml(pageHtml());

    expect(inspection.hasCalibrationCollar).toBe(true);
    expect(inspection.problems).toEqual([]);
  });

  it('refuses a page that dropped the collar', () => {
    const inspection = inspectReportHtml(pageHtml({ withoutCollar: true }));

    expect(inspection.hasCalibrationCollar).toBe(false);
    expect(inspection.problems.join(' ')).toContain('no confidence collar');
    expect(inspection.problems.join(' ')).toContain('reads as a commitment');
  });
});

describe('an unreachable R5 has to say so', () => {
  const ladder = (options: { readonly withSentence: boolean }): string =>
    `<p><span>R5 deployed</span>${options.withSentence ? `<span>${NO_DEPLOY_SIGNAL_SENTENCE}</span>` : ''}</p>`;

  it('accepts a ladder that prints the sentence', () => {
    const inspection = inspectReportHtml(pageHtml({ extra: ladder({ withSentence: true }) }));

    expect(inspection.statesNoDeploySignal).toBe(true);
    expect(inspection.problems).toEqual([]);
  });

  it('refuses a ladder that renders R5 as an ordinary empty notch', () => {
    const inspection = inspectReportHtml(pageHtml({ extra: ladder({ withSentence: false }) }));

    expect(inspection.statesNoDeploySignal).toBe(false);
    expect(inspection.problems.join(' ')).toContain(NO_DEPLOY_SIGNAL_SENTENCE);
    expect(inspection.problems.join(' ')).toContain('Compass cannot tell');
  });

  it('says nothing about a quiet day with no completions and so no ladder', () => {
    // A report with nothing in Yesterday has no notches to check, and demanding the
    // sentence there would fail an honest empty day.
    const inspection = inspectReportHtml(pageHtml());

    expect(inspection.statesNoDeploySignal).toBe(false);
    expect(inspection.problems).toEqual([]);
  });
});

describe('an alignment verdict with no way to check it', () => {
  /** One verdict and, optionally, the affordance that makes it checkable. */
  const verdict = (options: { readonly withAffordance: boolean }): string =>
    `<details ${ALIGNMENT_VERDICT_ATTRIBUTE}="off_goal">` +
    (options.withAffordance ? `<summary ${ALIGNMENT_AFFORDANCE_ATTRIBUTE}="semantic">How</summary>` : '') +
    '<div>OBJ-Q2-BILL</div></details>';

  it('accepts a page whose every verdict carries one', () => {
    const inspection = inspectReportHtml(
      pageHtml({ extra: `${verdict({ withAffordance: true })}${verdict({ withAffordance: true })}` }),
    );

    expect(inspection.alignmentVerdicts).toBe(2);
    expect(inspection.alignmentAffordances).toBe(2);
    expect(inspection.problems).toEqual([]);
  });

  it('refuses a page with three verdicts and one affordance', () => {
    // The failure a weaker "at least one" check would let through: two flags a
    // manager cannot check before repeating them to a person.
    const inspection = inspectReportHtml(
      pageHtml({
        extra:
          verdict({ withAffordance: true }) +
          verdict({ withAffordance: false }) +
          verdict({ withAffordance: false }),
      }),
    );

    expect(inspection.alignmentVerdicts).toBe(3);
    expect(inspection.alignmentAffordances).toBe(1);
    expect(inspection.problems.join(' ')).toContain('3 alignment verdicts but 1 evidence affordance');
    expect(inspection.problems.join(' ')).toContain('including an unattributed one');
  });

  it('says nothing about a day with no alignment verdicts at all', () => {
    // A quiet day is not a regression: nothing to check is different from
    // something unfalsifiable.
    const inspection = inspectReportHtml(pageHtml());

    expect(inspection.alignmentVerdicts).toBe(0);
    expect(inspection.problems).toEqual([]);
  });
});

describe('a page that is not the report at all', () => {
  it.each(REGRESSION_MARKERS.map((marker) => [marker.needle, marker.why] as const))(
    'refuses a response containing `%s`',
    (needle, why) => {
      const inspection = inspectReportHtml(pageHtml({ extra: `<div>${needle}</div>` }));

      expect(inspection.problems.join(' ')).toContain(needle);
      expect(inspection.problems.join(' ')).toContain(why);
    },
  );

  it('catches the marker whatever case the page wrote it in', () => {
    const inspection = inspectReportHtml(pageHtml({ extra: '<p>Sign In To Continue</p>' }));

    expect(inspection.problems.join(' ')).toContain('authentication wall');
  });
});

describe('a page that turned into a dashboard', () => {
  it.each(CHART_MARKERS.map((marker) => [marker] as const))('refuses a response containing `%s`', (marker) => {
    const inspection = inspectReportHtml(pageHtml({ extra: `${marker} data-chart>` }));

    expect(inspection.problems.join(' ')).toContain('Compass renders prose, never a chart');
  });
});

describe('the failure an operator reads', () => {
  it('throws once with every problem listed, not once per problem', () => {
    let thrown: unknown;
    try {
      assertColdStartHtml(pageHtml({ sections: [], links: [] }), 'http://localhost:3000/');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ColdStartCheckFailed);
    const failure = thrown as ColdStartCheckFailed;

    expect(failure.message).toContain('http://localhost:3000/');
    expect(failure.message).toContain('missing 6 of the six section headings');
    expect(failure.message).toContain('named but not rendered');
    expect(failure.message).toContain('No claim on the page links to an artifact page');
    expect(failure.inspection.problems).toHaveLength(3);
  });
});
