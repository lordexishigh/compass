import {
  MERGED_REPORT_WORD_BUDGET,
  SECTIONS,
  assertWithinWordBudget,
  countWords,
  mergedItemsInSection,
  mergedSectionKeys,
  type MergedReport,
  type MergedReportItem,
  type SectionKey,
} from '@compass/analysis';
import { formatCivilDate } from '@compass/clock';

/**
 * The merged cross-team report, as prose.
 *
 * ## Where the budget is enforced, and why here
 *
 * `assertWithinWordBudget` runs over the finished string at the bottom of `renderMergedReport`. A word
 * budget is a fact about the sentences a manager reads, and until there is a string there are no
 * sentences — only items that will become some number of words. Asserting on the payload would be
 * asserting on a proxy.
 *
 * It fails closed rather than truncating. A merged report cut off at word 400 would end mid-sentence,
 * which reads as a bug in Compass rather than as a budget; the *choosing* happens upstream in
 * `mergeTeamReports`, where the ranking is known and the least actionable item is the one that can be
 * left in its per-team report. If this ever throws, the fix is the item cap in the analysis core, not
 * a longer budget here.
 *
 * ## Why this renderer is never narrated
 *
 * The per-team reports are narrated; this one is not, deliberately. A model asked to phrase a page
 * with a hard word ceiling can only make it longer or less accurate, and the merged report has no
 * prose of its own to improve — every sentence in it is a headline the per-team analysis already
 * wrote and a count this renderer computed. Keeping a model out of it is also what makes the budget a
 * *guarantee* rather than a hope, and what makes the merged report byte-identical for the same
 * `(organization, instant)` without a testkit.
 *
 * ## No concatenation
 *
 * Each line is one ranked item with its team and its per-team item reference, not that team's
 * paragraph. The merged report's job is to be read *instead of* three reports and to point at the one
 * worth opening — so it states the team, the claim and the day counter, and the link down lives in the
 * view that renders it.
 */

export const MERGED_RENDERER_ID = 'merged-template';

export interface RenderedMergedReport {
  readonly rendererId: typeof MERGED_RENDERER_ID;
  /** `Compass — all teams — 2026-07-31`. */
  readonly masthead: string;
  /**
   * The civil date this report is for, on its own.
   *
   * A field rather than something a page recovers with `masthead.split(' — ').at(-1)`. That worked and was
   * a latent bug: the masthead's separator is presentation, so a team key containing an em dash — or any
   * change to the masthead's shape — would have silently made the page's heading show the wrong thing.
   */
  readonly reportDate: string;
  /** What moved across the teams, in one sentence. */
  readonly changeLine: string;
  /** One line per team: how many findings it has, and how many reached this page. */
  readonly teamLines: readonly string[];
  readonly sections: readonly RenderedMergedSection[];
  /** Stated when the ranking left items behind. Empty when everything fit. */
  readonly omittedLine: string;
  /** Every sentence, joined. This is the string the budget is asserted over. */
  readonly prose: string;
  /** The whole document with the Six Spine numerals, for a terminal or an email body. */
  readonly text: string;
  readonly wordCount: number;
  readonly wordBudget: number;
}

export interface RenderedMergedSection {
  readonly key: SectionKey;
  readonly numeral: string;
  readonly title: string;
  readonly lines: readonly RenderedMergedLine[];
}

export interface RenderedMergedLine {
  /** The per-team item's own id, carried through so the view can link down by it. */
  readonly stableId: string;
  readonly teamKey: string;
  readonly prose: string;
}

/**
 * One merged item as one sentence.
 *
 * The team first, because on a merged page "which team" is the reader's first question and putting it
 * last would make every line a small guessing game. The day counter is appended only when the item has
 * recurred, so a first sighting does not carry a "day 0" that means nothing.
 */
export function renderMergedLine(item: MergedReportItem): string {
  const headline = item.headline.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
  const day = item.seenDays > 0 ? `, day ${item.seenDays}` : '';
  return `${item.teamKey}: ${headline}${day}.`;
}

/** `platform 4 findings, 2 here` — the per-team index line. */
export function renderTeamLine(team: MergedReport['teams'][number]): string {
  return `${team.teamKey} has ${team.itemCount} finding${team.itemCount === 1 ? '' : 's'}, ${team.mergedItemCount} of them here.`;
}

export function renderMergedReport(report: MergedReport): RenderedMergedReport {
  const reportDate = formatCivilDate(report.instant, report.timezone);
  const masthead = `Compass — all teams — ${reportDate}`;
  const teamLines = report.teams.map(renderTeamLine);

  const sections: RenderedMergedSection[] = mergedSectionKeys(report).map((key) => {
    const definition = SECTIONS.find((candidate) => candidate.key === key);
    if (definition === undefined) {
      throw new Error(`No section definition for \`${key}\`; the Six Spine is fixed at ${SECTIONS.length}.`);
    }
    return {
      key,
      numeral: definition.numeral,
      title: definition.title,
      lines: mergedItemsInSection(report, key).map((item) => ({
        stableId: item.stableId,
        teamKey: item.teamKey,
        prose: renderMergedLine(item),
      })),
    };
  });

  const omittedLine =
    report.omittedItemCount === 0
      ? ''
      : `${report.omittedItemCount} further finding${report.omittedItemCount === 1 ? '' : 's'} ranked below these and stayed in the per-team reports.`;

  // An empty merged page is a real outcome and gets a sentence rather than a blank measure: three
  // teams with nothing that crossed a threshold is good news, and it should read as good news.
  const body =
    sections.length === 0
      ? ['No finding on any of these teams crossed a threshold worth your morning.']
      : sections.flatMap((section) => section.lines.map((line) => line.prose));

  const prose = [report.changeLine, ...teamLines, ...body, omittedLine]
    .filter((line) => line.length > 0)
    .join('\n\n');

  const text = [
    masthead,
    '',
    report.changeLine,
    '',
    ...teamLines,
    '',
    ...sections.flatMap((section) => [
      `${section.numeral} ${section.title.toUpperCase()}`,
      '',
      ...section.lines.map((line) => line.prose),
      '',
    ]),
    ...(sections.length === 0 ? [body[0] ?? '', ''] : []),
    ...(omittedLine.length === 0 ? [] : [omittedLine]),
  ]
    .join('\n')
    .trimEnd();

  // The budget covers `prose` — every sentence a manager reads — and not `text`, whose extra tokens are
  // the page's own furniture: a fixed `01` numeral is not a measurement and has nothing to say. Same
  // rule the per-team renderer applies to its interpretation guard, for the same reason.
  assertWithinWordBudget(prose, report.wordBudget, 'merged cross-team report');

  return {
    rendererId: MERGED_RENDERER_ID,
    masthead,
    reportDate,
    changeLine: report.changeLine,
    teamLines,
    sections,
    omittedLine,
    prose,
    text: `${text}\n`,
    wordCount: countWords(prose),
    wordBudget: report.wordBudget,
  };
}

/** Re-exported so a caller enforcing the budget does not have to reach into the analysis core. */
export { MERGED_REPORT_WORD_BUDGET };
