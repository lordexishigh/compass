import {
  APPEND_ONLY_TABLE_NAMES,
  ScopedDb,
  deliveryLog,
  orgScope,
  organizations,
  shareLinkAccess,
  subscriptions,
  users,
} from '@compass/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

/**
 * The delivery tables, against the real engine.
 *
 * One property here is worth a database test rather than a unit test, and it is the one the
 * acceptance criteria put in tension with each other: **the same scheduled delivery may be
 * attempted many times and must arrive once.** "Each attempt writes a DeliveryLog row" wants
 * many rows per (subscription, date); "enqueued twice sends exactly one message" wants
 * uniqueness. A plain unique constraint satisfies the second by turning the first retry into
 * a duplicate-key crash, so the guarantee is a *partial* unique index over `status = 'sent'`
 * — and whether a partial index actually behaves that way is a question about PostgreSQL,
 * not about TypeScript.
 *
 * It also matters that this guarantee lives in the database rather than only in the queue: a
 * pg-boss singletonKey stops a duplicate while the job is live, but once the queue is drained
 * the key is gone and only the index still remembers that Tuesday's report went out.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SUBSCRIPTION = '44444444-4444-4444-8444-444444444444';

let database: TestDatabase;

const asDate = (iso: string) => new Date(Date.parse(iso));

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  for (const [id, name] of [
    [ORG, 'Acme Platform'],
    [OTHER_ORG, 'Beta Robotics'],
  ] as const) {
    await database.db
      .insert(organizations)
      .values({
        id,
        organizationId: id,
        name,
        slug: name.toLowerCase().replace(/\s+/g, '-'),
        timezone: 'Europe/London',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .onConflictDoNothing()
      .execute();
  }

  const scoped = new ScopedDb(database.db, orgScope(ORG));

  await scoped
    .insertInto(users, {
      id: USER,
      email: 'priya@example.com',
      displayName: 'Priya Raman',
      passwordHash: null,
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  await scoped
    .insertInto(subscriptions, {
      id: SUBSCRIPTION,
      userId: USER,
      channel: 'email',
      target: 'priya@example.com',
      scope: 'team',
      sendTime: '07:30',
      timezone: 'Europe/London',
      active: true,
      unsubscribeTokenHash: 'a'.repeat(64),
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

/**
 * The text of a rejection, including its cause.
 *
 * Drizzle wraps a driver error as `Failed query: insert into …`, so the constraint name lives
 * on `error.cause` rather than on the message. Asserting only on the outer message would pass
 * for *any* failed insert — including one that failed because a column was missing — so the
 * whole chain is flattened and the assertions below name the specific index they expect.
 */
const rejectionText = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return '';
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(' | ');
  }
};

const attempt = (
  id: string,
  status: 'sent' | 'failed' | 'deferred' | 'skipped' | 'unsubscribed',
  overrides: { readonly deliveryDate?: string; readonly scopeKey?: string } = {},
) =>
  new ScopedDb(database.db, orgScope(ORG))
    .insertInto(deliveryLog, {
      id,
      subscriptionId: SUBSCRIPTION,
      reportId: null,
      deliveryDate: overrides.deliveryDate ?? '2026-08-03',
      scopeKind: 'team',
      scopeKey: overrides.scopeKey ?? 'platform',
      channel: 'email',
      target: 'priya@example.com',
      attempt: 1,
      status,
      providerMessageId: null,
      error: null,
      detail: 'probe',
      recordedAt: asDate('2026-08-03T06:30:00Z'),
    })
    .execute();

describe('one scheduled delivery, many attempts, one send', () => {
  it('accepts every failed, deferred and skipped attempt for the same (subscription, date)', async () => {
    // The retry path. If this threw, bounded retries with backoff would be unimplementable.
    await attempt('55555555-5555-4555-8555-000000000001', 'failed');
    await attempt('55555555-5555-4555-8555-000000000002', 'failed');
    await attempt('55555555-5555-4555-8555-000000000003', 'deferred');
    await attempt('55555555-5555-4555-8555-000000000004', 'skipped');

    const rows = await new ScopedDb(database.db, orgScope(ORG)).selectFrom(deliveryLog);
    expect(rows.filter((row) => row.deliveryDate === '2026-08-03')).toHaveLength(4);
  });

  it('refuses a second successful send for that same scheduled delivery', async () => {
    await attempt('55555555-5555-4555-8555-000000000005', 'sent');

    // The whole idempotency criterion in one assertion: the job enqueued twice cannot send
    // twice, because the engine will not record the second send. Named against the index, so
    // this cannot pass because of some unrelated insert failure.
    const rejection = await rejectionText(attempt('55555555-5555-4555-8555-000000000006', 'sent'));

    expect(rejection, 'a duplicate scheduled delivery must not be sendable').toMatch(
      /delivery_log_one_send_per_scheduled_delivery/,
    );
    expect(rejection).toMatch(/duplicate key|unique/i);
  });

  it('still allows the next day, and the other scope of a `both` subscription', async () => {
    // The index is per (subscription, date, scope), so tomorrow's daily and the merged report
    // of the same subscription are separate scheduled deliveries rather than duplicates.
    await attempt('55555555-5555-4555-8555-000000000007', 'sent', { deliveryDate: '2026-08-04' });
    await attempt('55555555-5555-4555-8555-000000000008', 'sent', { scopeKey: '*' });

    const rows = await new ScopedDb(database.db, orgScope(ORG)).selectFrom(deliveryLog);
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(3);
  });
});

describe('the delivery tables keep the package conventions', () => {
  it('treats both event logs as append-only, in the engine and in ScopedDb', async () => {
    expect(APPEND_ONLY_TABLE_NAMES).toContain('delivery_log');
    expect(APPEND_ONLY_TABLE_NAMES).toContain('share_link_access');

    const scoped = new ScopedDb(database.db, orgScope(ORG));
    expect(() => scoped.updateIn(deliveryLog, { detail: 'rewritten' })).toThrow();
    expect(() => scoped.deleteFrom(deliveryLog)).toThrow();
    expect(() => scoped.updateIn(shareLinkAccess, { userAgent: 'rewritten' })).toThrow();
    expect(() => scoped.deleteFrom(shareLinkAccess)).toThrow();

    // And underneath, so a psql session cannot either. "Did the manager get Tuesday's report"
    // is not answerable from a table whose rows can be edited afterwards.
    await expect(
      database.client.query('update delivery_log set detail = \'rewritten\''),
    ).rejects.toThrow(/append-only/i);
    await expect(database.client.query('truncate table share_link_access')).rejects.toThrow(/append-only/i);
  });

  it('defaults a share link to org members rather than to the public', async () => {
    const column = await database.client.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'share_links' and column_name = 'audience'`,
    );

    // A token being hard to guess is not an authorization decision, so the default is the
    // closed one and going public is a separate explicit act.
    expect(column.rows[0]?.column_default).toContain('org_members');
  });

  it('scopes every delivery row to its organization', async () => {
    const forOther = await new ScopedDb(database.db, orgScope(OTHER_ORG)).selectFrom(deliveryLog);
    expect(forOther, 'another tenant sees none of these attempts').toEqual([]);
  });

  it('allows one subscription per (user, channel) and no more', async () => {
    // The per-channel scope choice depends on this: two rows for one channel would make
    // "which scope does email use" ambiguous.
    const rejection = await rejectionText(
      new ScopedDb(database.db, orgScope(ORG))
        .insertInto(subscriptions, {
          id: '66666666-6666-4666-8666-666666666666',
          userId: USER,
          channel: 'email',
          target: 'priya+second@example.com',
          scope: 'merged',
          sendTime: '09:00',
          timezone: 'Europe/London',
          active: true,
          unsubscribeTokenHash: 'b'.repeat(64),
          createdAt: asDate('2026-08-01T00:00:00Z'),
          updatedAt: asDate('2026-08-01T00:00:00Z'),
        })
        .execute(),
    );

    expect(rejection).toMatch(/subscriptions_org_user_channel_key/);
  });

  it('lets the same person hold an independent Slack subscription', async () => {
    // "Each channel carries its own independent scope choice" — a different scope and a
    // different send time on the second channel, same person.
    await new ScopedDb(database.db, orgScope(ORG))
      .insertInto(subscriptions, {
        id: '77777777-7777-4777-8777-777777777777',
        userId: USER,
        channel: 'slack',
        target: '#platform-daily',
        scope: 'merged',
        sendTime: '08:45',
        timezone: 'America/New_York',
        active: true,
        unsubscribeTokenHash: 'c'.repeat(64),
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();

    const rows = await new ScopedDb(database.db, orgScope(ORG)).selectFrom(subscriptions);
    const byChannel = new Map(rows.map((row) => [row.channel, row]));

    expect(byChannel.get('email')?.scope).toBe('team');
    expect(byChannel.get('slack')?.scope).toBe('merged');
    expect(byChannel.get('slack')?.timezone).toBe('America/New_York');
  });
});
