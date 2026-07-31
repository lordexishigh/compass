import { SECTIONS, createEmptyStructuredReport } from '@compass/analysis';
import { instantFromIso, timeWindow } from '@compass/clock';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FreshnessLine } from '../components/freshness-line';
import { ReportSectionBlock } from '../components/report-section';
import { SeededHistoryNote } from '../components/seeded-history-note';
import { SixSpine } from '../components/six-spine';
import {
  datasetCoversWindow,
  describeWindow,
  loadFoundationView,
  resolveProvider,
  resolveTimezone,
} from '../lib/foundation-report';

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

describe('the request edge resolves the seeded substrate', () => {
  it('serves the generated seed, not the small foundation fixture', () => {
    const provider = resolveProvider();

    expect(provider.degradation, provider.degradation ?? '').toBeNull();
    expect(provider.dataset.datasetId).toBe('northwind-v1');
    expect(provider.datasetWindow).not.toBeNull();
    expect(provider.dataset.records.commits.length).toBeGreaterThan(600);
  });

  it('renders a view whose coverage names every configured source, degraded ones included', async () => {
    const view = await loadFoundationView();

    expect(view.report.sections).toHaveLength(6);
    expect(view.recordCount).toBeGreaterThan(3000);
    expect(view.report.coverage.map((note) => note.sourceKey)).toEqual([
      'primary-code',
      'primary-tracker',
      'team-chat',
      'archive-code',
    ]);
    // The rate-limited archive must be stated, never folded into a clean total.
    expect(view.report.coverage.find((note) => note.sourceKey === 'archive-code')?.status).toBe('unavailable');
  });

  it('names the rate-limited archive in the freshness line rather than folding it in', async () => {
    const view = await loadFoundationView();
    const markup = renderToStaticMarkup(
      <FreshnessLine
        notes={view.report.coverage}
        observedAt={view.observedAt}
        windowLabel={describeWindow(view.window, view.timezone)}
      />,
    );

    expect(markup).toContain('archive-code');
    expect(markup).toContain('exhausting its hourly quota');
  });
});

describe('a day outside the seeded history', () => {
  const seeded = resolveProvider().datasetWindow;

  it('is what the coverage predicate reports for a window past the end of the seed', () => {
    expect(seeded, 'seed/generated is missing; run `pnpm seed:generate`').not.toBeNull();
    expect(datasetCoversWindow(seeded, timeWindow(instantFromIso('2030-01-01T00:00:00Z'), instantFromIso('2030-01-02T00:00:00Z')))).toBe(
      false,
    );
    expect(datasetCoversWindow(seeded, timeWindow(instantFromIso('2020-01-01T00:00:00Z'), instantFromIso('2020-01-02T00:00:00Z')))).toBe(
      false,
    );
    expect(datasetCoversWindow(null, window)).toBe(false);
  });

  it('overlaps for a window inside the seeded span', () => {
    expect(datasetCoversWindow(seeded, timeWindow(instantFromIso('2026-07-29T00:00:00Z'), instantFromIso('2026-07-30T00:00:00Z')))).toBe(
      true,
    );
  });

  it('is stated in the product voice, not left as an empty day', () => {
    const markup = renderToStaticMarkup(
      <SeededHistoryNote datasetWindow={seeded} coversWindow={false} timezone={timezone} />,
    );

    expect(markup).toContain('stated-absence');
    expect(markup).toContain('sits outside that history');
    expect(markup).toContain('rather than presenting an empty day as a quiet one');
    expect(markup).toContain('The seeded history runs');
  });

  it('says nothing about an absence when the day is inside the seeded span', () => {
    const markup = renderToStaticMarkup(
      <SeededHistoryNote datasetWindow={seeded} coversWindow={true} timezone={timezone} />,
    );

    expect(markup).toContain('The seeded history runs');
    expect(markup).not.toContain('sits outside that history');
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
