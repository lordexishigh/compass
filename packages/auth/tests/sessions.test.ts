import {
  SESSION_ABSOLUTE_TTL_DAYS,
  SESSION_ABSOLUTE_TTL_MILLIS,
  SESSION_IDLE_TTL_DAYS,
  SESSION_IDLE_TTL_MILLIS,
  changeSeat,
  endAllSessions,
  endSession,
  registerAccount,
  resolveIdentity,
  sessionDeadline,
  sessionRejection,
  startSession,
} from '@compass/auth';
import { MILLIS_PER_DAY, MILLIS_PER_HOUR, addMillis, type Instant } from '@compass/clock';
import { findSessionByTokenHash, listSessionsForUser, type ScopedDb } from '@compass/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { T0, createAuthHarness, type AuthHarness } from './helpers/org.js';

/**
 * Session storage with rotation and expiry, asserted with an injected clock.
 *
 * Not one line of this waits. `now` is a parameter everywhere in `@compass/auth`, so
 * "expires 30 days after creation" and "expires 14 days after last use" are arithmetic
 * this suite can drive directly — which is the only reason they can be asserted at all.
 */

let harness: AuthHarness;
let scoped: ScopedDb;
let userId: string;
let membershipId: string;

const A_DAY_LATER = (from: Instant, days: number): Instant => addMillis(from, days * MILLIS_PER_DAY);

beforeEach(async () => {
  harness = await createAuthHarness();
  scoped = harness.scoped;

  const registered = await registerAccount({
    scoped,
    email: 'priya@example.com',
    displayName: 'Priya Raman',
    password: 'a-long-enough-passphrase',
    role: 'manager',
    status: 'active',
    now: T0,
  });
  userId = registered.user.id;
  membershipId = registered.membership.id;
});

afterEach(async () => {
  await harness.close();
});

describe('the documented lifetimes', () => {
  it('are 30 days absolute and 14 days idle', () => {
    expect(SESSION_ABSOLUTE_TTL_DAYS).toBe(30);
    expect(SESSION_IDLE_TTL_DAYS).toBe(14);
    expect(SESSION_ABSOLUTE_TTL_MILLIS).toBe(30 * MILLIS_PER_DAY);
    expect(SESSION_IDLE_TTL_MILLIS).toBe(14 * MILLIS_PER_DAY);
  });

  it('freezes the absolute deadline at creation and never extends it', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    expect(started.session.expiresAt).toBe(A_DAY_LATER(T0, 30));

    // Kept alive by use — a gap longer than 14 days would hit idle expiry instead, which
    // is a different rule and has its own test. Each use pushes the idle deadline out; the
    // absolute one must not budge.
    let last = T0;
    for (const day of [10, 20, 29]) {
      last = A_DAY_LATER(T0, day);
      const resolved = await resolveIdentity({ scoped, secret: started.secret, now: last });
      expect(resolved.kind, `day ${day} should still be signed in`).toBe('identified');
    }

    const row = await findSessionByTokenHash(scoped, started.session.tokenHash);
    expect(row?.expiresAt, 'the absolute deadline must not move').toBe(A_DAY_LATER(T0, 30));
    expect(row?.lastUsedAt).toBe(last);
  });

  it('takes whichever deadline comes first', () => {
    // Fresh session: the absolute deadline is 30 days out, the idle one 14, so 14 wins.
    expect(sessionDeadline({ expiresAt: A_DAY_LATER(T0, 30), lastUsedAt: T0 })).toBe(A_DAY_LATER(T0, 14));

    // Used on day 25: idle would be day 39, but absolute is day 30, so 30 wins.
    expect(sessionDeadline({ expiresAt: A_DAY_LATER(T0, 30), lastUsedAt: A_DAY_LATER(T0, 25) })).toBe(
      A_DAY_LATER(T0, 30),
    );
  });
});

describe('sessions expire 30 days after creation', () => {
  it('is live the moment before and refused the moment after', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    // The session has to be *used* along the way, or idle expiry would end it first.
    let last = T0;
    for (const day of [7, 13, 19, 25, 29]) {
      last = A_DAY_LATER(T0, day);
      const alive = await resolveIdentity({ scoped, secret: started.secret, now: last });
      expect(alive.kind, `day ${day} should still be signed in`).toBe('identified');
    }
    expect(last).toBe(A_DAY_LATER(T0, 29));

    const justBefore = addMillis(A_DAY_LATER(T0, 30), -1);
    expect((await resolveIdentity({ scoped, secret: started.secret, now: justBefore })).kind).toBe('identified');

    const atDeadline = await resolveIdentity({ scoped, secret: started.secret, now: A_DAY_LATER(T0, 30) });
    expect(atDeadline.kind).toBe('anonymous');
    expect(atDeadline.kind === 'anonymous' ? atDeadline.rejection : null).toBe('expired');
  });

  it('seals the row rather than leaving a dead cookie to be re-evaluated forever', async () => {
    const started = await startSession({ scoped, userId, now: T0 });
    await resolveIdentity({ scoped, secret: started.secret, now: A_DAY_LATER(T0, 31) });

    const row = await findSessionByTokenHash(scoped, started.session.tokenHash);
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe('sessions expire 14 days after last use', () => {
  it('is refused at fourteen idle days even though the absolute deadline is far off', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    expect(started.session.expiresAt).toBe(A_DAY_LATER(T0, 30));

    const justBefore = addMillis(A_DAY_LATER(T0, 14), -1);
    expect((await resolveIdentity({ scoped, secret: started.secret, now: justBefore })).kind).toBe('identified');
  });

  it('is refused after fourteen days without any use at all', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    const resolved = await resolveIdentity({ scoped, secret: started.secret, now: A_DAY_LATER(T0, 14) });

    expect(resolved.kind).toBe('anonymous');
    expect(resolved.kind === 'anonymous' ? resolved.rejection : null).toBe('idle');
  });

  it('moves the idle deadline forward each time the session is used', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    // Used on day 10 — the idle deadline becomes day 24, so day 20 is still fine.
    await resolveIdentity({ scoped, secret: started.secret, now: A_DAY_LATER(T0, 10) });
    const onDayTwenty = await resolveIdentity({ scoped, secret: started.secret, now: A_DAY_LATER(T0, 20) });

    expect(onDayTwenty.kind).toBe('identified');
  });

  it('does not write on every request — the touch is hourly, not per hit', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    // Two requests a minute apart. The second must not have moved `last_used_at`, or a
    // busy deployment would be one UPDATE per request forever.
    await resolveIdentity({ scoped, secret: started.secret, now: addMillis(T0, MILLIS_PER_HOUR + 1000) });
    const afterFirst = await findSessionByTokenHash(scoped, started.session.tokenHash);

    await resolveIdentity({ scoped, secret: started.secret, now: addMillis(T0, MILLIS_PER_HOUR + 61_000) });
    const afterSecond = await findSessionByTokenHash(scoped, started.session.tokenHash);

    expect(afterSecond?.lastUsedAt).toBe(afterFirst?.lastUsedAt);
  });

  it('reports a rejection for a secret nobody issued', async () => {
    expect(sessionRejection(null, T0)).toBe('not_found');

    const resolved = await resolveIdentity({ scoped, secret: 'not-a-session-secret', now: T0 });
    expect(resolved.kind).toBe('anonymous');
  });
});

describe('the session identifier rotates on a privilege change', () => {
  it('invalidates the prior identifier and issues a new one', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    const seat = await changeSeat({
      scoped,
      membershipId,
      role: 'viewer',
      actorUserId: userId,
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    expect(seat.changed).toContain('role');
    expect(seat.sessionsRevoked).toBe(1);

    // The prior identifier no longer resolves — this is the criterion.
    const withOldCookie = await resolveIdentity({
      scoped,
      secret: started.secret,
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });
    expect(withOldCookie.kind).toBe('anonymous');
    expect(withOldCookie.kind === 'anonymous' ? withOldCookie.rejection : null).toBe('revoked');

    const row = await findSessionByTokenHash(scoped, started.session.tokenHash);
    expect(row?.revokedReason).toBe('role_change');
  });

  it('issues the replacement with a recorded lineage when the actor changed their own seat', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    const seat = await changeSeat({
      scoped,
      membershipId,
      role: 'owner',
      actorUserId: userId,
      now: addMillis(T0, MILLIS_PER_HOUR),
      actorSession: started.session,
    });

    expect(seat.replacementSession).not.toBeNull();
    expect(seat.replacementSession?.session.rotatedFromSessionId).toBe(started.session.id);
    expect(seat.replacementSession?.secret).not.toBe(started.secret);

    // And the replacement carries the *new* role, because the role is read from the
    // membership on every request rather than stored on the session.
    const resolved = await resolveIdentity({
      scoped,
      secret: seat.replacementSession?.secret ?? '',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });
    expect(resolved.kind === 'identified' ? resolved.identity.principal : null).toBe('owner');
  });

  it('writes nothing and revokes nothing when the change moves nothing', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    const seat = await changeSeat({
      scoped,
      membershipId,
      role: 'manager', // the role it already is
      actorUserId: userId,
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    expect(seat.changed).toEqual([]);
    expect(seat.sessionsRevoked).toBe(0);
    expect((await resolveIdentity({ scoped, secret: started.secret, now: addMillis(T0, MILLIS_PER_HOUR) })).kind).toBe(
      'identified',
    );
  });
});

describe('sign out', () => {
  it('ends one session and leaves the others alone', async () => {
    const laptop = await startSession({ scoped, userId, now: T0 });
    const phone = await startSession({ scoped, userId, now: addMillis(T0, 1000) });

    await endSession({ scoped, session: laptop.session, now: addMillis(T0, MILLIS_PER_HOUR) });

    const withLaptop = await resolveIdentity({ scoped, secret: laptop.secret, now: addMillis(T0, MILLIS_PER_HOUR) });
    const withPhone = await resolveIdentity({ scoped, secret: phone.secret, now: addMillis(T0, MILLIS_PER_HOUR) });

    expect(withLaptop.kind).toBe('anonymous');
    expect(withPhone.kind).toBe('identified');
  });

  it('“sign out all devices” invalidates every session for that user', async () => {
    const secrets: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      secrets.push((await startSession({ scoped, userId, now: addMillis(T0, index * 1000) })).secret);
    }

    const revoked = await endAllSessions({
      scoped,
      userId,
      actorUserId: userId,
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    expect(revoked).toBe(4);
    for (const secret of secrets) {
      const resolved = await resolveIdentity({ scoped, secret, now: addMillis(T0, MILLIS_PER_HOUR) });
      expect(resolved.kind, 'every device must be signed out').toBe('anonymous');
    }

    const rows = await listSessionsForUser(scoped, userId);
    expect(rows.every((row) => row.revokedReason === 'sign_out_all_devices')).toBe(true);
  });

  it('leaves another user’s sessions untouched', async () => {
    const mine = await startSession({ scoped, userId, now: T0 });

    const other = await registerAccount({
      scoped,
      email: 'marcus@example.com',
      displayName: 'Marcus Hale',
      password: 'another-long-passphrase',
      role: 'viewer',
      status: 'active',
      now: T0,
    });
    const theirs = await startSession({ scoped, userId: other.user.id, now: T0 });

    await endAllSessions({ scoped, userId, actorUserId: userId, now: addMillis(T0, MILLIS_PER_HOUR) });

    expect((await resolveIdentity({ scoped, secret: mine.secret, now: addMillis(T0, MILLIS_PER_HOUR) })).kind).toBe(
      'anonymous',
    );
    expect((await resolveIdentity({ scoped, secret: theirs.secret, now: addMillis(T0, MILLIS_PER_HOUR) })).kind).toBe(
      'identified',
    );
  });
});

describe('sessions are stored as digests, never as the cookie value', () => {
  it('keeps the secret out of the row entirely', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    expect(started.session.tokenHash).not.toBe(started.secret);
    expect(started.session.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const dump = await harness.database.client.query<{ token_hash: string }>('select token_hash from sessions');
    for (const row of dump.rows) {
      expect(row.token_hash).not.toBe(started.secret);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('never resolves one tenant’s cookie in another tenant’s scope', async () => {
    const started = await startSession({ scoped, userId, now: T0 });

    const acrossTenants = await resolveIdentity({ scoped: harness.other, secret: started.secret, now: T0 });

    expect(acrossTenants.kind).toBe('anonymous');
  });
});
