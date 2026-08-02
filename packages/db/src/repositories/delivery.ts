import type { Instant } from '@compass/clock';
import { and, asc, eq, isNull, type InferSelectModel } from 'drizzle-orm';

import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { deliveryLog, shareLinkAccess, shareLinks, subscriptions } from '../schema/delivery.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Subscriptions, delivery attempts and share links.
 *
 * Two rules shape this file and both are enforced below it as well as here.
 *
 * **`delivery_log` and `share_link_access` are append-only.** There is deliberately no
 * `updateDeliveryAttempt` or `deleteShareLinkAccess` to call: `ScopedDb` refuses an UPDATE or a
 * DELETE on either table and a database trigger refuses one underneath that. The questions these
 * tables exist to answer — "did the manager get Tuesday's report, and if not what did the
 * provider say", "who opened this shared link" — are not answerable from rows that can be edited.
 *
 * **Secrets are stored as digests.** Neither an unsubscribe token nor a share token is ever
 * written; only its SHA-256, computed in `@compass/delivery`, which is also the only place that
 * can produce one. So every lookup here takes a hash, never a token.
 */

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type DeliveryChannelName = 'email' | 'slack';
export type DeliveryScopeName = 'team' | 'merged' | 'both';

export interface SubscriptionInput {
  readonly id: string;
  readonly userId: string;
  readonly channel: DeliveryChannelName;
  readonly target: string;
  readonly scope: DeliveryScopeName;
  /** `HH:MM` in `timezone`. Validated by `assertSchedulable` before it reaches here. */
  readonly sendTime: string;
  readonly timezone: string;
  /** SHA-256 of the one-click unsubscribe secret. Never the secret. */
  readonly unsubscribeTokenHash: string;
  /**
   * The Slack user this subscriber *is*, when it has been mapped.
   *
   * Not the same thing as `target`: a Slack subscription usually targets a channel, and a channel
   * is not a person. This is the mapping an interactive feedback action is authorized by, and null
   * — "not mapped" — is refused with an ephemeral reply rather than guessed at.
   */
  readonly slackUserId?: string | null;
}

export interface StoredSubscription extends SubscriptionInput {
  readonly organizationId: string;
  readonly active: boolean;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

type SubscriptionRow = InferSelectModel<typeof subscriptions>;

const toStoredSubscription = (row: SubscriptionRow): StoredSubscription => ({
  id: row.id,
  organizationId: row.organizationId,
  userId: row.userId,
  channel: row.channel,
  target: row.target,
  scope: row.scope,
  sendTime: row.sendTime,
  timezone: row.timezone,
  active: row.active,
  unsubscribeTokenHash: row.unsubscribeTokenHash,
  slackUserId: row.slackUserId,
  createdAt: fromDatabaseInstant(row.createdAt),
  updatedAt: fromDatabaseInstant(row.updatedAt),
});

/**
 * The subscription that claims a Slack user id — the (Slack user → Compass seat) mapping.
 *
 * Returns the row whether or not it is active, and the caller decides. An inactive subscription
 * still identifies who its owner is, and a manager who switched their Slack daily off has not
 * stopped being themselves; refusing their feedback for that reason would be a puzzle rather than a
 * permission decision.
 *
 * Two subscriptions claiming one Slack user id is a configuration mistake rather than an attack —
 * somebody entered a colleague's id — so the oldest is returned and the choice is deterministic.
 * Acting on an arbitrary one would make the same click authorize as different people on different
 * days.
 */
export async function findSubscriptionBySlackUserId(
  scoped: ScopedDb,
  slackUserId: string,
): Promise<StoredSubscription | null> {
  const [row] = await scoped
    .selectFrom(subscriptions, eq(subscriptions.slackUserId, slackUserId))
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id))
    .limit(1);
  return row === undefined ? null : toStoredSubscription(row);
}

/**
 * Creates or replaces a person's subscription for one channel.
 *
 * Upsert on `(organization, user, channel)` rather than insert-only, because the screen offers
 * one row per channel and editing a send time is the ordinary case. Re-subscribing after an
 * unsubscribe therefore sets `active` back to true through the same path, which is what a manager
 * clicking "email me the daily" again expects.
 */
export async function upsertSubscription(
  scoped: ScopedDb,
  input: SubscriptionInput,
  at: Instant,
): Promise<StoredSubscription> {
  const recordedAt = toDatabaseInstant(at);

  await scoped
    .insertInto(subscriptions, {
      id: input.id,
      userId: input.userId,
      channel: input.channel,
      target: input.target,
      scope: input.scope,
      sendTime: input.sendTime,
      timezone: input.timezone,
      active: true,
      unsubscribeTokenHash: input.unsubscribeTokenHash,
      slackUserId: input.slackUserId ?? null,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    })
    .onConflictDoUpdate({
      target: [subscriptions.organizationId, subscriptions.userId, subscriptions.channel],
      set: {
        target: input.target,
        scope: input.scope,
        sendTime: input.sendTime,
        timezone: input.timezone,
        active: true,
        unsubscribeTokenHash: input.unsubscribeTokenHash,
        // `undefined` leaves the stored mapping alone; an explicit null clears it. A caller that
        // only changes the send time must not silently unmap somebody's Slack identity.
        ...(input.slackUserId === undefined ? {} : { slackUserId: input.slackUserId }),
        updatedAt: recordedAt,
      },
    })
    .execute();

  const found = await findSubscriptionForChannel(scoped, input.userId, input.channel);
  if (found === null) {
    throw new Error(`Subscription for ${input.userId}/${input.channel} was written but could not be read back.`);
  }
  return found;
}

/** One subscription by id — what a delivery job resolves its payload to. */
export async function findSubscriptionById(
  scoped: ScopedDb,
  id: string,
): Promise<StoredSubscription | null> {
  const [row] = await scoped.selectFrom(subscriptions, eq(subscriptions.id, id)).limit(1);
  return row === undefined ? null : toStoredSubscription(row);
}

export async function findSubscriptionForChannel(
  scoped: ScopedDb,
  userId: string,
  channel: DeliveryChannelName,
): Promise<StoredSubscription | null> {
  const [row] = await scoped
    .selectFrom(subscriptions, and(eq(subscriptions.userId, userId), eq(subscriptions.channel, channel)))
    .limit(1);
  return row === undefined ? null : toStoredSubscription(row);
}

export async function listSubscriptionsForUser(
  scoped: ScopedDb,
  userId: string,
): Promise<readonly StoredSubscription[]> {
  const rows = await scoped
    .selectFrom(subscriptions, eq(subscriptions.userId, userId))
    .orderBy(asc(subscriptions.channel));
  return rows.map(toStoredSubscription);
}

/**
 * Every subscription the worker should consider on a tick.
 *
 * Only the active ones, and the filter is in SQL rather than in the scheduler: a deployment with
 * ten thousand unsubscribed rows should not read them all every minute to discard them.
 */
export async function listActiveSubscriptions(scoped: ScopedDb): Promise<readonly StoredSubscription[]> {
  const rows = await scoped
    .selectFrom(subscriptions, eq(subscriptions.active, true))
    .orderBy(asc(subscriptions.id));
  return rows.map(toStoredSubscription);
}

/**
 * The subscription a one-click unsubscribe URL names, by digest.
 *
 * Takes the hash, so the token in the URL is never compared against a stored secret and never
 * written anywhere. The digest is unique per organization, which makes this an indexed equality
 * read rather than a scan.
 */
export async function findSubscriptionByUnsubscribeHash(
  scoped: ScopedDb,
  unsubscribeTokenHash: string,
): Promise<StoredSubscription | null> {
  const [row] = await scoped
    .selectFrom(subscriptions, eq(subscriptions.unsubscribeTokenHash, unsubscribeTokenHash))
    .limit(1);
  return row === undefined ? null : toStoredSubscription(row);
}

/**
 * Switches a subscription off. Idempotent by construction.
 *
 * The row stays rather than being deleted: RFC 8058 one-click unsubscribe has to be idempotent,
 * and a deleted row would make a second click — which mail clients do send — look like a broken
 * link. Setting `active = false` twice is the same state.
 */
export async function deactivateSubscription(scoped: ScopedDb, id: string, at: Instant): Promise<void> {
  await scoped
    .updateIn(subscriptions, { active: false, updatedAt: toDatabaseInstant(at) }, eq(subscriptions.id, id))
    .execute();
}

// ---------------------------------------------------------------------------
// Delivery attempts
// ---------------------------------------------------------------------------

export type DeliveryAttemptStatus = 'sent' | 'failed' | 'deferred' | 'skipped' | 'unsubscribed';

export interface DeliveryAttemptInput {
  readonly id: string;
  readonly subscriptionId: string;
  /** Null for a deferral: there was no report, which is what `deferred` means. */
  readonly reportId: string | null;
  readonly deliveryDate: string;
  readonly scopeKind: string;
  readonly scopeKey: string;
  readonly channel: DeliveryChannelName;
  readonly target: string;
  readonly attempt: number;
  readonly status: DeliveryAttemptStatus;
  readonly providerMessageId: string | null;
  readonly error: string | null;
  readonly detail: string;
}

export interface StoredDeliveryAttempt extends DeliveryAttemptInput {
  readonly recordedAt: Instant;
}

type DeliveryLogRow = InferSelectModel<typeof deliveryLog>;

const toStoredAttempt = (row: DeliveryLogRow): StoredDeliveryAttempt => ({
  id: row.id,
  subscriptionId: row.subscriptionId,
  reportId: row.reportId,
  deliveryDate: row.deliveryDate,
  scopeKind: row.scopeKind,
  scopeKey: row.scopeKey,
  channel: row.channel,
  target: row.target,
  attempt: row.attempt,
  status: row.status,
  providerMessageId: row.providerMessageId,
  error: row.error,
  detail: row.detail,
  recordedAt: fromDatabaseInstant(row.recordedAt),
});

/**
 * Records one attempt. **Every** attempt, including the ones that sent nothing.
 *
 * A plain insert with no conflict handling, deliberately. The partial unique index over
 * `status = 'sent'` is what makes a second successful send for the same scheduled delivery
 * impossible, and swallowing that conflict here would turn the guarantee into a silent no-op —
 * the caller has to know it lost the race so it does not report a send that did not happen.
 */
export async function recordDeliveryAttempt(
  scoped: ScopedDb,
  input: DeliveryAttemptInput,
  at: Instant,
): Promise<void> {
  await scoped
    .insertInto(deliveryLog, {
      id: input.id,
      subscriptionId: input.subscriptionId,
      reportId: input.reportId,
      deliveryDate: input.deliveryDate,
      scopeKind: input.scopeKind,
      scopeKey: input.scopeKey,
      channel: input.channel,
      target: input.target,
      attempt: input.attempt,
      status: input.status,
      providerMessageId: input.providerMessageId,
      error: input.error,
      detail: input.detail,
      recordedAt: toDatabaseInstant(at),
    })
    .execute();
}

/** Every attempt for one scheduled delivery, oldest first — the retry history. */
export async function listDeliveryAttempts(
  scoped: ScopedDb,
  delivery: {
    readonly subscriptionId: string;
    readonly deliveryDate: string;
    readonly scopeKind?: string;
    readonly scopeKey?: string;
  },
): Promise<readonly StoredDeliveryAttempt[]> {
  const filters = [
    eq(deliveryLog.subscriptionId, delivery.subscriptionId),
    eq(deliveryLog.deliveryDate, delivery.deliveryDate),
    ...(delivery.scopeKind === undefined ? [] : [eq(deliveryLog.scopeKind, delivery.scopeKind)]),
    ...(delivery.scopeKey === undefined ? [] : [eq(deliveryLog.scopeKey, delivery.scopeKey)]),
  ];

  const rows = await scoped.selectFrom(deliveryLog, and(...filters)).orderBy(asc(deliveryLog.recordedAt));
  return rows.map(toStoredAttempt);
}

/**
 * Whether this scheduled delivery has already been sent.
 *
 * The pre-send check. The partial unique index is the real guarantee, but reading it first means
 * a drained-and-re-enqueued job declines to *call the provider* rather than calling it and then
 * failing to record the result — which would deliver twice and log once.
 */
export async function hasBeenSent(
  scoped: ScopedDb,
  delivery: {
    readonly subscriptionId: string;
    readonly deliveryDate: string;
    readonly scopeKind: string;
    readonly scopeKey: string;
  },
): Promise<boolean> {
  const [row] = await scoped
    .selectFrom(
      deliveryLog,
      and(
        eq(deliveryLog.subscriptionId, delivery.subscriptionId),
        eq(deliveryLog.deliveryDate, delivery.deliveryDate),
        eq(deliveryLog.scopeKind, delivery.scopeKind),
        eq(deliveryLog.scopeKey, delivery.scopeKey),
        eq(deliveryLog.status, 'sent'),
      ),
    )
    .limit(1);

  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

export type ShareAudienceName = 'org_members' | 'public';

export interface ShareLinkInput {
  readonly id: string;
  readonly reportId: string;
  /** SHA-256 of the 128-bit token. The token is shown once and never stored. */
  readonly tokenHash: string;
  readonly audience: ShareAudienceName;
  /** Null means never. */
  readonly expiresAt: Instant | null;
  readonly createdByUserId: string;
}

export interface StoredShareLink extends Omit<ShareLinkInput, 'expiresAt'> {
  readonly organizationId: string;
  readonly expiresAt: Instant | null;
  readonly revokedAt: Instant | null;
  readonly createdAt: Instant;
}

type ShareLinkRow = InferSelectModel<typeof shareLinks>;

const toStoredShareLink = (row: ShareLinkRow): StoredShareLink => ({
  id: row.id,
  organizationId: row.organizationId,
  reportId: row.reportId,
  tokenHash: row.tokenHash,
  audience: row.audience,
  expiresAt: fromNullableDatabaseInstant(row.expiresAt),
  revokedAt: fromNullableDatabaseInstant(row.revokedAt),
  createdByUserId: row.createdByUserId,
  createdAt: fromDatabaseInstant(row.createdAt),
});

export async function createShareLink(
  scoped: ScopedDb,
  input: ShareLinkInput,
  at: Instant,
): Promise<StoredShareLink> {
  const recordedAt = toDatabaseInstant(at);

  await scoped
    .insertInto(shareLinks, {
      id: input.id,
      reportId: input.reportId,
      tokenHash: input.tokenHash,
      audience: input.audience,
      expiresAt: input.expiresAt === null ? null : toDatabaseInstant(input.expiresAt),
      revokedAt: null,
      createdByUserId: input.createdByUserId,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    })
    .execute();

  const found = await findShareLinkById(scoped, input.id);
  if (found === null) throw new Error(`Share link ${input.id} was written but could not be read back.`);
  return found;
}

export async function findShareLinkById(scoped: ScopedDb, id: string): Promise<StoredShareLink | null> {
  const [row] = await scoped.selectFrom(shareLinks, eq(shareLinks.id, id)).limit(1);
  return row === undefined ? null : toStoredShareLink(row);
}

/**
 * The link a token names, by digest.
 *
 * Scoped by organization like every other read here, so a token cannot reach across tenants even
 * if two organizations somehow held the same digest.
 */
export async function findShareLinkByTokenHash(
  scoped: ScopedDb,
  tokenHash: string,
): Promise<StoredShareLink | null> {
  const [row] = await scoped.selectFrom(shareLinks, eq(shareLinks.tokenHash, tokenHash)).limit(1);
  return row === undefined ? null : toStoredShareLink(row);
}

export async function listShareLinksForReport(
  scoped: ScopedDb,
  reportId: string,
): Promise<readonly StoredShareLink[]> {
  const rows = await scoped
    .selectFrom(shareLinks, eq(shareLinks.reportId, reportId))
    .orderBy(asc(shareLinks.createdAt));
  return rows.map(toStoredShareLink);
}

/**
 * Revokes a link. The row stays so the access log keeps pointing at something.
 *
 * Idempotent: revoking twice leaves the first instant in place, because *when* it was revoked is
 * the fact somebody wants when a shared URL stops working.
 */
export async function revokeShareLink(scoped: ScopedDb, id: string, at: Instant): Promise<void> {
  await scoped
    .updateIn(
      shareLinks,
      { revokedAt: toDatabaseInstant(at), updatedAt: toDatabaseInstant(at) },
      // `isNull`, not `eq(…, null)`: in SQL `= NULL` is never true, so an equality comparison
      // here would match no row and revocation would silently do nothing.
      and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// Share-link access
// ---------------------------------------------------------------------------

export type ShareAccessOutcome = 'served' | 'expired' | 'revoked' | 'forbidden' | 'not_found';

export interface ShareLinkAccessInput {
  readonly id: string;
  /** Null when the token matched no link — there is nothing to point at, by definition. */
  readonly shareLinkId: string | null;
  readonly outcome: ShareAccessOutcome;
  /** /24 for IPv4, /48 for IPv6. Never the full address. */
  readonly ipPrefix: string | null;
  readonly userAgent: string | null;
  readonly userId: string | null;
}

/**
 * Records one attempt to open a share link, served or refused.
 *
 * Refusals are recorded as well as successes: "somebody tried a revoked link forty times last
 * night" is precisely the fact this table exists to be able to state, and a log that only kept
 * successes could not.
 */
export async function recordShareLinkAccess(
  scoped: ScopedDb,
  input: ShareLinkAccessInput,
  at: Instant,
): Promise<void> {
  await scoped
    .insertInto(shareLinkAccess, {
      id: input.id,
      shareLinkId: input.shareLinkId,
      outcome: input.outcome,
      ipPrefix: input.ipPrefix,
      userAgent: input.userAgent,
      userId: input.userId,
      accessedAt: toDatabaseInstant(at),
    })
    .execute();
}

export interface StoredShareLinkAccess extends ShareLinkAccessInput {
  readonly accessedAt: Instant;
}

type ShareAccessRow = InferSelectModel<typeof shareLinkAccess>;

const toStoredAccess = (row: ShareAccessRow): StoredShareLinkAccess => ({
  id: row.id,
  shareLinkId: row.shareLinkId,
  outcome: row.outcome,
  ipPrefix: row.ipPrefix,
  userAgent: row.userAgent,
  userId: row.userId,
  accessedAt: fromDatabaseInstant(row.accessedAt),
});

/** One link's access history, oldest first. */
export async function listShareLinkAccess(
  scoped: ScopedDb,
  shareLinkId: string,
): Promise<readonly StoredShareLinkAccess[]> {
  const rows = await scoped
    .selectFrom(shareLinkAccess, eq(shareLinkAccess.shareLinkId, shareLinkId))
    .orderBy(asc(shareLinkAccess.accessedAt));
  return rows.map(toStoredAccess);
}
