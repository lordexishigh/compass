import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { organizations, users } from './tables.js';
import { reports } from './reports.js';

/**
 * Delivery: where the daily goes, whether it got there, and who has seen a shared copy.
 *
 * The manager's existing channel is where this product lives or dies, so the tables here are
 * shaped around two facts that are easy to get wrong.
 *
 * **A send time is a wall-clock fact, not an offset.** `send_time` is `HH:MM` and `timezone`
 * is an IANA name, and the worker resolves the pair to an instant for each civil date through
 * `instantAtLocalTime`. Storing a UTC time instead would make a 07:30 daily arrive at 06:30
 * for half the year, and storing a fixed offset would rot the first time a government moved a
 * transition date.
 *
 * **A delivery is attempted many times and must arrive once.** Those two pull in opposite
 * directions: "each attempt writes a DeliveryLog row" wants many rows per scheduled send,
 * "exactly one message per (subscription, date)" wants uniqueness. A plain unique constraint
 * would make the second retry a duplicate-key crash instead of a retry. So the uniqueness is
 * a *partial* index over `status = 'sent'`: failures and deferrals accumulate freely, and the
 * database itself refuses a second successful send for the same scheduled delivery.
 */

/** The two channels. A third would be a new enum value and a new transport, nothing else. */
export const deliveryChannel = pgEnum('delivery_channel', ['email', 'slack']);

/**
 * Which report(s) a subscription wants.
 *
 * `both` exists because a manager of three teams legitimately wants the merged picture *and*
 * the per-team detail, and making them choose would push them back to reading three tabs.
 * The default is derived from roster membership — one team means `team`, two or more means
 * `merged` — and it is stored per channel row, so somebody can take the merged report by
 * email and one team's detail in Slack.
 */
export const deliveryScope = pgEnum('delivery_scope', ['team', 'merged', 'both']);

/**
 * What happened on one attempt.
 *
 *  - `sent` — the provider accepted it. The only status the uniqueness index counts.
 *  - `failed` — the provider refused or the network did. Retried with backoff.
 *  - `deferred` — there is no report for that (org, scope, date) yet, so there was nothing
 *    to send. Deliberately not `failed`: an empty message is worse than a late one, and a
 *    deferral is the correct outcome rather than an error to alert on.
 *  - `skipped` — no provider key is configured. The worker says so once per attempt and
 *    carries on; a missing key must not crash the process or retry forever.
 *  - `unsubscribed` — the subscription was switched off between scheduling and sending.
 */
export const deliveryStatus = pgEnum('delivery_status', [
  'sent',
  'failed',
  'deferred',
  'skipped',
  'unsubscribed',
]);

/**
 * Who gets the daily, where, and when in their own day.
 *
 * One row per (user, channel): the acceptance criterion is that each channel carries its own
 * independent scope choice, and one row per user with two scope columns would make that
 * impossible to express without inventing a second shape for "off".
 *
 * `target` is the channel's own address — an email address, a Slack DM user id (`U…`) or a
 * channel (`#daily`). Kept as one column because it is one concept, and because the transport
 * that reads it is chosen by `channel` anyway.
 *
 * There is no `team_key` column, deliberately. Which teams a `team`-scoped subscription covers
 * is a question about the roster, and the roster already answers it through
 * `membership_team_scopes`. A copy here would be a second answer that drifts the first time
 * somebody is moved between teams.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channel: deliveryChannel('channel').notNull(),
    /** Email address, Slack user id for a DM, or `#channel`. */
    target: text('target').notNull(),
    /**
     * The Slack user this subscriber *is* — the mapping an interactive action is authorized by.
     *
     * `target` cannot serve: a Slack subscription usually targets a channel, and a channel is
     * not a person. When a manager clicks a feedback button, Slack sends the acting user's id and
     * nothing else, so Compass needs a stored (slack user id → Compass user) pair before it will
     * mutate anything. Null means "not mapped", which is refused with an ephemeral reply rather
     * than guessed at — an unmapped click that silently dismissed somebody else's risk would be
     * the worst possible outcome of a convenience feature.
     */
    slackUserId: text('slack_user_id'),
    scope: deliveryScope('scope').notNull(),
    /** `HH:MM`, 24-hour, in `timezone`. Never a UTC time. */
    sendTime: text('send_time').notNull(),
    /** An IANA zone name. Validated by `@compass/clock` before it is written. */
    timezone: text('timezone').notNull(),
    /**
     * False after an unsubscribe. The row stays: RFC 8058 one-click unsubscribe has to be
     * idempotent, and a deleted row would make a second click look like a broken link.
     */
    active: boolean('active').notNull().default(true),
    /**
     * SHA-256 of the unsubscribe secret in the `List-Unsubscribe` URL.
     *
     * The digest, never the secret, for the same reason as `auth_tokens`: a leaked backup
     * must not yield working unsubscribe links for every subscriber. It is a capability URL
     * rather than a session because a one-click unsubscribe arrives from a mail client with
     * no cookies.
     */
    unsubscribeTokenHash: text('unsubscribe_token_hash').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    unique('subscriptions_org_user_channel_key').on(table.organizationId, table.userId, table.channel),
    unique('subscriptions_org_unsubscribe_hash_key').on(table.organizationId, table.unsubscribeTokenHash),
    index('subscriptions_org_active_idx').on(table.organizationId, table.active),
  ],
);

/**
 * One row per delivery attempt. **Append-only.**
 *
 * In `APPEND_ONLY_TABLE_NAMES`, so neither the repository layer nor a psql session can rewrite
 * an attempt. That matters more here than it looks: the question this table exists to answer
 * is "did the manager get Tuesday's report, and if not, what did the provider say", and a
 * table whose rows can be edited cannot answer it.
 *
 * `report_id` is nullable exactly for a `deferred` attempt — there was no report to point at,
 * which is the whole content of that outcome.
 */
export const deliveryLog = pgTable(
  'delivery_log',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    /** Null for a deferral: there was no report, which is what `deferred` means. */
    reportId: uuid('report_id').references(() => reports.id),
    /**
     * The civil date of the *scheduled* send in the subscription's zone.
     *
     * The idempotency dimension, and a civil date rather than an instant because "Tuesday's
     * daily" is the thing that must not arrive twice. A retry three hours later is the same
     * scheduled delivery.
     */
    deliveryDate: text('delivery_date').notNull(),
    /** `team` or `merged`, and the key — so a `both` subscription's two sends are distinct. */
    scopeKind: text('scope_kind').notNull(),
    scopeKey: text('scope_key').notNull(),
    channel: deliveryChannel('channel').notNull(),
    /** Where it was actually addressed, as sent. */
    target: text('target').notNull(),
    /** 1-based. pg-boss's retry count, recorded so backoff can be reasoned about. */
    attempt: integer('attempt').notNull(),
    status: deliveryStatus('status').notNull(),
    /** The provider's own id for the message, when it accepted one. */
    providerMessageId: text('provider_message_id'),
    /** The provider's error, verbatim, for an operator. Null on success. */
    error: text('error'),
    /** One sentence in the product's voice — what the operator reads first. */
    detail: text('detail').notNull(),
    recordedAt: instantColumn('recorded_at').notNull(),
  },
  (table) => [
    /**
     * Exactly one *successful* send per scheduled delivery, enforced by the engine.
     *
     * Partial, over `status = 'sent'`. A plain unique constraint on the same columns would
     * reject the second attempt after a failure — turning the retry the criteria require into
     * a crash. This shape lets failures pile up and still makes a double send impossible,
     * which is the guarantee that survives the queue being drained and re-enqueued.
     */
    uniqueIndex('delivery_log_one_send_per_scheduled_delivery')
      .on(table.organizationId, table.subscriptionId, table.deliveryDate, table.scopeKind, table.scopeKey)
      .where(sql`${table.status} = 'sent'`),
    index('delivery_log_org_subscription_date_idx').on(
      table.organizationId,
      table.subscriptionId,
      table.deliveryDate,
    ),
    index('delivery_log_org_status_idx').on(table.organizationId, table.status),
  ],
);

/** Who a share link is for. Org members by default; `public` is an explicit act. */
export const shareAudience = pgEnum('share_audience', ['org_members', 'public']);

/**
 * A revocable permalink to one report.
 *
 * `token_hash` is the SHA-256 of a 128-bit CSPRNG token; the token itself is shown once, at
 * creation, and never stored. Two consequences are deliberate: a stolen database yields no
 * working links, and a lookup is an indexed equality read on the digest.
 *
 * The token is **not** derived from the report id, or from any hash of it. A derived token
 * would be guessable by anyone who could guess a report id — and report ids are themselves
 * derived from `(organization, scope, instant)`, so "guess the id" is "guess a date".
 * `packages/delivery/tests/share-links.test.ts` asserts non-derivation directly.
 *
 * `audience` defaults to `org_members`: a link that is merely hard to guess is not an
 * authorization decision, and the org's blockers and risks are not a landing page. Making a
 * link public is a separate, explicit choice.
 */
export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id),
    /** SHA-256 hex of the 128-bit token. The token is never written. */
    tokenHash: text('token_hash').notNull(),
    audience: shareAudience('audience').notNull().default('org_members'),
    /** Null means never. 7, 30 and 90 days are what the UI offers. */
    expiresAt: instantColumn('expires_at'),
    /** Set on revocation. Terminal, and separate from expiry so the two read apart. */
    revokedAt: instantColumn('revoked_at'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    ...recordTimestamps(),
  },
  (table) => [
    unique('share_links_org_token_hash_key').on(table.organizationId, table.tokenHash),
    index('share_links_org_report_idx').on(table.organizationId, table.reportId),
  ],
);

/**
 * Every attempt to open a share link, served or refused. **Append-only.**
 *
 * Refusals are recorded as well as successes, and that is the point: "somebody tried a revoked
 * link forty times last night" is exactly the fact this table exists to be able to state, and
 * a table that only logged successes could not.
 *
 * `ip_prefix` is a truncated address — /24 for IPv4, /48 for IPv6 — not the full one. It is
 * enough to tell "one office" from "forty countries", which is the question an operator has,
 * and it avoids keeping a precise location log of a manager's reading habits.
 */
export const shareLinkAccessOutcome = pgEnum('share_link_access_outcome', [
  'served',
  'expired',
  'revoked',
  'forbidden',
  'not_found',
]);

export const shareLinkAccess = pgTable(
  'share_link_access',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /**
     * Null when the token matched no link at all.
     *
     * A `not_found` attempt is still worth recording — it is what a token-guessing sweep looks
     * like — and there is no row to point it at by definition.
     */
    shareLinkId: uuid('share_link_id').references(() => shareLinks.id),
    outcome: shareLinkAccessOutcome('outcome').notNull(),
    /** /24 for IPv4, /48 for IPv6. Never the full address. */
    ipPrefix: text('ip_prefix'),
    userAgent: text('user_agent'),
    /** The signed-in reader, when there was one. Null for an anonymous public read. */
    userId: uuid('user_id').references(() => users.id),
    accessedAt: instantColumn('accessed_at').notNull(),
  },
  (table) => [
    index('share_link_access_org_link_idx').on(table.organizationId, table.shareLinkId),
    index('share_link_access_org_accessed_idx').on(table.organizationId, table.accessedAt),
  ],
);

/**
 * One row per consumed email feedback link — what makes a state-changing link single-use.
 *
 * ## Why single-use needs a table
 *
 * A signed link is a bearer capability with a 30-day life, and it lands in an inbox, in a mail
 * client's prefetch cache, in a corporate scanner and in a forwarded thread. Without this table,
 * "dismiss this risk" would be replayable by anything that ever saw the URL, for a month.
 *
 * The row is the token's **digest**, never the token: the same rule `auth_tokens`, `share_links`
 * and `subscriptions` follow, so a stolen backup yields nothing usable. The primary key is
 * `(organization_id, token_digest)` and the insert is a plain insert, so the *database* is what
 * refuses the second click — a read-then-write check would let two concurrent prefetches both
 * pass.
 *
 * Read-only feedback links are not recorded here and stay replayable, deliberately: a link that
 * only *shows* something has nothing to spend, and burning it on a mail scanner's prefetch would
 * mean the manager's own click landed on an error page.
 */
export const feedbackLinkUses = pgTable(
  'feedback_link_uses',
  {
    organizationId: organizationId().references(() => organizations.id),
    /** SHA-256 hex of the signed token. The token itself is never stored. */
    tokenDigest: text('token_digest').notNull(),
    /** The item and action the token was scoped to, for the audit trail. */
    reportItemStableId: text('report_item_stable_id').notNull(),
    action: text('action').notNull(),
    usedAt: instantColumn('used_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'feedback_link_uses_pkey',
      columns: [table.organizationId, table.tokenDigest],
    }),
  ],
);
