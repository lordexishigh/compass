import { randomUUID } from 'node:crypto';

import { RATE_LIMIT_POLICIES, RecordingMailer, digestSecret } from '@compass/auth';
import { MILLIS_PER_MINUTE, addMillis, instantFromIso, type Instant } from '@compass/clock';
import { ScopedDb, memberships, orgScope, users } from '@compass/db';
import { createTestDatabase, type TestDatabase } from '@compass/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  checkRateLimit,
  clearRateLimit,
  clientAddress,
  notifyLockout,
  resetRateLimits,
  tooManyRequests,
} from '../lib/rate-limit';

/**
 * The request edge's half of rate limiting: the 429, the `Retry-After`, and the lockout notice.
 *
 * Every instant is injected. The threshold, the refusal, the escalation and the reset are asserted
 * by stepping `now` forward in arithmetic — no `setTimeout`, no fake timers, no fifteen-minute test.
 * That is the same discipline `packages/auth/tests/rate-limit.test.ts` applies to the policy; this
 * file adds what only exists at the edge: the response, the headers, and the mail.
 */

const ORG = 'dddddddd-4444-4444-8444-dddddddddddd';
const NOW = instantFromIso('2026-08-03T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORG));

const OWNER_A = 'priya@example.com';
const OWNER_B = 'marcus@example.com';
const VICTIM = 'sam@example.com';

/** The mailer the web edge sends through, replaced with one that keeps what it was given. */
const MAILER_KEY = Symbol.for('compass.web.mailer');
type MailerGlobal = typeof globalThis & { [MAILER_KEY]?: RecordingMailer };
const recording = new RecordingMailer();

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  await database.seedOrganization({
    organizationId: ORG,
    name: 'Acme Platform',
    slug: 'acme-platform-limits',
    timezone: 'Europe/London',
    at: asDate('2026-08-01T00:00:00Z'),
  });

  // Two active owners and one ordinary manager. Both owners must be told; the manager must not.
  for (const [email, role] of [
    [OWNER_A, 'owner'],
    [OWNER_B, 'owner'],
    [VICTIM, 'manager'],
  ] as const) {
    const userId = randomUUID();
    await scoped()
      .insertInto(users, {
        id: userId,
        email,
        displayName: email,
        passwordHash: null,
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
    await scoped()
      .insertInto(memberships, {
        id: randomUUID(),
        userId,
        role,
        status: 'active',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  // A revoked owner, who must *not* be mailed: telling somebody whose seat was taken away about
  // this organization's sign-in attempts would be a leak to a former colleague.
  const revokedId = randomUUID();
  await scoped()
    .insertInto(users, {
      id: revokedId,
      email: 'departed@example.com',
      displayName: 'Departed Owner',
      passwordHash: null,
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();
  await scoped()
    .insertInto(memberships, {
      id: randomUUID(),
      userId: revokedId,
      role: 'owner',
      status: 'revoked',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  (globalThis as MailerGlobal)[MAILER_KEY] = recording;
}, 180_000);

afterAll(async () => {
  delete (globalThis as MailerGlobal)[MAILER_KEY];
  await database?.close();
});

afterEach(() => {
  // Counters are process-wide, so a test that inherited another's windows would pass or fail for
  // reasons it did not set up.
  resetRateLimits();
  recording.clear();
});

/** Spends `count` requests at one instant and returns the last outcome. */
const spend = (
  action: Parameters<typeof checkRateLimit>[0]['action'],
  subjects: Parameters<typeof checkRateLimit>[0]['subjects'],
  count: number,
  now: Instant = NOW,
) => {
  let outcome = checkRateLimit({ action, subjects, now });
  for (let index = 1; index < count; index += 1) outcome = checkRateLimit({ action, subjects, now });
  return outcome;
};

describe('a refused request answers 429 with Retry-After and performs nothing', () => {
  it('permits the documented allowance and refuses the next request', async () => {
    const policy = RATE_LIMIT_POLICIES.feedback_write;
    const subjects = { user: 'user-1' };

    const last = spend('feedback_write', subjects, policy.limit);
    expect(last.allowed).toBe(true);
    expect(last.response).toBeNull();

    const refused = checkRateLimit({ action: 'feedback_write', subjects, now: NOW });
    expect(refused.allowed).toBe(false);
    expect(refused.response?.status).toBe(429);
  });

  it('carries Retry-After in whole seconds, and a body naming the limit', async () => {
    const policy = RATE_LIMIT_POLICIES.report_regeneration;
    const subjects = { organization: ORG };

    spend('report_regeneration', subjects, policy.limit);
    const refused = checkRateLimit({ action: 'report_regeneration', subjects, now: NOW });

    const header = refused.response?.headers.get('retry-after');
    expect(header).not.toBeNull();
    expect(header).toMatch(/^\d+$/);
    expect(Number.parseInt(header!, 10)).toBeGreaterThan(0);
    // A delta rather than an HTTP date: the client most likely to be hammering an endpoint is also
    // the one most likely to have a wrong clock.
    expect(header).not.toContain('GMT');

    const body = (await refused.response!.json()) as { error: string; detail: string; retryAfterSeconds: number };
    expect(body.error).toBe('rate_limited');
    expect(body.detail).toContain('5 per hour per organization');
    expect(body.retryAfterSeconds).toBe(Number.parseInt(header!, 10));
  });

  it('is never cached, so a proxy cannot serve one caller’s 429 to the next', () => {
    const refused = tooManyRequests({
      policy: RATE_LIMIT_POLICIES.feedback_write,
      retryAfterSeconds: 30,
      lockedOut: false,
    });

    expect(refused.headers.get('cache-control')).toBe('no-store');
  });

  it('reports the longest wait when two subjects are both exhausted', () => {
    // A `Retry-After` shorter than the real wait is a header that lies: a well-behaved client obeys
    // it, is refused again, and concludes the header means nothing.
    const policy = RATE_LIMIT_POLICIES.auth_attempt;

    // Exhaust the IP counter first, at an earlier instant, so its window ends sooner.
    spend('auth_attempt', { ip: '203.0.113.9' }, policy.limit, NOW);
    // Then exhaust the account counter later, so its window — and its wait — is longer.
    const later = addMillis(NOW, 5 * MILLIS_PER_MINUTE);
    spend('auth_attempt', { account: VICTIM }, policy.limit, later);

    const refused = checkRateLimit({
      action: 'auth_attempt',
      subjects: { ip: '203.0.113.9', account: VICTIM },
      now: later,
    });

    expect(refused.allowed).toBe(false);
    // The account's window started five minutes later, so its deadline is the later of the two.
    expect(refused.retryAfterSeconds).toBeGreaterThan(15 * 60 - 5 * 60);
  });

  it('counts every subject even after one has refused, so no counter can be frozen', () => {
    /**
     * The failure this prevents.
     *
     * With an early exit on the first exhausted subject, an attacker could hold one IP at its limit
     * and the per-account counter would stop advancing — parked just below its own threshold, so the
     * lockout would never fire and the owner would never be told.
     */
    const policy = RATE_LIMIT_POLICIES.auth_attempt;
    const subjects = { ip: '203.0.113.9', account: VICTIM };

    // Exhaust the IP on its own first.
    spend('auth_attempt', { ip: '203.0.113.9' }, policy.limit);

    // Now hammer with both. The account counter must still climb to its own limit and lock out.
    let sawLockout = false;
    for (let index = 0; index < policy.limit + 2; index += 1) {
      const outcome = checkRateLimit({ action: 'auth_attempt', subjects, now: NOW });
      if (outcome.lockoutBegan) sawLockout = true;
    }

    expect(sawLockout, 'the account counter must keep advancing behind a refusing IP counter').toBe(true);
  });

  it('gives each subject value its own allowance', () => {
    const policy = RATE_LIMIT_POLICIES.feedback_write;

    spend('feedback_write', { user: 'user-1' }, policy.limit);
    expect(checkRateLimit({ action: 'feedback_write', subjects: { user: 'user-1' }, now: NOW }).allowed).toBe(false);
    // A different manager is unaffected — an office behind one address must not share an allowance.
    expect(checkRateLimit({ action: 'feedback_write', subjects: { user: 'user-2' }, now: NOW }).allowed).toBe(true);
  });

  it('does not count a subject the request has no value for', () => {
    // `/api/feedback` counts per user. An unauthenticated caller has no user id, and counting them
    // under a shared `null` bucket would let one anonymous flood refuse every manager.
    const outcome = checkRateLimit({ action: 'feedback_write', subjects: { user: null }, now: NOW });

    expect(outcome.allowed).toBe(true);
    for (let index = 0; index < 200; index += 1) {
      expect(checkRateLimit({ action: 'feedback_write', subjects: { user: null }, now: NOW }).allowed).toBe(true);
    }
  });
});

describe('the reset, on the injected clock', () => {
  it.each(['auth_attempt', 'report_regeneration', 'feedback_write', 'share_link_read'] as const)(
    'lets %s through again once its window has elapsed',
    (action) => {
      const policy = RATE_LIMIT_POLICIES[action];
      const subjects = { ip: 'x', account: 'y', organization: 'z', user: 'u', token: 't' };

      spend(action, subjects, policy.limit);
      expect(checkRateLimit({ action, subjects, now: NOW }).allowed).toBe(false);

      // One millisecond early: still refused. The window must not reset ahead of time.
      const early = addMillis(NOW, policy.windowMillis - 1);
      expect(checkRateLimit({ action, subjects, now: early }).allowed).toBe(false);

      // For a locking action the penalty is served after the window, so step past both.
      const after = addMillis(NOW, policy.windowMillis * 2 + 60 * MILLIS_PER_MINUTE);
      expect(checkRateLimit({ action, subjects, now: after }).allowed).toBe(true);
    },
  );

  it('forgets a subject’s pressure entirely when a correct credential arrives', () => {
    // Counting successful sign-ins would lock out the demonstration harness and anybody signing in
    // on a third device. `lib/rate-limit.ts` argues the case; this is the behaviour.
    const policy = RATE_LIMIT_POLICIES.auth_attempt;
    const subjects = { ip: '203.0.113.9', account: VICTIM };

    spend('auth_attempt', subjects, policy.limit);
    expect(checkRateLimit({ action: 'auth_attempt', subjects, now: NOW }).allowed).toBe(false);

    clearRateLimit('auth_attempt', subjects);

    expect(checkRateLimit({ action: 'auth_attempt', subjects, now: NOW }).allowed).toBe(true);
  });

  it('clears only the subjects it was given', () => {
    const policy = RATE_LIMIT_POLICIES.auth_attempt;

    spend('auth_attempt', { ip: '203.0.113.9', account: VICTIM }, policy.limit);
    clearRateLimit('auth_attempt', { account: VICTIM });

    // The account is clear; the address is not.
    expect(checkRateLimit({ action: 'auth_attempt', subjects: { account: VICTIM }, now: NOW }).allowed).toBe(true);
    expect(checkRateLimit({ action: 'auth_attempt', subjects: { ip: '203.0.113.9' }, now: NOW }).allowed).toBe(false);
  });
});

describe('the lockout escalates and the owner is told', () => {
  it('locks out on the eleventh attempt and reports the transition exactly once', () => {
    const policy = RATE_LIMIT_POLICIES.auth_attempt;
    const subjects = { account: VICTIM };

    spend('auth_attempt', subjects, policy.limit);

    const first = checkRateLimit({ action: 'auth_attempt', subjects, now: NOW });
    expect(first.allowed).toBe(false);
    expect(first.lockoutBegan, 'the request that earns the lockout is the transition').toBe(true);
    expect(first.strikes).toBe(1);

    for (let index = 0; index < 20; index += 1) {
      const again = checkRateLimit({ action: 'auth_attempt', subjects, now: addMillis(NOW, index) });
      expect(again.allowed).toBe(false);
      expect(again.lockoutBegan, 'a caller who keeps hammering must not re-trigger the notice').toBe(false);
    }
  });

  it('escalates: each lockout waits strictly longer than the one before', () => {
    const policy = RATE_LIMIT_POLICIES.auth_attempt;
    const subjects = { account: VICTIM };
    const waits: number[] = [];
    let now = NOW;

    for (let strike = 1; strike <= 4; strike += 1) {
      spend('auth_attempt', subjects, policy.limit, now);
      const refused = checkRateLimit({ action: 'auth_attempt', subjects, now });

      expect(refused.strikes).toBe(strike);
      expect(refused.lockoutBegan).toBe(true);
      waits.push(refused.retryAfterSeconds);

      now = addMillis(now, refused.retryAfterSeconds * 1000);
    }

    for (let index = 1; index < waits.length; index += 1) {
      expect(waits[index]!, `strike ${index + 1} must be longer than strike ${index}`).toBeGreaterThan(
        waits[index - 1]!,
      );
    }
    // Exponential rather than linear: the increments themselves double.
    const increments = waits.slice(1).map((wait, index) => wait - waits[index]!);
    expect(increments).toEqual([60, 120, 240]);
  });

  it('answers `account_locked` rather than `rate_limited`, so the form can say which it is', async () => {
    const policy = RATE_LIMIT_POLICIES.auth_attempt;
    const subjects = { account: VICTIM };

    spend('auth_attempt', subjects, policy.limit);
    const refused = checkRateLimit({ action: 'auth_attempt', subjects, now: NOW });

    const body = (await refused.response!.json()) as { error: string; detail: string };
    expect(body.error).toBe('account_locked');
    expect(body.detail).toContain('locked');
    expect(body.detail).toContain('email me a link');
  });

  it('mails every active owner, and nobody else', async () => {
    const sent = await notifyLockout({
      scoped: scoped(),
      subjectEmail: VICTIM,
      strikes: 1,
      retryAfterSeconds: 16 * 60,
      accountUrl: 'https://compass.example.com/account',
    });

    expect([...sent].sort()).toEqual([OWNER_B, OWNER_A].sort());
    expect(recording.sent).toHaveLength(2);

    // Not the manager whose account it is about, and not the revoked owner.
    const recipients = recording.sent.map((message) => message.to);
    expect(recipients).not.toContain(VICTIM);
    expect(recipients, 'a former owner must not be told about this organization’s sign-in attempts').not.toContain(
      'departed@example.com',
    );
  });

  it('writes a message that names the account, the duration and what to do', async () => {
    await notifyLockout({
      scoped: scoped(),
      subjectEmail: VICTIM,
      strikes: 3,
      retryAfterSeconds: 20 * 60,
      accountUrl: 'https://compass.example.com/account',
    });

    const message = recording.lastTo(OWNER_A);
    expect(message).not.toBeNull();
    expect(message?.purpose).toBe('lockout_notice');
    expect(message?.subject).toContain(VICTIM);
    expect(message?.body).toContain(VICTIM);
    expect(message?.body).toContain('20 minutes');
    expect(message?.body).toContain('3rd consecutive lockout');
    expect(message?.body).toContain('email me a link');
    // Nothing has been changed, and the mail says so — otherwise an owner reads it as an incident.
    expect(message?.body).toContain('Nothing has been changed');
  });

  it('carries no credential and no link that would bypass the lockout', async () => {
    await notifyLockout({
      scoped: scoped(),
      subjectEmail: VICTIM,
      strikes: 1,
      retryAfterSeconds: 960,
      accountUrl: 'https://compass.example.com/account',
    });

    const message = recording.lastTo(OWNER_A)!;
    // An "unlock" or "reset" link mailed to an inbox is a bypass worth exactly as much as that inbox.
    expect(message.link).toBe('https://compass.example.com/account');
    expect(message.body.toLowerCase()).not.toContain('unlock');
    expect(message.body).not.toContain('token=');
    expect(message.body).not.toContain(digestSecret(VICTIM));
  });

  it('says "first" for the first lockout rather than "1st consecutive"', async () => {
    await notifyLockout({
      scoped: scoped(),
      subjectEmail: VICTIM,
      strikes: 1,
      retryAfterSeconds: 960,
      accountUrl: 'https://compass.example.com/account',
    });

    expect(recording.lastTo(OWNER_A)?.body).toContain('the first lockout');
  });

  it('does not turn a failed send into a failed refusal', async () => {
    // The account is already locked, which is the part that mattered. A broken mail transport must
    // not turn a successful rate-limit refusal into a 500.
    const exploding = {
      async send() {
        throw new Error('smtp is down');
      },
    };
    (globalThis as MailerGlobal)[MAILER_KEY] = exploding as unknown as RecordingMailer;

    await expect(
      notifyLockout({
        scoped: scoped(),
        subjectEmail: VICTIM,
        strikes: 1,
        retryAfterSeconds: 960,
        accountUrl: 'https://compass.example.com/account',
      }),
    ).resolves.toEqual([]);

    (globalThis as MailerGlobal)[MAILER_KEY] = recording;
  });
});

describe('the address a request is counted against', () => {
  it('takes the first entry of x-forwarded-for, which is the client', () => {
    const request = new Request('https://compass.example.com/api/auth/login', {
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7, 192.0.2.1' },
    });

    expect(clientAddress(request)).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip, then to a shared bucket rather than to no limit', () => {
    expect(
      clientAddress(new Request('https://compass.example.com/', { headers: { 'x-real-ip': '203.0.113.9' } })),
    ).toBe('203.0.113.9');

    // `unknown` is a real bucket: requests with no forwarded header share one allowance, which is
    // the strict reading. Returning null and skipping the count would be the lenient one.
    const anonymous = clientAddress(new Request('https://compass.example.com/'));
    expect(anonymous).toBe('unknown');
    expect(anonymous.length).toBeGreaterThan(0);
  });

  it('ignores whitespace, so ` 203.0.113.9 ` is not a second allowance', () => {
    const request = new Request('https://compass.example.com/', {
      headers: { 'x-forwarded-for': '  203.0.113.9  , 198.51.100.7' },
    });

    expect(clientAddress(request)).toBe('203.0.113.9');
  });
});
