// @vitest-environment jsdom
import { instantFromIso } from '@compass/clock';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { FreshnessPanel } from '../components/freshness-panel';
import { ReportDocument } from '../components/report-document';
import { buildReportView } from '../lib/view-model';

import { freshnessComplete, freshnessWithMissingSource, storedBundle } from './helpers/report-fixture';

/**
 * Honest degradation, asserted on the rendered page.
 *
 * > WHEN a configured source produced no data for the window THE SYSTEM SHALL state in the report
 * > which source is missing and what it would have contributed.
 * > WHEN a source is rate-limited THE SYSTEM SHALL say so with the time of the last successful fetch.
 * > No report presents itself as complete when a configured source is missing.
 *
 * The rule these three share is negative, and it is the whole argument of the product: a page that
 * listed a dead source in small grey type and still read as finished would be the quiet dishonesty
 * Compass exists to replace. So the assertions are about what the reader is *told*, not about
 * whether a flag was set — a `complete: false` in a view model nobody renders satisfies nothing.
 *
 * `view.test.tsx` covers the view model's own coverage arithmetic. This file covers the half that
 * only exists once the components run, which is where the gap was: `FreshnessSourceView.sourceKind`
 * was resolved, carried all the way to the panel, and never rendered — so the report named the
 * silent source without ever saying what was therefore absent from it.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const withMissingSource = () =>
  buildReportView({ bundle: storedBundle(), freshness: freshnessWithMissingSource() });

const panelMarkup = (freshness = freshnessWithMissingSource()): string =>
  renderToStaticMarkup(
    <FreshnessPanel freshness={buildReportView({ bundle: storedBundle(), freshness }).freshness} />,
  );

describe('a source that produced no data is named, with what it would have contributed', () => {
  it('names the silent source', () => {
    document.body.innerHTML = panelMarkup();

    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('legacy-code');
  });

  it('says what the report is missing without it, rather than only that something is', () => {
    document.body.innerHTML = panelMarkup();

    const stated = [...document.body.querySelectorAll('[data-testid="missing-contribution"]')].map((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );

    expect(stated, 'no contribution was stated for the missing source').toHaveLength(1);
    // `legacy-code` is a `code` source, so what is absent is the merge evidence — which is what tells
    // a manager which of the six sections is thin this morning.
    expect(stated[0]).toBe(
      'Without it this report is missing commits, pull requests, reviews and release tags.',
    );
  });

  it('states the contribution proper to the kind of source, not one generic sentence', () => {
    // A silent tracker and a silent code host leave different holes. If both produced the same
    // sentence the disclosure would be decoration.
    const trackerDown = {
      ...freshnessWithMissingSource(),
      sources: freshnessWithMissingSource().sources.map((entry) =>
        entry.sourceKey === 'legacy-code'
          ? { ...entry, sourceKey: 'primary-tracker-2', sourceKind: 'tracker' as const }
          : entry,
      ),
      missingSourceKeys: ['primary-tracker-2'],
    };

    document.body.innerHTML = panelMarkup(trackerDown);
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('missing tickets, their status changes and sprint scope');
    expect(text).not.toContain('missing commits, pull requests');
  });

  it('says nothing of the kind for a source that answered', () => {
    document.body.innerHTML = panelMarkup(freshnessComplete());

    // The disclosure is the exception. Printing "without it…" beside a healthy source would train a
    // reader to skip the line that matters.
    expect(document.body.querySelectorAll('[data-testid="missing-contribution"]')).toHaveLength(0);
  });
});

describe('a rate-limited source says so, with the time of its last successful fetch', () => {
  /**
   * The fixture's rate-limited source has never answered, so it honestly renders "never answered".
   * The criterion is about the other case — a source that *was* working and is now throttled — which
   * is the one an operator has to be able to act on, and which needs a real instant to state.
   */
  const throttledAfterWorking = () => {
    const base = freshnessWithMissingSource();
    return {
      ...base,
      sources: base.sources.map((entry) =>
        entry.sourceKey === 'legacy-code'
          ? {
              ...entry,
              reason: 'rate_limited' as const,
              detail: 'legacy-code returned 429 after exhausting its hourly quota.',
              // It answered at 18:00 yesterday and has been throttled since.
              lastObservedAt: instantFromIso('2026-07-30T18:00:00Z'),
            }
          : entry,
      ),
    };
  };

  it('states the rate limit in the connector’s own words', () => {
    document.body.innerHTML = panelMarkup(throttledAfterWorking());

    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    // Compass does not paraphrase "rate limited" into something softer, and it does not hide the 429.
    expect(text).toContain('429');
    expect(text).toContain('exhausting its hourly quota');
  });

  it('shows when it last succeeded rather than implying it never did', () => {
    document.body.innerHTML = panelMarkup(throttledAfterWorking());

    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    // A real instant, and specifically not the "never answered" wording — the two are different
    // facts and conflating them would misreport a working source as a dead one.
    expect(text).toMatch(/last \S/);
    expect(text).not.toContain('never answered');
  });

  it('still shows "never answered" when that is the truth', () => {
    // The other direction, so the assertion above cannot pass by the label being unconditional.
    document.body.innerHTML = panelMarkup();

    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain('never answered');
  });
});

describe('no report presents itself as complete when a configured source is missing', () => {
  it('marks the coverage statement not-complete, and says so in prose', () => {
    document.body.innerHTML = renderToStaticMarkup(<ReportDocument view={withMissingSource()} />);

    const statement = document.body.querySelector('[data-testid="coverage-statement"]');
    expect(statement, 'the report renders no coverage statement at all').not.toBeNull();
    // The flag and the prose must move together: either alone is the failure mode this asserts. A
    // `data-complete="false"` under prose that reads as finished is exactly the quiet dishonesty
    // this suite exists to catch.
    expect(statement?.getAttribute('data-complete')).toBe('false');

    const prose = (statement?.textContent ?? '').replace(/\s+/g, ' ');
    expect(prose).toContain('this report is not complete');
    // And it names the source in the same breath, rather than leaving the reader to find it below.
    expect(prose).toContain('legacy-code');
  });

  it('disabling one source flips a complete report to not-complete', () => {
    /**
     * The criterion's own test: take the report that *is* complete, remove one configured source's
     * data, and assert the page stops claiming completeness. Asserted as a transition rather than as
     * a single state, because a page that said "not complete" unconditionally would pass every
     * one-state assertion while telling every reader the same useless thing.
     */
    const complete = buildReportView({ bundle: storedBundle(), freshness: freshnessComplete() });

    document.body.innerHTML = renderToStaticMarkup(<ReportDocument view={complete} />);
    const before = document.body.querySelector('[data-testid="coverage-statement"]');
    expect(before?.getAttribute('data-complete'), 'the baseline fixture is not complete').toBe('true');
    expect((before?.textContent ?? '')).toContain('complete');

    document.body.innerHTML = renderToStaticMarkup(<ReportDocument view={withMissingSource()} />);
    const after = document.body.querySelector('[data-testid="coverage-statement"]');
    expect(after?.getAttribute('data-complete')).toBe('false');
  });

  it('counts the silent sources against every configured one, not against the answering ones', () => {
    document.body.innerHTML = renderToStaticMarkup(<ReportDocument view={withMissingSource()} />);

    const statement = (
      document.body.querySelector('[data-testid="coverage-statement"]')?.textContent ?? ''
    ).replace(/\s+/g, ' ');

    // "1 of 3", never "1 of 1": folding the answering sources out of the denominator — or the silent
    // one out of it — is precisely how a partial report comes to look complete.
    expect(statement).toContain('1 of 3 configured sources did not answer');
  });

  it('keeps the view model and the markup agreeing about completeness', () => {
    const view = withMissingSource();
    expect(view.freshness.complete).toBe(false);
    expect(view.freshness.missingSourceKeys).toContain('legacy-code');

    document.body.innerHTML = renderToStaticMarkup(<ReportDocument view={view} />);
    expect(
      document.body.querySelector('[data-testid="coverage-statement"]')?.getAttribute('data-complete'),
    ).toBe('false');
  });
});
