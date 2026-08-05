import {
  SECTIONS,
  extractNumericTokens,
  sentencesWithNumbers,
  type StructuredReport,
} from '@compass/analysis';
import { describe, expect, it } from 'vitest';

import {
  MAX_SENTENCES_PER_ITEM,
  RENDERER_ID,
  UngroundedNumberError,
  assertEveryQuantityInterpreted,
  interpretationClauseIn,
  renderFreshness,
  renderReport,
  renderSectionProse,
} from '@compass/renderers';

import { emptyReport, fullReport, kanbanReport, withItems } from './helpers/reports.js';

describe('byte-identical output', () => {
  it('emits the same bytes for the same structured payload', () => {
    // Two independently constructed reports with the same content, so this
    // asserts determinism over the *payload* rather than over object identity.
    expect(renderReport(fullReport()).text).toBe(renderReport(fullReport()).text);
    expect(renderReport(emptyReport()).text).toBe(renderReport(emptyReport()).text);
  });

  it('names itself, so a stored report records which renderer wrote it', () => {
    expect(renderReport(fullReport()).rendererId).toBe(RENDERER_ID);
  });
});

describe('exactly six sections in the fixed order', () => {
  const rendered = renderReport(fullReport());

  it('renders six, keyed and numbered from the one section definition', () => {
    expect(rendered.sections).toHaveLength(6);
    expect(rendered.sections.map((section) => section.key)).toEqual(SECTIONS.map((section) => section.key));
    expect(rendered.sections.map((section) => section.numeral)).toEqual(['01', '02', '03', '04', '05', '06']);
  });

  it('places the headings in that order in the plain-text document', () => {
    const positions = SECTIONS.map((section) =>
      rendered.text.indexOf(`${section.numeral} ${section.title.toUpperCase()}`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('gives every section prose, including the empty ones', () => {
    for (const section of renderReport(emptyReport()).sections) {
      expect(section.prose.length, `${section.key} rendered nothing`).toBeGreaterThan(0);
    }
  });
});

describe('prose only', () => {
  const outputs = [renderReport(fullReport()).text, renderReport(emptyReport()).text];

  it('carries no chart, canvas, svg or table of metrics', () => {
    for (const output of outputs) {
      for (const forbidden of ['<canvas', '<svg', 'chart', 'sparkline', 'gauge', 'axis', '|---']) {
        expect(output.toLowerCase(), forbidden).not.toContain(forbidden);
      }
    }
  });

  it('states an absence as a sentence rather than leaving a blank', () => {
    const output = renderReport(emptyReport()).text;
    for (const section of SECTIONS) {
      expect(output).toContain(section.emptyStatement.replace(/\.$/, ''));
    }
  });
});

/**
 * The acceptance criterion, stated directly.
 *
 * `extractNumericTokens` and `sentencesWithNumbers` are imported from
 * `@compass/analysis` — the same extractor the grounding validator uses. A second
 * regex here would pass this test and still let an uninterpreted number reach a
 * narration, which is exactly the drift the shared extractor exists to prevent.
 */
describe('no metric without an interpretation', () => {
  const reports: readonly (readonly [string, StructuredReport])[] = [
    ['a report with items in all six sections', fullReport()],
    ['a report with nothing in it', emptyReport()],
    ['a report with no ingest record at all', { ...emptyReport(), coverage: [] }],
  ];

  it.each(reports)('%s: every numeric token shares a sentence with a documented clause', (_label, report) => {
    const prose = renderReport(report).prose;
    const offenders: string[] = [];

    for (const { sentence } of sentencesWithNumbers(prose)) {
      if (interpretationClauseIn(sentence.text) === null) offenders.push(sentence.text);
    }

    expect(offenders, `these sentences state a quantity with no interpretation:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('is a real constraint: the fixtures do state quantities', () => {
    const prose = renderReport(fullReport()).prose;
    expect(extractNumericTokens(prose).length).toBeGreaterThan(10);
    expect(sentencesWithNumbers(prose).length).toBeGreaterThan(4);
  });

  it('applies to the freshness line as well as to the sections', () => {
    const freshness = renderFreshness(fullReport());
    expect(extractNumericTokens(freshness).length).toBeGreaterThan(0);
    for (const { sentence } of sentencesWithNumbers(freshness)) {
      expect(interpretationClauseIn(sentence.text), sentence.text).not.toBeNull();
    }
  });

  it('holds by construction: a numeric section summary still comes out grounded', () => {
    const report = emptyReport();
    const withNumberInTheSummary: StructuredReport = {
      ...report,
      sections: report.sections.map((section) =>
        section.key === 'blockers'
          ? { ...section, emptyStatement: 'Nothing is blocked across 3 repositories.' }
          : section,
      ),
    };
    const section = withNumberInTheSummary.sections[2];
    if (section === undefined) throw new Error('the report has no Blockers section');

    const prose = renderSectionProse(withNumberInTheSummary, section);

    expect(prose).toContain('Nothing is blocked across 3 repositories');
    expect(prose).toContain('so this section carries 0 items');
    expect(() => renderReport(withNumberInTheSummary)).not.toThrow();
  });

  it('fails closed when the construction is broken', () => {
    // The guard exists for a future sentence builder that forgets its clause.
    // Every existing sentence is grounded, so the only honest way to test it is
    // to hand it the prose such a builder would produce.
    expect(() => assertEveryQuantityInterpreted('Four reviews are waiting 9 days.')).toThrow(UngroundedNumberError);
    expect(() => assertEveryQuantityInterpreted('Nothing is blocked.')).not.toThrow();
    expect(() =>
      assertEveryQuantityInterpreted('Four reviews are waiting 9 days — so this section carries 4 items.'),
    ).not.toThrow();
  });
});

describe('bounded length', () => {
  const rendered = renderReport(fullReport());

  it('spends at most three sentences on any one claim', () => {
    for (const section of rendered.sections) {
      // The first paragraph is the section lead; the rest are one per item.
      for (const paragraph of section.prose.split('\n\n').slice(1)) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
        expect(sentences.length, `${section.key}: "${paragraph}"`).toBeLessThanOrEqual(MAX_SENTENCES_PER_ITEM);
      }
    }
  });

  it('leads every non-empty section with its own summary', () => {
    const blockers = rendered.sections.find((section) => section.key === 'blockers');
    expect(blockers?.prose.split('\n\n')[0]).toContain('so this section carries 1 item');
  });
});

describe('the interpretation each section reaches for', () => {
  const rendered = renderReport(fullReport());
  const prose = (key: string): string => rendered.sections.find((section) => section.key === key)?.prose ?? '';

  it('reads a completion percentage against the schedule already spent', () => {
    expect(prose('progress')).toContain('the pace the elapsed schedule implies');
  });

  it('collars the projected date with its confidence and its method', () => {
    expect(prose('progress')).toContain('low confidence from cycle time');
  });

  it('names the rung a completion actually reached', () => {
    expect(prose('yesterday')).toContain('so it reached R2 merged and nothing above that');
  });

  it('says how long a blocker has held, and why that makes it one', () => {
    expect(prose('blockers')).toContain('so it has held for 6 days and is stated as a blocker');
  });

  it('carries a risk severity and its direction', () => {
    expect(prose('risks')).toContain('which Compass rates high severity and worsened');
  });

  it('says a recommendation is one step and when it is finishable', () => {
    expect(prose('recommendations')).toContain('and it is one step, finishable today');
  });

  it('names the rule a win cleared', () => {
    expect(prose('wins')).toContain('because it crossed the threshold T8a sets');
  });

  it('states the elapsed fact behind a run-in change clause', () => {
    expect(prose('blockers')).toContain('which makes today day 6 of it');
  });

  it('offers the evidence chain as something openable', () => {
    expect(prose('yesterday')).toContain('traced to 3 artifacts you can open');
  });
});

/**
 * A Kanban team's Progress section, in the voice a manager reads.
 *
 * The same six sections and the same rules, with one shape swapped underneath: no
 * percentage, no points, no pace verdict, and three flow figures the renderer has to have
 * a clause for. It is asserted through `renderReport` rather than over the payload because
 * the failure this guards against is a *rendering* one — a flow figure whose cause kind no
 * clause matches falls through to "Compass records it as unchanged", which passes every
 * interpretation check while telling the reader nothing about the number in front of them.
 */
describe('a Kanban team reads as flow rather than as a sprint that lost its percentage', () => {
  const rendered = renderReport(kanbanReport());
  const progress = rendered.sections.find((section) => section.key === 'progress')?.prose ?? '';

  it('names the work in progress column by column', () => {
    expect(progress).toContain('In Progress 12');
    expect(progress).toContain('In Review 10');
  });

  it('states which way cycle time moved, and over what', () => {
    expect(progress).toContain('the median item took 6 days');
    expect(progress).toContain('the slowest sixth took 8 or more');
    // The trend itself, in the prose and not only in the payload. It has to travel in the
    // headline: the deterministic renderer emits a claim's headline, its change clause and
    // its evidence, so a trend left in `detail` would be a metric that exists in the report
    // object and never appears on the page.
    expect(progress).toContain('Cycle time is lengthening');
    expect(progress).toContain('a median of 5 days over the earlier 14-day half');
  });

  it('reads an aging item against the board’s own P85 rather than a deadline', () => {
    expect(progress).toContain('and that is measured against the 8-day P85 this board finished its own work in');
  });

  it('reads every flow figure as a measured rate, never as a target the team missed', () => {
    // Three of the four flow claims take the `rate` clause, so it appears more than once.
    expect(progress.split('and that is the measured rate rather than a target').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('offers no pace verdict and no completion percentage, because neither exists', () => {
    expect(progress).not.toContain('the pace the elapsed schedule implies');
    expect(progress).not.toContain('% complete');
  });

  it('interprets every quantity it states, exactly as the sprint voice must', () => {
    expect(() => assertEveryQuantityInterpreted(rendered.prose)).not.toThrow();
  });
});

describe('honest coverage', () => {
  it('names a degraded source and refuses to call the report complete', () => {
    const freshness = renderFreshness(fullReport());

    expect(freshness).toContain('archive-code');
    expect(freshness).toContain('exhausting its hourly quota');
    expect(freshness).toContain('this report is not complete');
    expect(freshness).not.toContain('this report is complete');
  });

  it('says so plainly when every source answered', () => {
    const report = emptyReport();
    const complete: StructuredReport = {
      ...report,
      coverage: report.coverage.filter((note) => note.status === 'complete'),
    };

    expect(renderFreshness(complete)).toContain('so every configured source answered and this report is complete');
  });

  it('does not invent a freshness value when there is no ingest record', () => {
    const freshness = renderFreshness({ ...emptyReport(), coverage: [] });

    expect(freshness).toContain('no ingest record');
    expect(freshness).toContain('not a complete picture');
  });
});

describe('failing closed on a tampered report', () => {
  it('refuses a report that lost a section', () => {
    const report = emptyReport();
    expect(() => renderReport({ ...report, sections: report.sections.slice(0, 3) })).toThrow();
  });

  it('refuses a report whose sections were reordered', () => {
    const report = emptyReport();
    const swapped = [...report.sections];
    const [first, second] = [swapped[0]!, swapped[1]!];
    swapped[0] = second;
    swapped[1] = first;

    expect(() => renderReport({ ...report, sections: swapped })).toThrow();
  });

  it('exports the guard so a caller can recognise the failure', () => {
    expect(new UngroundedNumberError('4 things', ['4']).name).toBe('UngroundedNumberError');
  });
});

describe('the empty report still reads as a considered answer', () => {
  it('says what it does not know, in every section', () => {
    const rendered = renderReport(withItems(emptyReport(), {}));

    for (const section of rendered.sections) {
      expect(section.prose.trim().endsWith('.'), `${section.key}: ${section.prose}`).toBe(true);
    }
  });
});
