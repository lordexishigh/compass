import type { Instant } from '@compass/clock';
import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { userRecoveryCodes, userSecondFactors } from '../schema/second-factor.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Reading and writing the second factor.
 *
 * Two operations here carry a guarantee that cannot live in a handler, and both are written as a single
 * conditional statement so the database decides rather than the caller:
 *
 *  - **`advanceTotpStep`** refuses to move `last_used_step` backwards. The predicate is in the `WHERE`
 *    clause, so two concurrent sign-ins with the same code cannot both succeed — one updates, the other
 *    matches no row.
 *  - **`spendRecoveryCode`** sets `used_at` only `WHERE used_at IS NULL`. That is what makes a recovery
 *    code single-use *under concurrency*: a check-then-write in TypeScript would let two simultaneous
 *    submissions of the same code both pass the check.
 *
 * This file holds no policy. Whether a code is valid is `verifyTotpCode` in `@compass/auth`; whether
 * 2FA is enforced is `secondFactorIsActive`. A repository that decided either would put the rule in the
 * layer that cannot be unit-tested without a database.
 */

export interface StoredSecondFactor {
  readonly id: string;
  readonly userId: string;
  /** The base32 shared secret. See the schema for why it is stored as issued. */
  readonly secret: string;
  /** Null while the enrollment is pending. Enforcement reads this, never the secret's presence. */
  readonly activatedAt: Instant | null;
  /** The last TOTP step this user spent. Null before the first verification. */
  readonly lastUsedStep: number | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

const toStored = (row: typeof userSecondFactors.$inferSelect): StoredSecondFactor => ({
  id: row.id,
  userId: row.userId,
  secret: row.secret,
  activatedAt: fromNullableDatabaseInstant(row.activatedAt),
  lastUsedStep: row.lastUsedStep,
  createdAt: fromDatabaseInstant(row.createdAt),
  updatedAt: fromDatabaseInstant(row.updatedAt),
});

/** This user's enrollment, or null when they have never started one. */
export async function findSecondFactor(
  scoped: ScopedDb,
  userId: string,
): Promise<StoredSecondFactor | null> {
  const rows = await scoped
    .selectFrom(userSecondFactors, eq(userSecondFactors.userId, userId))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toStored(row);
}

/**
 * Starts (or restarts) an enrollment with a fresh secret.
 *
 * `ON CONFLICT (user_id) DO UPDATE` against the unique index, so pressing "set up" twice replaces the
 * pending secret rather than failing. **`activated_at` and `last_used_step` are reset to null**, which
 * is the important half: a new secret has spent no steps, and carrying the old `last_used_step` forward
 * would refuse the first code from the new authenticator for up to thirty seconds for no reason a person
 * could understand.
 *
 * Restarting an enrollment for an *already active* factor is refused by the caller, not here — see
 * `apps/web/app/api/auth/2fa/enroll/route.ts`, which requires a disable first so that losing an
 * authenticator cannot be turned into a silent factor swap by anybody holding a live session.
 */
export async function beginSecondFactorEnrollment(
  scoped: ScopedDb,
  input: { readonly id: string; readonly userId: string; readonly secret: string },
  now: Instant,
): Promise<void> {
  const at = toDatabaseInstant(now);

  await scoped
    .insertInto(userSecondFactors, {
      id: input.id,
      userId: input.userId,
      secret: input.secret,
      activatedAt: null,
      lastUsedStep: null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: userSecondFactors.userId,
      set: { secret: input.secret, activatedAt: null, lastUsedStep: null, updatedAt: at },
    })
    .execute();
}

/**
 * Marks an enrollment active and records the step its proving code used.
 *
 * The step is written in the same statement as the activation, so the code that proved the enrollment
 * is spent by the act of enrolling. Without that, the very code somebody just typed would still be
 * replayable at the login screen for the rest of its thirty seconds.
 */
export async function activateSecondFactor(
  scoped: ScopedDb,
  input: { readonly userId: string; readonly usedStep: number },
  now: Instant,
): Promise<void> {
  await scoped
    .updateIn(
      userSecondFactors,
      { activatedAt: toDatabaseInstant(now), lastUsedStep: input.usedStep, updatedAt: toDatabaseInstant(now) },
      eq(userSecondFactors.userId, input.userId),
    )
    .execute();
}

/**
 * Records a spent TOTP step, refusing to move backwards.
 *
 * Returns whether the row moved. `false` means another request already spent this step or a later one —
 * which the caller must treat as a replay, because that is what it is: two sign-ins presenting the same
 * code, of which at most one can be the person.
 *
 * The `>` predicate is in the statement rather than in TypeScript on purpose. A read-then-write would
 * let two concurrent requests both read `null`, both verify the same code, and both write — and the
 * replay guarantee would hold only for requests that happened to be serialised.
 */
export async function advanceTotpStep(
  scoped: ScopedDb,
  input: { readonly userId: string; readonly step: number },
  now: Instant,
): Promise<boolean> {
  const moved = await scoped
    .updateIn(
      userSecondFactors,
      { lastUsedStep: input.step, updatedAt: toDatabaseInstant(now) },
      and(
        eq(userSecondFactors.userId, input.userId),
        // One statement, both cases. `NULL` is "no step spent yet", which any step beats; otherwise the
        // stored step must be strictly behind. Splitting this into two updates — try-null-then-try-less —
        // would reintroduce exactly the race the predicate exists to close, because the second statement
        // would run against a row the first had already read.
        or(isNull(userSecondFactors.lastUsedStep), lt(userSecondFactors.lastUsedStep, input.step)),
      ),
    )
    .returning({ id: userSecondFactors.id });

  return moved.length > 0;
}

/**
 * Removes the enrollment and every recovery code for this user.
 *
 * Both together, in that order, because a recovery code with no enrollment would be a credential that
 * unlocks nothing — and an enrollment with no codes would be one somebody could be locked out of.
 * Deleting rather than deactivating: a disabled second factor's secret is a live credential, and the one
 * table in this schema where keeping history would only widen the blast radius of a dump.
 *
 * The audit record is written by the caller, which is the layer that knows *who* disabled it.
 */
export async function deleteSecondFactor(scoped: ScopedDb, userId: string): Promise<void> {
  await scoped.deleteFrom(userRecoveryCodes, eq(userRecoveryCodes.userId, userId)).execute();
  await scoped.deleteFrom(userSecondFactors, eq(userSecondFactors.userId, userId)).execute();
}

/**
 * Replaces the whole batch of recovery codes.
 *
 * Regeneration is a replacement, never an addition: a person who regenerates expects the codes on the
 * paper in their drawer to stop working, and appending would leave the old ones live while the screen
 * said otherwise.
 */
export async function replaceRecoveryCodes(
  scoped: ScopedDb,
  input: {
    readonly userId: string;
    /** `{ id, codeHash }` per code. Hashes only — the plaintext is shown once and never stored. */
    readonly codes: readonly { readonly id: string; readonly codeHash: string }[];
  },
  now: Instant,
): Promise<void> {
  const at = toDatabaseInstant(now);

  await scoped.deleteFrom(userRecoveryCodes, eq(userRecoveryCodes.userId, input.userId)).execute();

  if (input.codes.length === 0) return;

  await scoped
    .insertInto(
      userRecoveryCodes,
      input.codes.map((code) => ({
        id: code.id,
        userId: input.userId,
        codeHash: code.codeHash,
        usedAt: null,
        createdAt: at,
        updatedAt: at,
      })),
    )
    .execute();
}

/** The unspent code hashes for this user, for `matchRecoveryCode` to compare against. */
export async function listUnspentRecoveryCodeHashes(
  scoped: ScopedDb,
  userId: string,
): Promise<readonly string[]> {
  const rows = await scoped.selectFrom(
    userRecoveryCodes,
    and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)),
  );

  return rows.map((row) => row.codeHash);
}

/** How many codes are left, for the screen to state rather than imply. */
export const countUnspentRecoveryCodes = async (scoped: ScopedDb, userId: string): Promise<number> =>
  (await listUnspentRecoveryCodeHashes(scoped, userId)).length;

/**
 * Spends one recovery code, and answers whether this call was the one that spent it.
 *
 * `WHERE used_at IS NULL` is the single-use guarantee, and it is in the statement because that is the
 * only place it holds under concurrency: two simultaneous submissions of the same code would both pass
 * a `SELECT`-then-`UPDATE` check, and both would be told they had signed in.
 *
 * Returns `false` for a code that does not exist as well as one already spent. The caller must not
 * distinguish them to the user — "that code has already been used" tells an attacker which of ten
 * guesses was a real code.
 */
export async function spendRecoveryCode(
  scoped: ScopedDb,
  input: { readonly userId: string; readonly codeHash: string },
  now: Instant,
): Promise<boolean> {
  const spent = await scoped
    .updateIn(
      userRecoveryCodes,
      { usedAt: toDatabaseInstant(now), updatedAt: toDatabaseInstant(now) },
      and(
        eq(userRecoveryCodes.userId, input.userId),
        eq(userRecoveryCodes.codeHash, input.codeHash),
        isNull(userRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: userRecoveryCodes.id });

  return spent.length > 0;
}
