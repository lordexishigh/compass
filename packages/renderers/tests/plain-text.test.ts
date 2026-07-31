import { SECTIONS, createEmptyStructuredReport, type StructuredReport } from '@compass/analysis';
import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { renderCoverageLine, renderPlainTextReport } from '@compass/renderers';

const base = (): StructuredReport =>
  createEmptyStructuredReport({
    organizationId: '11111111-1111-4111-8111-111111111111',
    scope: { kind: 'team', teamKey: 'platform' },
    instant: instantFromIso('2026-07-30T08:12:00Z'),
    timezone: 'Europe/London',
    window: timeWindow(instantFromIso('2026-07-29T00:00:00Z'), instantFromIso('2026-07-30T00:00:00Z')),
    coverage: [
      { sourceKey: 'primary-code', status: 'complete', detail: 'primary-code answered the full window.' },
      { sourceKey: 'team-chat', status: 'unavailable', detail: 'team-chat disconnected 6h ago — Blockers may be incomplete.' },
    ],
  });

const withItem = (): StructuredReport => {
  const report = base();
  return {
    ...report,
    sections: report.sections.map((section) =>
      section.key === 'yesterday'
        ? {
            ...section,
            items: [
              {
                stableId: 'yesterday:DEV-501:merged',
                headline: 'DEV-501 merged as #883',
                detail: 'Priya Raman merged the batch writer at 11:41.',
                changeTag: 'new' as const,
                ageDays: 0,
                evidence: [
                  { kind: 'issue' as const, label: 'DEV-501', sourceKey: 'primary-tracker', sourceRecordId: 'issue-1' },
                  { kind: 'pull_request' as const, label: '#883', sourceKey: 'primary-code', sourceRecordId: 'pr-883' },
                ],
              },
            ],
          }
        : section,
    ),
  };
};

describe('the deterministic renderer', () => {
  it('emits the same bytes for the same report', () => {
    expect(renderPlainTextReport(withItem())).toBe(renderPlainTextReport(withItem()));
  });

  it('emits exactly six sections in the fixed order', () => {
    const output = renderPlainTextReport(base());

    const headings = SECTIONS.map((section) => `${section.numeral} ${section.title.toUpperCase()}`);
    for (const heading of headings) {
      expect(output).toContain(heading);
    }
    const positions = headings.map((heading) => output.indexOf(heading));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('states the empty case rather than leaving a blank', () => {
    const output = renderPlainTextReport(base());

    for (const section of SECTIONS) {
      expect(output).toContain(section.emptyStatement);
    }
  });

  it('renders an item with its evidence', () => {
    const output = renderPlainTextReport(withItem());

    expect(output).toContain('- DEV-501 merged as #883');
    expect(output).toContain('evidence: DEV-501, #883');
  });

  it('dates the masthead in the team timezone', () => {
    const output = renderPlainTextReport(base());

    expect(output.startsWith('Compass — platform — 2026-07-30')).toBe(true);
  });

  it('carries no chart, canvas or svg markup', () => {
    const output = renderPlainTextReport(withItem());

    for (const forbidden of ['<canvas', '<svg', 'chart', 'sparkline', 'gauge']) {
      expect(output.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('states degraded coverage instead of implying the report is complete', () => {
    expect(renderCoverageLine(base())).toContain('team-chat disconnected 6h ago');
    expect(renderCoverageLine({ ...base(), coverage: [] })).toContain('not complete');
  });

  it('refuses to render a report whose sections were tampered with', () => {
    const broken = { ...base(), sections: base().sections.slice(0, 3) };

    expect(() => renderPlainTextReport(broken)).toThrow();
  });
});
