import type { SectionKey } from '@compass/analysis';
import type { StoredReportBundle } from '@compass/db';
import { RENDERER_ID, type RenderedReport, type RenderedSection } from '@compass/renderers';

/**
 * The persisted report, in the shape the channels read.
 *
 * Deliberately a *projection of what is stored*, not a re-render. The prose in `report_sections`
 * and `report_items` is the prose a manager already read on the web — narrated or templated — and
 * re-running a renderer here could produce different sentences for the same report id, which would
 * make the email and the page disagree about what Compass said. So every sentence comes off the
 * row.
 *
 * `lead` prefers the section's stored `summary` and falls back to its `emptyStatement`, which is
 * exactly the rule the web view follows: a section with nothing to say states that in the
 * product's voice rather than rendering blank.
 */
export function storedReportToRendered(bundle: StoredReportBundle): RenderedReport {
  const { report, sections } = bundle;

  const rendered: RenderedSection[] = sections.map((section) => {
    const claims = section.items.map((item) => ({ stableId: item.stableId, prose: item.prose }));
    const lead = section.summary ?? section.emptyStatement;

    return {
      key: section.sectionKey as SectionKey,
      index: section.ordinal,
      numeral: String(section.ordinal).padStart(2, '0'),
      title: section.title,
      prose: section.prose,
      lead,
      claims,
      trailer: null,
    };
  });

  return {
    rendererId: RENDERER_ID,
    // The same masthead shape the web page and the deterministic renderer use.
    masthead: `Compass — ${report.scopeKind === 'merged' ? 'all teams' : report.scopeKey} — ${report.reportDate}`,
    freshness: freshnessSentence(report.coverageStatus),
    sections: rendered,
    prose: report.prose,
    text: rendered.map((section) => `${section.numeral} ${section.title.toUpperCase()}\n\n${section.prose}`).join('\n\n'),
  };
}

/**
 * What the coverage status means, in one sentence.
 *
 * Stated rather than omitted when it is not `complete`: a report computed over a window one source
 * could not answer for is a report with a gap in it, and a channel that dropped that sentence
 * would present a partial picture as a whole one.
 */
const freshnessSentence = (coverageStatus: string): string => {
  if (coverageStatus === 'complete') return 'Every source answered for the window.';
  if (coverageStatus === 'partial') {
    return 'At least one source did not answer for the whole window, so this report may be missing activity.';
  }
  return 'No source could be reached for this window, so this report is computed from what was already known.';
};
