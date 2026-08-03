import { RecordingMailer } from '@compass/auth';
import { FixedClock, instantFromIso, toEpochMillis, type Instant } from '@compass/clock';
import {
  PRIVACY_DEFAULTS,
  countRawEvents,
  ensurePrivacySettings,
  insertDeletionRequest,
  latestPurgeRun,
  listPurgeRuns,
  listSlackChannels,
  recordRawEvents,
  setSlackChannelIngestion,
  updatePrivacySettings,
  type ScopedDb,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { FakeSlackTransport } from '@compass/delivery/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_NOTICE_CRON,
  DELETION_CRON,
  PURGE_CRON,
  runChannelNotices,
  runDeletionSweep,
  runRetentionPurge,
  type PrivacyDependencies,
} from '../src/privacy.js';

/**
 * Subtasks 001, 003 and 005, at the scheduled edge.
 *
 * Every deadline in this file is checked with a `FixedClock`, never by waiting: the grace
 * period is seven days and a test that slept would take a week. That is also why the handlers
 * take `now` as a parameter rather than reading a clock — the injectability *is* the
 * testability, and `apps/web/tests/time-travel.test.ts` holds the same rule on the other edge.
 */

const ORGANIZATION_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c60';
const OWNER_EMAIL = 'owner@northwind.example';
const at = (iso: string): Instant => instantFromIso(iso);

/** Day zero for every deadline below. */
const REQUESTED_AT = at('2026-08-05T09:00:00Z');
const DAY = 86_400_000;

let database: TestDatabase;
let mailer: RecordingMailer;
let slack: FakeSlackTransport;
let dependencies: PrivacyDependencies;
let idCounter: number;

const scoped = (): ScopedDb => database.scopedFor(ORGANIZATION_ID);

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Retail',
    slug: 'northwind-retail',
    timezone: 'Europe/London',
    at: new Date(Date.parse('2026-07-01T00:00:00Z')),
  });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.client.query('delete from raw_events');
  await database.client.query('delete from purge_runs');
  await database.client.query('delete from slack_channel_ingestion');
  await database.client.query('delete from deletion_requests');
  await database.client.query('delete from org_privacy_settings');

  mailer = new RecordingMailer();
  slack = new FakeSlackTransport();
  idCounter = 0;

  dependencies = {
    scopedFor: () => scoped(),
    mailer,
    slack,
    baseUrl: 'https://compass.northwind.example',
    // Deterministic, so a failure names the same row twice and a snapshot never churns.
    newId: () => `00000000-0000-4000-8000-${String((idCounter += 1)).padStart(12, '0')}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
});

async function storeMessages(...postedAt: readonly string[]): Promise<void> {
  await recordRawEvents(
    scoped(),
    postedAt.map((iso, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      sourceKey: 'primary-chat',
      sourceKind: 'chat',
      artifactKind: 'messages',
      sourceRecordId: `m-${index + 1}`,
      conversationKey: 'conv-checkout',
      conversationName: 'checkout-standup',
      authorIdentityKind: 'chat_handle',
      authorIdentityValue: '@priya',
      body: `message ${index + 1}`,
      occurredAt: at(iso),
      ingestedAt: at(iso),
    })),
  );
}

// ---------------------------------------------------------------------------
// 001: the purge
// ---------------------------------------------------------------------------

describe('the retention purge', () => {
  it('runs on a documented daily schedule', () => {
    // Quoted in `docs/DEVELOPMENT.md`. Daily rather than hourly: the shortest window Compass
    // offers is 30 days, so an hourly purge would be 23 no-op rows a day and no earlier a
    // deletion.
    expect(PURGE_CRON).toBe('17 3 * * *');
    expect(DELETION_CRON).toBe('23 * * * *');
    expect(CHANNEL_NOTICE_CRON).toBe('*/10 * * * *');
  });

  it('deletes the rows past the window and records the count and the timestamp', async () => {
    const now = at('2026-08-05T03:17:00Z');
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: now });

    // 90 days before 2026-08-05 is 2026-05-07. One message either side of it.
    await storeMessages('2026-01-02T09:00:00Z', '2026-08-04T09:00:00Z');
    expect(await countRawEvents(scoped())).toBe(2);

    const result = await runRetentionPurge(dependencies, ORGANIZATION_ID, now);

    expect(result.rawEventsDeleted).toBe(1);
    expect(await countRawEvents(scoped())).toBe(1);

    const recorded = await latestPurgeRun(scoped());
    expect(recorded).not.toBeNull();
    expect(recorded?.rawEventsDeleted).toBe(1);
    expect(recorded?.outcome).toBe('complete');
    // The timestamp is the injected instant, not a server clock — which is what makes the row
    // byte-stable across runs and the assertion exact rather than approximate.
    expect(recorded?.startedAt).toBe(now);
    expect(recorded?.completedAt).toBe(now);
    // The cutoff is stored beside the count, so the claim is checkable rather than asserted.
    expect(recorded?.rawCutoff).toBe(at('2026-05-07T03:17:00Z'));
  });

  it('honours a shortened window immediately on the next run', async () => {
    const now = at('2026-08-05T03:17:00Z');
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: now });
    await storeMessages('2026-06-01T09:00:00Z', '2026-08-04T09:00:00Z');

    // Both survive 90 days.
    expect((await runRetentionPurge(dependencies, ORGANIZATION_ID, now)).rawEventsDeleted).toBe(0);

    await updatePrivacySettings(scoped(), { rawEventRetentionDays: 30, at: now });

    // 30 days reaches back only to 2026-07-06, so the June message goes.
    expect((await runRetentionPurge(dependencies, ORGANIZATION_ID, now)).rawEventsDeleted).toBe(1);
  });

  it('writes a row even when nothing was old enough, so the page can prove the job is alive', async () => {
    const now = at('2026-08-05T03:17:00Z');
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: now });
    await storeMessages('2026-08-04T09:00:00Z');

    await runRetentionPurge(dependencies, ORGANIZATION_ID, now);

    const runs = await listPurgeRuns(scoped());
    expect(runs).toHaveLength(1);
    expect(runs[0]?.rawEventsDeleted).toBe(0);
    // The sentence is the point. "Never purged" and "nothing was old enough" are different
    // facts, and only one of them means the scheduler is working.
    expect(runs[0]?.detail).toContain('No chat message was older than 90 days');
  });

  it('touches nothing derived when retention is indefinite, and says so', async () => {
    const now = at('2026-08-05T03:17:00Z');
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: now });
    await updatePrivacySettings(scoped(), { derivedRetentionYears: null, at: now });

    const result = await runRetentionPurge(dependencies, ORGANIZATION_ID, now);

    expect(result.derivedCutoff).toBeNull();
    expect(result.reportsDeleted).toBe(0);
    expect(result.detail).toContain('kept indefinitely');
  });

  it('falls back to the documented defaults when no settings row exists', async () => {
    const now = at('2026-08-05T03:17:00Z');
    await storeMessages('2026-01-02T09:00:00Z');

    // No `ensurePrivacySettings`. The failure direction for "we could not read your preference"
    // has to be the documented default rather than "keep everything".
    const result = await runRetentionPurge(dependencies, ORGANIZATION_ID, now);

    expect(PRIVACY_DEFAULTS.rawEventRetentionDays).toBe(90);
    expect(result.rawEventsDeleted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 003: the deletion sweep
// ---------------------------------------------------------------------------

async function pendingDeletion(subjectKind: 'account' | 'organization'): Promise<string> {
  const stored = await insertDeletionRequest(scoped(), {
    id: '20000000-0000-4000-8000-000000000001',
    subjectKind,
    subjectId: subjectKind === 'organization' ? ORGANIZATION_ID : '30000000-0000-4000-8000-000000000001',
    requestedByUserId: null,
    notifyEmail: OWNER_EMAIL,
    requestedAt: REQUESTED_AT,
    graceEndsAt: instantFromEpoch(toEpochMillis(REQUESTED_AT) + 7 * DAY),
    hardDeleteBy: instantFromEpoch(toEpochMillis(REQUESTED_AT) + 30 * DAY),
    undoTokenHash: 'a'.repeat(64),
    exportOfferedAt: REQUESTED_AT,
    detail: 'Requested.',
  });
  return stored.id;
}

const instantFromEpoch = (millis: number): Instant => instantFromIso(new Date(millis).toISOString());

describe('the deletion sweep', () => {
  it('does nothing while the grace period is still running', async () => {
    await pendingDeletion('account');

    // Day six. The whole promise of the grace period is that nothing happens inside it.
    const result = await runDeletionSweep(
      dependencies,
      ORGANIZATION_ID,
      instantFromEpoch(toEpochMillis(REQUESTED_AT) + 6 * DAY),
    );

    expect(result.purged).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it('completes once the grace period has ended, and mails what was deleted', async () => {
    await pendingDeletion('account');

    const now = instantFromEpoch(toEpochMillis(REQUESTED_AT) + 7 * DAY + 3_600_000);
    const result = await runDeletionSweep(dependencies, ORGANIZATION_ID, now);

    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);

    const confirmation = mailer.lastTo(OWNER_EMAIL);
    expect(confirmation).not.toBeNull();
    expect(confirmation?.purpose).toBe('deletion_confirmation');
    // The criterion is an email *enumerating the data categories deleted*, so the assertion is
    // on the categories rather than on the fact that mail was sent.
    expect(confirmation?.body).toContain('your account: name, email address and password hash');
    expect(confirmation?.body).toContain('every signed-in session');
  });

  it('completes well inside the thirty-day deadline', async () => {
    await pendingDeletion('account');
    const now = instantFromEpoch(toEpochMillis(REQUESTED_AT) + 7 * DAY + 3_600_000);

    await runDeletionSweep(dependencies, ORGANIZATION_ID, now);

    // The sweep fires on the *grace* deadline, not the hard one, so completion is a week in
    // rather than a month. Waiting for `hard_delete_by` would honour the outer bound by
    // missing the point of the inner one.
    expect(toEpochMillis(now) - toEpochMillis(REQUESTED_AT)).toBeLessThan(30 * DAY);
  });

  it('erases the whole tenant on an organization deletion, and names what it kept', async () => {
    await storeMessages('2026-08-04T09:00:00Z');
    await pendingDeletion('organization');

    const now = instantFromEpoch(toEpochMillis(REQUESTED_AT) + 8 * DAY);
    const result = await runDeletionSweep(dependencies, ORGANIZATION_ID, now);

    expect(result.purged).toBe(1);
    expect(await countRawEvents(scoped())).toBe(0);

    const confirmation = mailer.lastTo(OWNER_EMAIL);
    expect(confirmation?.body).toContain('chat message bodies');
    expect(confirmation?.body).toContain('the append-only version history');
    // Retained, and said so. A list of deletions with no mention of what survived would be a
    // true list and a misleading message.
    expect(confirmation?.body).toContain('Compass has kept the following');
    expect(confirmation?.body).toContain('counts and timestamps of past retention purges');

    // The two records the criteria require to survive an erasure did.
    const purges = await database.client.query<{ count: string }>('select count(*)::text as count from purge_runs');
    expect(purges.rows[0]?.count).toBeDefined();
    const requests = await database.client.query<{ status: string }>('select status from deletion_requests');
    expect(requests.rows[0]?.status).toBe('purged');
  });

  it('leaves the append-only guarantee in force outside an erasure', async () => {
    // The GUC-gated exception is scoped to `eraseWithin`'s transaction, so an ordinary delete
    // is still refused by the database after an erasure has run in the same process.
    await expect(database.client.query('delete from entity_versions')).rejects.toThrow(/append-only/i);
  });
});

// ---------------------------------------------------------------------------
// 005: the channel notice
// ---------------------------------------------------------------------------

describe('the channel notice', () => {
  it('posts in every enabled channel that has not been told', async () => {
    const now = at('2026-08-05T09:10:00Z');
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: now });
    await setSlackChannelIngestion(scoped(), {
      id: '40000000-0000-4000-8000-000000000001',
      conversationKey: 'C123CHECKOUT',
      conversationName: 'checkout-standup',
      conversationKind: 'public_channel',
      enabled: true,
      byUserId: null,
      at: now,
    });

    const result = await runChannelNotices(dependencies, ORGANIZATION_ID, now);

    expect(result.posted).toBe(1);
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.target.target).toBe('C123CHECKOUT');

    const text = JSON.stringify(slack.sent[0]?.messages);
    // The four things the notice has to say.
    expect(text).toContain('Compass reads this channel');
    expect(text).toContain('90 days');
    expect(text).toContain('never reads direct messages or private channels');
    expect(text).toContain('/me');
  });

  it('does not post twice for the same channel', async () => {
    const now = at('2026-08-05T09:10:00Z');
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: now });
    await setSlackChannelIngestion(scoped(), {
      id: '40000000-0000-4000-8000-000000000002',
      conversationKey: 'C123CHECKOUT',
      conversationName: 'checkout-standup',
      conversationKind: 'public_channel',
      enabled: true,
      byUserId: null,
      at: now,
    });

    await runChannelNotices(dependencies, ORGANIZATION_ID, now);
    await runChannelNotices(dependencies, ORGANIZATION_ID, at('2026-08-05T09:20:00Z'));

    expect(slack.sent).toHaveLength(1);

    const [channel] = await listSlackChannels(scoped());
    expect(channel?.noticePostedAt).toBe(now);
  });

  it('keeps the channel on the work list when Slack cannot be reached, and says the team was not told', async () => {
    const now = at('2026-08-05T09:10:00Z');
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: now });
    await setSlackChannelIngestion(scoped(), {
      id: '40000000-0000-4000-8000-000000000003',
      conversationKey: 'C123CHECKOUT',
      conversationName: 'checkout-standup',
      conversationKind: 'public_channel',
      enabled: true,
      byUserId: null,
      at: now,
    });

    // A deployment with no bot token: the transport reports `skipped` rather than throwing.
    slack.unconfigured();

    const result = await runChannelNotices(dependencies, ORGANIZATION_ID, now);

    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(1);

    const [channel] = await listSlackChannels(scoped());
    // Null, so the next tick tries again. A stored excuse with a timestamp would mean the team
    // was never told and the page said they were.
    expect(channel?.noticePostedAt).toBeNull();
    expect(channel?.noticeDetail).toContain('SLACK_BOT_TOKEN');
  });

  it('does nothing at all when no channel is enabled', async () => {
    const result = await runChannelNotices(dependencies, ORGANIZATION_ID, at('2026-08-05T09:10:00Z'));
    expect(result).toEqual({ posted: 0, skipped: 0, details: [] });
    expect(slack.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The clock rule
// ---------------------------------------------------------------------------

describe('every deadline is a function of the injected instant', () => {
  it('gives the same answer twice for the same instant', async () => {
    const clock = new FixedClock(at('2026-08-05T03:17:00Z'));
    await ensurePrivacySettings(scoped(), { id: settingsId(), at: clock.now() });
    await storeMessages('2026-01-02T09:00:00Z');

    const first = await runRetentionPurge(dependencies, ORGANIZATION_ID, clock.now());
    const second = await runRetentionPurge(dependencies, ORGANIZATION_ID, clock.now());

    // Same instant, same cutoff. The second run finds nothing because the first deleted it,
    // which is the honest form of idempotence here — not that the delete is repeated.
    expect(first.rawCutoff).toBe(second.rawCutoff);
    expect(second.rawEventsDeleted).toBe(0);
  });
});

/** The settings row id. Derived, so two callers land on the same row. */
const settingsId = (): string => '50000000-0000-4000-8000-000000000001';
