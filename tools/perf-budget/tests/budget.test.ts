import { describe, expect, it } from 'vitest';

import {
  BASE_URL_ENV_VAR,
  BrowserUnavailableError,
  BudgetExceededError,
  LCP_PROBE_SCRIPT,
  REPORT_LCP_BUDGET_MILLIS,
  THROTTLE_PROFILE,
  TIME_TRAVEL_BUDGET_MILLIS,
  outcome,
  resolveBaseUrl,
} from '../src/index.js';

/**
 * The thresholds, the profile and the verdict arithmetic.
 *
 * What this file deliberately does **not** do is measure anything. There is no browser in a vitest
 * process and no server on the other end of it, so an "LCP is under 2000 ms" assertion here would be
 * a sentence with nothing behind it. The measurement is `pnpm perf`, against a running deployment.
 *
 * What is left is still worth pinning, and it is the half that silently rots: the numbers themselves
 * (which `docs/budgets.md` quotes and `tools/quality-gates` diffs), the throttling profile they are
 * only meaningful with respect to, and the decision that a run which could not measure fails.
 */

describe('the documented performance budgets', () => {
  it('is 2000 ms for the report render', () => {
    expect(REPORT_LCP_BUDGET_MILLIS).toBe(2000);
  });

  it('is 5000 ms for a time-travel regeneration', () => {
    expect(TIME_TRAVEL_BUDGET_MILLIS).toBe(5000);
  });

  it('allows a regeneration more room than a render, because it is a whole pipeline run', () => {
    // Stated as a relationship: if these ever inverted, one of the two numbers would be describing
    // the wrong operation.
    expect(TIME_TRAVEL_BUDGET_MILLIS).toBeGreaterThan(REPORT_LCP_BUDGET_MILLIS);
  });
});

describe('the throttled mid-tier mobile profile', () => {
  it('throttles the CPU 4x, as the acceptance criterion names', () => {
    expect(THROTTLE_PROFILE.cpuThrottlingRate).toBe(4);
  });

  it('emulates Slow 4G: 400 kbps each way at 400 ms of latency', () => {
    // Lighthouse's own preset rather than invented numbers, so a figure measured here is comparable
    // with one measured by any other tool using it. Expressed in bytes per second for the CDP call.
    expect(THROTTLE_PROFILE.downloadThroughputBytesPerSecond).toBeCloseTo((400 * 1024) / 8, 5);
    expect(THROTTLE_PROFILE.uploadThroughputBytesPerSecond).toBeCloseTo((400 * 1024) / 8, 5);
    expect(THROTTLE_PROFILE.latencyMillis).toBe(400);
  });

  it('uses a phone viewport, so the element that paints is the one a phone paints', () => {
    // On a desktop viewport the LCP element can be a different node entirely, and the number would be
    // about a layout no manager sees.
    expect(THROTTLE_PROFILE.viewport.width).toBeLessThanOrEqual(430);
    expect(THROTTLE_PROFILE.viewport.height).toBeGreaterThan(600);
    expect(THROTTLE_PROFILE.deviceScaleFactor).toBeGreaterThan(1);
  });

  it('is frozen, so a run cannot quietly re-profile itself', () => {
    expect(Object.isFrozen(THROTTLE_PROFILE)).toBe(true);
  });
});

describe('the verdict', () => {
  it('treats a measurement exactly at the budget as within it', () => {
    const verdict = outcome({ name: 'probe', budgetMillis: 2000, measuredMillis: 2000 });

    expect(verdict.withinBudget).toBe(true);
    expect(verdict.detail).toContain('2000 ms against a budget of 2000 ms');
  });

  it('fails the millisecond after, and says by how much', () => {
    const verdict = outcome({ name: 'probe', budgetMillis: 2000, measuredMillis: 2350 });

    expect(verdict.withinBudget).toBe(false);
    // "over by 350 ms" is the number somebody acts on; "failed" is not.
    expect(verdict.detail).toContain('over its 2000 ms budget by 350 ms');
  });

  it('rounds the reported figure but not the comparison', () => {
    // 2000.4 ms is over budget. Reporting it as "2000 ms" while failing would read as a bug, so the
    // detail rounds for legibility and the verdict is taken on the raw value.
    const verdict = outcome({ name: 'probe', budgetMillis: 2000, measuredMillis: 2000.4 });

    expect(verdict.withinBudget).toBe(false);
    expect(verdict.detail).toContain('2000 ms');
  });
});

describe('a run that could not measure is a failure, not a pass', () => {
  it('says what it looked for and what to do, when no browser could be launched', () => {
    const error = new BrowserUnavailableError('msedge: not found; chrome: not found');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BrowserUnavailableError');
    // The reasoning is in the message, because the person reading it is looking at a red CI job.
    expect(error.message).toContain('failure rather than a skip');
    expect(error.message).toContain('reports a number nobody took');
    expect(error.message).toContain('msedge: not found');
  });

  it('names every exceeded budget, and the profile they were measured on', () => {
    const error = new BudgetExceededError([
      outcome({ name: 'Report render (LCP)', budgetMillis: 2000, measuredMillis: 2400 }),
      outcome({ name: 'Time-travel regeneration', budgetMillis: 5000, measuredMillis: 4200 }),
    ]);

    expect(error.message).toContain('1 performance budget exceeded');
    expect(error.message).toContain('Report render (LCP)');
    // The one that passed is not listed as a failure.
    expect(error.message).not.toContain('Time-travel regeneration took');
    // A figure with no profile attached is not comparable with anything.
    expect(error.message).toContain('4x CPU, Slow 4G');
    expect(error.outcomes).toHaveLength(2);
  });

  it('pluralises honestly when more than one budget is over', () => {
    const error = new BudgetExceededError([
      outcome({ name: 'Report render (LCP)', budgetMillis: 2000, measuredMillis: 2400 }),
      outcome({ name: 'Time-travel regeneration', budgetMillis: 5000, measuredMillis: 9000 }),
    ]);

    expect(error.message).toContain('2 performance budgets exceeded');
  });
});

describe('the LCP probe', () => {
  it('observes largest-contentful-paint with buffered entries', () => {
    // `buffered: true` is what makes it correct to attach the observer after navigation has begun.
    // Without it the entry for the paint being measured can already have been emitted and lost.
    expect(LCP_PROBE_SCRIPT).toContain('largest-contentful-paint');
    expect(LCP_PROBE_SCRIPT).toContain('buffered: true');
  });

  it('takes the last candidate rather than the first', () => {
    // LCP is revised upwards as larger elements paint. Resolving on the first candidate would report
    // the masthead's paint as the report's, which would pass this budget on a page showing a heading.
    expect(LCP_PROBE_SCRIPT).toContain('Math.max');
  });

  it('waits for load before it settles, and disconnects when it does', () => {
    expect(LCP_PROBE_SCRIPT).toContain("addEventListener('load'");
    expect(LCP_PROBE_SCRIPT).toContain('observer.disconnect()');
  });
});

describe('where the run points', () => {
  it('defaults to the local dev server', () => {
    expect(resolveBaseUrl({})).toBe('http://localhost:3000');
  });

  it('takes a configured origin and drops a trailing slash', () => {
    // Otherwise every path would be built with a double slash, which some proxies redirect — and a
    // redirect would be measured as part of the paint.
    expect(resolveBaseUrl({ [BASE_URL_ENV_VAR]: 'https://compass.example.com/' })).toBe(
      'https://compass.example.com',
    );
  });

  it('ignores an empty value rather than pointing at nothing', () => {
    expect(resolveBaseUrl({ [BASE_URL_ENV_VAR]: '' })).toBe('http://localhost:3000');
  });
});
