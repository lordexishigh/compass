import type { Instant } from '@compass/clock';
import { and, asc, desc, eq, isNull, or, type InferSelectModel } from 'drizzle-orm';

import { deterministicUuid } from '../entity-id.js';
import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { authTokens, membershipTeamScopes } from '../schema/auth.js';
import { auditLogEntries, memberships, sessions, users } from '../schema/tables.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Identity, seats, sessions, tokens and the audit log — all through one scope.
 *
 * Every function here takes a `ScopedDb` as its first parameter and reaches the
 * database only through it, so the `organization_id` predicate is added by the
 * layer rather than remembered by the caller. `tests/scoped-repositories.test.ts`
 * enumerates every exported repository function in the package and fails on any
 * that does not, which is what stops the next one from being written differently.
 *
 * Two rules are structural rather than conventional:
 *
 *  - **The audit log is append-only.** `audit_log_entries` is in
 *    `APPEND_ONLY_TABLE_NAMES`, so `ScopedDb.updateIn` and `deleteFrom` throw for
 *    it and a database trigger refuses the same thing underneath. There is
 *    deliberately no `updateAuditLogEntry` or `deleteAuditLogEntry` in this file to
 *    call in the first place.
 *  - **Secrets are stored as digests.** Neither a session cookie nor a mailed token
 *    is ever written; only its SHA-256. The digest is computed in `@compass/auth`,
 *    which is also the only place that can produce one.
 */

// ---------------------------------------------------------------------------
// Row ids
// ---------------------------------------------------------------------------

/**
 * Email, canonicalised for identity.
 *
 * Lower-cased and trimmed, and nothing else. Stripping dots or `+tag` suffixes
 * would merge two addresses that some providers treat as distinct, which would let
 * an invite reach a mailbox the inviter did not name.
 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Derived ids, so a replayed write lands on the row it already wrote.
 *
 * The seat bootstrap runs on every boot; without derivation it would insert a
 * second owner membership per container restart.
 */
export const userRowId = (organizationId: string, email: string): string =>
  deterministicUuid(`user:${organizationId}:${normalizeEmail(email)}`);

export const membershipRowId = (organizationId: string, userId: string): string =>
  deterministicUuid(`membership:${organizationId}:${userId}`);

export const teamScopeRowId = (organizationId: string, membershipId: string, teamKey: string): string =>
  deterministicUuid(`membership-team-scope:${organizationId}:${membershipId}:${teamKey}`);

export const authTokenRowId = (organizationId: string, tokenHash: string): string =>
  deterministicUuid(`auth-token:${organizationId}:${tokenHash}`);

export const sessionRowId = (organizationId: string, tokenHash: string): string =>
  deterministicUuid(`session:${organizationId}:${tokenHash}`);

export const auditLogRowId = (
  organizationId: string,
  action: string,
  targetId: string,
  occurredAtMillis: number,
): string => deterministicUuid(`audit:${organizationId}:${action}:${targetId}:${occurredAtMillis}`);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type MembershipRole = 'owner' | 'manager' | 'member' | 'viewer';
export type MembershipStatus = 'pending' | 'active' | 'revoked';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** Argon2id PHC string, or null for an account that has only ever used a link. */
  readonly passwordHash: string | null;
}

export interface UserInput {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly at: Instant;
}

const toUserRow = (row: typeof users.$inferSelect): UserRow => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  passwordHash: row.passwordHash,
});

export async function findUserByEmail(scoped: ScopedDb, email: string): Promise<UserRow | null> {
  const rows = await scoped.selectFrom(users, eq(users.email, normalizeEmail(email))).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : toUserRow(row);
}

export async function findUserById(scoped: ScopedDb, userId: string): Promise<UserRow | null> {
  const rows = await scoped.selectFrom(users, eq(users.id, userId)).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : toUserRow(row);
}

/**
 * Creates a user, or returns the one that already holds the address.
 *
 * An invite to an address that is already a user must attach a seat to that user
 * rather than fail or shadow them, so this is an upsert on nothing: the row is
 * inserted if absent and read back if present, and an existing display name or
 * password is never overwritten by an invitation.
 */
export async function ensureUser(scoped: ScopedDb, input: UserInput): Promise<UserRow> {
  const email = normalizeEmail(input.email);
  const existing = await findUserByEmail(scoped, email);
  if (existing !== null) return existing;

  const id = userRowId(scoped.organizationId, email);
  const at = toDatabaseInstant(input.at);
  await scoped
    .insertInto(users, {
      id,
      email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .execute();

  return (
    (await findUserByEmail(scoped, email)) ?? {
      id,
      email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
    }
  );
}

/** Replaces a user's password hash. The prior hash is overwritten, never archived. */
export async function setUserPasswordHash(
  scoped: ScopedDb,
  userId: string,
  passwordHash: string,
  at: Instant,
): Promise<void> {
  await scoped
    .updateIn(users, { passwordHash, updatedAt: toDatabaseInstant(at) }, eq(users.id, userId))
    .execute();
}

export async function setUserDisplayName(
  scoped: ScopedDb,
  userId: string,
  displayName: string,
  at: Instant,
): Promise<void> {
  await scoped
    .updateIn(users, { displayName, updatedAt: toDatabaseInstant(at) }, eq(users.id, userId))
    .execute();
}

// ---------------------------------------------------------------------------
// Memberships — the seats
// ---------------------------------------------------------------------------

export interface MembershipRow {
  readonly id: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/** A seat with the person and the team scopes attached — what the seats screen lists. */
export interface SeatRow extends MembershipRow {
  readonly email: string;
  readonly displayName: string;
  readonly hasPassword: boolean;
  readonly teamKeys: readonly string[];
}

const toMembershipRow = (row: typeof memberships.$inferSelect): MembershipRow => ({
  id: row.id,
  userId: row.userId,
  role: row.role,
  status: row.status,
  createdAt: fromDatabaseInstant(row.createdAt),
  updatedAt: fromDatabaseInstant(row.updatedAt),
});

export async function findMembershipByUserId(scoped: ScopedDb, userId: string): Promise<MembershipRow | null> {
  const rows = await scoped.selectFrom(memberships, eq(memberships.userId, userId)).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : toMembershipRow(row);
}

export async function findMembershipById(scoped: ScopedDb, membershipId: string): Promise<MembershipRow | null> {
  const rows = await scoped.selectFrom(memberships, eq(memberships.id, membershipId)).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : toMembershipRow(row);
}

export interface MembershipInput {
  readonly userId: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly at: Instant;
}

/** Creates a seat, or returns the existing one for that user unchanged. */
export async function ensureMembership(scoped: ScopedDb, input: MembershipInput): Promise<MembershipRow> {
  const existing = await findMembershipByUserId(scoped, input.userId);
  if (existing !== null) return existing;

  const id = membershipRowId(scoped.organizationId, input.userId);
  const at = toDatabaseInstant(input.at);
  await scoped
    .insertInto(memberships, {
      id,
      userId: input.userId,
      role: input.role,
      status: input.status,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .execute();

  return (
    (await findMembershipByUserId(scoped, input.userId)) ?? {
      id,
      userId: input.userId,
      role: input.role,
      status: input.status,
      createdAt: input.at,
      updatedAt: input.at,
    }
  );
}

export async function setMembershipRole(
  scoped: ScopedDb,
  membershipId: string,
  role: MembershipRole,
  at: Instant,
): Promise<void> {
  await scoped
    .updateIn(memberships, { role, updatedAt: toDatabaseInstant(at) }, eq(memberships.id, membershipId))
    .execute();
}

export async function setMembershipStatus(
  scoped: ScopedDb,
  membershipId: string,
  status: MembershipStatus,
  at: Instant,
): Promise<void> {
  await scoped
    .updateIn(memberships, { status, updatedAt: toDatabaseInstant(at) }, eq(memberships.id, membershipId))
    .execute();
}

/**
 * Role order for display, so the seats list is stable and owners are at the top.
 *
 * Written here rather than relying on the Postgres enum's declaration order: that
 * order is a schema detail nobody should have to know in order to read this list.
 */
const ROLE_RANK: Readonly<Record<MembershipRole, number>> = { owner: 0, manager: 1, member: 2, viewer: 3 };

/** Every seat in the organization, with its person and its team scopes. */
export async function listSeats(scoped: ScopedDb): Promise<readonly SeatRow[]> {
  const membershipRows = await scoped.selectFrom(memberships).orderBy(asc(memberships.createdAt));
  const userRows = await scoped.selectFrom(users);
  const scopeRows = await scoped
    .selectFrom(membershipTeamScopes)
    .orderBy(asc(membershipTeamScopes.membershipId), asc(membershipTeamScopes.teamKey));

  const userById = new Map(userRows.map((row) => [row.id, row]));
  const scopesByMembership = new Map<string, string[]>();
  for (const row of scopeRows) {
    const bucket = scopesByMembership.get(row.membershipId);
    if (bucket === undefined) scopesByMembership.set(row.membershipId, [row.teamKey]);
    else bucket.push(row.teamKey);
  }

  return membershipRows
    .map((row): SeatRow => {
      const user = userById.get(row.userId);
      return {
        ...toMembershipRow(row),
        email: user?.email ?? '',
        displayName: user?.displayName ?? '',
        hasPassword: (user?.passwordHash ?? null) !== null,
        teamKeys: scopesByMembership.get(row.id) ?? [],
      };
    })
    .sort((left, right) => {
      const byRole = ROLE_RANK[left.role] - ROLE_RANK[right.role];
      return byRole !== 0 ? byRole : left.email < right.email ? -1 : left.email > right.email ? 1 : 0;
    });
}

/**
 * Every seat that can still act, for the "is this the last owner" check.
 *
 * Pending seats count: an invited owner who has not accepted yet is still an owner
 * the organization is relying on, and treating them as absent would let the only
 * active owner remove themselves and lock everyone out.
 */
export async function listUsableMemberships(scoped: ScopedDb): Promise<readonly MembershipRow[]> {
  const usable = or(eq(memberships.status, 'active'), eq(memberships.status, 'pending'));
  const rows = await scoped.selectFrom(memberships, usable).orderBy(asc(memberships.createdAt));
  return rows.map(toMembershipRow);
}

// ---------------------------------------------------------------------------
// Team scopes
// ---------------------------------------------------------------------------

/** The team keys one membership may read. Empty means "no scope row was written". */
export async function listTeamScopes(scoped: ScopedDb, membershipId: string): Promise<readonly string[]> {
  const rows = await scoped
    .selectFrom(membershipTeamScopes, eq(membershipTeamScopes.membershipId, membershipId))
    .orderBy(asc(membershipTeamScopes.teamKey));
  return rows.map((row) => row.teamKey);
}

/**
 * Sets a membership's team scopes to exactly `teamKeys`.
 *
 * A delete-then-insert rather than a diff: the scope set is small, the whole point
 * is that the result is exactly what was asked for, and a diff that dropped a
 * removal would silently leave a manager reading a team they were just taken off.
 */
export async function replaceTeamScopes(
  scoped: ScopedDb,
  membershipId: string,
  teamKeys: readonly string[],
  at: Instant,
): Promise<readonly string[]> {
  await scoped.deleteFrom(membershipTeamScopes, eq(membershipTeamScopes.membershipId, membershipId)).execute();

  const wanted = [...new Set(teamKeys.map((key) => key.trim()).filter((key) => key.length > 0))].sort();
  if (wanted.length === 0) return wanted;

  const stamp = toDatabaseInstant(at);
  await scoped
    .insertInto(
      membershipTeamScopes,
      wanted.map((teamKey) => ({
        id: teamScopeRowId(scoped.organizationId, membershipId, teamKey),
        membershipId,
        teamKey,
        createdAt: stamp,
        updatedAt: stamp,
      })),
    )
    .onConflictDoNothing()
    .execute();

  return wanted;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly issuedAt: Instant;
  readonly lastUsedAt: Instant;
  readonly expiresAt: Instant;
  readonly revokedAt: Instant | null;
  readonly revokedReason: string | null;
  readonly rotatedFromSessionId: string | null;
}

const toSessionRow = (row: typeof sessions.$inferSelect): SessionRow => ({
  id: row.id,
  userId: row.userId,
  tokenHash: row.tokenHash,
  issuedAt: fromDatabaseInstant(row.issuedAt),
  lastUsedAt: fromDatabaseInstant(row.lastUsedAt),
  expiresAt: fromDatabaseInstant(row.expiresAt),
  revokedAt: fromNullableDatabaseInstant(row.revokedAt),
  revokedReason: row.revokedReason,
  rotatedFromSessionId: row.rotatedFromSessionId,
});

export interface SessionInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly issuedAt: Instant;
  /** The absolute deadline, computed by `@compass/auth` and frozen here. */
  readonly expiresAt: Instant;
  readonly rotatedFromSessionId?: string | null;
}

export async function insertSession(scoped: ScopedDb, input: SessionInput): Promise<SessionRow> {
  const id = sessionRowId(scoped.organizationId, input.tokenHash);
  await scoped
    .insertInto(sessions, {
      id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      issuedAt: toDatabaseInstant(input.issuedAt),
      lastUsedAt: toDatabaseInstant(input.issuedAt),
      expiresAt: toDatabaseInstant(input.expiresAt),
      revokedAt: null,
      revokedReason: null,
      rotatedFromSessionId: input.rotatedFromSessionId ?? null,
    })
    .onConflictDoNothing()
    .execute();

  return {
    id,
    userId: input.userId,
    tokenHash: input.tokenHash,
    issuedAt: input.issuedAt,
    lastUsedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    revokedAt: null,
    revokedReason: null,
    rotatedFromSessionId: input.rotatedFromSessionId ?? null,
  };
}

export async function findSessionByTokenHash(scoped: ScopedDb, tokenHash: string): Promise<SessionRow | null> {
  const rows = await scoped.selectFrom(sessions, eq(sessions.tokenHash, tokenHash)).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : toSessionRow(row);
}

export async function findSessionById(scoped: ScopedDb, sessionId: string): Promise<SessionRow | null> {
  const rows = await scoped.selectFrom(sessions, eq(sessions.id, sessionId)).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : toSessionRow(row);
}

/** Advances `last_used_at`, which is what the idle deadline is measured from. */
export async function touchSession(scoped: ScopedDb, sessionId: string, at: Instant): Promise<void> {
  await scoped.updateIn(sessions, { lastUsedAt: toDatabaseInstant(at) }, eq(sessions.id, sessionId)).execute();
}

export async function revokeSession(
  scoped: ScopedDb,
  sessionId: string,
  reason: string,
  at: Instant,
): Promise<void> {
  await scoped
    .updateIn(
      sessions,
      { revokedAt: toDatabaseInstant(at), revokedReason: reason },
      and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)),
    )
    .execute();
}

/**
 * Revokes every live session a user holds.
 *
 * This is both "sign out all devices" and the second half of a privilege change:
 * a role change revokes the lot and issues one new session for the browser that is
 * currently talking, so a cookie held by an old tab stops working the moment the
 * role moves.
 */
export async function revokeAllSessionsForUser(
  scoped: ScopedDb,
  userId: string,
  reason: string,
  at: Instant,
): Promise<number> {
  const live = await scoped.selectFrom(sessions, and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  if (live.length === 0) return 0;

  await scoped
    .updateIn(
      sessions,
      { revokedAt: toDatabaseInstant(at), revokedReason: reason },
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt)),
    )
    .execute();

  return live.length;
}

/** Every session a user holds, newest first — what a device list reads. */
export async function listSessionsForUser(scoped: ScopedDb, userId: string): Promise<readonly SessionRow[]> {
  const rows = await scoped.selectFrom(sessions, eq(sessions.userId, userId)).orderBy(desc(sessions.issuedAt));
  return rows.map(toSessionRow);
}

// ---------------------------------------------------------------------------
// Single-use tokens
// ---------------------------------------------------------------------------

export type AuthTokenPurpose = 'magic_link' | 'password_reset' | 'invite';

export interface AuthTokenRow {
  readonly id: string;
  readonly purpose: AuthTokenPurpose;
  readonly userId: string;
  readonly tokenHash: string;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
  readonly consumedAt: Instant | null;
  readonly revokedAt: Instant | null;
  readonly issuedByUserId: string | null;
}

const toAuthTokenRow = (row: typeof authTokens.$inferSelect): AuthTokenRow => ({
  id: row.id,
  purpose: row.purpose,
  userId: row.userId,
  tokenHash: row.tokenHash,
  issuedAt: fromDatabaseInstant(row.issuedAt),
  expiresAt: fromDatabaseInstant(row.expiresAt),
  consumedAt: fromNullableDatabaseInstant(row.consumedAt),
  revokedAt: fromNullableDatabaseInstant(row.revokedAt),
  issuedByUserId: row.issuedByUserId,
});

export interface AuthTokenInput {
  readonly purpose: AuthTokenPurpose;
  readonly userId: string;
  readonly tokenHash: string;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
  readonly issuedByUserId?: string | null;
}

export async function insertAuthToken(scoped: ScopedDb, input: AuthTokenInput): Promise<AuthTokenRow> {
  const id = authTokenRowId(scoped.organizationId, input.tokenHash);
  await scoped
    .insertInto(authTokens, {
      id,
      purpose: input.purpose,
      userId: input.userId,
      tokenHash: input.tokenHash,
      issuedAt: toDatabaseInstant(input.issuedAt),
      expiresAt: toDatabaseInstant(input.expiresAt),
      consumedAt: null,
      revokedAt: null,
      issuedByUserId: input.issuedByUserId ?? null,
    })
    .onConflictDoNothing()
    .execute();

  return {
    id,
    purpose: input.purpose,
    userId: input.userId,
    tokenHash: input.tokenHash,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    consumedAt: null,
    revokedAt: null,
    issuedByUserId: input.issuedByUserId ?? null,
  };
}

export async function findAuthTokenByHash(scoped: ScopedDb, tokenHash: string): Promise<AuthTokenRow | null> {
  const rows = await scoped.selectFrom(authTokens, eq(authTokens.tokenHash, tokenHash)).limit(1);
  const row = rows.at(0);
  return row === undefined ? null : toAuthTokenRow(row);
}

/**
 * Marks a token spent, and reports whether *this* call is the one that spent it.
 *
 * The `consumed_at is null` predicate is the single-use guarantee, and it is in the
 * UPDATE rather than in a preceding SELECT on purpose: two clicks on the same
 * mailed link arriving together would both pass a read-then-write check, and both
 * would be honoured. Here the second one updates zero rows and is told so.
 */
export async function consumeAuthToken(scoped: ScopedDb, tokenId: string, at: Instant): Promise<boolean> {
  const updated = await scoped
    .updateIn(
      authTokens,
      { consumedAt: toDatabaseInstant(at) },
      and(eq(authTokens.id, tokenId), isNull(authTokens.consumedAt), isNull(authTokens.revokedAt)),
    )
    .returning({ id: authTokens.id });

  return updated.length === 1;
}

/**
 * Revokes every unspent token of one purpose for one user.
 *
 * Called when a new one is issued, so a second reset link invalidates the first,
 * and when an owner revokes a pending invite.
 */
export async function revokeAuthTokens(
  scoped: ScopedDb,
  userId: string,
  purpose: AuthTokenPurpose,
  at: Instant,
): Promise<number> {
  const unspent = and(
    eq(authTokens.userId, userId),
    eq(authTokens.purpose, purpose),
    isNull(authTokens.consumedAt),
    isNull(authTokens.revokedAt),
  );

  const live = await scoped.selectFrom(authTokens, unspent);
  if (live.length === 0) return 0;

  await scoped.updateIn(authTokens, { revokedAt: toDatabaseInstant(at) }, unspent).execute();
  return live.length;
}

/** Every still-usable token of one purpose for one user, oldest first. */
export async function listLiveAuthTokens(
  scoped: ScopedDb,
  userId: string,
  purpose: AuthTokenPurpose,
): Promise<readonly AuthTokenRow[]> {
  const rows = await scoped
    .selectFrom(
      authTokens,
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        isNull(authTokens.revokedAt),
      ),
    )
    .orderBy(asc(authTokens.issuedAt));
  return rows.map(toAuthTokenRow);
}

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

export interface AuditLogInput {
  /** Null for an act by the system itself — the boot script provisioning a seat. */
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly occurredAt: Instant;
}

export interface AuditLogRow extends AuditLogInput {
  readonly id: string;
}

/**
 * Appends one audit entry. There is no counterpart that edits or removes one.
 *
 * The id is derived from `(action, target, instant)`, so a retried request writes
 * the row it already wrote instead of a duplicate — which matters because the write
 * is not in a transaction with the act it records, and a caller that retried after
 * a network blip would otherwise double-count a role change.
 */
export async function appendAuditLogEntry(scoped: ScopedDb, input: AuditLogInput): Promise<AuditLogRow> {
  const id = auditLogRowId(scoped.organizationId, input.action, input.targetId, input.occurredAt);

  await scoped
    .insertInto(auditLogEntries, {
      id,
      actorUserId: input.actorUserId,
      action: input.action,
      targetKind: input.targetKind,
      targetId: input.targetId,
      beforeState: input.before,
      afterState: input.after,
      occurredAt: toDatabaseInstant(input.occurredAt),
    })
    .onConflictDoNothing()
    .execute();

  return { ...input, id };
}

const toAuditLogRow = (row: InferSelectModel<typeof auditLogEntries>): AuditLogRow => ({
  id: row.id,
  actorUserId: row.actorUserId,
  action: row.action,
  targetKind: row.targetKind,
  targetId: row.targetId,
  before: (row.beforeState ?? null) as Record<string, unknown> | null,
  after: (row.afterState ?? null) as Record<string, unknown> | null,
  occurredAt: fromDatabaseInstant(row.occurredAt),
});

/** The audit trail, newest first. Read-only by construction — nothing writes over it. */
export async function listAuditLogEntries(
  scoped: ScopedDb,
  options: { readonly limit?: number; readonly targetId?: string } = {},
): Promise<readonly AuditLogRow[]> {
  const filter = options.targetId === undefined ? undefined : eq(auditLogEntries.targetId, options.targetId);
  const rows = await scoped
    .selectFrom(auditLogEntries, filter)
    .orderBy(desc(auditLogEntries.occurredAt), asc(auditLogEntries.action))
    .limit(options.limit ?? 100);

  return rows.map(toAuditLogRow);
}

/**
 * One audit entry by id, or null.
 *
 * A keyed lookup rather than a scan of the recent trail, because one caller needs a
 * *specific* historical row: `undoMerge` restores the attribution a merge recorded in its own
 * `before` state, and that merge may be arbitrarily old. Finding it by paging through the
 * newest N entries would make an un-merge silently impossible once the organization had
 * written N more audit rows — and this log takes a row from every configuration write, every
 * seat change and every sign-in, so N is reached in ordinary use. The caller would then be
 * told, wrongly, that no such merge exists.
 *
 * Still read-only against an append-only table: this adds a way to *find* a row, not to
 * change one.
 */
export async function findAuditLogEntry(scoped: ScopedDb, id: string): Promise<AuditLogRow | null> {
  const rows = await scoped.selectFrom(auditLogEntries, eq(auditLogEntries.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toAuditLogRow(row);
}
