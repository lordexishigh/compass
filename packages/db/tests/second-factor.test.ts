import { addSeconds, instantFromIso, type Instant } from '@compass/clock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ScopedDb,
  activateSecondFactor,
  advanceTotpStep,
  beginSecondFactorEnrollment,
  countUnspentRecoveryCodes,
  deleteSecondFactor,
  ensureUser,
  findSecondFactor,
  listUnspentRecoveryCodeHashes,
  orgScope,
  organizations,
  replaceRecoveryCodes,
  secondFactorIsActive,
  spendRecoveryCode,
  userRecoveryCodes,
} from '@compass/db';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

/**
 * The second factor, against a real engine.
 *
 * `packages/auth/tests/totp.test.ts` proves the algorithm and the replay *rule*. This file proves the
 * two guarantees that only hold in the database, and which a handler cannot make on its own:
 *
 *  - **A recovery code is single-use under concurrency.** `spendRecoveryCode` is one conditional UPDATE
 *    with `used_at IS NULL` in its `WHERE`, so two simultaneous submissions of the same code cannot both
 *    be told they succeeded. A `SELECT`-then-`UPDATE` in TypeScript would let both through, and the
 *    failure would only appear under load.
 *  - **A spent TOTP step never moves backwards.** Same reasoning: the predicate is in the statement.
 *
 * Both are asserted by racing the calls rather than by reading the SQL, because the SQL is not the claim.
 */

const ORGANIZATION_ID = '77777777-7777-4777-8777-777777777777';
const FACTOR_ID = '99999999-9999-4999-8999-999999999999';

/** Set in `beforeAll` from the row `ensureUser` returns — the id is derived, not chosen. */
let USER_ID = '';

const T0: Instant = instantFromIso('2026-08-05T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

/** Ten well-formed hashes. The CHECK constraint requires 64 lower-case hex characters. */
const hashes = (count = 10): readonly string[] =>
  Array.from({ length: count }, (_unused, index) => String(index).padStart(2, '0').repeat(32));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  await database.db
    .insert(organizations)
    .values({
      id: ORGANIZATION_ID,
      organizationId: ORGANIZATION_ID,
      name: 'Northwind Systems',
      slug: 'northwind-second-factor',
      timezone: 'Europe/London',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .onConflictDoNothing()
    .execute();

  /**
   * `ensureUser` derives the row id from the organization and the email, so the id cannot be chosen —
   * which is the point of a deterministic id. The returned row is the source of truth for it.
   */
  const user = await ensureUser(scoped(), {
    email: 'owner@example.com',
    displayName: 'An Owner',
    passwordHash: null,
    at: T0,
  });
  USER_ID = user.id;
}, 120_000);

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await deleteSecondFactor(scoped(), USER_ID);
});

describe('an enrollment', () => {
  it('starts pending, so opening the screen cannot lock anybody out', async () => {
    await beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: 'JBSWY3DPEHPK3PXP' }, T0);

    const stored = await findSecondFactor(scoped(), USER_ID);
    expect(stored?.secret).toBe('JBSWY3DPEHPK3PXP');
    // The distinction the whole design rests on: a secret exists, enforcement does not.
    expect(stored?.activatedAt).toBeNull();
    expect(secondFactorIsActive(stored!)).toBe(false);
    expect(stored?.lastUsedStep).toBeNull();
  });

  it('replaces a pending secret rather than failing, and resets the spent step', async () => {
    /**
     * Pressing "set up" twice is ordinary. The reset is the part that matters: a new secret has spent no
     * steps, and carrying the old `last_used_step` forward would refuse the first code from the new
     * authenticator for up to thirty seconds, for a reason no person could work out.
     */
    await beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: 'FIRSTSECRET' }, T0);
    await activateSecondFactor(scoped(), { userId: USER_ID, usedStep: 5_000 }, T0);

    await beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: 'SECONDSECRET' }, T0);

    const stored = await findSecondFactor(scoped(), USER_ID);
    expect(stored?.secret).toBe('SECONDSECRET');
    expect(stored?.activatedAt).toBeNull();
    expect(stored?.lastUsedStep).toBeNull();
  });

  it('becomes active and spends the proving code in one act', async () => {
    // Without recording the step here, the very code somebody just typed would still be replayable at
    // the login screen for the rest of its thirty seconds.
    await beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: 'JBSWY3DPEHPK3PXP' }, T0);
    await activateSecondFactor(scoped(), { userId: USER_ID, usedStep: 1_234 }, T0);

    const stored = await findSecondFactor(scoped(), USER_ID);
    expect(secondFactorIsActive(stored!)).toBe(true);
    expect(stored?.lastUsedStep).toBe(1_234);
  });

  it('refuses an empty secret at the database, whatever the handler did', async () => {
    await expect(
      beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: '   ' }, T0),
    ).rejects.toThrow();
  });

  it('reports no enrollment for a user who never started one', async () => {
    expect(await findSecondFactor(scoped(), USER_ID)).toBeNull();
  });
});

describe('a spent TOTP step never moves backwards', () => {
  beforeEach(async () => {
    await beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: 'JBSWY3DPEHPK3PXP' }, T0);
    await activateSecondFactor(scoped(), { userId: USER_ID, usedStep: 1_000 }, T0);
  });

  it('advances to a later step', async () => {
    expect(await advanceTotpStep(scoped(), { userId: USER_ID, step: 1_001 }, T0)).toBe(true);
    expect((await findSecondFactor(scoped(), USER_ID))?.lastUsedStep).toBe(1_001);
  });

  it('refuses the step already spent — the replay, at the data layer', async () => {
    expect(await advanceTotpStep(scoped(), { userId: USER_ID, step: 1_000 }, T0)).toBe(false);
    expect((await findSecondFactor(scoped(), USER_ID))?.lastUsedStep).toBe(1_000);
  });

  it('refuses an earlier step, which is equally a replay inside the drift window', async () => {
    expect(await advanceTotpStep(scoped(), { userId: USER_ID, step: 999 }, T0)).toBe(false);
  });

  it('lets exactly one of two simultaneous sign-ins with the same code win', async () => {
    /**
     * The reason the predicate is in the statement.
     *
     * Two requests presenting the same code — a double-submitted form, or an attacker racing the person
     * they intercepted it from — both verify against the same secret and both try to record the same
     * step. At most one can be the person, so at most one may be told it succeeded. A read-then-write in
     * TypeScript would let both read the old value and both write.
     */
    const results = await Promise.all([
      advanceTotpStep(scoped(), { userId: USER_ID, step: 1_500 }, T0),
      advanceTotpStep(scoped(), { userId: USER_ID, step: 1_500 }, T0),
    ]);

    expect(results.filter((won) => won)).toHaveLength(1);
    expect((await findSecondFactor(scoped(), USER_ID))?.lastUsedStep).toBe(1_500);
  });
});

describe('recovery codes', () => {
  const CODES = hashes();

  beforeEach(async () => {
    await beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: 'JBSWY3DPEHPK3PXP' }, T0);
    await replaceRecoveryCodes(
      scoped(),
      { userId: USER_ID, codes: CODES.map((codeHash, index) => ({ id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`, codeHash })) },
      T0,
    );
  });

  it('stores a batch, all unspent', async () => {
    expect(await countUnspentRecoveryCodes(scoped(), USER_ID)).toBe(10);
    expect([...(await listUnspentRecoveryCodeHashes(scoped(), USER_ID))].sort()).toEqual([...CODES].sort());
  });

  it('refuses a plaintext code in the hash column, at the database', async () => {
    // The CHECK constraint is what stops a plaintext recovery code being written by *any* path — a psql
    // session, a future importer, a bug in a handler. `ABCD-EFGH` is nine characters and fails it.
    await expect(
      replaceRecoveryCodes(
        scoped(),
        { userId: USER_ID, codes: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', codeHash: 'ABCD-EFGH' }] },
        T0,
      ),
    ).rejects.toThrow();
  });

  it('spends a code once, and refuses it the second time', async () => {
    const code = CODES[3] as string;

    expect(await spendRecoveryCode(scoped(), { userId: USER_ID, codeHash: code }, T0)).toBe(true);
    // Single-use. The criterion, at the layer that can actually guarantee it.
    expect(await spendRecoveryCode(scoped(), { userId: USER_ID, codeHash: code }, T0)).toBe(false);

    expect(await countUnspentRecoveryCodes(scoped(), USER_ID)).toBe(9);
    expect(await listUnspentRecoveryCodeHashes(scoped(), USER_ID)).not.toContain(code);
  });

  it('lets exactly one of two simultaneous submissions of the same code win', async () => {
    // A `SELECT`-then-`UPDATE` would tell both callers they had signed in, and the bug would only ever
    // appear under load.
    const code = CODES[7] as string;

    const results = await Promise.all([
      spendRecoveryCode(scoped(), { userId: USER_ID, codeHash: code }, T0),
      spendRecoveryCode(scoped(), { userId: USER_ID, codeHash: code }, T0),
    ]);

    expect(results.filter((won) => won)).toHaveLength(1);
    expect(await countUnspentRecoveryCodes(scoped(), USER_ID)).toBe(9);
  });

  it('refuses a code that was never issued, indistinguishably from one already spent', async () => {
    // Both answer `false`. Distinguishing them to the user would tell an attacker which of ten guesses
    // was a real code.
    expect(await spendRecoveryCode(scoped(), { userId: USER_ID, codeHash: 'f'.repeat(64) }, T0)).toBe(false);
  });

  it('keeps the spent row, so "when was a recovery code used" stays answerable', async () => {
    /**
     * Deleting the row instead would lose exactly the signal that somebody has lost a device.
     */
    const code = CODES[0] as string;
    await spendRecoveryCode(scoped(), { userId: USER_ID, codeHash: code }, addSeconds(T0, 30));

    const all = await scoped().selectFrom(userRecoveryCodes);
    expect(all).toHaveLength(10);
    expect(all.find((row) => row.codeHash === code)?.usedAt).not.toBeNull();
  });

  it('regenerating replaces the batch rather than appending to it', async () => {
    /**
     * A person who regenerates expects the codes on the paper in their drawer to stop working. Appending
     * would leave the old ones live while the screen said otherwise — the worst of both.
     */
    await spendRecoveryCode(scoped(), { userId: USER_ID, codeHash: CODES[0] as string }, T0);

    const fresh = hashes(10).map((hash, index) => ({
      id: `cccccccc-0000-4000-8000-${String(index).padStart(12, '0')}`,
      // Distinct from the first batch, so "replaced" is observable.
      codeHash: hash.slice(0, 63) + 'a',
    }));
    await replaceRecoveryCodes(scoped(), { userId: USER_ID, codes: fresh }, T0);

    const remaining = await scoped().selectFrom(userRecoveryCodes);
    expect(remaining).toHaveLength(10);
    // The old batch is gone, including the spent one — regeneration is a clean slate.
    expect(remaining.map((row) => row.codeHash).sort()).toEqual(fresh.map((code) => code.codeHash).sort());
  });
});

describe('disabling', () => {
  it('removes the enrollment and every code together', async () => {
    /**
     * Both, in that order. A recovery code with no enrollment would be a credential that unlocks
     * nothing; an enrollment with no codes would be one somebody could be locked out of.
     */
    await beginSecondFactorEnrollment(scoped(), { id: FACTOR_ID, userId: USER_ID, secret: 'JBSWY3DPEHPK3PXP' }, T0);
    await activateSecondFactor(scoped(), { userId: USER_ID, usedStep: 1 }, T0);
    await replaceRecoveryCodes(
      scoped(),
      { userId: USER_ID, codes: hashes(3).map((codeHash, index) => ({ id: `dddddddd-0000-4000-8000-${String(index).padStart(12, '0')}`, codeHash })) },
      T0,
    );

    await deleteSecondFactor(scoped(), USER_ID);

    expect(await findSecondFactor(scoped(), USER_ID)).toBeNull();
    expect(await scoped().selectFrom(userRecoveryCodes)).toEqual([]);
  });

  it('is idempotent, so a double-submitted disable is not an error', async () => {
    await deleteSecondFactor(scoped(), USER_ID);
    await expect(deleteSecondFactor(scoped(), USER_ID)).resolves.toBeUndefined();
  });
});
