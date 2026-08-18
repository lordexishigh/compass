import {
  generateTotpSecret,
  hashRecoveryCode,
  issueSecondFactorChallenge,
  registerAccount,
  startSession,
  totpCodeForStep,
  totpStepFor,
  SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR,
} from '@compass/auth';
import { addMillis, instantFromIso, toEpochMillis, type Instant } from '@compass/clock';
import {
  ScopedDb,
  activateSecondFactor,
  beginSecondFactorEnrollment,
  findSecondFactor,
  listAuditLogEntries,
  orgScope,
  replaceRecoveryCodes,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { edgeNow } from './helpers/edge-now';
import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import { FIXTURE_PASSPHRASE, WRONG_PASSPHRASE, fixtureCredential } from './helpers/fixture-credentials';

/**
 * Two-factor sign-in, executed against a real migrated database.
 *
 * `packages/auth/tests/totp.test.ts` proves the algorithm against RFC 6238's own vectors and proves that
 * `verifyTotpCode` refuses a step it is *told* was already spent. That is a property of a pure function,
 * and it is not the guarantee anybody cares about: the guarantee is that presenting the same six digits
 * to the running endpoint twice fails the second time, which is true only if the accepted step is written
 * back to `user_second_factors.last_used_step` — the column migration 0016 added for exactly this.
 *
 * So these tests drive the handlers. The only stubbed thing is `lib/database`'s pool, the seam between
 * this process and a database, exactly as `login-route.test.ts` does it. Argon2id, the guard, the matrix,
 * `verifyTotpCode`, the conditional `UPDATE`s and `startSession` are all the production path.
 *
 * Time is chosen rather than waited for: `T0` fixes the TOTP step, so "the same code half a minute later"
 * is expressed by moving the instant instead of sleeping.
 */

let database: TestDatabase;

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;
const T0 = instantFromIso('2026-08-05T09:00:00Z');

const PASSWORD = FIXTURE_PASSPHRASE;
const EMAIL = 'priya@example.com';
const CHALLENGE_SECRET = fixtureCredential('second-factor-challenge-signing');

const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

let userId = '';

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-systems',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  const account = await registerAccount({
    scoped: scoped(),
    email: EMAIL,
    displayName: 'Priya Raman',
    password: PASSWORD,
    role: 'manager',
    status: 'active',
    now: T0,
  });

  userId = account.user.id;
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(() => {
  process.env[SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR] = CHALLENGE_SECRET;
});

afterEach(async () => {
  delete process.env[SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR];
  // Each test states its own enrollment, so nothing carries over.
  const { deleteSecondFactor } = await import('@compass/db');
  await deleteSecondFactor(scoped(), userId);
});


/** An activated enrollment with a known secret, so the test can compute the code the app would show. */
async function enroll(at: Instant = edgeNow()): Promise<string> {
  const secret = generateTotpSecret();
  await beginSecondFactorEnrollment(scoped(), { id: crypto.randomUUID(), userId, secret }, at);
  // Activated with a step well behind `at`, so the code *for* `at` is still unspent.
  await activateSecondFactor(scoped(), { userId, usedStep: totpStepFor(at) - 5 }, at);
  return secret;
}

const jsonRequest = (path: string, body: unknown, method = 'POST') =>
  new Request(`https://compass.example.com${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sessionCookie = (response: Response): string | null =>
  response.headers.getSetCookie().find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? null;

/**
 * A request carrying a real session cookie for the enrolled user.
 *
 * Minted at the edge clock, not at `T0`: the guard resolves this cookie against real time, and a session
 * issued at a fixed past instant would be refused for being idle rather than for the reason under test.
 */
async function signedInRequest(path: string, body: unknown, method = 'POST'): Promise<Request> {
  const started = await startSession({ scoped: scoped(), userId, now: edgeNow() });
  return new Request(`https://compass.example.com${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(started.secret)}`,
    },
    body: JSON.stringify(body),
  });
}

describe('a password alone does not sign in an account with 2FA on', () => {
  it('returns a challenge and no session cookie', async () => {
    await enroll();
    const { POST } = await import('../app/api/auth/login/route');

    const response = await POST(jsonRequest('/api/auth/login', { email: EMAIL, password: PASSWORD }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    /**
     * The assertion that makes the factor mandatory rather than advisory.
     *
     * A cookie here would mean every screen it authorises is already reachable and the code prompt is a
     * page somebody can navigate away from.
     */
    expect(sessionCookie(response), 'a session cookie was set before the code was presented').toBeNull();
    expect(body).toMatchObject({ signedIn: false, secondFactorRequired: true });
    expect(typeof body['challenge']).toBe('string');
  });

  it('still signs in normally when the enrollment is only pending', async () => {
    // A half-finished enrollment must not lock somebody out of their own account.
    const secret = generateTotpSecret();
    await beginSecondFactorEnrollment(scoped(), { id: crypto.randomUUID(), userId, secret }, T0);

    const { POST } = await import('../app/api/auth/login/route');
    const response = await POST(jsonRequest('/api/auth/login', { email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(200);
    expect(sessionCookie(response)).not.toBeNull();
  });

  it('refuses rather than downgrading when the challenge cannot be signed', async () => {
    await enroll();
    delete process.env[SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR];

    const { POST } = await import('../app/api/auth/login/route');
    const response = await POST(jsonRequest('/api/auth/login', { email: EMAIL, password: PASSWORD }));

    // A missing secret must not silently turn every 2FA account back into a password-only one.
    expect(response.status).toBe(503);
    expect(sessionCookie(response)).toBeNull();
  });
});

describe('the code step', () => {
  it('accepts a valid code once and refuses the identical code the second time', async () => {
    const at = edgeNow();
    const secret = await enroll(at);
    const { POST } = await import('../app/api/auth/2fa/challenge/route');

    const challenge = issueSecondFactorChallenge({ userId, now: at }) ?? '';
    const code = totpCodeForStep(secret, totpStepFor(at));

    const first = await POST(jsonRequest('/api/auth/2fa/challenge', { challenge, code }));
    expect(first.status).toBe(200);
    expect(sessionCookie(first), 'the first, valid attempt got no session').not.toBeNull();

    /**
     * The whole point of migration 0016, asserted end to end.
     *
     * The same six digits, still inside their 30-second window, against the running endpoint. This can
     * only fail if the accepted step was persisted — and if it were not, a shoulder-surfed code would be
     * replayable for the rest of its step by anybody who also holds a challenge.
     */
    const replay = await POST(
      jsonRequest('/api/auth/2fa/challenge', {
        challenge: issueSecondFactorChallenge({ userId, now: addMillis(at, 1_000) }) ?? '',
        code,
      }),
    );

    expect(replay.status).toBe(401);
    expect(sessionCookie(replay), 'a replayed code minted a session').toBeNull();

    // And the durable record of it is in the row, not just in the refusal.
    const stored = await findSecondFactor(scoped(), userId);
    expect(stored?.lastUsedStep).toBe(totpStepFor(at));
  });

  it('mints a session whose lifetime matches a password-only session', async () => {
    const at = edgeNow();
    const secret = await enroll(at);

    const twoFactor = await (await import('../app/api/auth/2fa/challenge/route')).POST(
      jsonRequest('/api/auth/2fa/challenge', {
        challenge: issueSecondFactorChallenge({ userId, now: at }) ?? '',
        code: totpCodeForStep(secret, totpStepFor(at)),
      }),
    );
    expect(twoFactor.status).toBe(200);
    const twoFactorBody = (await twoFactor.json()) as Record<string, unknown>;

    /**
     * The same `startSession`, so both TTLs and the rotation are inherited rather than re-decided — a
     * second-factor session that expired on its own schedule would be a policy nobody chose.
     *
     * Compared as a *lifetime* rather than as two absolute timestamps. The route read the edge clock and
     * this line reads it again, so the two instants differ by however long the handler took; asserting
     * equal ISO strings would be asserting that a database round trip takes zero milliseconds, which is a
     * test that passes until the machine is busy.
     */
    const reference = edgeNow();
    const direct = await startSession({ scoped: scoped(), userId, now: reference });

    const twoFactorLifetime =
      Date.parse(String(twoFactorBody['sessionExpiresAt'])) - toEpochMillis(at);
    const passwordLifetime = direct.session.expiresAt - toEpochMillis(reference);

    expect(twoFactorLifetime).toBeGreaterThan(0);
    // Within a second of each other: same policy, two clock reads.
    expect(Math.abs(twoFactorLifetime - passwordLifetime)).toBeLessThan(1_000);
  });

  it('refuses a code presented with a forged challenge', async () => {
    const at = edgeNow();
    const secret = await enroll(at);
    const { POST } = await import('../app/api/auth/2fa/challenge/route');

    // A correct code, and a challenge naming the right user at the right time — but not signed by this
    // deployment. Without the signature check this is a sign-in for anybody who knows a user id.
    const forged = `${userId}.${toEpochMillis(at)}.${'0'.repeat(64)}`;
    const response = await POST(
      jsonRequest('/api/auth/2fa/challenge', {
        challenge: forged,
        code: totpCodeForStep(secret, totpStepFor(at)),
      }),
    );

    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toBeNull();
  });
});

describe('recovery codes', () => {
  it('accepts one exactly once, against the database', async () => {
    const at = edgeNow();
    await enroll(at);

    const RECOVERY = 'ABCD-EFGH';
    await replaceRecoveryCodes(
      scoped(),
      { userId, codes: [{ id: crypto.randomUUID(), codeHash: hashRecoveryCode(RECOVERY) }] },
      at,
    );

    const { POST } = await import('../app/api/auth/2fa/challenge/route');

    const first = await POST(
      jsonRequest('/api/auth/2fa/challenge', {
        challenge: issueSecondFactorChallenge({ userId, now: at }) ?? '',
        code: RECOVERY,
      }),
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as Record<string, unknown>)['usedRecoveryCode']).toBe(true);

    /**
     * Single use, which is the difference between a recovery code and a second password.
     *
     * Enforced by `used_at IS NULL` in the `UPDATE` and by only unspent hashes being offered to
     * `matchRecoveryCode` — a spent hash left in the candidate list would keep matching for ever.
     */
    const second = await POST(
      jsonRequest('/api/auth/2fa/challenge', {
        challenge: issueSecondFactorChallenge({ userId, now: addMillis(at, 1_000) }) ?? '',
        code: RECOVERY,
      }),
    );

    expect(second.status).toBe(401);
    expect(sessionCookie(second)).toBeNull();
  });

  it('regenerating replaces the batch and requires the current password', async () => {
    await enroll();
    const { POST } = await import('../app/api/auth/2fa/recovery-codes/route');

    const refused = await POST(
      await signedInRequest('/api/auth/2fa/recovery-codes', { password: WRONG_PASSPHRASE }),
    );
    // A session is not enough: the output is ten credentials that each bypass the authenticator app.
    expect(refused.status).toBe(403);

    const allowed = await POST(
      await signedInRequest('/api/auth/2fa/recovery-codes', { password: PASSWORD }),
    );
    expect(allowed.status).toBe(200);

    const issued = (await allowed.json())['recoveryCodes'] as string[];
    expect(issued).toHaveLength(10);
    // Replacement, not addition: the codes on the paper in somebody's drawer must stop working.
    expect(new Set(issued).size).toBe(10);
  });
});

describe('turning 2FA off', () => {
  it('refuses without re-authentication even with a valid session', async () => {
    await enroll();
    const { DELETE } = await import('../app/api/auth/2fa/route');

    const response = await DELETE(
      await signedInRequest('/api/auth/2fa', { password: WRONG_PASSPHRASE }, 'DELETE'),
    );

    expect(response.status).toBe(403);
    // Still on, which is the part that matters.
    expect((await findSecondFactor(scoped(), userId))?.activatedAt).not.toBeNull();
  });

  it('disables on the correct password and writes an audit row naming the actor', async () => {
    await enroll();
    const { DELETE } = await import('../app/api/auth/2fa/route');

    const response = await DELETE(await signedInRequest('/api/auth/2fa', { password: PASSWORD }, 'DELETE'));

    expect(response.status).toBe(200);
    expect(await findSecondFactor(scoped(), userId)).toBeNull();

    /**
     * The audit row is the criterion's other half.
     *
     * Disabling 2FA is what an attacker holding a stolen password does next, and it looks identical to the
     * rightful owner doing the same thing. The row naming the actor and the time is the only thing that
     * lets the two be told apart afterwards.
     */
    const entries = await listAuditLogEntries(scoped(), { limit: 50 });
    const disabled = entries.find((entry) => entry.action === 'account.second_factor_disabled');

    expect(disabled, 'disabling 2FA wrote no audit row').toBeDefined();
    expect(disabled?.actorUserId).toBe(userId);
    expect(disabled?.targetId).toBe(userId);
  });
});
