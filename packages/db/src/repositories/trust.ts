import type { Instant } from '@compass/clock';
import { and, eq, isNotNull, ne, or, sql } from 'drizzle-orm';

import { deterministicUuid } from '../entity-id.js';
import {
  fromDatabaseInstant,
  fromNullableDatabaseInstant,
  toDatabaseInstant,
} from '../schema/columns.js';
import { subprocessorNoticeSubscribers } from '../schema/trust.js';
import type { ScopedDb } from '../scoped-db.js';
import { normalizeEmail } from './auth.js';

/**
 * The subprocessor change-notice list.
 *
 * Reading and writing only. Whether a change *deserves* a notice, and what the notice says, is
 * `apps/worker/src/trust-notices.ts` over the digest exported by `@compass/trust` — a repository that
 * decided that would put the 30-day policy in the layer that cannot be unit-tested without a database.
 */

export interface StoredNoticeSubscriber {
  readonly id: string;
  readonly email: string;
  /** Null until the address has been confirmed. An unconfirmed row is never sent a notice. */
  readonly confirmedAt: Instant | null;
  readonly lastNoticedDigest: string | null;
  readonly lastNoticedAt: Instant | null;
  readonly unsubscribeTokenHash: string;
  readonly createdAt: Instant;
}

const toStored = (
  row: typeof subprocessorNoticeSubscribers.$inferSelect,
): StoredNoticeSubscriber => ({
  id: row.id,
  email: row.email,
  confirmedAt: fromNullableDatabaseInstant(row.confirmedAt),
  lastNoticedDigest: row.lastNoticedDigest,
  lastNoticedAt: fromNullableDatabaseInstant(row.lastNoticedAt),
  unsubscribeTokenHash: row.unsubscribeTokenHash,
  createdAt: fromDatabaseInstant(row.createdAt),
});

/**
 * Deterministic row id from `(organization, address)`.
 *
 * So a second subscription of the same address is the *same row* by construction rather than by a
 * lookup that two concurrent requests could both miss. The unique index would refuse the duplicate
 * either way; deriving the id means the upsert below is a genuine upsert.
 */
export const noticeSubscriberRowId = (organizationId: string, email: string): string =>
  deterministicUuid(`subprocessor-notice:${organizationId}:${email.toLowerCase()}`);

/**
 * Addresses are canonicalised through `normalizeEmail`, the same helper the account tables use.
 *
 * It lower-cases and trims, which is exactly what this table needs — one address must not be
 * subscribable twice by capitalisation. A second local copy of those two calls was the first version of
 * this file and it was wrong twice over: two spellings of one rule drift, and the enumerated list in
 * `packages/db/tests/scoped-repositories.test.ts` would have carried two entries with the same reason
 * written out beside each of them.
 */

export interface SubscribeInput {
  readonly email: string;
  /** SHA-256 of the unsubscribe token. The caller keeps the token and mails it. */
  readonly unsubscribeTokenHash: string;
  /**
   * The digest of the list as published right now.
   *
   * Recorded on the *new* row so a subscriber who joins today is not immediately notified about a change
   * that happened before they arrived. Ignored on an existing row: overwriting it would erase the record
   * of what that person was last told.
   */
  readonly currentDigest: string;
}

export interface SubscribeResult {
  readonly subscriber: StoredNoticeSubscriber;
  /** False when the address was already on the list, so the caller can say "already subscribed". */
  readonly created: boolean;
}

/**
 * Adds an address, or finds the one already there.
 *
 * `ON CONFLICT … DO UPDATE` touching only `updated_at`, which is what makes a re-submission idempotent
 * *and* observable: the row is returned either way so the route can re-send a confirmation, and nothing
 * about the existing subscription — its confirmation, its notice history — is disturbed by somebody
 * typing their address a second time.
 */
export async function subscribeToSubprocessorNotices(
  scoped: ScopedDb,
  input: SubscribeInput,
  at: Instant,
): Promise<SubscribeResult> {
  const email = normalizeEmail(input.email);
  const id = noticeSubscriberRowId(scoped.organizationId, email);
  const timestamp = toDatabaseInstant(at);

  const inserted = await scoped
    .insertInto(subprocessorNoticeSubscribers, {
      id,
      email,
      confirmedAt: null,
      lastNoticedDigest: input.currentDigest,
      lastNoticedAt: null,
      unsubscribeTokenHash: input.unsubscribeTokenHash,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing({ target: subprocessorNoticeSubscribers.id })
    .returning({ id: subprocessorNoticeSubscribers.id });

  const rows = await scoped.selectFrom(
    subprocessorNoticeSubscribers,
    eq(subprocessorNoticeSubscribers.id, id),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`The notice subscription for ${email} could not be read back after writing it.`);
  }

  return { subscriber: toStored(row), created: inserted.length > 0 };
}

/** Marks an address confirmed. Idempotent: confirming twice leaves the first instant in place. */
export async function confirmNoticeSubscriber(
  scoped: ScopedDb,
  unsubscribeTokenHash: string,
  at: Instant,
): Promise<StoredNoticeSubscriber | null> {
  const rows = await scoped.selectFrom(
    subprocessorNoticeSubscribers,
    eq(subprocessorNoticeSubscribers.unsubscribeTokenHash, unsubscribeTokenHash),
  );
  const row = rows[0];
  if (row === undefined) return null;

  if (row.confirmedAt === null) {
    await scoped
      .updateIn(
        subprocessorNoticeSubscribers,
        { confirmedAt: toDatabaseInstant(at), updatedAt: toDatabaseInstant(at) },
        eq(subprocessorNoticeSubscribers.id, row.id),
      )
      .execute();
  }

  const reread = await scoped.selectFrom(
    subprocessorNoticeSubscribers,
    eq(subprocessorNoticeSubscribers.id, row.id),
  );
  const confirmed = reread[0];
  return confirmed === undefined ? null : toStored(confirmed);
}

/** Removes an address by its unsubscribe token. Returns whether a row was there to remove. */
export async function unsubscribeFromSubprocessorNotices(
  scoped: ScopedDb,
  unsubscribeTokenHash: string,
): Promise<boolean> {
  const removed = await scoped
    .deleteFrom(
      subprocessorNoticeSubscribers,
      eq(subprocessorNoticeSubscribers.unsubscribeTokenHash, unsubscribeTokenHash),
    )
    .returning({ id: subprocessorNoticeSubscribers.id });

  return removed.length > 0;
}

/**
 * Confirmed subscribers who have not been told about the current list.
 *
 * The `digest !== current OR digest IS NULL` predicate is the whole selection rule, and it is in SQL
 * rather than in the job so the job cannot accidentally mail everybody: a bug that fetched the full list
 * and filtered in memory would still have loaded it, and the failure mode of *that* is sending a notice
 * to somebody who already had one.
 */
export async function subscribersAwaitingNotice(
  scoped: ScopedDb,
  currentDigest: string,
): Promise<readonly StoredNoticeSubscriber[]> {
  const rows = await scoped.selectFrom(
    subprocessorNoticeSubscribers,
    and(
      isNotNull(subprocessorNoticeSubscribers.confirmedAt),
      or(
        sql`${subprocessorNoticeSubscribers.lastNoticedDigest} is null`,
        ne(subprocessorNoticeSubscribers.lastNoticedDigest, currentDigest),
      ),
    ),
  );

  return rows.map(toStored);
}

/** Every subscriber, for the operator's own read. Confirmed and unconfirmed alike. */
export async function listNoticeSubscribers(
  scoped: ScopedDb,
): Promise<readonly StoredNoticeSubscriber[]> {
  const rows = await scoped.selectFrom(subprocessorNoticeSubscribers);
  return rows.map(toStored);
}

/**
 * Records that a subscriber has been told about a digest.
 *
 * Written *after* the send, so a transport that threw leaves the row behind and the next run tries again.
 * The opposite order would swallow the one notice the 30-day commitment exists to deliver.
 */
export async function recordNoticeSent(
  scoped: ScopedDb,
  input: { readonly id: string; readonly digest: string },
  at: Instant,
): Promise<void> {
  await scoped
    .updateIn(
      subprocessorNoticeSubscribers,
      {
        lastNoticedDigest: input.digest,
        lastNoticedAt: toDatabaseInstant(at),
        updatedAt: toDatabaseInstant(at),
      },
      eq(subprocessorNoticeSubscribers.id, input.id),
    )
    .execute();
}
