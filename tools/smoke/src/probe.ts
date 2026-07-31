/**
 * Waiting for a container without lying about how long it took.
 *
 * The cold-start criterion is a deadline — `/` answers with a full report within
 * 60 seconds — so the probe measures from when it was asked to start, not from
 * when the server happened to become reachable. A poll loop that reset its own
 * clock on each attempt could report four seconds after waiting five minutes.
 *
 * `elapsedMillis` is therefore taken from the caller's own `now`, and the deadline
 * is checked before each attempt rather than only after a failure. Everything is
 * injected — `now`, `fetch`, `sleep` — so the whole loop is testable without a
 * container, a network or a real second passing.
 */

export interface ProbeAttempt {
  readonly attempt: number;
  readonly elapsedMillis: number;
  /** Null when the request never produced a response. */
  readonly status: number | null;
  /** Why this attempt did not count as ready. Null when it did. */
  readonly problem: string | null;
}

export interface ProbeResult {
  readonly url: string;
  readonly body: string;
  readonly status: number;
  readonly elapsedMillis: number;
  readonly attempts: readonly ProbeAttempt[];
}

export class ProbeTimeout extends Error {
  readonly attempts: readonly ProbeAttempt[];

  constructor(url: string, budgetMillis: number, attempts: readonly ProbeAttempt[]) {
    const last = attempts[attempts.length - 1];
    super(
      `${url} did not return a report within ${(budgetMillis / 1000).toFixed(0)}s ` +
        `(${attempts.length} ${attempts.length === 1 ? 'attempt' : 'attempts'}). ` +
        `Last attempt: ${last?.problem ?? 'none was made'}.`,
    );
    this.name = 'ProbeTimeout';
    this.attempts = attempts;
  }
}

export interface ProbeOptions {
  readonly url: string;
  /** The whole budget, from the first attempt. Defaults to the 60s criterion. */
  readonly budgetMillis?: number;
  readonly intervalMillis?: number;
  /** Milliseconds since an arbitrary epoch. Injected so a test needs no clock. */
  readonly now: () => number;
  readonly sleep: (millis: number) => Promise<void>;
  readonly fetch: (url: string) => Promise<{ readonly status: number; text(): Promise<string> }>;
  /** Called after each attempt, so the CLI can narrate a long wait. */
  readonly onAttempt?: (attempt: ProbeAttempt) => void;
}

/** The zero-config criterion, in milliseconds. One number, named once. */
export const COLD_START_BUDGET_MILLIS = 60_000;

/**
 * Fetches a URL until it answers 200 with a body, or the budget runs out.
 *
 * A non-200 is retried rather than failed: a container mid-boot legitimately
 * answers 502 through a proxy, or 503 while the pool warms. What is *not* retried
 * is a 200 with a body — that is the answer, and whether it is a good answer is
 * `assertColdStartHtml`'s question, not this function's.
 */
export async function probeUntilReady(options: ProbeOptions): Promise<ProbeResult> {
  const budgetMillis = options.budgetMillis ?? COLD_START_BUDGET_MILLIS;
  const intervalMillis = options.intervalMillis ?? 1_000;
  const startedAt = options.now();
  const attempts: ProbeAttempt[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const elapsedBefore = options.now() - startedAt;
    if (attempt > 1 && elapsedBefore >= budgetMillis) break;

    let status: number | null = null;
    let body: string | null = null;
    let problem: string | null = null;

    try {
      const response = await options.fetch(options.url);
      status = response.status;
      if (response.status === 200) {
        body = await response.text();
        if (body.length === 0) problem = 'the response was 200 with an empty body';
      } else {
        problem = `the response was HTTP ${response.status}`;
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }

    const record: ProbeAttempt = {
      attempt,
      elapsedMillis: options.now() - startedAt,
      status,
      problem,
    };
    attempts.push(record);
    options.onAttempt?.(record);

    if (problem === null && body !== null && status !== null) {
      return { url: options.url, body, status, elapsedMillis: record.elapsedMillis, attempts };
    }

    // Sleeping past the deadline only delays the failure report, so the remaining
    // budget caps the wait and the loop re-checks it at the top.
    const remaining = budgetMillis - (options.now() - startedAt);
    if (remaining <= 0) break;
    await options.sleep(Math.min(intervalMillis, remaining));
  }

  throw new ProbeTimeout(options.url, budgetMillis, attempts);
}
