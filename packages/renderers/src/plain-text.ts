import { SECTIONS, assertSixSectionsInOrder, type StructuredReport } from '@compass/analysis';
import { formatCivilDate } from '@compass/clock';

/**
 * The deterministic renderer.
 *
 * It is the cold-start narrator and the fail-closed fallback whenever the
 * Anthropic key is absent or grounding rejects a narration — so it renders the
 * complete report, not a placeholder. Given the same structured report it emits
 * byte-identical text, which is what makes it usable as a golden fixture.
 *
 * Prose only: no chart, no canvas, no table of metrics. Absence of signal is
 * stated as a sentence, never left as a blank.
 */
export interface PlainTextOptions {
  /** Prefix each section with its fixed `01`–`06` numeral. */
  readonly withNumerals?: boolean;
}

export function renderPlainTextReport(report: StructuredReport, options: PlainTextOptions = {}): string {
  assertSixSectionsInOrder(report);
  const withNumerals = options.withNumerals ?? true;

  const scopeLabel = report.scope.kind === 'team' ? report.scope.teamKey : 'all teams';
  const lines: string[] = [
    `Compass — ${scopeLabel} — ${formatCivilDate(report.instant, report.timezone)}`,
    '',
    renderCoverageLine(report),
    '',
  ];

  report.sections.forEach((section, position) => {
    const definition = SECTIONS[position];
    const heading = withNumerals && definition ? `${definition.numeral} ${section.title}` : section.title;
    lines.push(heading.toUpperCase());

    if (section.items.length === 0) {
      lines.push(section.emptyStatement);
    } else {
      for (const item of section.items) {
        lines.push(`- ${item.headline}`);
        if (item.detail.length > 0) lines.push(`  ${item.detail}`);
        if (item.evidence.length > 0) {
          lines.push(`  evidence: ${item.evidence.map((reference) => reference.label).join(', ')}`);
        }
      }
    }
    lines.push('');
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

/** The freshness line: what was ingested, and what was not. */
export function renderCoverageLine(report: StructuredReport): string {
  if (report.coverage.length === 0) {
    return 'No ingest has been recorded for this window — this report is not complete.';
  }
  const complete = report.coverage.filter((note) => note.status === 'complete').map((note) => note.sourceKey);
  const degraded = report.coverage.filter((note) => note.status !== 'complete');

  const parts: string[] = [];
  if (complete.length > 0) parts.push(`Ingested: ${complete.join(', ')}`);
  for (const note of degraded) parts.push(note.detail);
  return parts.join(' · ');
}
