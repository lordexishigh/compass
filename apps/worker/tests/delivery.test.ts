import { randomUUID } from 'node:crypto';

import { instantFromIso, toEpochMillis, type Instant } from '@compass/clock';
import {
  ScopedDb,
  listDeliveryAttempts,
  orgScope,
  organizations,
  recordDeliveryAttempt,
  reports,
  subscriptions,
  upsertSubscription,
  users,
  type StoredReportBundle,
} from '@compass/db';
import { createTestDatabase, type TestDatabase } from '@compass/db/testing';
import { FakeEmailTransport, FakeSlackTransport } from '@compass/delivery/testkit';
import { RecordingSink } from '@compass/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DELIVERY_RETRY_LIMIT,
  InvalidDeliveryPayloadError,
  deliveryJobOptions,
  deliveryJobsDue,
  handleReportDeliver,
  type DeliveryDependencies,
} from '../src/delivery.js';

/**
 * The delivery job, against a real migrated database.
 *
 * Every guarantee this handler makes is about *what got written* — a `delivery_log` row for every
 * attempt, exactly one `sent` row per scheduled delivery, a `deferred` row rather than an empty
 * message — so the assertions read the table rather than the return value alone. The transports
 * are the testkit fakes, so the production code path runs with the network removed.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SUBSCRIPTION = '33333333-3333-4333-8333-333333333333';
/** A real `reports` row: `delivery_log.report_id` is a uuid with a foreign key to it. */
const REPORT = '44444444-4444-4444-8444-444444444444';

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-03T07:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
let email: FakeEmailTransport;
let slack: FakeSlackTransport;

const scoped = () => new ScopedDb(database.db, orgScope(ORG));

/** A minimal persisted bundle: six sections, each with one item. */
const bundle = (reportId = REPORT): StoredReportBundle =>
  ({
    report: {
      id: reportId,
      organizationId: ORG,
      scopeKind: 'team',
      scopeKey: 'platform',
      reportDate: '2026-08-03',
      coverageStatus: 'complete',
      prose: 'The whole report.',
      timezone: 'Europe/London',
    },
    sections: ['yesterday', 'progress', 'blockers', 'risks', 'recommendations', 'wins'].map(
      (sectionKey, index) => ({
        id: `${reportId}-${sectionKey}`,
        sectionKey,
        ordinal: index + 1,
        title: sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1),
        prose: `The ${sectionKey} prose.`,
        payload: {},
        itemCount: 1,
        emptyStatement: `Nothing for ${sectionKey}.`,
        summary: `The ${sectionKey} lead.`,
        items: [
          {
            id: `${reportId}-${sectionKey}-1`,
            ordinal: 1,
            stableId: `${sectionKey}:1`,
            causeEntityRef: `ticket:${sectionKey.toUpperCase()}-1`,
            // `status_dwell` on purpose: a blockers item with this cause offers the
            // already-resolved and snooze actions, so the email and Slack renders under test
            // actually carry buttons rather than exercising the no-offers branch.
            causeKind: 'status_dwell',
            causeDiscriminator: '',
            headline: 'A headline',
            detail: 'A detail',
            prose: `A claim about ${sectionKey}.`,
            changeTag: 'unchanged',
            ageDays: 1,
            firstSeenAt: 1_785_000_000_000 as never,
            severityScore: 4,
            signalOnsetAt: 1_785_000_000_000 as never,
            feedbackState: null,
            changeClause: null,
            ladder: null,
            payload: {},
            evidence: [],
          },
        ],
      }),
    ),
  }) as unknown as StoredReportBundle;

const dependencies = (
  overrides: Partial<DeliveryDependencies> = {},
): DeliveryDependencies => ({
  scopedFor: () => scoped(),
  loadReport: async () => bundle(),
  renderStored: (stored) => {
    const sections = stored.sections.map((section) => ({
      key: section.sectionKey as never,
      index: section.ordinal,
      numeral: String(section.ordinal).padStart(2, '0'),
      title: section.title,
      prose: section.prose,
      lead: section.summary ?? section.emptyStatement,
      claims: section.items.map((item) => ({ stableId: item.stableId, prose: item.prose })),
      trailer: null,
    }));
    return {
      rendererId: 'template' as never,
      masthead: 'Compass — platform — 2026-08-03',
      freshness: 'Every source answered for the window.',
      changeLine: 'Nothing material changed since yesterday.',
      sections,
      prose: stored.report.prose,
      text: 'the text form',
    };
  },
  email,
  slack,
  baseUrl: 'https://compass.acme.example',
  unsubscribeUrlFor: (subscription) =>
    `https://compass.acme.example/api/delivery/unsubscribe?token=${subscription.unsubscribeTokenHash}`,
  // Real UUIDs: `delivery_log.id` is a uuid column, and a readable-but-invalid id would fail at
  // the insert rather than at the assertion.
  newId: () => randomUUID(),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  ...overrides,
});

/**
 * A distinct civil date per test.
 *
 * `delivery_log` is append-only — deliberately, since it is the record of what the provider said —
 * so a test cannot clear it between cases. Giving each test its own `deliveryDate` makes each one a
 * genuinely separate scheduled delivery instead, which is both closer to reality and the only way
 * to assert "exactly one row" without deleting history.
 */
let testDate = '';
let dayCounter = 0;

const payload = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  subscriptionId: SUBSCRIPTION,
  deliveryDate: testDate,
  scopeKind: 'team' as const,
  scopeKey: 'platform',
  ...overrides,
});

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  await database.db
    .insert(organizations)
    .values({
      id: ORG,
      organizationId: ORG,
      name: 'Acme',
      slug: 'acme',
      timezone: 'Europe/London',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .onConflictDoNothing()
    .execute();

  await scoped()
    .insertInto(users, {
      id: USER,
      email: 'priya@acme.example',
      displayName: 'Priya Raman',
      passwordHash: null,
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  // The report the delivery log points at. Inserted directly rather than through `saveReport`
  // because the handler under test only ever reads it through the injected `loadReport`; what the
  // database needs is a row for the foreign key to resolve against.
  await scoped()
    .insertInto(reports, {
      id: REPORT,
      scopeKind: 'team',
      scopeKey: 'platform',
      schemaVersion: 1,
      reportInstant: asDate('2026-08-03T06:00:00Z'),
      reportDate: '2026-08-03',
      timezone: 'Europe/London',
      windowStart: asDate('2026-08-02T00:00:00Z'),
      windowEnd: asDate('2026-08-03T00:00:00Z'),
      contentHash: 'a'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: 'The whole report.',
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'complete',
      ingestRunId: null,
      generatedAt: asDate('2026-08-03T06:00:00Z'),
    })
    .execute();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  email = new FakeEmailTransport();
  slack = new FakeSlackTransport();
  dayCounter += 1;
  /**
   * Rolled through months rather than counted up within one.
   *
   * `2026-09-${n}` was fine at seventeen tests and became a trap at thirty: the thirty-first case
   * would have produced `2026-09-31` and failed on an invalid date at the insert rather than on an
   * assertion, which is the kind of failure that costs an afternoon to read. Twenty-eight days per
   * month keeps every generated date valid in every month, so the only cost of adding a test here is
   * the test.
   */
  const dayOfMonth = ((dayCounter - 1) % 28) + 1;
  const month = 9 + Math.floor((dayCounter - 1) / 28);
  testDate = `2026-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;

  await upsertSubscription(
    scoped(),
    {
      id: SUBSCRIPTION,
      userId: USER,
      channel: 'email',
      target: 'priya@acme.example',
      scope: 'team',
      sendTime: '07:30',
      timezone: 'Europe/London',
      unsubscribeTokenHash: 'a'.repeat(64),
    },
    NOW,
  );
});

describe('a due delivery with a report to send', () => {
  it('sends it and records a `sent` attempt', async () => {
    const result = await handleReportDeliver(dependencies(), payload(), NOW);

    expect(result.status).toBe('sent');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe('priya@acme.example');

    const attempts = await listDeliveryAttempts(scoped(), {
      subscriptionId: SUBSCRIPTION,
      deliveryDate: testDate,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('sent');
    expect(attempts[0]?.reportId).toBe(REPORT);
    expect(attempts[0]?.attempt).toBe(1);
  });

  it('carries the scheduled delivery into the provider idempotency key', async () => {
    await handleReportDeliver(dependencies(), payload(), NOW);

    // The bug this guards: keying on the subject would give every subscriber of the same team
    // and date the same key, and the provider would deduplicate all but the first away.
    expect(email.sent[0]?.delivery).toEqual({
      subscriptionId: SUBSCRIPTION,
      deliveryDate: testDate,
      scopeKind: 'team',
      scopeKey: 'platform',
    });
  });

  it('delivers the whole report inline, not a link to it', async () => {
    await handleReportDeliver(dependencies(), payload(), NOW);

    const html = email.sent[0]?.rendered.html ?? '';
    for (const title of ['Yesterday', 'Progress', 'Blockers', 'Risks', 'Recommendations', 'Wins']) {
      expect(html).toContain(title);
    }
    expect(html).not.toMatch(/click here to view/i);
  });
});

describe('the same job enqueued twice', () => {
  it('sends exactly one message', async () => {
    const first = await handleReportDeliver(dependencies(), payload(), NOW);
    const second = await handleReportDeliver(dependencies(), payload(), NOW, 2);

    expect(first.status).toBe('sent');
    // The pre-send check: the second job declines to call the provider at all.
    expect(second.status).toBe('already_sent');
    expect(email.sent, 'exactly one message for one scheduled delivery').toHaveLength(1);
  });

  it('is refused by the database even if two workers race past the pre-send check', async () => {
    await handleReportDeliver(dependencies(), payload(), NOW);

    // Simulates the race: both workers read "not sent yet", both send, both try to record. The
    // partial unique index is the only thing that holds here, which is why it is in the schema.
    await expect(
      recordDeliveryAttempt(
        scoped(),
        {
          id: randomUUID(),
          subscriptionId: SUBSCRIPTION,
          reportId: null,
          deliveryDate: testDate,
          scopeKind: 'team',
          scopeKey: 'platform',
          channel: 'email',
          target: 'priya@acme.example',
          attempt: 1,
          status: 'sent',
          providerMessageId: null,
          error: null,
          detail: 'racing',
        },
        NOW,
      ),
    ).rejects.toThrow();
  });

  it('uses the scheduled delivery as the pg-boss singleton key', () => {
    const options = deliveryJobOptions(payload());

    expect(options.singletonKey).toBe(`compass:${SUBSCRIPTION}:${testDate}:team:platform`);
    expect(options.retryLimit).toBe(DELIVERY_RETRY_LIMIT);
    expect(options.retryBackoff).toBe(true);
  });
});

describe('when there is no report yet', () => {
  it('defers rather than sending an empty message', async () => {
    const result = await handleReportDeliver(
      dependencies({ loadReport: async () => null }),
      payload(),
      NOW,
    );

    expect(result.status).toBe('deferred');
    expect(email.sent, 'nothing may be sent when there is nothing to send').toHaveLength(0);

    const attempts = await listDeliveryAttempts(scoped(), {
      subscriptionId: SUBSCRIPTION,
      deliveryDate: testDate,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('deferred');
    // Null because there was no report to point at — that is the content of the outcome.
    expect(attempts[0]?.reportId).toBeNull();
    expect(attempts[0]?.detail).toContain('No report exists yet');
  });

  it('does not throw, so the tick continues for every other subscriber', async () => {
    await expect(
      handleReportDeliver(dependencies({ loadReport: async () => null }), payload(), NOW),
    ).resolves.toMatchObject({ status: 'deferred' });
  });
});

describe('when no provider key is configured', () => {
  it('records the skip naming the variable and does not throw', async () => {
    const result = await handleReportDeliver(
      dependencies({ email: new FakeEmailTransport().unconfigured() }),
      payload(),
      NOW,
    );

    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('RESEND_API_KEY');

    const attempts = await listDeliveryAttempts(scoped(), {
      subscriptionId: SUBSCRIPTION,
      deliveryDate: testDate,
    });
    expect(attempts[0]?.status).toBe('skipped');
    expect(attempts[0]?.error, 'a missing key is not a provider error').toBeNull();
  });
});

describe('when the provider refuses', () => {
  it('records a failed attempt and rethrows so pg-boss applies the backoff', async () => {
    const failing = new FakeEmailTransport().answerWith({
      status: 'failed',
      providerMessageId: null,
      error: 'Resend answered 500',
      detail: 'Resend refused the message.',
    });

    await expect(handleReportDeliver(dependencies({ email: failing }), payload(), NOW, 3)).rejects.toThrow(
      /Resend answered 500/,
    );

    // The row is written *before* the throw, so the failure is on the record either way.
    const attempts = await listDeliveryAttempts(scoped(), {
      subscriptionId: SUBSCRIPTION,
      deliveryDate: testDate,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[0]?.error).toBe('Resend answered 500');
    expect(attempts[0]?.attempt, "pg-boss's own retry count").toBe(3);
  });

  it('leaves the scheduled delivery sendable, so a retry can still succeed', async () => {
    const failing = new FakeEmailTransport().answerWith({
      status: 'failed',
      providerMessageId: null,
      error: 'transient',
      detail: 'transient',
    });

    await expect(handleReportDeliver(dependencies({ email: failing }), payload(), NOW, 1)).rejects.toThrow();

    // A later instant, because a retry genuinely happens later — and because two rows recorded at
    // the identical instant have no defined order for `listDeliveryAttempts` to return them in.
    const retried = await handleReportDeliver(dependencies(), payload(), at('2026-08-03T07:05:00Z'), 2);
    expect(retried.status).toBe('sent');

    const attempts = await listDeliveryAttempts(scoped(), {
      subscriptionId: SUBSCRIPTION,
      deliveryDate: testDate,
    });
    expect(attempts.map((row) => row.status)).toEqual(['failed', 'sent']);
  });

  /**
   * The fourth of the four structured events the observability criterion names.
   *
   * > Pipeline runs, narration fallbacks, ingest coverage gaps and delivery failures each emit a
   * > structured log event with the org, team and instant.
   *
   * The other three belong to the pipeline and are asserted in
   * `packages/pipeline/tests/observability.test.ts`. This one is the worker's, because the worker is
   * the layer that knows the attempt number and whether the provider actually refused.
   *
   * Asserted on an injected `RecordingSink` rather than on captured console output, so the objects a
   * hosted log product would receive are the objects the test reads.
   */
  it('emits delivery.failure with the organization, the team and the instant', async () => {
    const sink = new RecordingSink();
    const failing = new FakeEmailTransport().answerWith({
      status: 'failed',
      providerMessageId: null,
      error: 'Resend answered 503',
      detail: 'Resend refused the message.',
    });

    await expect(
      handleReportDeliver(dependencies({ email: failing, logSink: sink }), payload(), NOW, 2),
    ).rejects.toThrow();

    const record = sink.last('delivery.failure');
    expect(record, 'a failed delivery emitted no structured event').not.toBeNull();
    expect(record?.organizationId).toBe(ORG);
    // A team-scoped delivery's scope key *is* the team key, which is what makes "which teams missed
    // a daily this week" answerable.
    expect(record?.teamKey).toBe('platform');
    expect(record?.at).toBe(toEpochMillis(NOW));
    expect(record?.extras['channel']).toBe('email');
    // pg-boss's own retry count, so the event agrees with the `delivery_log` row beside it.
    expect(record?.extras['attempt']).toBe(2);
    expect(record?.extras['status']).toBe('failed');
    // A missed daily is a failure, not a degradation: nobody got the report.
    expect(record?.level).toBe('error');
  });

  it('emits the event before the throw, so a failure is never lost to it', async () => {
    // The throw is how pg-boss learns to back off, and anything sequenced after it does not happen.
    // This is the same argument the `delivery_log` row is written first for.
    const sink = new RecordingSink();
    const failing = new FakeEmailTransport().answerWith({
      status: 'failed',
      providerMessageId: null,
      error: 'transient',
      detail: 'transient',
    });

    await expect(
      handleReportDeliver(dependencies({ email: failing, logSink: sink }), payload(), NOW, 1),
    ).rejects.toThrow();

    expect(sink.records.filter((entry) => entry.event === 'delivery.failure')).toHaveLength(1);
  });
});

describe('the states that are not failures emit no failure event', () => {
  /**
   * `skipped` and `deferred` are deliberately silent on this event.
   *
   * A missing provider key is a documented deployment state — the transport says so and the row
   * records it — and an `error`-level event on every tick of a deployment that has no mailer is how
   * an operator learns to ignore the event that matters. A deferral is Compass declining to send an
   * empty message, which is the product working correctly.
   */
  it('emits nothing when the provider key is absent, so the signal stays the exception', async () => {
    const sink = new RecordingSink();
    const unconfigured = new FakeEmailTransport().answerWith({
      status: 'skipped',
      providerMessageId: null,
      error: null,
      detail: 'No RESEND_API_KEY is set, so no email was sent.',
    });

    const result = await handleReportDeliver(
      dependencies({ email: unconfigured, logSink: sink }),
      payload(),
      NOW,
      1,
    );

    expect(result.status).toBe('skipped');
    expect(sink.last('delivery.failure')).toBeNull();
  });

  it('emits nothing when there is no report yet, because a deferral is not a failure', async () => {
    const sink = new RecordingSink();

    const result = await handleReportDeliver(
      dependencies({ loadReport: async () => null, logSink: sink }),
      payload(),
      NOW,
      1,
    );

    expect(result.status).toBe('deferred');
    expect(sink.last('delivery.failure')).toBeNull();
  });
});

describe('a subscription switched off between scheduling and sending', () => {
  it('records `unsubscribed` and sends nothing', async () => {
    await scoped()
      .updateIn(subscriptions, { active: false, updatedAt: asDate('2026-08-03T06:00:00Z') })
      .execute();

    const result = await handleReportDeliver(dependencies(), payload(), NOW);

    expect(result.status).toBe('unsubscribed');
    expect(email.sent).toHaveLength(0);
  });
});

describe('a malformed payload', () => {
  it('throws, because it is a bug upstream rather than a delivery outcome', async () => {
    await expect(handleReportDeliver(dependencies(), { nonsense: true }, NOW)).rejects.toThrow(
      InvalidDeliveryPayloadError,
    );
  });
});

describe('the tick that enqueues the jobs', () => {
  const subscription = (overrides: Record<string, unknown> = {}) =>
    ({
      id: SUBSCRIPTION,
      organizationId: ORG,
      userId: USER,
      channel: 'email',
      target: 'priya@acme.example',
      scope: 'team',
      sendTime: '07:30',
      timezone: 'Europe/London',
      active: true,
      unsubscribeTokenHash: 'a'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }) as never;

  it('enqueues nothing before the send time', () => {
    const jobs = deliveryJobsDue([subscription()], () => ['platform'], at('2026-08-03T05:00:00Z'), ORG, {
      lookbackDays: 0,
    });
    expect(jobs).toEqual([]);
  });

  it('enqueues one job per team for a team-scoped subscription', () => {
    const jobs = deliveryJobsDue(
      [subscription({ scope: 'team' })],
      () => ['platform', 'checkout'],
      at('2026-08-03T08:00:00Z'),
      ORG,
      { lookbackDays: 0 },
    );

    expect(jobs.map((job) => job.scopeKey)).toEqual(['platform', 'checkout']);
    expect(jobs.every((job) => job.scopeKind === 'team')).toBe(true);
    expect(jobs.every((job) => job.deliveryDate === '2026-08-03')).toBe(true);
  });

  it('enqueues merged and per-team jobs for a `both` subscription', () => {
    const jobs = deliveryJobsDue(
      [subscription({ scope: 'both' })],
      () => ['platform'],
      at('2026-08-03T08:00:00Z'),
      ORG,
      { lookbackDays: 0 },
    );

    expect(jobs.map((job) => `${job.scopeKind}:${job.scopeKey}`)).toEqual(['merged:*', 'team:platform']);
    // Distinct singleton keys, so neither blocks the other.
    expect(new Set(jobs.map((job) => deliveryJobOptions(job).singletonKey)).size).toBe(2);
  });

  it('skips an inactive subscription', () => {
    const jobs = deliveryJobsDue(
      [subscription({ active: false })],
      () => ['platform'],
      at('2026-08-03T08:00:00Z'),
      ORG,
    );
    expect(jobs).toEqual([]);
  });
});
