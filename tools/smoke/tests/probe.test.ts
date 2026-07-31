import { afterEach, describe, expect, it } from 'vitest';

import {
  COLD_START_BUDGET_MILLIS,
  DEFAULT_SMOKE_URL,
  DeadSourceLinkError,
  ProbeTimeout,
  SMOKE_BUDGET_ENV_VAR,
  SMOKE_URL_ENV_VAR,
  assertFirstSourceLinkResolves,
  parseSmokeArgs,
  probeUntilReady,
  type ProbeAttempt,
} from '@compass/smoke';

/**
 * The wait loop, driven by a fake clock.
 *
 * The whole point of the probe is the deadline, and a test that waited real
 * seconds to check a sixty-second deadline would be the slowest test in the repo.
 * So `now`, `sleep` and `fetch` are all injected, and the clock only advances
 * because `sleep` advances it.
 */

interface Scripted {
  readonly status?: number;
  readonly body?: string;
  readonly throws?: string;
  /** Milliseconds this attempt takes before answering. */
  readonly costMillis?: number;
}

function harness(script: readonly Scripted[], budgetMillis = COLD_START_BUDGET_MILLIS) {
  let clock = 1_000;
  let index = 0;
  const attempts: ProbeAttempt[] = [];
  const slept: number[] = [];

  const run = () =>
    probeUntilReady({
      url: 'http://localhost:3000/',
      budgetMillis,
      intervalMillis: 1_000,
      now: () => clock,
      sleep: async (millis) => {
        slept.push(millis);
        clock += millis;
      },
      fetch: async () => {
        // Past the end of the script the server stays broken, which is what makes
        // the timeout path reachable without writing sixty entries.
        const step = script[index] ?? { throws: 'ECONNREFUSED' };
        index += 1;
        clock += step.costMillis ?? 0;
        if (step.throws !== undefined) throw new Error(step.throws);
        return { status: step.status ?? 200, text: async () => step.body ?? '<main>ok</main>' };
      },
      onAttempt: (attempt) => attempts.push(attempt),
    });

  return { run, attempts, slept, clockAt: () => clock };
}

describe('the probe returns the first real answer', () => {
  it('returns immediately when the first request answers 200 with a body', async () => {
    const { run, attempts } = harness([{ status: 200, body: '<main id="report">six sections</main>' }]);
    const result = await run();

    expect(result.status).toBe(200);
    expect(result.body).toContain('six sections');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.problem).toBeNull();
  });

  it('retries a connection refused, then a 503, then succeeds', async () => {
    const { run, attempts, slept } = harness([
      { throws: 'connect ECONNREFUSED 127.0.0.1:3000' },
      { status: 503 },
      { status: 200, body: '<main>ready</main>' },
    ]);

    const result = await run();

    expect(result.body).toBe('<main>ready</main>');
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.problem).toContain('ECONNREFUSED');
    expect(attempts[1]?.problem).toBe('the response was HTTP 503');
    expect(slept).toEqual([1_000, 1_000]);
  });

  it('retries a 200 with an empty body rather than calling it ready', async () => {
    const { run, attempts } = harness([{ status: 200, body: '' }, { status: 200, body: '<main>ready</main>' }]);
    const result = await run();

    expect(result.body).toBe('<main>ready</main>');
    expect(attempts[0]?.problem).toBe('the response was 200 with an empty body');
  });

  it('surfaces a redirect as a non-200 rather than following it', async () => {
    // `redirect: 'manual'` in the CLI means an auth redirect arrives here as a 302.
    // It must be visible as a status, not silently followed to a login page.
    const { run, attempts } = harness([{ status: 302 }, { status: 200 }]);
    await run();

    expect(attempts[0]?.status).toBe(302);
    expect(attempts[0]?.problem).toBe('the response was HTTP 302');
  });
});

describe('the deadline is measured from the first attempt', () => {
  it('reports elapsed time across the whole wait, not since the last attempt', async () => {
    const { run } = harness([{ throws: 'refused' }, { throws: 'refused' }, { status: 200 }]);
    const result = await run();

    // Two one-second sleeps between three attempts.
    expect(result.elapsedMillis).toBe(2_000);
    expect(result.attempts.map((attempt) => attempt.elapsedMillis)).toEqual([0, 1_000, 2_000]);
  });

  it('gives up once the budget is spent, naming the last problem', async () => {
    const { run } = harness([], 3_000);

    await expect(run()).rejects.toThrow(ProbeTimeout);
    await expect(run()).rejects.toThrow('did not return a report within 3s');
    await expect(run()).rejects.toThrow('ECONNREFUSED');
  });

  it('never sleeps past the deadline just to fail later', async () => {
    const { run, slept } = harness([], 2_500);

    await expect(run()).rejects.toThrow(ProbeTimeout);
    // 1000 + 1000 + 500: the last wait is clipped to what is left.
    expect(slept.reduce((sum, millis) => sum + millis, 0)).toBeLessThanOrEqual(2_500);
    expect(slept[slept.length - 1]).toBe(500);
  });

  it('counts a slow response against the budget, not only the sleeps', async () => {
    const { run } = harness([{ costMillis: 4_000, throws: 'timed out' }], 3_000);

    const failure = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProbeTimeout);
    expect((failure as ProbeTimeout).attempts).toHaveLength(1);
  });

  it('always makes at least one attempt, even with a spent budget', async () => {
    const { run } = harness([{ status: 200, body: '<main>ready</main>' }], 0);

    // A zero budget must still report what the server said rather than nothing:
    // "the deadline had already passed" is a useless diagnosis on its own.
    await expect(run()).resolves.toMatchObject({ status: 200 });
  });
});

describe('following an evidence link', () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
  });

  const respondWith = (status: number, body: string) => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      seen.push(String(input));
      return { status, text: async () => body } as Response;
    }) as typeof fetch;
    return seen;
  };

  it('resolves the href against the page url and accepts a page', async () => {
    const seen = respondWith(200, '<main>pull request #883</main>');

    await expect(
      assertFirstSourceLinkResolves('http://web:3000/', ['/artifact/pull_request/pr-883']),
    ).resolves.toBeUndefined();
    expect(seen).toEqual(['http://web:3000/artifact/pull_request/pr-883']);
  });

  it('refuses a link that 404s, because a dead link cannot be checked', async () => {
    respondWith(404, 'not found');

    await expect(assertFirstSourceLinkResolves('http://web:3000/', ['/artifact/issue/DEV-1'])).rejects.toThrow(
      DeadSourceLinkError,
    );
    await expect(assertFirstSourceLinkResolves('http://web:3000/', ['/artifact/issue/DEV-1'])).rejects.toThrow(
      'HTTP 404',
    );
  });

  it('refuses a link that answers 200 with nothing', async () => {
    respondWith(200, '');

    await expect(assertFirstSourceLinkResolves('http://web:3000/', ['/artifact/issue/DEV-1'])).rejects.toThrow(
      'the response body was empty',
    );
  });

  it('says nothing when there is no link to follow, leaving that to the html check', async () => {
    // An empty report legitimately links to nothing; `inspectReportHtml` is what
    // decides whether that is acceptable, and this must not pre-empt it.
    respondWith(500, '');
    await expect(assertFirstSourceLinkResolves('http://web:3000/', [])).resolves.toBeUndefined();
  });

  it('reports a refused connection as a dead link rather than crashing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
    }) as typeof fetch;

    await expect(assertFirstSourceLinkResolves('http://web:3000/', ['/artifact/issue/DEV-1'])).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

describe('the command line', () => {
  it('defaults to localhost and the 60-second criterion', () => {
    expect(parseSmokeArgs([], {})).toEqual({
      url: DEFAULT_SMOKE_URL,
      budgetMillis: COLD_START_BUDGET_MILLIS,
    });
    expect(COLD_START_BUDGET_MILLIS).toBe(60_000);
  });

  it('prefers a positional url over the environment', () => {
    const options = parseSmokeArgs(['http://compass.test/'], { [SMOKE_URL_ENV_VAR]: 'http://ignored/' });
    expect(options.url).toBe('http://compass.test/');
  });

  it('reads the url and the budget from the environment', () => {
    const options = parseSmokeArgs([], {
      [SMOKE_URL_ENV_VAR]: 'http://web:3000/',
      [SMOKE_BUDGET_ENV_VAR]: '90000',
    });

    expect(options).toEqual({ url: 'http://web:3000/', budgetMillis: 90_000 });
  });

  it('ignores an unusable budget rather than waiting zero milliseconds', () => {
    for (const value of ['', 'soon', '0', '-5']) {
      expect(parseSmokeArgs([], { [SMOKE_BUDGET_ENV_VAR]: value }).budgetMillis).toBe(COLD_START_BUDGET_MILLIS);
    }
  });

  it('ignores flags when looking for the url', () => {
    expect(parseSmokeArgs(['--verbose', 'http://web:3000/'], {}).url).toBe('http://web:3000/');
  });
});
