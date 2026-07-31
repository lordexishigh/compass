import { setTimeout as delay } from 'node:timers/promises';

import { COLD_START_BUDGET_MILLIS, probeUntilReady } from './probe.js';
import { assertColdStartHtml } from './report-html.js';

/**
 * The cold-start smoke test, wired to a real clock and a real socket.
 *
 * Split from `cli.ts` so the argument parsing and the wiring can be tested without
 * a module that runs itself on import. `cli.ts` is the entry point and holds
 * nothing but the call.
 */

export interface SmokeOptions {
  readonly url: string;
  readonly budgetMillis: number;
}

export const DEFAULT_SMOKE_URL = 'http://localhost:3000/';
export const SMOKE_URL_ENV_VAR = 'COMPASS_SMOKE_URL';
export const SMOKE_BUDGET_ENV_VAR = 'COMPASS_SMOKE_BUDGET_MS';

/**
 * `smoke <url>`, then `COMPASS_SMOKE_URL`, then localhost.
 *
 * The budget is overridable because a cold CI runner starting Postgres and
 * PostgreSQL's own first-boot initdb is slower than a warm laptop, and a smoke test
 * that fails on runner variance rather than on a product defect gets disabled
 * within a week. The default stays at the 60-second criterion.
 */
export function parseSmokeArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SmokeOptions {
  const positional = argv.find((argument) => !argument.startsWith('-'));
  const configured = env[SMOKE_URL_ENV_VAR];
  const budget = env[SMOKE_BUDGET_ENV_VAR];
  const parsedBudget = budget === undefined ? Number.NaN : Number.parseInt(budget, 10);

  return {
    url: positional ?? (configured !== undefined && configured.length > 0 ? configured : DEFAULT_SMOKE_URL),
    budgetMillis: Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : COLD_START_BUDGET_MILLIS,
  };
}

export async function runSmoke(options: SmokeOptions): Promise<void> {
  console.info(
    `[smoke] fetching ${options.url} — a full six-section report must arrive within ` +
      `${(options.budgetMillis / 1000).toFixed(0)}s.`,
  );

  const result = await probeUntilReady({
    url: options.url,
    budgetMillis: options.budgetMillis,
    now: () => Date.now(),
    sleep: (millis) => delay(millis).then(() => undefined),
    // `redirect: 'manual'` is deliberate: an authentication redirect must be
    // *seen*, not silently followed to a login page that then fails a content
    // check for the wrong reason. A 302 surfaces as a retried non-200 and then as
    // a timeout naming the status, which is the honest diagnosis.
    fetch: (url) => fetch(url, { headers: { accept: 'text/html' }, redirect: 'manual' }),
    onAttempt: (attempt) => {
      if (attempt.problem === null) return;
      console.info(
        `[smoke] attempt ${attempt.attempt} at ${(attempt.elapsedMillis / 1000).toFixed(1)}s: ${attempt.problem}`,
      );
    },
  });

  const inspection = assertColdStartHtml(result.body, options.url);

  console.info(
    `[smoke] ${options.url} answered in ${(result.elapsedMillis / 1000).toFixed(1)}s with all six sections ` +
      `(${inspection.headingsFound.join(', ')}) and ${inspection.sourceLinks.length} source ` +
      `${inspection.sourceLinks.length === 1 ? 'link' : 'links'}.`,
  );

  await assertFirstSourceLinkResolves(options.url, inspection.sourceLinks);
}

export class DeadSourceLinkError extends Error {
  constructor(href: string, detail: string) {
    super(
      `The report links to ${href}, but that page did not resolve: ${detail}. ` +
        'A claim whose evidence link is dead is a claim that cannot be checked, which is the same failure as a ' +
        'claim with no link at all.',
    );
    this.name = 'DeadSourceLinkError';
  }
}

/**
 * Follows one evidence link and insists on a page.
 *
 * "At least one source link is present" is satisfied by a link to nowhere, and the
 * criterion is that a claim *resolves* to an artifact page. Checking the first link
 * rather than all of them is deliberate: they are all built by one function,
 * `artifactHref`, and served by one route segment, so if one resolves they all do —
 * and a report with forty claims should not cost forty requests in CI.
 */
export async function assertFirstSourceLinkResolves(
  pageUrl: string,
  sourceLinks: readonly string[],
): Promise<void> {
  const [href] = sourceLinks;
  if (href === undefined) return;

  const target = new URL(href, pageUrl).toString();
  let status: number;
  let body: string;

  try {
    const response = await fetch(target, { headers: { accept: 'text/html' }, redirect: 'manual' });
    status = response.status;
    body = await response.text();
  } catch (error) {
    throw new DeadSourceLinkError(target, error instanceof Error ? error.message : String(error));
  }

  if (status !== 200) throw new DeadSourceLinkError(target, `HTTP ${status}`);
  if (body.length === 0) throw new DeadSourceLinkError(target, 'the response body was empty');

  console.info(`[smoke] ${target} resolves, so the evidence markers on the report are followable.`);
}
