import type { StructuredReport } from '@compass/analysis';

import { renderFreshness, renderReport } from './prose.js';

/**
 * The plain-text channel.
 *
 * There is only one renderer in Compass and it lives in `prose.ts`; this file is
 * the *channel* that renders its output into a terminal or an email body. It adds
 * the masthead, the `01`–`06` numerals and the blank lines, and it adds nothing
 * else — every sentence a reader sees was written by the prose renderer, so the
 * plain-text form and the web form can never say different things about the same
 * report.
 */
export interface PlainTextOptions {
  /** Prefix each section with its fixed `01`–`06` numeral. */
  readonly withNumerals?: boolean;
}

export function renderPlainTextReport(report: StructuredReport, options: PlainTextOptions = {}): string {
  const rendered = renderReport(report);
  if (options.withNumerals ?? true) return rendered.text;

  const lines = [rendered.masthead, '', rendered.freshness, ''];
  for (const section of rendered.sections) {
    lines.push(section.title.toUpperCase(), '', section.prose, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The freshness line on its own — what a one-line digest header shows. */
export function renderCoverageLine(report: StructuredReport): string {
  return renderFreshness(report);
}
