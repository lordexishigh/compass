import { SECTIONS, createEmptyStructuredReport } from '@compass/analysis';
import { instantFromIso, timeWindow } from '@compass/clock';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FreshnessLine } from '../components/freshness-line';
import { ReportSectionBlock } from '../components/report-section';
import { SixSpine } from '../components/six-spine';
import { describeWindow, resolveTimezone } from '../lib/foundation-report';

const timezone = 'Europe/London';
const now = instantFromIso('2026-07-31T08:12:00Z');
const window = timeWindow(instantFromIso('2026-07-29T23:00:00Z'), instantFromIso('2026-07-30T23:00:00Z'));

const report = createEmptyStructuredReport({
  organizationId: '00000000-0000-4000-8000-000000000001',
  scope: { kind: 'team', teamKey: 'platform' },
  instant: now,
  timezone,
  window,
  coverage: [
    { sourceKey: 'primary-code', status: 'complete', detail: 'primary-code is reachable and answering.' },
    { sourceKey: 'legacy-code', status: 'unavailable', detail: 'legacy-code rejected the stored credential.' },
  ],
});

const entries = SECTIONS.map((section) => ({
  key: section.key,
  numeral: section.numeral,
  title: section.title,
  count: 0,
}));

describe('the Six Spine', () => {
  const markup = renderToStaticMarkup(<SixSpine entries={entries} initialActiveKey="yesterday" />);

  it('lists the six sections in the fixed order, twice: phone strip and desktop rail', () => {
    for (const section of SECTIONS) {
      expect(markup).toContain(`#section-${section.key}`);
    }
    const positions = SECTIONS.map((section) => markup.indexOf(`href="#section-${section.key}"`));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(markup.match(/href="#section-yesterday"/g)).toHaveLength(2);
  });

  it('shows a mono count for every section', () => {
    expect(markup).toContain('tabular-nums');
    expect(markup).toContain('font-mono');
  });

  it('marks the active section for assistive technology as well as the eye', () => {
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('border-verified');
  });

  it('is navigable and labelled', () => {
    expect(markup).toContain('aria-label="Report sections"');
  });
});

describe('a report section', () => {
  it('states its absence rather than rendering a blank', () => {
    const section = report.sections[0];
    if (!section) throw new Error('the report has no sections');

    const markup = renderToStaticMarkup(<ReportSectionBlock section={section} numeral="01" />);

    expect(markup).toContain(section.emptyStatement);
    expect(markup).toContain('stated-absence');
    expect(markup).toContain('id="section-yesterday"');
  });

  it('renders an item with its evidence tokens in mono', () => {
    const section = report.sections[0];
    if (!section) throw new Error('the report has no sections');

    const markup = renderToStaticMarkup(
      <ReportSectionBlock
        numeral="01"
        section={{
          ...section,
          items: [
            {
              stableId: 'yesterday:DEV-501:merged',
              headline: 'DEV-501 merged as #883',
              detail: 'Merged at 11:41.',
              changeTag: 'new',
              ageDays: 6,
              evidence: [{ kind: 'issue', label: 'DEV-501', sourceKey: 'primary-tracker', sourceRecordId: 'i-1' }],
            },
          ],
        }}
      />,
    );

    expect(markup).toContain('DEV-501 merged as #883');
    expect(markup).toContain('day 6');
    expect(markup).toContain('data-token');
  });
});

describe('the freshness line', () => {
  const markup = renderToStaticMarkup(
    <FreshnessLine
      notes={report.coverage}
      observedAt="2026-07-31 09:12"
      windowLabel={describeWindow(window, timezone)}
    />,
  );

  it('names the sources that answered', () => {
    expect(markup).toContain('primary-code');
  });

  it('names a degraded source instead of implying the report is complete', () => {
    expect(markup).toContain('legacy-code');
    expect(markup).toContain('rejected the stored credential');
  });

  it('states the window in the team timezone', () => {
    expect(markup).toContain('2026-07-30 00:00');
  });
});

describe('the reading column', () => {
  it('contains no chart, canvas or svg primitive anywhere in the rendered view', () => {
    const markup = [
      renderToStaticMarkup(<SixSpine entries={entries} />),
      renderToStaticMarkup(
        <FreshnessLine notes={report.coverage} observedAt="2026-07-31 09:12" windowLabel="x" />,
      ),
      ...report.sections.map((section) => renderToStaticMarkup(<ReportSectionBlock section={section} numeral="01" />)),
    ].join('');

    for (const forbidden of ['<canvas', '<svg', 'chart', 'sparkline', 'gauge']) {
      expect(markup.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('timezone resolution', () => {
  it('falls back to a documented default rather than the host zone', () => {
    expect(resolveTimezone({} as NodeJS.ProcessEnv)).toBe('Europe/London');
    expect(
      resolveTimezone({ COMPASS_DEFAULT_TIMEZONE: 'Asia/Kolkata' } as unknown as NodeJS.ProcessEnv),
    ).toBe('Asia/Kolkata');
  });
});
