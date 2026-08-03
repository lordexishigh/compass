import { chromium, type Browser, type Page } from 'playwright-core';

import {
  BrowserUnavailableError,
  LCP_PROBE_SCRIPT,
  REPORT_LCP_BUDGET_MILLIS,
  THROTTLE_PROFILE,
  TIME_TRAVEL_BUDGET_MILLIS,
  outcome,
  type BudgetOutcome,
} from './index.js';

/**
 * Measuring the two performance budgets in a real browser, throttled.
 *
 * ## Why a browser channel and not a downloaded Chromium
 *
 * `playwright-core` ships no browser binaries, and this package installs none. It launches the
 * Chromium-family browser the machine already has — Edge on Windows, Chrome elsewhere — through
 * Playwright's `channel` option. The reasons are practical and both matter: a 300 MB browser download
 * in the dependency tree of a monorepo that otherwise installs in seconds is a real cost paid by
 * everyone on every install, and CI runners for both Windows and Linux already have one of these.
 *
 * The trade-off is stated rather than hidden: the measurement is taken on whatever Chromium version
 * the host has, so a figure is comparable across runs on the same runner and only roughly comparable
 * across different ones. For a budget expressed as "under two seconds on a throttled phone" that is
 * the right precision — the number exists to catch a regression of hundreds of milliseconds, not to
 * benchmark a browser.
 */

/** Tried in order. The first that launches wins; all failing is an error, never a skip. */
const CHANNELS = ['msedge', 'chrome', 'chromium'] as const;

export interface LaunchedBrowser {
  readonly browser: Browser;
  /** Which channel answered, for the run's own log line. */
  readonly channel: string;
}

/**
 * Launches a throttleable browser, or explains why it could not.
 *
 * Every channel is attempted before giving up, and the failure names all of them. A CI log saying
 * "no browser" without saying what was looked for is a log somebody has to read this source to act on.
 */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  const failures: string[] = [];

  for (const channel of CHANNELS) {
    try {
      // `chromium` is the bundled-binary path and takes no channel; the others are installed browsers.
      const browser =
        channel === 'chromium'
          ? await chromium.launch({ headless: true })
          : await chromium.launch({ headless: true, channel });
      return { browser, channel };
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }

  throw new BrowserUnavailableError(failures.join('; '));
}

/**
 * Applies the throttled mid-tier mobile profile to one page.
 *
 * CPU and network throttling are Chrome DevTools Protocol calls, not Playwright options — there is no
 * cross-browser abstraction for them, which is the other reason this runner is Chromium-family only.
 * A `Page` with an emulated viewport but no throttling would report a laptop's numbers under a mobile
 * heading, which is worse than not measuring.
 */
export async function applyThrottling(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);

  await session.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE_PROFILE.cpuThrottlingRate });
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: THROTTLE_PROFILE.latencyMillis,
    downloadThroughput: THROTTLE_PROFILE.downloadThroughputBytesPerSecond,
    uploadThroughput: THROTTLE_PROFILE.uploadThroughputBytesPerSecond,
  });
}

/**
 * The report's Largest Contentful Paint, in milliseconds.
 *
 * The observer is installed as an init script so it is running *before* the document exists — attach
 * it after navigation and the entry for the paint you are trying to measure may already have been
 * emitted. `buffered: true` in the probe covers the same hazard from the other side.
 */
export async function measureReportLcp(browser: Browser, baseUrl: string): Promise<BudgetOutcome> {
  const context = await browser.newContext({
    viewport: { ...THROTTLE_PROFILE.viewport },
    deviceScaleFactor: THROTTLE_PROFILE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });

  try {
    const page = await context.newPage();
    await applyThrottling(page);

    await page.goto(`${baseUrl}/`, { waitUntil: 'commit', timeout: 60_000 });
    // The report is the largest text block on the page; waiting for it means the paint has happened.
    await page.waitForSelector('main#report', { timeout: 60_000 });

    const measuredMillis = await page.evaluate<number>(LCP_PROBE_SCRIPT);

    if (measuredMillis <= 0) {
      throw new Error(
        'The browser reported no largest-contentful-paint entry for `/`. That is not a fast page; it is a page ' +
          'that painted nothing measurable, and reporting it as 0 ms would be the one outcome worse than a failure.',
      );
    }

    return outcome({ name: 'Report render (LCP)', budgetMillis: REPORT_LCP_BUDGET_MILLIS, measuredMillis });
  } finally {
    await context.close();
  }
}

/**
 * How long a time-travel regeneration takes, from the request to a persisted report.
 *
 * Measured against the API rather than by driving the scrubber, and that is deliberate: the budget is
 * about the *regeneration*, and clicking through the UI would fold the click handler, a client
 * round-trip and a re-render into a number that is supposed to be about the pipeline. The scrubber's
 * own obligation — honest progress rather than hanging — is a separate claim, asserted by
 * `apps/web/tests/time-travel.test.ts`.
 *
 * `fetch` runs inside the throttled page, so the request crosses the same emulated Slow 4G link a
 * manager's phone would.
 */
export async function measureTimeTravel(
  browser: Browser,
  baseUrl: string,
  input: { readonly date: string; readonly teamKey: string },
): Promise<BudgetOutcome> {
  const context = await browser.newContext({
    viewport: { ...THROTTLE_PROFILE.viewport },
    deviceScaleFactor: THROTTLE_PROFILE.deviceScaleFactor,
  });

  try {
    const page = await context.newPage();
    await applyThrottling(page);
    // Same origin as the endpoint, so the POST is not a cross-origin request.
    await page.goto(`${baseUrl}/`, { waitUntil: 'commit', timeout: 60_000 });

    const result = await page.evaluate<{ readonly millis: number; readonly status: number; readonly body: string }>(
      `(async () => {
        const started = performance.now();
        const response = await fetch('/api/time-travel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(${JSON.stringify(input)}),
        });
        const body = await response.text();
        return { millis: performance.now() - started, status: response.status, body: body.slice(0, 400) };
      })()`,
    );

    if (result.status !== 200) {
      throw new Error(
        `POST /api/time-travel answered ${result.status}, so no regeneration was measured. The endpoint requires an ` +
          `owner or manager session and the seeded simulated clock. Response: ${result.body}`,
      );
    }

    return outcome({
      name: 'Time-travel regeneration',
      budgetMillis: TIME_TRAVEL_BUDGET_MILLIS,
      measuredMillis: result.millis,
    });
  } finally {
    await context.close();
  }
}
