import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { organizations, users } from './tables.js';

/**
 * The second factor: one enrollment per user, and the recovery codes that get them back in.
 *
 * Two tables, and the split is what makes each guarantee enforceable in the database rather than only
 * in a handler.
 *
 * ## `user_second_factors` — the enrollment, one row per user
 *
 * Mutable, unlike the history tables: an enrollment genuinely moves between pending and active, and
 * `last_used_step` genuinely advances on every sign-in. There is no value in an append-only ledger of
 * TOTP steps.
 *
 * **`last_used_step` is the replay guarantee, and it lives here rather than in memory.** A code is a
 * one-time password; presenting it twice is either a double-submitted form or somebody replaying an
 * intercepted code, and Compass cannot tell those apart. An in-process cache would forget on deploy and
 * would not be shared between the two Compass processes, so the fact has to be a row. `verifyTotpCode`
 * takes it as an argument and returns the step it accepted, which the login path writes back — the
 * signature makes it impossible to verify a code correctly and still accept a replay.
 *
 * **`activated_at` is what distinguishes an enrollment from an enforcement.** A secret exists from the
 * moment somebody presses "set up", but 2FA is not *required* until they have proved they can produce a
 * code from it. Enforcing on the presence of the secret alone would lock out anybody who opened the
 * enrollment screen and closed the tab — the classic self-inflicted account lockout.
 *
 * ## `user_recovery_codes` — one row per code, so single-use is a row state
 *
 * Ten rows rather than an array column, because "this code has been spent" is a fact about one code and
 * needs somewhere to live. `used_at` is that place; a null means unspent. The alternative — deleting the
 * row — would lose the audit of *when* a recovery code was used, which is exactly the signal that
 * somebody has lost a device.
 *
 * **Only the hash is stored.** `code_hash` is a SHA-256 HMAC of the normalised code; the code itself is
 * shown once at generation and never again, and no query in this schema can return it. Regenerating
 * replaces the whole batch, which is why the unique index is on `(user_id, code_hash)` rather than on
 * the hash alone — the same code could in principle be issued to two people, and a global constraint
 * would make the second person's batch fail for a reason that is nothing to do with them.
 */
export const userSecondFactors = pgTable(
  'user_second_factors',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /**
     * The base32 shared secret.
     *
     * Stored as issued rather than encrypted, and that is a deliberate, stated trade. A TOTP secret is
     * a *verifier*: Compass has to hold the same value the phone holds in order to compute the same
     * code, so unlike an OAuth token there is no form of it that is useful to Compass and useless to a
     * database thief. Envelope-encrypting it would move the exposure to `COMPASS_KMS_MASTER_KEY` without
     * removing it, and would make the login path depend on the KMS being reachable — a second factor
     * that fails closed on a key-service outage locks every user out at once.
     *
     * What actually protects it is that it is worthless alone: it is a *second* factor, so an attacker
     * with the database still needs the password, and the password is Argon2id.
     */
    secret: text('secret').notNull(),
    /**
     * Null until the user has proved they can produce a code. Enforcement reads this, never `secret`.
     */
    activatedAt: instantColumn('activated_at'),
    /**
     * The last TOTP step this user successfully presented. Null before the first verification.
     *
     * See the header: this is the replay guarantee. A candidate step at or below it is refused.
     */
    lastUsedStep: integer('last_used_step'),
    ...recordTimestamps(),
  },
  (table) => [
    // One enrollment per user. What makes the repository's write a genuine upsert rather than a
    // select-then-insert two concurrent enrollment attempts could both pass.
    uniqueIndex('user_second_factors_user_key').on(table.userId),
  ],
);

export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** SHA-256 HMAC of the normalised code. The code itself is shown once and never stored. */
    codeHash: text('code_hash').notNull(),
    /** Null while unspent. Set the moment it is accepted, which is what makes it single-use. */
    usedAt: instantColumn('used_at'),
    ...recordTimestamps(),
  },
  (table) => [
    // Per user rather than global: see the header for why a global constraint would fail the wrong
    // person's batch.
    uniqueIndex('user_recovery_codes_user_hash_key').on(table.userId, table.codeHash),
    // The one read the login path makes: this user's unspent codes.
    index('user_recovery_codes_user_used_idx').on(table.userId, table.usedAt),
  ],
);

/**
 * True when this enrollment enforces a code at sign-in.
 *
 * Read this rather than the secret's presence. A secret exists from the moment somebody opens the
 * enrollment screen; enforcing on that would lock out anybody who opened it and closed the tab.
 *
 * There is deliberately no `enforced` boolean column: `activated_at` already says it, and a boolean
 * beside it would be a third state to keep in step with an instant that answers the same question.
 */
export const secondFactorIsActive = (row: { readonly activatedAt: unknown }): boolean =>
  row.activatedAt !== null && row.activatedAt !== undefined;
