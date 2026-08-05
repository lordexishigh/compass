import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  JIRA_SIGNATURE_HEADER,
  WEBHOOK_PROVIDERS,
  WEBHOOK_SECRET_ENV_VAR,
  githubSignatureFor,
  jiraSignatureFor,
} from '@compass/auth';
import type { CompassDatabase } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER, slackSignatureFor } from '@compass/delivery';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../app/api/webhooks/[provider]/route';
import { fixtureCredential } from './helpers/fixture-credentials';

/**
 * The webhook route, end to end through the handler.
 *
 * The acceptance criteria are stated in terms of *responses and log entries* — "SHALL return 401 and
 * write a log entry naming the provider" — so they are asserted here, on the real handler, rather
 * than only against the verifier. `packages/auth/tests/webhooks.test.ts` covers the arithmetic; this
 * covers what a provider and an operator actually see.
 */

const SECRET = fixtureCredential('webhook-signing');
const BODY = JSON.stringify({ action: 'opened', number: 9201 });

/**
 * The one thing stubbed: the connection pool.
 *
 * The handler opens with `guard()`, which resolves who is asking before it does anything else, and
 * that needs a database. So the seam between "this process" and "a database somewhere" is replaced
 * with a real migrated PostgreSQL 17 through PGlite, exactly as `login-route.test.ts` does it, and
 * every layer above it is the production path — including the guard, which is what proves a webhook
 * goes through the matrix like everything else rather than around it.
 */
const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

let database: TestDatabase;
const originalEnv = new Map<string, string | undefined>();
let warnings: string[] = [];
let infos: string[] = [];

beforeAll(async () => {
  // The seeded tenant, because `guard` resolves the request's organization through
  // `resolveSeededRun` and a database without that row would scope every query to nothing.
  database = await createMigratedTestDatabase({
    organizationId: SEEDED_ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-systems-webhooks',
    timezone: 'Europe/London',
    at: new Date(Date.parse('2026-08-01T00:00:00Z')),
  });
  pool.current = database.db;
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(() => {
  for (const provider of WEBHOOK_PROVIDERS) {
    const variable = WEBHOOK_SECRET_ENV_VAR[provider];
    originalEnv.set(variable, process.env[variable]);
    process.env[variable] = SECRET;
  }

  warnings = [];
  infos = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  for (const [variable, value] of originalEnv) {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
  }
  originalEnv.clear();
  vi.restoreAllMocks();
});

/** Posts a body to one provider's webhook with whatever headers were given. */
const post = async (provider: string, headers: Record<string, string>, body = BODY) =>
  POST(
    new Request(`https://compass.example.com/api/webhooks/${provider}`, { method: 'POST', headers, body }),
    { params: Promise.resolve({ provider }) },
  );

const githubHeaders = (body = BODY, signature?: string) => ({
  [GITHUB_SIGNATURE_HEADER]: signature ?? githubSignatureFor(body, SECRET),
  [GITHUB_EVENT_HEADER]: 'pull_request',
  [GITHUB_DELIVERY_HEADER]: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  'content-type': 'application/json',
});

const slackHeaders = (body = BODY, secondsFromNow = 0) => {
  const timestamp = String(Math.floor(Date.now() / 1000) + secondsFromNow);
  return {
    [SLACK_SIGNATURE_HEADER]: slackSignatureFor(body, timestamp, SECRET),
    [SLACK_TIMESTAMP_HEADER]: timestamp,
    'content-type': 'application/json',
  };
};

const jiraHeaders = (body = BODY, signature?: string) => ({
  [JIRA_SIGNATURE_HEADER]: signature ?? jiraSignatureFor(body, SECRET),
  'content-type': 'application/json',
});

/**
 * Flips the last hex digit: still a well-formed signature, no longer the right one.
 *
 * Conditional on what the digit already is, which is not fastidiousness — the first version of this
 * appended a literal `'0'`, so on the runs where the digest happened to end in `0` the "tampered"
 * signature was the genuine one and the test asserted 401 against a legitimate request. It failed
 * loudly, but a suite where it had been the *negative* case would have passed while checking nothing.
 */
const tamper = (signature: string): string =>
  `${signature.slice(0, -1)}${signature.slice(-1) === '0' ? '1' : '0'}`;

describe('a verified delivery is accepted', () => {
  it('accepts a genuine GitHub signature with 202', async () => {
    const response = await post('github', githubHeaders());

    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean; provider: string; detail: string };
    expect(body.accepted).toBe(true);
    expect(body.provider).toBe('github');
    // Honest about what acceptance means: a hint, not an ingest.
    expect(body.detail).toContain('next incremental ingest');
  });

  it('accepts a genuine Slack signature inside the window', async () => {
    const response = await post('slack', slackHeaders());

    expect(response.status).toBe(202);
  });

  it('accepts both of Jira’s forms', async () => {
    expect((await post('jira', jiraHeaders())).status).toBe(202);
  });

  it('logs the delivery by its identifiers and never by its body', async () => {
    await post('github', githubHeaders());

    const line = infos.join('\n');
    expect(line).toContain('github');
    expect(line).toContain('pull_request');
    expect(line).toContain('72d3162e-cc78-11e3-81ab-4c9367dc0958');
    // A Jira issue update carries summaries and comments. None of that belongs in Compass's log.
    expect(line).not.toContain(BODY);
    expect(line).not.toContain('9201');
  });
});

describe('a tampered signature over a valid body is refused', () => {
  it.each([...WEBHOOK_PROVIDERS])('answers 401 for %s and writes a log entry naming it', async (provider) => {
    /**
     * The acceptance criterion, verbatim: a valid body arrives with a tampered signature, the
     * system returns 401 and writes a log entry naming the provider.
     */
    const headers =
      provider === 'github'
        ? githubHeaders(BODY, tamper(githubSignatureFor(BODY, SECRET)))
        : provider === 'slack'
          ? { ...slackHeaders(), [SLACK_SIGNATURE_HEADER]: `v0=${'0'.repeat(64)}` }
          : jiraHeaders(BODY, tamper(jiraSignatureFor(BODY, SECRET)));

    const response = await post(provider, headers);

    expect(response.status).toBe(401);

    const logged = warnings.join('\n');
    expect(logged, `the refusal must name ${provider}`).toContain(provider);
    expect(logged, 'the operator has to know which secret to look at').toContain(WEBHOOK_SECRET_ENV_VAR[provider]);
  });

  it('says only that the signature did not verify, never which check failed', async () => {
    // Telling an unauthenticated caller whether they failed on the signature, the timestamp or a
    // missing secret is a tuning signal. The detail goes to the log; the caller gets one sentence.
    const response = await post('github', githubHeaders(BODY, tamper(githubSignatureFor(BODY, SECRET))));
    const body = (await response.json()) as { error: string; detail: string };

    expect(body.error).toBe('signature_not_verified');
    expect(body.detail).not.toContain('bad_signature');
    expect(body.detail).not.toContain('stale');
    expect(body.detail).not.toContain('malformed');
  });

  it('refuses a body altered after it was signed', async () => {
    const signed = githubHeaders(BODY);
    const response = await post('github', signed, BODY.replace('9201', '9202'));

    expect(response.status).toBe(401);
  });

  it('refuses when the secret is not configured, rather than accepting the unverifiable', async () => {
    delete process.env[WEBHOOK_SECRET_ENV_VAR.github];

    const response = await post('github', githubHeaders());

    expect(response.status).toBe(401);
    expect(warnings.join('\n')).toContain('GITHUB_WEBHOOK_SECRET is not set');
  });

  it('refuses a delivery with no signature at all', async () => {
    const response = await post('github', { 'content-type': 'application/json' });

    expect(response.status).toBe(401);
    expect(warnings.join('\n')).toContain('github');
  });
});

describe('Slack’s five-minute window', () => {
  it('refuses a request older than five minutes even though the signature is valid', async () => {
    // The criterion names this specifically: the timestamp is checked *regardless* of whether the
    // signature verifies, because a captured request stays validly signed forever.
    const response = await post('slack', slackHeaders(BODY, -(5 * 60 + 30)));

    expect(response.status).toBe(401);
    expect(warnings.join('\n')).toContain('300 seconds');
  });

  it('refuses a request dated in the future by more than the window', async () => {
    const response = await post('slack', slackHeaders(BODY, 5 * 60 + 30));

    expect(response.status).toBe(401);
  });

  it('accepts one just inside the window, so the bound is a window and not a rejection', async () => {
    const response = await post('slack', slackHeaders(BODY, -(4 * 60)));

    expect(response.status).toBe(202);
  });
});

describe('the route itself', () => {
  it('refuses a provider it does not know, without pretending to authenticate it', async () => {
    const response = await post('gitlab', { 'content-type': 'application/json' });

    // Not 401: nothing was claimed, so nothing failed to authenticate. Naming the accepted
    // providers is what makes a mistyped URL diagnosable, and they are in the documentation anyway.
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('unknown_provider');
    expect(body.detail).toContain('github');
  });

  it('reads the body once, as text, so nothing is verified against a re-serialisation', async () => {
    // Behavioural: a body whose key order differs would produce a different HMAC. The accepting
    // case above proves the handler hashed exactly the bytes that arrived.
    const reordered = JSON.stringify({ number: 9201, action: 'opened' });
    expect(reordered).not.toBe(BODY);

    // Signed as the reordered bytes, sent as the reordered bytes: accepted.
    expect((await post('github', githubHeaders(reordered), reordered)).status).toBe(202);
    // Signed as one, sent as the other: refused.
    expect((await post('github', githubHeaders(BODY), reordered)).status).toBe(401);
  });

  it('never sets a session cookie, whatever the outcome', async () => {
    // A webhook is authenticated by a signature over one delivery. It must not leave behind a
    // credential that authenticates anything else.
    for (const headers of [githubHeaders(), githubHeaders(BODY, `v0=${'0'.repeat(64)}`)]) {
      const response = await post('github', headers);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('answers no-store, so no proxy caches an acceptance or a refusal', async () => {
    expect((await post('github', githubHeaders())).headers.get('cache-control')).toBe('no-store');
    expect((await post('github', {})).headers.get('cache-control')).toBe('no-store');
  });
});
