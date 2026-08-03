import {
  BudgetExceededError,
  BrowserUnavailableError,
  THROTTLE_PROFILE,
  resolveBaseUrl,
  type BudgetOutcome,
} from './index.js';
import { launchBrowser, measureReportLcp, measureTimeTravel } from './measure.js';

/**
 * `pnpm perf` — measure the two performance budgets against a running deployment.
 *
 * Separate from `pnpm test` for the reason `docs/budgets.md` states: a unit-test runner cannot measure
 * a paint. This needs a server on the other end and a browser on this one, which makes it a CI job of
 * the same shape as `pnpm smoke`.
 *
 * ## Exit codes
 *
 * `0` only when every budget was measured and every measurement was within it. A browser that could
 * not launch, a page that painted nothing, an endpoint that refused — all `1`. There is deliberately
 * no "could not measure, so passing" path: a green performance job that took no measurement is a
 * report that the product is fast, issued by something that did not look.
 *
 * ## What the time-travel step needs
 *
 * A seeded deployment with a session that may regenerate. `COMPASS_PERF_TIME_TRAVEL_DATE` and
 * `COMPASS_PERF_TEAM` name the day and team; without a date the step is *reported as not run* rather
 * than silently skipped, because "we did not measure this" and "this was within budget" must never
 * print the same way.
 */

const DATE_ENV_VAR = 'COMPASS_PERF_TIME_TRAVEL_DATE';
const TEAM_ENV_VAR = 'COMPASS_PERF_TEAM';

async function main(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const { browser, channel } = await launchBrowser();

  console.info(
    `[compass] measuring performance budgets against ${baseUrl} in ${channel}, at ` +
      `${THROTTLE_PROFILE.cpuThrottlingRate}x CPU and Slow 4G (${THROTTLE_PROFILE.latencyMillis} ms RTT).`,
  );

  const outcomes: BudgetOutcome[] = [];

  try {
    outcomes.push(await measureReportLcp(browser, baseUrl));

    const date = process.env[DATE_ENV_VAR];
    const teamKey = process.env[TEAM_ENV_VAR] ?? 'platform';

    if (date === undefined || date.length === 0) {
      // Stated, not skipped. The distinction is the whole point of this file.
      console.warn(
        `[compass] time-travel regeneration NOT MEASURED: set ${DATE_ENV_VAR} to a date inside the seeded history ` +
          `(and ${TEAM_ENV_VAR} if not \`platform\`). The report LCP budget below was measured; this one was not.`,
      );
    } else {
      outcomes.push(await measureTimeTravel(browser, baseUrl, { date, teamKey }));
    }
  } finally {
    await browser.close();
  }

  for (const entry of outcomes) {
    console.info(`[compass] ${entry.withinBudget ? 'within budget' : 'OVER BUDGET'} — ${entry.detail}`);
  }

  if (outcomes.some((entry) => !entry.withinBudget)) throw new BudgetExceededError(outcomes);
}

await main().catch((error: unknown) => {
  if (error instanceof BrowserUnavailableError || error instanceof BudgetExceededError) {
    console.error(`[compass] ${error.message}`);
  } else {
    console.error(
      `[compass] the performance run could not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
});
