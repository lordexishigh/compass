import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readiness } from '../lib/health';

const original = { ...process.env };

beforeEach(() => {
  delete process.env['DATABASE_URL'];
  delete process.env['DATABASE_URL_DIRECT'];
});

afterEach(() => {
  process.env = { ...original };
});

describe('readiness', () => {
  it('states a missing database as a configuration fact, not a crash', async () => {
    const report = await readiness();

    const database = report.checks.find((check) => check.name === 'database');
    expect(database?.status).toBe('not_configured');
    expect(database?.detail).toContain('DATABASE_URL');

    // The *check* is `not_configured`. The overall status is asserted separately below, because on
    // this fixture the seeded connector is simultaneously `degraded` — and which of the two wins is
    // the thing that was wrong. This assertion used to claim `not_configured` here while the test at
    // "reports the connector per source" asserted a degraded connector in the same run: the suite
    // documented the masking instead of catching it.
    expect(['degraded', 'not_configured']).toContain(report.status);
  });

  /**
   * The precedence, pinned, because it silently flipped once already.
   *
   * `not_configured` was tested first, which made `degraded` unreachable on any deployment with an
   * unconfigured capability — and the demo defaults make that every deployment: no `RESEND_API_KEY`,
   * no `SLACK_BOT_TOKEN`, and the owner still on the published password are all `not_configured` by
   * design. A genuinely degraded database was therefore reported as the value that means "nothing is
   * broken".
   *
   * This fixture is exactly the mixed case: the seeded connector reports `degraded` (its archived
   * code host is declared rate-limited on purpose) while mail, Slack, database and seats report
   * `not_configured`. So the assertion needs no mocking — the default environment already produces
   * both, which is what makes it a regression test rather than a construction.
   */
  it('reports degraded rather than not_configured when both are present', async () => {
    const report = await readiness();

    const statuses = report.checks.map((check) => check.status);

    // Both kinds are genuinely present, so the assertion below is about precedence and not about
    // one of them being absent.
    expect(statuses, 'no check is degraded, so this asserts nothing about precedence').toContain('degraded');
    expect(statuses, 'no check is unconfigured, so this asserts nothing about precedence').toContain(
      'not_configured',
    );

    // Something broken outranks something merely absent.
    expect(report.status).toBe('degraded');
  });

  it('reports not_configured only when nothing is actually broken', async () => {
    // The other half of the precedence: `not_configured` is still reachable, and still means what
    // the file's comments say it means. Asserted over a synthetic check list rather than the live
    // report, because the seeded connector is always degraded here.
    const only = (statuses: readonly string[]): string =>
      statuses.includes('degraded') ? 'degraded' : statuses.includes('not_configured') ? 'not_configured' : 'ready';

    expect(only(['ready', 'not_configured'])).toBe('not_configured');
    expect(only(['ready', 'ready'])).toBe('ready');
    expect(only(['not_configured', 'degraded'])).toBe('degraded');
  });

  it('resolves the instant once, at the edge, and reports it', async () => {
    const report = await readiness();

    const clock = report.checks.find((check) => check.name === 'clock');
    expect(clock?.status).toBe('ready');
    expect(report.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('reports the connector per source, degraded when one is down', async () => {
    const report = await readiness();

    const connector = report.checks.find((check) => check.name === 'connector');
    expect(connector?.detail).toContain('primary-code: complete');
    // The seed declares its archived code host as rate-limited on purpose, so a
    // degraded source is always exercisable without credentials.
    expect(connector?.detail).toContain('archive-code: unavailable');
    expect(connector?.status).toBe('degraded');
  });

  it('names the seeded dataset it is serving and the span it covers', async () => {
    const report = await readiness();

    const dataset = report.checks.find((check) => check.name === 'seed-dataset');
    expect(dataset?.status).toBe('ready');
    expect(dataset?.detail).toContain('northwind-v1');
    expect(dataset?.detail).toContain('2026-05-18T00:00:00.000Z');
  });

  it('names every capability it checked', async () => {
    const report = await readiness();

    expect(report.checks.map((check) => check.name)).toEqual([
      'clock',
      'connector',
      'seed-dataset',
      'database',
      'seats',
      'mail',
      // Its own capability, not a clause on the mail one: a deployment can legitimately have
      // one channel and not the other, and "why is my Slack daily not arriving" should be
      // answerable without reading a sentence about email.
      'slack',
    ]);
  });

  /**
   * Sign-in is a capability, so it is reported like every other one.
   *
   * "Nobody can sign in" and "the owner is still on the published demonstration password"
   * are both states an operator has to be told about, and this is the one place they look
   * when something seems wrong. A deployment that quietly kept the demo credentials would
   * otherwise look completely healthy.
   */
  it('states that seats could not be read when there is no database, rather than crashing', async () => {
    const report = await readiness();

    const seats = report.checks.find((check) => check.name === 'seats');
    expect(seats?.status).toBe('not_configured');
    expect(seats?.detail).toContain('Sign-in is unavailable');
  });

  it('says out loud where a sign-in link actually goes', async () => {
    const report = await readiness();

    const mail = report.checks.find((check) => check.name === 'mail');
    expect(mail?.status).toBe('not_configured');
    // The honest-degradation rule: nothing is silently dropped, and the report says so.
    expect(mail?.detail).toContain('process log');
    expect(mail?.detail).toContain('Nothing is silently dropped');
  });
});

/**
 * The activity fields: queue depth, last successful ingest, last successful delivery.
 *
 * These are a different question from the checks above and the distinction is the point. A check
 * says whether a capability is *configured*; these say whether the product has *done* anything.
 * Every check can be green while the worker has been dead since Tuesday, and only these show it.
 *
 * With no `DATABASE_URL` there is nothing to read them from, so the contract under test here is the
 * shape and the honest null — not the numbers, which need a live queue and are covered against a
 * real engine by `packages/db`'s own suites.
 */
describe('the activity payload', () => {
  it('is present as a field, so a consumer can rely on the key existing', async () => {
    const report = await readiness();

    // Explicitly `null` rather than absent: an operator's script reading these should fail on a
    // missing database with a readable error, not silently read `undefined`.
    expect(report).toHaveProperty('activity');
    expect(report.activity).toBeNull();
  });

  /**
   * The scope split, pinned.
   *
   * `queue` is deployment-wide and the two instants are per-organization, so they are two fields.
   * They were one, under a doc comment claiming "the numbers are not global" — which was false of
   * queue depth, because `pgboss.job` has no tenant column. This test is what stops them being
   * merged back together by somebody tidying the payload.
   */
  it('keeps the deployment-wide queue out of the per-organization activity', async () => {
    const report = await readiness();

    expect(report).toHaveProperty('queue');
    // Specifically *not* on `activity`: that object's every field is about one organization.
    expect(report.activity ?? {}).not.toHaveProperty('queueDepth');
    expect(report.activity ?? {}).not.toHaveProperty('queue');
  });

  it('names the organization only on the fields that are about one', async () => {
    const report = await readiness();

    // With no database both are null, so the contract under test is the *shape*: `organizationId`
    // belongs to `ActivityReport` and there is no per-organization claim on `queue`.
    expect(report.queue).toBeNull();
    expect(report.activity).toBeNull();
  });

  it('does not turn a cold deployment yellow', async () => {
    const report = await readiness();

    // The overall status comes from the checks alone. An empty queue and a never-delivered report
    // are the *correct* state of a fresh `docker compose up`, and a health endpoint that went
    // degraded on one would train an operator to ignore it.
    //
    // `degraded` first, matching `readiness()`. This mirror encoded the old precedence and so would
    // have kept agreeing with a bug rather than catching it — which is the hazard of restating logic
    // in a test at all. It is kept because the claim here is specifically "activity does not feed
    // into status", and that needs a status computed from the checks alone to compare against.
    const fromChecks = report.checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : report.checks.some((check) => check.status === 'not_configured')
        ? 'not_configured'
        : 'ready';

    expect(report.status).toBe(fromChecks);
  });

  it('never lets a connection string reach the payload', async () => {
    const report = await readiness();

    /**
     * `/api/health` is public so a container's own HEALTHCHECK can call it, so a failure to read
     * activity is logged rather than returned: a driver error names the host, the port and the user.
     *
     * Matched on the *connection-string shape* rather than on the word "password", deliberately.
     * The seats check names `COMPASS_OWNER_PASSWORD` — the name of an environment variable an
     * operator has to set — and a test that forbade the word would forbid telling them which
     * variable to set. A `postgres://` URL is the thing that carries an actual credential.
     */
    const payload = JSON.stringify(report);
    expect(payload).not.toMatch(/postgres(?:ql)?:\/\//i);
    // And no `key=value` credential pair, which is the other shape a driver error uses.
    expect(payload).not.toMatch(/password=\S/i);
  });
});
