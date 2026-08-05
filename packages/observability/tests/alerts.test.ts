import {
  ALERT_RULES,
  ROLLING_WINDOW_MILLIS,
  evaluateAlerts,
  logRecord,
  type Alert,
  type LogRecord,
} from '@compass/observability';
import { describe, expect, it } from 'vitest';

/**
 * The four production alert rules the launch criteria name.
 *
 * > WHEN narration fallbacks exceed 2% of generated reports over a rolling 24-hour window THE SYSTEM
 * > SHALL raise an alert naming the affected orgs.
 * > Delivery failures and pipeline generation failures raise alerts with the org, team and instant.
 * > Ingest coverage gaps produce an alert.
 *
 * Asserted over `LogRecord`s built by the real emitters' own `logRecord`, so the shape these rules
 * read is the shape the product writes. A rule tested against a hand-authored object would pass while
 * the field it keys on had been renamed.
 *
 * Time is a parameter throughout: `now` is chosen, never read, which is what makes a 24-hour rolling
 * window assertable without waiting a day for the boundary.
 */

const ORG_A = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const ORG_B = '1b2c3d4e-5f6a-4b7c-8d9e-1f2a3b4c5d6e';
const NOW = Date.parse('2026-08-05T06:00:00.000Z');

/** The published rate, passed in the way production passes it. See `AlertInput.fallbackRate`. */
const PUBLISHED_FALLBACK_RATE = 0.02;

const HOUR = 60 * 60 * 1000;

const run = (organizationId: string, teamKey: string | null, at: number): LogRecord =>
  logRecord(
    'pipeline.run',
    { organizationId, teamKey, at, detail: 'Generated a report.' },
    { scopeKind: teamKey === null ? 'merged' : 'team', rendererId: 'narrated', durationMillis: 900 },
  );

const fallback = (organizationId: string, teamKey: string | null, at: number): LogRecord =>
  logRecord(
    'narration.fallback',
    { organizationId, teamKey, at, detail: 'The narration was refused.' },
    { sectionKey: 'risks', outcome: 'rejected', cause: 'grounding', attempts: 3 },
  );

const generationFailure = (
  organizationId: string,
  teamKey: string | null,
  at: number,
  attempt = 1,
): LogRecord =>
  logRecord(
    'pipeline.failure',
    { organizationId, teamKey, at, detail: 'Generation failed.' },
    { scopeKind: 'team', reason: 'the database refused the write', attempt, retryLimit: 5 },
  );

const deliveryFailure = (organizationId: string, teamKey: string | null, at: number, channel = 'email'): LogRecord =>
  logRecord(
    'delivery.failure',
    { organizationId, teamKey, at, detail: 'Resend refused the message.' },
    { channel, attempt: 2, status: 'failed' },
  );

const coverageGap = (organizationId: string, teamKey: string | null, at: number, sourceKey = 'legacy-code'): LogRecord =>
  logRecord(
    'ingest.coverage_gap',
    { organizationId, teamKey, at, detail: 'A source did not cover the window.' },
    { sourceKey, status: 'unavailable', reason: 'rate_limited' },
  );

const evaluate = (records: readonly LogRecord[], now = NOW): readonly Alert[] =>
  evaluateAlerts({ records, now, fallbackRate: PUBLISHED_FALLBACK_RATE });

const ruleOf = (alerts: readonly Alert[], rule: string): Alert | undefined =>
  alerts.find((alert) => alert.rule === rule);

describe('the closed set of rules', () => {
  it('is exactly the four conditions the criteria name', () => {
    expect([...ALERT_RULES]).toEqual([
      'narration.fallback_rate',
      'pipeline.generation_failure',
      'delivery.failure',
      'ingest.coverage_gap',
    ]);
  });

  it('publishes the rolling window the fallback criterion specifies', () => {
    expect(ROLLING_WINDOW_MILLIS).toBe(24 * HOUR);
  });

  it('says nothing at all about a healthy window', () => {
    // An empty array rather than a null, so a caller renders a list with no special case — and so
    // "no alerts" is a positive assertion rather than the absence of one.
    expect(evaluate([run(ORG_A, 'platform', NOW - HOUR), run(ORG_A, 'platform', NOW - 2 * HOUR)])).toEqual([]);
  });
});

describe('narration fallbacks over the published rate', () => {
  /** 100 clean runs, so one fallback is exactly 1% and two is exactly 2%. */
  const hundredRuns = (organizationId = ORG_A): readonly LogRecord[] =>
    Array.from({ length: 100 }, (_, index) => run(organizationId, 'platform', NOW - HOUR - index * 1000));

  it('stays silent at one percent, which is under the ceiling', () => {
    const alerts = evaluate([...hundredRuns(), fallback(ORG_A, 'platform', NOW - HOUR)]);

    expect(ruleOf(alerts, 'narration.fallback_rate')).toBeUndefined();
  });

  it('stays silent at exactly two percent, because the criterion says fallbacks must *exceed* it', () => {
    const alerts = evaluate([
      ...hundredRuns(),
      fallback(ORG_A, 'platform', NOW - HOUR),
      fallback(ORG_A, 'platform', NOW - 2 * HOUR),
    ]);

    expect(ruleOf(alerts, 'narration.fallback_rate')).toBeUndefined();
  });

  it('alerts at three in a hundred, and names the affected organizations', () => {
    const alerts = evaluate([
      ...hundredRuns(),
      fallback(ORG_A, 'platform', NOW - HOUR),
      fallback(ORG_B, 'checkout', NOW - 2 * HOUR),
      fallback(ORG_B, 'insights', NOW - 3 * HOUR),
    ]);

    const alert = ruleOf(alerts, 'narration.fallback_rate');
    expect(alert, 'three fallbacks in a hundred runs is over 2% and must alert').toBeDefined();
    // The criterion's own words: the alert names the orgs. Sorted and deduplicated, so the page reads
    // the same however the events arrived.
    expect(alert?.organizationIds).toEqual([ORG_A, ORG_B].sort());
    expect(alert?.count).toBe(3);
    expect(alert?.severity).toBe('critical');
    expect(alert?.summary).toContain('3.0%');
    expect(alert?.summary).toContain('2.0%');
    // The masking argument, where somebody woken at 2am will actually read it.
    expect(alert?.summary).toContain('invisible in the product');
  });

  it('counts only the runs inside the rolling window', () => {
    /**
     * The window is what makes this a rate rather than an all-time ratio.
     *
     * 100 runs that happened 25 hours ago have aged out, so the two fallbacks inside the window are
     * measured against the two runs inside it — 100%, which alerts. Without the window filter the
     * same records read as 2 in 102 and stay silent, which is the bug this pins.
     */
    const aged = Array.from({ length: 100 }, (_, index) => run(ORG_A, 'platform', NOW - 25 * HOUR - index * 1000));

    const alerts = evaluate([
      ...aged,
      run(ORG_A, 'platform', NOW - HOUR),
      run(ORG_A, 'platform', NOW - 2 * HOUR),
      fallback(ORG_A, 'platform', NOW - HOUR),
      fallback(ORG_A, 'platform', NOW - 2 * HOUR),
    ]);

    expect(ruleOf(alerts, 'narration.fallback_rate')).toBeDefined();
    expect(ruleOf(alerts, 'narration.fallback_rate')?.count).toBe(2);
  });

  it('ages a fallback out of the window once it is older than 24 hours', () => {
    const alerts = evaluate([
      ...hundredRuns(),
      fallback(ORG_A, 'platform', NOW - 25 * HOUR),
      fallback(ORG_A, 'platform', NOW - 26 * HOUR),
      fallback(ORG_A, 'platform', NOW - 27 * HOUR),
    ]);

    // Three fallbacks, all outside the window: yesterday's incident must not page anybody today.
    expect(ruleOf(alerts, 'narration.fallback_rate')).toBeUndefined();
  });

  it('does not alert on a window with no reports at all', () => {
    /**
     * The zero case, which would otherwise be `NaN` — and the same reasoning
     * `narrationFallbackAlert` encodes. No reports generated is a *different* condition (the
     * scheduler did not run) with its own signal; folding it in here would page whoever is on call
     * about narration when narration was never reached.
     */
    expect(evaluate([])).toEqual([]);
    expect(ruleOf(evaluate([fallback(ORG_A, 'platform', NOW - HOUR)]), 'narration.fallback_rate')).toBeUndefined();
  });
});

describe('pipeline generation failures', () => {
  it('alerts with the org, team and instant', () => {
    const at = NOW - 30 * 60 * 1000;
    const alert = ruleOf(evaluate([generationFailure(ORG_A, 'platform', at)]), 'pipeline.generation_failure');

    expect(alert).toBeDefined();
    expect(alert?.organizationIds).toEqual([ORG_A]);
    expect(alert?.teamKeys).toEqual(['platform']);
    expect(alert?.at).toBe(at);
    expect(alert?.severity).toBe('critical');
  });

  it('distinguishes a retryable failure from one that has exhausted every attempt', () => {
    // The distinction that decides whether this needs somebody tonight: pg-boss retries, so a first
    // failure often heals itself while an exhausted one means the report will never exist.
    const retryable = ruleOf(
      evaluate([generationFailure(ORG_A, 'platform', NOW - HOUR, 1)]),
      'pipeline.generation_failure',
    );
    expect(retryable?.summary).toContain('retries remaining');

    const exhausted = ruleOf(
      evaluate([generationFailure(ORG_A, 'platform', NOW - HOUR, 5)]),
      'pipeline.generation_failure',
    );
    expect(exhausted?.summary).toContain('exhausted every retry');
    expect(exhausted?.summary).toContain('do not exist');
  });

  it('collapses many failures into one alert carrying the count', () => {
    // One alert per condition, not per event: twelve pages for one outage is a pager that gets muted.
    const alert = ruleOf(
      evaluate([
        generationFailure(ORG_A, 'platform', NOW - HOUR),
        generationFailure(ORG_A, 'checkout', NOW - 2 * HOUR),
        generationFailure(ORG_B, 'insights', NOW - 3 * HOUR),
      ]),
      'pipeline.generation_failure',
    );

    expect(alert?.count).toBe(3);
    expect(alert?.organizationIds).toEqual([ORG_A, ORG_B].sort());
    expect(alert?.teamKeys).toEqual(['checkout', 'insights', 'platform']);
  });

  it('carries no team for a merged report, because it genuinely has none', () => {
    const alert = ruleOf(evaluate([generationFailure(ORG_A, null, NOW - HOUR)]), 'pipeline.generation_failure');

    expect(alert?.organizationIds).toEqual([ORG_A]);
    // Absent rather than an empty string masquerading as a team called nothing.
    expect(alert?.teamKeys).toEqual([]);
  });
});

describe('delivery failures', () => {
  it('alerts with the org, team and instant, and names the channel', () => {
    const at = NOW - 15 * 60 * 1000;
    const alert = ruleOf(evaluate([deliveryFailure(ORG_A, 'platform', at, 'slack')]), 'delivery.failure');

    expect(alert).toBeDefined();
    expect(alert?.organizationIds).toEqual([ORG_A]);
    expect(alert?.teamKeys).toEqual(['platform']);
    expect(alert?.at).toBe(at);
    expect(alert?.summary).toContain('slack');
    // The severity distinction that matters: nobody got the report, but it is still readable.
    expect(alert?.summary).toContain('still readable in Compass');
  });
});

describe('ingest coverage gaps', () => {
  it('alerts and names the source that did not answer', () => {
    const alert = ruleOf(evaluate([coverageGap(ORG_A, 'platform', NOW - HOUR, 'legacy-code')]), 'ingest.coverage_gap');

    expect(alert).toBeDefined();
    expect(alert?.summary).toContain('legacy-code');
    expect(alert?.organizationIds).toEqual([ORG_A]);
    // A gap is a warning, not a page: the product already states its own incompleteness to the reader.
    expect(alert?.severity).toBe('warning');
  });

  it('says the product is already telling the reader the truth about it', () => {
    /**
     * The other half of the criterion is that a coverage gap is *also* reflected in the in-product
     * freshness indicator — `apps/web/tests/honest-degradation.test.tsx` owns that assertion. This
     * one records that the alert knows it, so an operator is not sent looking for a misled reader.
     */
    const alert = ruleOf(evaluate([coverageGap(ORG_A, 'platform', NOW - HOUR)]), 'ingest.coverage_gap');

    expect(alert?.summary).toContain('freshness panel');
    expect(alert?.summary).toContain('no reader has been');
  });
});

describe('ordering', () => {
  it('puts critical before warning, so the top of the list is what to look at', () => {
    const alerts = evaluate([
      coverageGap(ORG_A, 'platform', NOW - 1000),
      deliveryFailure(ORG_A, 'platform', NOW - 2 * HOUR),
      generationFailure(ORG_A, 'platform', NOW - 3 * HOUR),
    ]);

    expect(alerts.map((alert) => alert.severity)).toEqual(['critical', 'critical', 'warning']);
    // The coverage gap is the *newest* event and still sorts last, so severity outranks recency.
    expect(alerts.at(-1)?.rule).toBe('ingest.coverage_gap');
  });
});
