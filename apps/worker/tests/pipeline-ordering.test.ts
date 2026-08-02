import { randomUUID } from 'node:crypto';

import { SECTION_ORDER } from '@compass/analysis';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  listDeliveryAttempts,
  orgScope,
  organizations,
  saveReport,
  upsertSubscription,
  users,
  findLatestReportForDate,
  loadReportBundle,
} from '@compass/db';
import { createTestDatabase, type TestDatabase } from '@compass/db/testing';
import { FakeEmailTransport, FakeSlackTransport } from '@compass/delivery/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleReportDeliver, type DeliveryDependencies } from '../src/delivery.js';
import { handleReportGenerate, reportInstantFor, type GenerationDependencies } from '../src/generation.js';
import { storedReportToRendered } from '../src/stored-report.js';

/**
 * Ingest → generation → delivery, in that order, per (org, team, date).
 *
 * The acceptance criterion is the sequence rather than any single job: *enqueue delivery before
 * generation and exactly one message is sent, after generation completes.* So this test drives the
 * two real handlers against a real migrated database and lets the ordering emerge from the state
 * they share, which is the only thing that holds when the queue reorders them.
 *
 * The guarantee is deliberately **not** enqueue order. Delivery reads the stored report for its
 * (org, scope, date) and defers when there is none — so a delivery that arrives early sends nothing
 * and records why, and the next tick sends once generation has written the row. A test that only
 * checked "generation was enqueued first" would pass on a queue that happened to be FIFO and fail
 * silently the moment a retry reordered anything.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SUBSCRIPTION = '33333333-3333-4333-8333-333333333333';

const at = (iso: string): Instant => instantFromIso(iso);
const asDate = (iso: string) => new Date(Date.parse(iso));

const TIMEZONE = 'Europe/London';
const GENERATION_TIME = '06:00';
/** The delivery tick runs after the team's 07:30 send time. */
const DELIVERY_NOW = at('2026-08-03T07:00:00Z');

/**
 * A distinct civil day per test.
 *
 * Both tables this test reads persist across cases, and `delivery_log` is append-only by design —
 * it is the record of what a provider said, so a test cannot clear it. Giving each case its own
 * scheduled day makes each one a genuinely separate (org, team, date), which is both closer to
 * reality and the only way to assert "exactly one message" without deleting history.
 */
let REPORT_DATE = '';
let dayCounter = 0;

let database: TestDatabase;
let email: FakeEmailTransport;
let slack: FakeSlackTransport;

const scoped = () => new ScopedDb(database.db, orgScope(ORG));

/** Six sections, in the fixed order, so the report is renderable rather than half-written. */
const sectionsFor = () =>
  SECTION_ORDER.map((sectionKey, index) => ({
    sectionKey,
    ordinal: index + 1,
    title: sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1),
    prose: `The ${sectionKey} prose.`,
    payload: {},
    emptyStatement: `Nothing for ${sectionKey}.`,
    summary: `The ${sectionKey} lead.`,
    items: [
      {
        stableId: `${sectionKey}:1`,
        causeEntityRef: `ticket:${sectionKey.toUpperCase()}-1`,
        causeKind: 'status_dwell',
        causeDiscriminator: '',
        headline: 'A headline',
        detail: 'A detail',
        prose: `A claim about ${sectionKey}.`,
        changeTag: 'unchanged',
        ageDays: 1,
        firstSeenAt: at('2026-08-02T05:00:00Z'),
        severityScore: 4,
        signalOnsetAt: at('2026-08-02T05:00:00Z'),
        feedbackState: null,
        changeClause: null,
        ladder: null,
        payload: {},
        evidence: [],
      },
    ],
  }));

/**
 * The generation dependency, writing a real report through the real repository.
 *
 * `saveReport` derives the row id from `(org, scope, reportInstant)`, so this is the same
 * idempotency the production path has: a second generation for the same day replaces the row rather
 * than adding one.
 */
const generation = (): GenerationDependencies => ({
  ensureReport: async (request) => {
    const existing = await findLatestReportForDate(
      scoped(),
      { scopeKind: request.scopeKind, scopeKey: request.scopeKey },
      REPORT_DATE,
    );
    if (existing !== null) return { reportId: existing.id, generated: false };

    const stored = await saveReport(scoped(), {
      scopeKind: request.scopeKind,
      scopeKey: request.scopeKey,
      schemaVersion: 1,
      reportInstant: request.reportInstant,
      reportDate: REPORT_DATE,
      timezone: request.timezone,
      window: { start: at('2026-08-02T05:00:00Z'), end: at('2026-08-03T05:00:00Z') },
      contentHash: 'a'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: 'The whole report.',
      changeLine: 'Nothing material changed since yesterday.',
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'complete',
      ingestRunId: null,
      generatedAt: request.reportInstant,
      sections: sectionsFor(),
    });

    return { reportId: stored.id, generated: true };
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

/** Delivery, reading the *real* stored report — the lookup the deferral decision depends on. */
const delivery = (): DeliveryDependencies => ({
  scopedFor: () => scoped(),
  loadReport: async (db, scope, reportDate) => {
    const report = await findLatestReportForDate(db, scope, reportDate);
    return report === null ? null : loadReportBundle(db, report.id);
  },
  renderStored: storedReportToRendered,
  email,
  slack,
  baseUrl: 'https://compass.acme.example',
  unsubscribeUrlFor: (subscription) =>
    `https://compass.acme.example/api/delivery/unsubscribe?token=${subscription.unsubscribeTokenHash}`,
  newId: () => randomUUID(),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

const deliverPayload = () => ({
  organizationId: ORG,
  subscriptionId: SUBSCRIPTION,
  deliveryDate: REPORT_DATE,
  scopeKind: 'team' as const,
  scopeKey: 'platform',
});

const generatePayload = () => ({
  organizationId: ORG,
  scopeKind: 'team' as const,
  scopeKey: 'platform',
  reportDate: REPORT_DATE,
  timezone: TIMEZONE,
  generationTime: GENERATION_TIME,
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
      slug: 'acme-ordering',
      timezone: TIMEZONE,
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
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  email = new FakeEmailTransport();
  slack = new FakeSlackTransport();
  dayCounter += 1;
  REPORT_DATE = `2026-09-${String(dayCounter).padStart(2, '0')}`;

  await upsertSubscription(
    scoped(),
    {
      id: SUBSCRIPTION,
      userId: USER,
      channel: 'email',
      target: 'priya@acme.example',
      scope: 'team',
      sendTime: '07:30',
      timezone: TIMEZONE,
      unsubscribeTokenHash: 'a'.repeat(64),
    },
    DELIVERY_NOW,
  );
});

describe('delivery enqueued before generation', () => {
  it('sends exactly one message, and only after generation has completed', async () => {
    // 1. Delivery runs first. There is no report for (org, team, date) yet.
    const early = await handleReportDeliver(delivery(), deliverPayload(), DELIVERY_NOW, 1);

    expect(early.status, 'a delivery with no report must defer, never send').toBe('deferred');
    expect(email.sent).toHaveLength(0);

    // 2. Generation runs and writes the report for that exact (org, team, date).
    const generated = await handleReportGenerate(generation(), generatePayload());
    expect(generated.status).toBe('generated');

    // 3. The same scheduled delivery runs again — the retry or the next tick.
    const afterGeneration = await handleReportDeliver(delivery(), deliverPayload(), DELIVERY_NOW, 2);
    expect(afterGeneration.status).toBe('sent');

    // The criterion, stated once: exactly one message, and it went out after generation.
    expect(email.sent, 'exactly one message across the whole sequence').toHaveLength(1);

    // 4. And a third run cannot send a second copy.
    const duplicate = await handleReportDeliver(delivery(), deliverPayload(), DELIVERY_NOW, 3);
    expect(duplicate.status).toBe('already_sent');
    expect(email.sent).toHaveLength(1);
  });

  it('records the deferral so the wait is explained rather than silent', async () => {
    await handleReportDeliver(delivery(), deliverPayload(), DELIVERY_NOW, 1);

    const attempts = await listDeliveryAttempts(scoped(), {
      subscriptionId: SUBSCRIPTION,
      deliveryDate: REPORT_DATE,
    });

    const deferred = attempts.filter((attempt) => attempt.status === 'deferred');
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    // Null because there was no report to point at — that is the content of the outcome.
    expect(deferred[0]?.reportId).toBeNull();
    expect(deferred[0]?.detail).toContain('No report exists yet');
  });

  it('leaves the full attempt history: deferred first, then sent', async () => {
    await handleReportDeliver(delivery(), deliverPayload(), DELIVERY_NOW, 1);
    await handleReportGenerate(generation(), generatePayload());
    await handleReportDeliver(delivery(), deliverPayload(), at('2026-08-03T07:05:00Z'), 2);

    const attempts = await listDeliveryAttempts(scoped(), {
      subscriptionId: SUBSCRIPTION,
      deliveryDate: REPORT_DATE,
    });

    // The record an operator reads to see that the daily was late and why.
    expect(attempts.map((attempt) => attempt.status)).toEqual(['deferred', 'sent']);
  });

  it('sends the generated report, not an empty document', async () => {
    await handleReportGenerate(generation(), generatePayload());
    await handleReportDeliver(delivery(), deliverPayload(), DELIVERY_NOW, 1);

    const html = email.sent[0]?.rendered.html ?? '';
    // All six sections reached the message, which is what proves delivery read the *stored* report
    // rather than shipping a placeholder.
    for (const sectionKey of SECTION_ORDER) {
      expect(html).toContain(`A claim about ${sectionKey}.`);
    }
  });
});

describe('generation run twice for one (org, team, date)', () => {
  it('produces one Report row, because the instant it derives is the same', async () => {
    const first = await handleReportGenerate(generation(), generatePayload());
    const second = await handleReportGenerate(generation(), generatePayload());

    expect(first.status).toBe('generated');
    expect(second.status, 'the second run finds the first report').toBe('already_present');
    expect(second.reportId).toBe(first.reportId);

    // And the row id is the one derived from the pinned instant, so even a forced replay would
    // overwrite rather than accumulate.
    const rows = await database.client.query<{ count: string }>(
      `select count(*)::text as count from reports where report_date = $1 and scope_key = 'platform'`,
      [REPORT_DATE],
    );
    expect(Number.parseInt(rows.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('derives that instant from the team civil day, not from the tick', async () => {
    const expected = reportInstantFor(generatePayload());
    await handleReportGenerate(generation(), generatePayload());

    const stored = await findLatestReportForDate(
      scoped(),
      { scopeKind: 'team', scopeKey: 'platform' },
      REPORT_DATE,
    );

    expect(stored?.reportInstant).toBe(expected);
  });
});
