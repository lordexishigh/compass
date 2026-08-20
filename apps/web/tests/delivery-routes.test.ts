import { startSession } from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  findSubscriptionForChannel,
  memberships,
  orgScope,
  replaceTeamScopes,
  subscriptions,
  users,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import { edgeNow } from './helpers/edge-now';

/**
 * `POST /api/delivery/subscription`, executed end to end.
 *
 * `delivery-schedule.test.tsx` proves the screen offers the act and states what is true; this proves
 * that pressing the button does it. Both halves are needed and neither implies the other — the
 * failure this whole change exists to fix was a *table* nothing could write to, and shipping a form
 * that 303s straight back with a 400 would be the same failure wearing a different hat.
 *
 * The handler is imported unchanged and reaches a real migrated PostgreSQL 17 through PGlite. `guard`,
 * `authorize` and the session resolution are the production path, because "your own subscription,
 * never somebody else's" is a claim the guard and the handler make together. Only `lib/database`'s
 * pool is replaced, the way every other route test in this directory does it.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;

const MANAGER = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const MANAGER_MEMBERSHIP = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
const VIEWER = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7b';
const VIEWER_MEMBERSHIP = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8c';

const T0: Instant = instantFromIso('2026-08-05T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

const sessions: Record<'manager' | 'viewer', string> = { manager: '', viewer: '' };

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-delivery-routes',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  for (const [id, email, name] of [
    [MANAGER, 'priya@example.com', 'Priya Raman'],
    [VIEWER, 'sam@example.com', 'Sam Okoro'],
  ] as const) {
    await scoped()
      .insertInto(users, {
        id,
        email,
        displayName: name,
        passwordHash: null,
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  for (const [id, userId, role] of [
    [MANAGER_MEMBERSHIP, MANAGER, 'manager'],
    [VIEWER_MEMBERSHIP, VIEWER, 'viewer'],
  ] as const) {
    await scoped()
      .insertInto(memberships, {
        id,
        userId,
        role,
        status: 'active',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  // One team each, so the roster default resolves to that team's own report rather than to a
  // per-team scope with no team — which would be a subscription that never sends.
  await replaceTeamScopes(scoped(), MANAGER_MEMBERSHIP, ['platform'], T0);
  await replaceTeamScopes(scoped(), VIEWER_MEMBERSHIP, ['platform'], T0);

  sessions.manager = (await startSession({ scoped: scoped(), userId: MANAGER, now: edgeNow() })).secret;
  sessions.viewer = (await startSession({ scoped: scoped(), userId: VIEWER, now: edgeNow() })).secret;
}, 120_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await scoped().deleteFrom(subscriptions).execute();
});

const formPost = (fields: Record<string, string>, session: string | null = sessions.manager): Request =>
  new Request('https://compass.example.com/api/delivery/subscription', {
    method: 'POST',
    headers: {
      // Exactly what a browser sends for `<form method="post">` with no `enctype`.
      'content-type': 'application/x-www-form-urlencoded',
      ...(session === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}` }),
    },
    body: new URLSearchParams(fields).toString(),
  });

const jsonPost = (body: unknown, session: string | null = sessions.manager): Request =>
  new Request('https://compass.example.com/api/delivery/subscription', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}` }),
    },
    body: JSON.stringify(body),
  });

const SAVE_EMAIL = {
  channel: 'email',
  intent: 'save',
  target: 'priya@example.com',
  sendTime: '07:30',
  timezone: 'Europe/London',
  scope: 'default',
};

describe('setting up the daily from the account screen', () => {
  it('writes the subscription and sends the browser back with an outcome slug', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    const response = await POST(formPost(SAVE_EMAIL));

    // 303, so the browser follows with GET and a refresh does not re-post the form.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://compass.example.com/account?delivery=email-saved');

    const stored = await findSubscriptionForChannel(scoped(), MANAGER, 'email');
    expect(stored?.target).toBe('priya@example.com');
    expect(stored?.sendTime).toBe('07:30');
    expect(stored?.timezone).toBe('Europe/London');
    expect(stored?.active).toBe(true);
    // `default` resolved through the roster rather than being stored as a literal.
    expect(stored?.scope).toBe('team');
    // NOT NULL, and the plaintext is not recoverable — the one-click unsubscribe depends on it.
    expect(stored?.unsubscribeTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers a JSON caller in JSON', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    const response = await POST(jsonPost({ ...SAVE_EMAIL, sendTime: '06:15', scope: 'merged' }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['channel']).toBe('email');
    expect(body['sendTime']).toBe('06:15');
    expect(body['scope']).toBe('merged');
    expect(body['teamKeys']).toEqual(['platform']);
  });

  it('refuses an unschedulable zone without writing anything', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    const response = await POST(formPost({ ...SAVE_EMAIL, timezone: 'Middle/Earth' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('delivery=schedule-rejected');
    // The worst failure this feature has is a row that looks configured and never sends, so
    // nothing partial is stored.
    expect(await findSubscriptionForChannel(scoped(), MANAGER, 'email')).toBeNull();
  });

  it('refuses a target the channel could not deliver to', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');

    const asJson = await POST(jsonPost({ ...SAVE_EMAIL, target: 'priya' }));
    expect(asJson.status).toBe(422);
    expect(((await asJson.json()) as Record<string, unknown>)['error']).toBe('invalid_target');

    const asForm = await POST(
      formPost({ ...SAVE_EMAIL, channel: 'slack', target: 'platform-standup' }),
    );
    expect(asForm.headers.get('location')).toContain('delivery=slack-target-rejected');

    expect(await findSubscriptionForChannel(scoped(), MANAGER, 'email')).toBeNull();
    expect(await findSubscriptionForChannel(scoped(), MANAGER, 'slack')).toBeNull();
  });

  it('accepts a Slack channel, a direct message and a Slack id', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');

    for (const target of ['#platform-standup', '@priya', 'C0123456']) {
      const response = await POST(jsonPost({ ...SAVE_EMAIL, channel: 'slack', target }));
      expect(response.status).toBe(200);
      expect((await findSubscriptionForChannel(scoped(), MANAGER, 'slack'))?.target).toBe(target);
    }
  });

  it('stops the daily, idempotently, and keeps the row', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    await POST(formPost(SAVE_EMAIL));

    const first = await POST(formPost({ channel: 'email', intent: 'stop' }));
    expect(first.headers.get('location')).toContain('delivery=email-stopped');

    const stored = await findSubscriptionForChannel(scoped(), MANAGER, 'email');
    // Kept rather than deleted: the schedule survives so turning it back on changes nothing else.
    expect(stored).not.toBeNull();
    expect(stored?.active).toBe(false);
    expect(stored?.sendTime).toBe('07:30');

    // A second click, a retried request or a mail client that pre-fetches must not look broken.
    const second = await POST(formPost({ channel: 'email', intent: 'stop' }));
    expect(second.status).toBe(303);

    // And saving again switches it back on through the same path.
    await POST(formPost(SAVE_EMAIL));
    expect((await findSubscriptionForChannel(scoped(), MANAGER, 'email'))?.active).toBe(true);
  });

  it('lets a viewer set up their own daily', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    const response = await POST(
      formPost({ ...SAVE_EMAIL, target: 'sam@example.com' }, sessions.viewer),
    );

    expect(response.status).toBe(303);
    // The narrowest write in the matrix: a viewer deciding when their own copy of a report they may
    // already read arrives. Restricting it to owners would mean somebody else has to configure it.
    expect((await findSubscriptionForChannel(scoped(), VIEWER, 'email'))?.target).toBe('sam@example.com');
  });

  it('writes only the caller’s own subscription, ignoring a user id in the body', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    const response = await POST(jsonPost({ ...SAVE_EMAIL, userId: VIEWER, target: 'elsewhere@example.com' }));

    expect(response.status).toBe(200);
    // The row is keyed on the session, so a field naming somebody else changes nothing about them.
    expect(await findSubscriptionForChannel(scoped(), VIEWER, 'email')).toBeNull();
    expect((await findSubscriptionForChannel(scoped(), MANAGER, 'email'))?.target).toBe('elsewhere@example.com');
  });

  it('refuses an anonymous caller', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    const response = await POST(formPost(SAVE_EMAIL, null));

    expect(response.status).toBe(401);
    // No seat, no row to own — admitting `public` here would be a way to make Compass mail a
    // report to an address of a stranger's choosing.
    expect(await findSubscriptionForChannel(scoped(), MANAGER, 'email')).toBeNull();
  });

  it('refuses an intent it does not implement', async () => {
    const { POST } = await import('../app/api/delivery/subscription/route');
    const response = await POST(jsonPost({ ...SAVE_EMAIL, intent: 'pause' }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)['detail']).toContain('`stop`');
  });
});
