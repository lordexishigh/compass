/**
 * The two performance budgets, and the runner that measures them.
 *
 * ## Why this is a tool and not a test
 *
 * Largest Contentful Paint is a fact about a browser painting pixels. There is no way to observe it
 * from a unit-test runner: jsdom has no layout engine, so it has no paint, so it has no LCP. A suite
 * that claimed to assert a 2000 ms LCP from vitest would be asserting nothing at all.
 *
 * So the thresholds live here as constants — which `tests/budget.test.ts` and
 * `tools/quality-gates/tests/budgets.test.ts` do assert, against `docs/budgets.md` — and the
 * *measurement* is a separate command that drives a real browser against a running deployment,
 * exactly as `@compass/smoke` drives a real HTTP client against a running container.
 *
 * ## Fails rather than skips
 *
 * `measure()` throws when it cannot launch a browser. A performance gate that quietly passes when it
 * could not measure anything is worse than no gate: it reports a number nobody took, and it reports
 * it green. The CI job is allowed to be absent; it is not allowed to be dishonest.
 */

/** LCP for `/` on the throttled mobile profile. Quoted by `docs/budgets.md`. */
export const REPORT_LCP_BUDGET_MILLIS = 2000;

/** Selecting a time-travel date to a regenerated report, same profile. */
export const TIME_TRAVEL_BUDGET_MILLIS = 5000;

/**
 * The throttled mid-tier mobile profile, as the acceptance criterion names it.
 *
 * 4x CPU and Slow 4G. The numbers are Lighthouse's own "Slow 4G" preset rather than invented ones, so
 * a figure measured here is comparable with a figure measured by any other tool using that preset —
 * which is the whole value of naming a standard profile instead of a bespoke one.
 */
export const THROTTLE_PROFILE = Object.freeze({
  cpuThrottlingRate: 4,
  /** 400 kbps down, expressed as bytes per second for the CDP call. */
  downloadThroughputBytesPerSecond: (400 * 1024) / 8,
  uploadThroughputBytesPerSecond: (400 * 1024) / 8,
  latencyMillis: 400,
  /** A mid-tier phone viewport, so the measured LCP element is the one a phone paints. */
  viewport: Object.freeze({ width: 390, height: 844 }),
  deviceScaleFactor: 2,
});

export interface BudgetOutcome {
  readonly name: string;
  readonly budgetMillis: number;
  readonly measuredMillis: number;
  readonly withinBudget: boolean;
  /** One sentence, in the product's own voice, for the CI log. */
  readonly detail: string;
}

export const outcome = (input: {
  readonly name: string;
  readonly budgetMillis: number;
  readonly measuredMillis: number;
}): BudgetOutcome => {
  const withinBudget = input.measuredMillis <= input.budgetMillis;
  return {
    ...input,
    withinBudget,
    detail: withinBudget
      ? `${input.name} took ${Math.round(input.measuredMillis)} ms against a budget of ${input.budgetMillis} ms.`
      : `${input.name} took ${Math.round(input.measuredMillis)} ms, over its ${input.budgetMillis} ms budget by ` +
        `${Math.round(input.measuredMillis - input.budgetMillis)} ms.`,
  };
};

export class BrowserUnavailableError extends Error {
  constructor(cause: string) {
    super(
      'The performance budget could not be measured because no browser could be launched: ' +
        `${cause}\n` +
        'This is a failure rather than a skip on purpose. A performance gate that passes when it could not ' +
        'measure anything reports a number nobody took. Install a Chromium-family browser (Edge and Chrome are ' +
        'both accepted) or run this job on a runner that has one.',
    );
    this.name = 'BrowserUnavailableError';
  }
}

export class BudgetExceededError extends Error {
  readonly outcomes: readonly BudgetOutcome[];

  constructor(outcomes: readonly BudgetOutcome[]) {
    const over = outcomes.filter((entry) => !entry.withinBudget);
    super(
      `${over.length} performance budget${over.length === 1 ? '' : 's'} exceeded on the throttled mobile profile ` +
        `(${THROTTLE_PROFILE.cpuThrottlingRate}x CPU, Slow 4G):\n` +
        over.map((entry) => `  - ${entry.detail}`).join('\n'),
    );
    this.name = 'BudgetExceededError';
    this.outcomes = outcomes;
  }
}

/**
 * The `PerformanceObserver` script evaluated in the page.
 *
 * Kept as a string rather than a function reference because it is serialised into the browser and has
 * no access to anything in this module. It resolves on the *last* LCP candidate rather than the first:
 * the specification allows LCP to be revised upwards as larger elements paint, and taking the first
 * candidate would report the masthead's paint as the report's.
 *
 * `buffered: true` is what makes it correct to attach the observer after navigation has begun — the
 * entries that already happened are replayed rather than lost.
 */
export const LCP_PROBE_SCRIPT = `
  new Promise((resolve) => {
    let latest = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) latest = Math.max(latest, entry.startTime);
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });

    // LCP is only final once the page stops changing. The load event plus a settling beat is the
    // pragmatic end: Compass's report is server-rendered prose, so nothing paints after hydration.
    const finish = () => {
      setTimeout(() => {
        observer.takeRecords();
        observer.disconnect();
        resolve(latest);
      }, 500);
    };
    if (document.readyState === 'complete') finish();
    else window.addEventListener('load', finish, { once: true });
  })
`;

/** Where the runner points. Overridable so a CI job can measure a deployed URL. */
export const BASE_URL_ENV_VAR = 'COMPASS_PERF_BASE_URL';

export const resolveBaseUrl = (environment: Record<string, string | undefined> = process.env): string => {
  const configured = environment[BASE_URL_ENV_VAR];
  return configured !== undefined && configured.length > 0 ? configured.replace(/\/$/, '') : 'http://localhost:3000';
};
