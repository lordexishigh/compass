import { startSession } from '@compass/auth';
import { instantFromIso, toIso, type Instant } from '@compass/clock';
import {
  APP_FEEDBACK_MAX_LENGTH,
  ScopedDb,
  appFeedback,
  memberships,
  orgScope,
  organizations,
  readAppFeedback,
  replaceTeamScopes,
  users,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';

/**
 * The in-app feedback channel, executed end to end.
 *
 * The handlers are imported unchanged and reach a real migrated PostgreSQL 17 through PGlite. Only
 * `lib/database`'s pool is stubbed, exactly as `feedback-routes.test.ts` and `login-route.test.ts`
 * do it: that is the seam between this process and a database, and everything above it — `guard`,
 * `authorize`, the session resolution — is the production path. A mocked guard would answer a
 * question nobody asked, since the whole point of the owner-only read is that the guard decides it.
 *
 * ## Why the ordering test fakes `Date`
 *
 * `created_at` comes from the request edge's own clock, and three POSTs inside one millisecond is
 * ordinary in a test. Asserting "newest first" against three rows that share a timestamp would be
 * asserting the planner's mood. So the ordering test steps the system clock between submissions,
 * which is both deterministic and the real distinction the criterion is about. Only `Date` is faked
 * — PGlite's own timers have to keep running or nothing resolves.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;

const OWNER = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const OWNER_MEMBERSHIP = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const MANAGER = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const MANAGER_MEMBERSHIP = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const VIEWER = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const VIEWER_MEMBERSHIP = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';

const T0: Instant = instantFromIso('2026-08-03T09:00:00Z');
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

const sessions: Record<'owner' | 'manager' | 'viewer', string> = { owner: '', manager: '', viewer: '' };

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-app-feedback',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  for (const [id, email, name] of [
    [OWNER, 'owner@example.com', 'An Owner'],
    [MANAGER, 'priya@example.com', 'Priya Raman'],
    [VIEWER, 'director@example.com', 'A Director'],
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
    [OWNER_MEMBERSHIP, OWNER, 'owner'],
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

  // Both non-owner seats are scoped to a team, so their refusal below is about their *role* and not
  // about a missing scope row. Asserting against an unscoped seat would assert the wrong rule.
  await replaceTeamScopes(scoped(), MANAGER_MEMBERSHIP, ['platform'], T0);
  await replaceTeamScopes(scoped(), VIEWER_MEMBERSHIP, ['platform'], T0);

  sessions.owner = (await startSession({ scoped: scoped(), userId: OWNER, now: T0 })).secret;
  sessions.manager = (await startSession({ scoped: scoped(), userId: MANAGER, now: T0 })).secret;
  sessions.viewer = (await startSession({ scoped: scoped(), userId: VIEWER, now: T0 })).secret;
}, 120_000);

afterAll(async () => {
  await database?.close();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Empties the table between the groups that count rows, so each one states its own fixture. */
const clearSubmissions = async (): Promise<void> => {
  await scoped().deleteFrom(appFeedback).execute();
};

const submit = (body: unknown, session?: string): Request =>
  new Request('https://compass.example.com/api/feedback/app', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}` }),
    },
    body: JSON.stringify(body),
  });

const list = (session?: string): Request =>
  new Request('https://compass.example.com/api/feedback', {
    method: 'GET',
    headers: session === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}` },
  });

// ---------------------------------------------------------------------------
// 001 — the control's storage
// ---------------------------------------------------------------------------

describe('POST /api/feedback/app', () => {
  beforeAll(clearSubmissions);

  it('persists a submission with an id, the message body and a created_at', async () => {
    const { POST } = await import('../app/api/feedback/app/route');

    const response = await POST(submit({ message: 'The projected date reads as more certain than its collar.' }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['recorded']).toBe(true);
    expect(typeof body['id']).toBe('string');

    const stored = await readAppFeedback(scoped());
    const found = stored.find((entry) => entry.id === body['id']);

    expect(found, 'the submission was acknowledged but not written').toBeDefined();
    expect(found?.message).toBe('The projected date reads as more certain than its collar.');
    // The three fields the criterion names, all present and all real values.
    expect(found?.createdAt).toBeGreaterThan(0);
    expect(found?.organizationId).toBe(ORGANIZATION_ID);
  });

  it('confirms in the product’s voice rather than acknowledging the click', async () => {
    const { POST } = await import('../app/api/feedback/app/route');

    const response = await POST(submit({ message: 'A second thought.' }));
    const detail = String(((await response.json()) as Record<string, unknown>)['detail']);

    // The sentence has to say where it went and what it will not do, because "Submitted" is not a
    // fact anybody can check.
    expect(detail).toContain('stored');
    expect(detail.toLowerCase()).toContain('owner');
    // And it says what Compass will *not* do with it, because a support box that might quietly
    // change tomorrow's report is a box a manager would think twice before using.
    expect(detail).toContain('will not use it to change what your reports say');
  });

  it('accepts a submission with no session at all, and records the absence as null', async () => {
    /**
     * The reader who most needs to say "this page is confusing" is the one who has not signed up:
     * `/` is deliberately session-less on the demonstration tenant, so a seated-only control would be
     * a control that never hears from them.
     */
    const { POST } = await import('../app/api/feedback/app/route');

    const response = await POST(submit({ message: 'I opened the demo and could not tell what R5 meant.' }));
    expect(response.status).toBe(200);

    const id = ((await response.json()) as Record<string, unknown>)['id'];
    const found = (await readAppFeedback(scoped())).find((entry) => entry.id === id);

    expect(found?.userId, 'no session means no user, stated rather than invented').toBeNull();
  });

  it('attributes a submission to the signed-in user when there is one', async () => {
    const { POST } = await import('../app/api/feedback/app/route');

    const response = await POST(submit({ message: 'The weekly digest omits my second team.' }, sessions.manager));
    expect(response.status).toBe(200);

    const id = ((await response.json()) as Record<string, unknown>)['id'];
    const found = (await readAppFeedback(scoped())).find((entry) => entry.id === id);

    expect(found?.userId).toBe(MANAGER);
  });

  it('refuses an empty or whitespace-only message and writes nothing', async () => {
    const { POST } = await import('../app/api/feedback/app/route');

    for (const message of ['', '   ', '\n\t']) {
      const before = (await readAppFeedback(scoped())).length;
      const response = await POST(submit({ message }));

      expect(response.status, `\`${JSON.stringify(message)}\` was accepted`).toBe(400);
      expect((await readAppFeedback(scoped())).length).toBe(before);
    }
  });

  it('refuses a message over the ceiling rather than truncating it', async () => {
    /**
     * Storing the first four thousand characters and answering "thanks" would lose the part somebody
     * cared about while telling them it arrived. The refusal names the number so they know what to cut.
     */
    const { POST } = await import('../app/api/feedback/app/route');

    const before = (await readAppFeedback(scoped())).length;
    const response = await POST(submit({ message: 'x'.repeat(APP_FEEDBACK_MAX_LENGTH + 1) }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('message_too_long');
    expect(String(body['detail'])).toContain(String(APP_FEEDBACK_MAX_LENGTH));
    expect((await readAppFeedback(scoped())).length, 'a refused message must not be stored in part').toBe(before);
  });

  it('stores a message exactly at the ceiling, so the boundary is inclusive', async () => {
    const { POST } = await import('../app/api/feedback/app/route');

    const response = await POST(submit({ message: 'y'.repeat(APP_FEEDBACK_MAX_LENGTH) }));

    expect(response.status).toBe(200);
  });

  it('refuses a body that is not JSON, or carries no message field', async () => {
    const { POST } = await import('../app/api/feedback/app/route');

    const notJson = await POST(
      new Request('https://compass.example.com/api/feedback/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    );
    expect(notJson.status).toBe(400);

    const noField = await POST(submit({ note: 'wrong field name' }));
    expect(noField.status).toBe(400);
    expect(String(((await noField.json()) as Record<string, unknown>)['detail'])).toContain('message');
  });
});

// ---------------------------------------------------------------------------
// 002 — GET /api/feedback
// ---------------------------------------------------------------------------

describe('GET /api/feedback', () => {
  it('returns objects with exactly id, message and created_at', async () => {
    await clearSubmissions();
    const { POST } = await import('../app/api/feedback/app/route');
    const { GET } = await import('../app/api/feedback/route');

    await POST(submit({ message: 'One message.' }, sessions.manager));

    const response = await GET(list(sessions.owner));
    expect(response.status).toBe(200);

    const body = (await response.json()) as readonly Record<string, unknown>[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);

    // Exactly these keys, in the sense of *no others*: the stored row also carries the organization
    // and the submitting user, and a `...row` would publish the identity of whoever wrote it.
    expect(Object.keys(body[0] ?? {}).sort()).toEqual(['created_at', 'id', 'message']);
    expect(body[0]?.['message']).toBe('One message.');
    expect(String(body[0]?.['created_at'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('discloses neither the organization nor the submitting user anywhere in the payload', async () => {
    await clearSubmissions();
    const { POST } = await import('../app/api/feedback/app/route');
    const { GET } = await import('../app/api/feedback/route');

    await POST(submit({ message: 'A message from a manager.' }, sessions.manager));

    const text = await (await GET(list(sessions.owner))).text();

    expect(text).not.toContain(MANAGER);
    expect(text).not.toContain(ORGANIZATION_ID);
    expect(text.toLowerCase()).not.toContain('user_id');
    expect(text.toLowerCase()).not.toContain('organization');
  });

  it('returns three submissions most recent first', async () => {
    await clearSubmissions();
    const { POST } = await import('../app/api/feedback/app/route');
    const { GET } = await import('../app/api/feedback/route');

    // Distinct instants, so "newest first" is a claim about the data rather than about the planner.
    // Only `Date` is faked: PGlite's timers have to keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const [iso, message] of [
        ['2026-08-03T09:00:00Z', 'first'],
        ['2026-08-03T09:05:00Z', 'second'],
        ['2026-08-03T09:10:00Z', 'third'],
      ] as const) {
        vi.setSystemTime(new Date(iso));
        const response = await POST(submit({ message }));
        expect(response.status).toBe(200);
      }
    } finally {
      vi.useRealTimers();
    }

    const body = (await (await GET(list(sessions.owner))).json()) as readonly Record<string, unknown>[];

    expect(body.map((entry) => entry['message'])).toEqual(['third', 'second', 'first']);
    expect(body[0]?.['created_at']).toBe(toIso(instantFromIso('2026-08-03T09:10:00Z')));

    // And the order is monotonic rather than merely ending in the right place.
    const stamps = body.map((entry) => Date.parse(String(entry['created_at'])));
    expect(stamps).toEqual([...stamps].sort((left, right) => right - left));
  });

  it('answers 403 for a manager and for a viewer', async () => {
    const { GET } = await import('../app/api/feedback/route');

    for (const [role, session] of [
      ['manager', sessions.manager],
      ['viewer', sessions.viewer],
    ] as const) {
      const response = await GET(list(session));

      // 403 and not 404: hiding the route would make an access problem indistinguishable from a bug,
      // and the person hitting it usually needs to know which owner to ask.
      expect(response.status, `${role} was not refused with 403`).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['error']).toBe('role_not_permitted');
      // Nothing about the inbox leaks through the refusal, not even how large it is.
      expect(JSON.stringify(body)).not.toContain('message');
    }
  });

  it('answers 401 with no session, rather than an empty array', async () => {
    // An empty array to an anonymous caller would read as "there is no feedback", which is a
    // different statement from "you may not read this".
    const { GET } = await import('../app/api/feedback/route');

    const response = await GET(list());

    expect(response.status).toBe(401);
    expect(((await response.json()) as Record<string, unknown>)['error']).toBe('authentication_required');
  });

  it('is never cached, because the response depends on who asked', async () => {
    const { GET } = await import('../app/api/feedback/route');

    expect((await GET(list(sessions.owner))).headers.get('cache-control')).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

const OTHER_ORGANIZATION = '99999999-9999-4999-8999-999999999999';

describe('submissions are scoped to their organization', () => {
  it('never returns another organization’s submissions to this owner', async () => {
    /**
     * A support inbox is exactly the kind of table somebody reads with a hand-written query, so the
     * scoping is asserted through the *route* rather than through the repository. The other tenant's
     * row is inserted with the unscoped handle on purpose: `ScopedDb.insertInto` refuses a foreign
     * organization id outright, so there is no way to plant it through the layer under test.
     */
    await clearSubmissions();
    const { GET } = await import('../app/api/feedback/route');

    await database.db
      .insert(organizations)
      .values({
        id: OTHER_ORGANIZATION,
        organizationId: OTHER_ORGANIZATION,
        name: 'Beta Robotics',
        slug: 'beta-robotics',
        timezone: 'UTC',
        createdAt: new Date(T0),
        updatedAt: new Date(T0),
      })
      .onConflictDoNothing()
      .execute();

    await database.db
      .insert(appFeedback)
      .values([
        {
          id: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a',
          organizationId: ORGANIZATION_ID,
          userId: null,
          message: 'ours',
          createdAt: new Date(T0),
        },
        {
          id: '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b',
          organizationId: OTHER_ORGANIZATION,
          userId: null,
          message: 'theirs',
          createdAt: new Date(T0),
        },
      ])
      .execute();

    const body = (await (await GET(list(sessions.owner))).json()) as readonly Record<string, unknown>[];

    expect(body.map((entry) => entry['message'])).toEqual(['ours']);
  });

  it('emits an organization predicate on the read, so no caller can forget one', () => {
    // The predicate is added by `ScopedDb`, not by the repository, and this is the assertion that
    // says so about *this* table specifically.
    const query = scoped().selectFrom(appFeedback).toSQL();

    expect(query.sql).toContain('organization_id');
    expect(query.params).toContain(ORGANIZATION_ID);
  });
});
