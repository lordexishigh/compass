import { index, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { memberships, organizations, users } from './tables.js';

/**
 * Team scoping and single-use tokens — the two things identity needs that the
 * foundation schema did not already carry.
 *
 * `organizations`, `users`, `memberships`, `sessions` and `audit_log_entries` were
 * declared in `schema/tables.ts` from the first migration, so they are not
 * redeclared here. What was missing was narrower than a table apiece:
 *
 *  - a membership answers *which role*, but nothing answered *which teams*, and
 *    "a manager of team A cannot read team B's report" is unenforceable without it;
 *  - three flows (magic link, password reset, seat invite) each need a secret that
 *    expires and can be spent exactly once.
 */

/**
 * The three things a mailed secret can be for.
 *
 * One table rather than three, because the *rules* are identical — issue a secret,
 * store only its digest, expire it, spend it once, revoke it early — and three
 * tables would be three chances to implement "single use" slightly differently.
 * The purpose decides the TTL and what consuming it does, and both of those live in
 * `@compass/auth` where they can be tested without a database.
 */
export const authTokenPurpose = pgEnum('auth_token_purpose', ['magic_link', 'password_reset', 'invite']);

/**
 * A single-use, expiring secret.
 *
 * `token_hash` is a SHA-256 digest of the secret that was mailed, never the secret
 * itself: a stolen database backup must not yield a working password-reset link.
 * The digest is unique per organization, which is what makes "look up the token"
 * an indexed equality read rather than a scan.
 *
 * `consumed_at` and `revoked_at` are both nullable and both terminal. They are
 * separate columns rather than one status enum because the two answers a human
 * needs are different: "this link was already used" and "an owner took this
 * invitation back" are not the same event, and an audit that conflated them could
 * not tell a double-click apart from a revoked seat.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    purpose: authTokenPurpose('purpose').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** SHA-256 of the mailed secret, hex. The secret itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    issuedAt: instantColumn('issued_at').notNull(),
    expiresAt: instantColumn('expires_at').notNull(),
    /** Set the first time the token is spent. A second attempt reads this and fails. */
    consumedAt: instantColumn('consumed_at'),
    /** Set when an owner revokes a pending invite, or when a newer token supersedes this one. */
    revokedAt: instantColumn('revoked_at'),
    /** Who caused this token to be issued, when that was a person rather than a form. */
    issuedByUserId: uuid('issued_by_user_id').references(() => users.id),
  },
  (table) => [
    unique('auth_tokens_org_hash_key').on(table.organizationId, table.tokenHash),
    index('auth_tokens_org_user_purpose_idx').on(table.organizationId, table.userId, table.purpose),
  ],
);

/**
 * Which teams a membership may read.
 *
 * A row per (membership, team). No rows at all means *unscoped*, which is the only
 * sensible reading for an owner: an owner of a three-team org who was accidentally
 * scoped to zero teams would be locked out of their own product. Managers, members
 * and viewers are the reverse — the matrix requires at least one scope row before
 * a team-scoped route will answer for them, so a manager whose scopes were never
 * set reads nothing rather than everything. `@compass/auth`'s `teamScopeDecision`
 * is the one implementation of that asymmetry.
 *
 * `team_key` is the team's natural key (`platform`), not a surrogate: it is the same
 * string the report scope and the connector use, so a scope row can be written
 * before the team has been ingested and still match when it arrives.
 */
export const membershipTeamScopes = pgTable(
  'membership_team_scopes',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    teamKey: text('team_key').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    unique('membership_team_scopes_org_membership_team_key').on(
      table.organizationId,
      table.membershipId,
      table.teamKey,
    ),
    index('membership_team_scopes_org_membership_idx').on(table.organizationId, table.membershipId),
  ],
);
