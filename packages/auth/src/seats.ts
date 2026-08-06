import type { Instant } from '@compass/clock';
import {
  consumeAuthToken,
  ensureMembership,
  ensureUser,
  findAuthTokenByHash,
  findMembershipById,
  findMembershipByUserId,
  findUserById,
  insertAuthToken,
  listSeats,
  listTeamScopes,
  listUsableMemberships,
  normalizeEmail,
  replaceTeamScopes,
  revokeAllSessionsForUser,
  revokeAuthTokens,
  setMembershipRole,
  setMembershipStatus,
  setUserDisplayName,
  setUserPasswordHash,
  type MembershipRole,
  type MembershipRow,
  type ScopedDb,
  type SeatRow,
  type SessionRow,
  type UserRow,
} from '@compass/db';

import {
  AuthRequestError,
  looksLikeEmail,
  rotateSessionsForPrivilegeChange,
  startSession,
  type StartedSession,
} from './accounts.js';
import { changedKeys, recordAudit } from './audit.js';
import { composeAuthMail, type AuthMailer } from './mailer.js';
import { assertUsablePassword, hashPassword } from './password.js';
import {
  digestSecret,
  issueSecret,
  tokenExpiryFor,
  tokenRejection,
  type TokenRejection,
} from './secrets.js';

/**
 * The seat lifecycle: invite, resend, revoke, change role, change scopes, remove.
 *
 * Every one of these is a privileged act, so every one of them writes an
 * `AuditLogEntry` with the actor, the target and the before/after states — and the
 * three that change what a person can see also **rotate that person's sessions**,
 * because a role written to a row that a live cookie keeps overriding is not a role
 * change at all.
 *
 * Two invariants are enforced here rather than trusted to the caller:
 *
 *  - **An organization always has an owner.** The last one cannot be demoted or
 *    removed. Without this, one PATCH locks every human out of the tenant and no
 *    route exists to get back in.
 *  - **A seat's role and its team scopes move together or not at all.** A manager
 *    promoted to owner keeps their scope rows, which become irrelevant because owners
 *    are unscoped; a manager moved to viewer keeps them, because the scopes are what
 *    they may read and the role is what they may do.
 */

export const SEAT_ROLES = ['owner', 'manager', 'member', 'viewer'] as const satisfies readonly MembershipRole[];

export const isSeatRole = (value: unknown): value is MembershipRole =>
  typeof value === 'string' && (SEAT_ROLES as readonly string[]).includes(value);

export class LastOwnerError extends AuthRequestError {
  constructor(what: string) {
    super(
      `${what} would leave the organization with no owner. Give someone else the owner role first — otherwise nobody ` +
        'could manage seats, and there is no way back in from outside.',
    );
    this.name = 'LastOwnerError';
  }
}

export class SeatNotFoundError extends AuthRequestError {
  constructor(membershipId: string) {
    super(`No seat \`${membershipId}\` exists in this organization.`);
    this.name = 'SeatNotFoundError';
  }
}

/** The seats an owner or manager reads. */
export const readSeats = (scoped: ScopedDb): Promise<readonly SeatRow[]> => listSeats(scoped);

async function otherOwnersExist(scoped: ScopedDb, exceptMembershipId: string): Promise<boolean> {
  const usable = await listUsableMemberships(scoped);
  return usable.some((seat) => seat.role === 'owner' && seat.id !== exceptMembershipId);
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

export interface InviteInput {
  readonly scoped: ScopedDb;
  readonly email: string;
  readonly role: MembershipRole;
  readonly teamKeys?: readonly string[];
  readonly actor: { readonly userId: string; readonly displayName: string };
  readonly now: Instant;
  readonly mailer: AuthMailer;
  readonly organizationName: string;
  readonly baseUrl: string;
}

export interface InviteResult {
  readonly seat: SeatRow;
  readonly membership: MembershipRow;
  /** Present so a deployment with no mail transport can still show the link once. */
  readonly link: string;
  readonly expiresAt: Instant;
}

/**
 * Invites an address to a seat.
 *
 * The Membership is created `pending` and the token is what turns it `active`, so a
 * seat that was never accepted is visible in the list as exactly that rather than
 * as a person who has simply not logged in. Inviting an address that already has a
 * seat is refused by name rather than silently re-inviting: the owner meant to
 * change a role, and this says so.
 */
export async function inviteSeat(input: InviteInput): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) {
    throw new AuthRequestError('Enter an email address Compass can send the invitation to.');
  }
  if (!isSeatRole(input.role)) {
    throw new AuthRequestError('Choose one of owner, manager, member or viewer.');
  }

  const existingSeats = await listSeats(input.scoped);
  const already = existingSeats.find((seat) => seat.email === email);
  if (already !== undefined && already.status !== 'revoked') {
    throw new AuthRequestError(
      `${email} already has a ${already.role} seat here` +
        (already.status === 'pending' ? ', invited and not yet accepted. Resend the invitation instead.' : '. Change their role instead of inviting them again.'),
    );
  }

  // The user row comes first: a Membership references it, and an invited address
  // that is already a user must attach to that person rather than shadow them.
  const user = await ensureUser(input.scoped, {
    email,
    // The invitee chooses their own name when they accept. Until then the address is
    // the only honest thing to show, and inventing "New User" would put a fiction in
    // the seat list.
    displayName: email,
    passwordHash: null,
    at: input.now,
  });

  const membership = already?.status === 'revoked'
    ? await reactivateRevokedSeat(input.scoped, already.id, input.role, input.now)
    : await ensureMembership(input.scoped, {
        userId: user.id,
        role: input.role,
        status: 'pending',
        at: input.now,
      });

  const teamKeys = await replaceTeamScopes(input.scoped, membership.id, input.teamKeys ?? [], input.now);

  const issued = await issueInviteToken({
    scoped: input.scoped,
    user,
    actorUserId: input.actor.userId,
    now: input.now,
    mailer: input.mailer,
    organizationName: input.organizationName,
    baseUrl: input.baseUrl,
    invitedByName: input.actor.displayName,
  });

  await recordAudit(input.scoped, {
    action: 'seat.invited',
    actorUserId: input.actor.userId,
    targetKind: 'membership',
    targetId: membership.id,
    before: null,
    after: { email, role: input.role, status: 'pending', teamKeys, expiresAt: issued.expiresAt },
    occurredAt: input.now,
  });

  return {
    seat: {
      ...membership,
      email,
      displayName: user.displayName,
      hasPassword: false,
      teamKeys,
      // Newly invited: nobody has signed in on this seat, and the invitation just issued
      // is the live one. Both stated rather than left for the caller to re-read.
      lastActiveAt: null,
      inviteExpiresAt: issued.expiresAt,
    },
    membership,
    link: issued.link,
    expiresAt: issued.expiresAt,
  };
}

/** A revoked seat being re-invited: the same row, put back to pending. */
async function reactivateRevokedSeat(
  scoped: ScopedDb,
  membershipId: string,
  role: MembershipRole,
  now: Instant,
): Promise<MembershipRow> {
  await setMembershipRole(scoped, membershipId, role, now);
  await setMembershipStatus(scoped, membershipId, 'pending', now);
  const membership = await findMembershipById(scoped, membershipId);
  if (membership === null) throw new SeatNotFoundError(membershipId);
  return membership;
}

async function issueInviteToken(input: {
  readonly scoped: ScopedDb;
  readonly user: UserRow;
  readonly actorUserId: string;
  readonly now: Instant;
  readonly mailer: AuthMailer;
  readonly organizationName: string;
  readonly baseUrl: string;
  readonly invitedByName: string;
}): Promise<{ readonly link: string; readonly expiresAt: Instant }> {
  // Issuing a new invitation revokes any earlier unused one, so a resend does not
  // leave two live links and a revoke does not have to chase copies.
  await revokeAuthTokens(input.scoped, input.user.id, 'invite', input.now);

  const issued = issueSecret();
  const expiresAt = tokenExpiryFor('invite', input.now);

  await insertAuthToken(input.scoped, {
    purpose: 'invite',
    userId: input.user.id,
    tokenHash: issued.digest,
    issuedAt: input.now,
    expiresAt,
    issuedByUserId: input.actorUserId,
  });

  const link = `${input.baseUrl}/account/invite?token=${encodeURIComponent(issued.secret)}`;

  await input.mailer.send(
    composeAuthMail({
      purpose: 'invite',
      to: input.user.email,
      link,
      organizationName: input.organizationName,
      invitedByName: input.invitedByName,
    }),
  );

  return { link, expiresAt };
}

// ---------------------------------------------------------------------------
// Resend and revoke
// ---------------------------------------------------------------------------

export async function resendInvite(input: {
  readonly scoped: ScopedDb;
  readonly membershipId: string;
  readonly actor: { readonly userId: string; readonly displayName: string };
  readonly now: Instant;
  readonly mailer: AuthMailer;
  readonly organizationName: string;
  readonly baseUrl: string;
}): Promise<{ readonly link: string; readonly expiresAt: Instant }> {
  const membership = await findMembershipById(input.scoped, input.membershipId);
  if (membership === null) throw new SeatNotFoundError(input.membershipId);
  if (membership.status !== 'pending') {
    throw new AuthRequestError(
      'That seat is not a pending invitation, so there is nothing to resend. An active seat signs in; a revoked one has to be invited again.',
    );
  }

  const user = await findUserById(input.scoped, membership.userId);
  if (user === null) throw new SeatNotFoundError(input.membershipId);

  const issued = await issueInviteToken({
    scoped: input.scoped,
    user,
    actorUserId: input.actor.userId,
    now: input.now,
    mailer: input.mailer,
    organizationName: input.organizationName,
    baseUrl: input.baseUrl,
    invitedByName: input.actor.displayName,
  });

  await recordAudit(input.scoped, {
    action: 'seat.invite_resent',
    actorUserId: input.actor.userId,
    targetKind: 'membership',
    targetId: membership.id,
    before: { email: user.email, status: 'pending' },
    after: { email: user.email, status: 'pending', expiresAt: issued.expiresAt },
    occurredAt: input.now,
  });

  return issued;
}

/**
 * Revokes a pending invitation, making its token unusable.
 *
 * The seat becomes `revoked` and the token is marked revoked, so the mailed link
 * fails with "this was withdrawn" rather than with a generic error — the difference
 * between the two matters to whoever clicks it.
 */
export async function revokeInvite(input: {
  readonly scoped: ScopedDb;
  readonly membershipId: string;
  readonly actorUserId: string;
  readonly now: Instant;
}): Promise<void> {
  const membership = await findMembershipById(input.scoped, input.membershipId);
  if (membership === null) throw new SeatNotFoundError(input.membershipId);
  if (membership.status !== 'pending') {
    throw new AuthRequestError('That seat is not a pending invitation. Remove the seat instead.');
  }
  if (membership.role === 'owner' && !(await otherOwnersExist(input.scoped, membership.id))) {
    throw new LastOwnerError('Revoking this invitation');
  }

  const revokedTokens = await revokeAuthTokens(input.scoped, membership.userId, 'invite', input.now);
  await setMembershipStatus(input.scoped, membership.id, 'revoked', input.now);

  await recordAudit(input.scoped, {
    action: 'seat.invite_revoked',
    actorUserId: input.actorUserId,
    targetKind: 'membership',
    targetId: membership.id,
    before: { status: 'pending', liveInviteTokens: revokedTokens },
    after: { status: 'revoked', liveInviteTokens: 0 },
    occurredAt: input.now,
  });
}

// ---------------------------------------------------------------------------
// Role and scope changes
// ---------------------------------------------------------------------------

export interface SeatChangeInput {
  readonly scoped: ScopedDb;
  readonly membershipId: string;
  readonly role?: MembershipRole;
  readonly teamKeys?: readonly string[];
  readonly actorUserId: string;
  readonly now: Instant;
  /**
   * The session of the browser making the request, when the actor is changing their
   * *own* seat. Passed so the rotation issues a replacement for that browser instead
   * of signing the actor out of the screen they are working on.
   */
  readonly actorSession?: SessionRow | null;
}

export interface SeatChangeResult {
  readonly membership: MembershipRow;
  readonly teamKeys: readonly string[];
  /** How many sessions the change ended. Zero when nothing that matters moved. */
  readonly sessionsRevoked: number;
  /** A fresh session for the actor's own browser, when the actor changed their own seat. */
  readonly replacementSession: StartedSession | null;
  readonly changed: readonly string[];
}

/**
 * Changes a seat's role, its team scopes, or both — and rotates its sessions.
 *
 * The rotation is the part that makes the acceptance criterion true: a new role
 * applies "on the next request" only because every cookie that carried the old one
 * has been revoked. `resolveIdentity` reads the role from the membership on every
 * request rather than from the session, so the new role is in force immediately for
 * the replacement cookie too.
 *
 * A change that moves nothing writes nothing: no audit row, no revocation. An owner
 * saving a form they did not edit should not sign a colleague out of four devices.
 */
export async function changeSeat(input: SeatChangeInput): Promise<SeatChangeResult> {
  const membership = await findMembershipById(input.scoped, input.membershipId);
  if (membership === null) throw new SeatNotFoundError(input.membershipId);

  if (input.role !== undefined && !isSeatRole(input.role)) {
    throw new AuthRequestError('Choose one of owner, manager, member or viewer.');
  }

  const scopesBefore = await listTeamScopes(input.scoped, membership.id);
  const nextRole = input.role ?? membership.role;

  if (
    membership.role === 'owner' &&
    nextRole !== 'owner' &&
    !(await otherOwnersExist(input.scoped, membership.id))
  ) {
    throw new LastOwnerError(`Changing this seat to ${nextRole}`);
  }

  const before = { role: membership.role, teamKeys: [...scopesBefore] };

  let scopesAfter = scopesBefore;
  if (input.teamKeys !== undefined) {
    scopesAfter = await replaceTeamScopes(input.scoped, membership.id, input.teamKeys, input.now);
  }
  if (nextRole !== membership.role) {
    await setMembershipRole(input.scoped, membership.id, nextRole, input.now);
  }

  const after = { role: nextRole, teamKeys: [...scopesAfter] };
  const changed = changedKeys(before, after);

  if (changed.length === 0) {
    return {
      membership,
      teamKeys: scopesAfter,
      sessionsRevoked: 0,
      replacementSession: null,
      changed,
    };
  }

  const rotated = await rotateSessionsForPrivilegeChange({
    scoped: input.scoped,
    userId: membership.userId,
    reason: 'role_change',
    now: input.now,
    replacementFor:
      input.actorSession !== undefined &&
      input.actorSession !== null &&
      input.actorSession.userId === membership.userId
        ? input.actorSession
        : null,
  });

  if (changed.includes('role')) {
    await recordAudit(input.scoped, {
      action: 'seat.role_changed',
      actorUserId: input.actorUserId,
      targetKind: 'membership',
      targetId: membership.id,
      before: { role: before.role },
      after: { role: after.role, sessionsRevoked: rotated.revoked },
      occurredAt: input.now,
    });
  }
  if (changed.includes('teamKeys')) {
    await recordAudit(input.scoped, {
      action: 'seat.team_scopes_changed',
      actorUserId: input.actorUserId,
      targetKind: 'membership',
      targetId: membership.id,
      before: { teamKeys: before.teamKeys },
      after: { teamKeys: after.teamKeys, sessionsRevoked: rotated.revoked },
      occurredAt: input.now,
    });
  }

  const updated = await findMembershipById(input.scoped, membership.id);

  return {
    membership: updated ?? { ...membership, role: nextRole },
    teamKeys: scopesAfter,
    sessionsRevoked: rotated.revoked,
    replacementSession: rotated.replacement,
    changed,
  };
}

/**
 * Removes a seat.
 *
 * The Membership becomes `revoked` rather than being deleted, and the User row stays
 * — because the audit log references both, and an audit trail whose actor rows have
 * been deleted is not one. Every session is ended immediately, and every unused
 * invitation for that person is revoked so a stale link cannot let them back in.
 */
export async function removeSeat(input: {
  readonly scoped: ScopedDb;
  readonly membershipId: string;
  readonly actorUserId: string;
  readonly now: Instant;
}): Promise<{ readonly sessionsRevoked: number }> {
  const membership = await findMembershipById(input.scoped, input.membershipId);
  if (membership === null) throw new SeatNotFoundError(input.membershipId);
  if (membership.role === 'owner' && !(await otherOwnersExist(input.scoped, membership.id))) {
    throw new LastOwnerError('Removing this seat');
  }

  const scopesBefore = await listTeamScopes(input.scoped, membership.id);
  const sessionsRevoked = await revokeAllSessionsForUser(
    input.scoped,
    membership.userId,
    'seat_revoked',
    input.now,
  );
  await revokeAuthTokens(input.scoped, membership.userId, 'invite', input.now);
  await revokeAuthTokens(input.scoped, membership.userId, 'magic_link', input.now);
  await revokeAuthTokens(input.scoped, membership.userId, 'password_reset', input.now);
  await replaceTeamScopes(input.scoped, membership.id, [], input.now);
  await setMembershipStatus(input.scoped, membership.id, 'revoked', input.now);

  await recordAudit(input.scoped, {
    action: 'seat.removed',
    actorUserId: input.actorUserId,
    targetKind: 'membership',
    targetId: membership.id,
    before: { role: membership.role, status: membership.status, teamKeys: [...scopesBefore] },
    after: { role: membership.role, status: 'revoked', teamKeys: [], sessionsRevoked },
    occurredAt: input.now,
  });

  return { sessionsRevoked };
}

// ---------------------------------------------------------------------------
// Accepting an invitation
// ---------------------------------------------------------------------------

export type AcceptResult =
  | {
      readonly ok: true;
      readonly user: UserRow;
      readonly membership: MembershipRow;
      readonly started: StartedSession;
    }
  | { readonly ok: false; readonly rejection: TokenRejection };

/**
 * Accepts an invitation: sets a name and a password, activates the seat, signs in.
 *
 * Single-use is enforced by the same not-yet-consumed UPDATE the other flows use, so
 * a double-submitted form activates the seat once. A revoked invitation fails here
 * rather than at the door, which is the criterion "revoking a pending invite makes
 * its token unusable".
 */
export async function acceptInvite(input: {
  readonly scoped: ScopedDb;
  readonly secret: string;
  readonly displayName: string;
  readonly password: string;
  readonly now: Instant;
}): Promise<AcceptResult> {
  assertUsablePassword(input.password);
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new AuthRequestError('Enter the name you want to appear beside your seat.');
  }

  const token = await findAuthTokenByHash(input.scoped, digestSecret(input.secret));
  const rejection = tokenRejection(token, 'invite', input.now);
  if (rejection !== null || token === null) {
    return { ok: false, rejection: rejection ?? 'not_found' };
  }

  const membership = await findMembershipByUserId(input.scoped, token.userId);
  if (membership === null || membership.status === 'revoked') {
    return { ok: false, rejection: 'revoked' };
  }

  if (!(await consumeAuthToken(input.scoped, token.id, input.now))) {
    return { ok: false, rejection: 'already_used' };
  }

  await setUserDisplayName(input.scoped, token.userId, displayName, input.now);
  await setUserPasswordHash(input.scoped, token.userId, await hashPassword(input.password), input.now);
  await setMembershipStatus(input.scoped, membership.id, 'active', input.now);

  await recordAudit(input.scoped, {
    action: 'seat.accepted',
    actorUserId: token.userId,
    targetKind: 'membership',
    targetId: membership.id,
    before: { status: membership.status, hasPassword: false },
    after: { status: 'active', hasPassword: true, displayName },
    occurredAt: input.now,
  });

  const user = await findUserById(input.scoped, token.userId);
  if (user === null) return { ok: false, rejection: 'not_found' };

  const updated = await findMembershipById(input.scoped, membership.id);

  return {
    ok: true,
    user,
    membership: updated ?? { ...membership, status: 'active' },
    started: await startSession({ scoped: input.scoped, userId: user.id, now: input.now }),
  };
}
