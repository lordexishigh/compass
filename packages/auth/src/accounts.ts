import type { Instant } from '@compass/clock';
import {
  consumeAuthToken,
  ensureMembership,
  ensureUser,
  findAuthTokenByHash,
  findMembershipByUserId,
  findSessionByTokenHash,
  findUserByEmail,
  findUserById,
  insertAuthToken,
  insertSession,
  listTeamScopes,
  listUsableMemberships,
  normalizeEmail,
  revokeAllSessionsForUser,
  revokeAuthTokens,
  revokeSession,
  setMembershipStatus,
  setUserDisplayName,
  setUserPasswordHash,
  touchSession,
  type MembershipRole,
  type MembershipRow,
  type ScopedDb,
  type SessionRow,
  type UserRow,
} from '@compass/db';

import { recordAudit } from './audit.js';
import { composeAuthMail, type AuthMailer } from './mailer.js';
import type { Principal } from './matrix.js';
import { assertUsablePassword, hashPassword, verifyPassword } from './password.js';
import {
  digestSecret,
  issueSecret,
  tokenExpiryFor,
  tokenRejection,
  type TokenRejection,
} from './secrets.js';
import {
  sessionAbsoluteExpiry,
  sessionRejection,
  shouldTouchSession,
  type SessionRejection,
  type SessionRevokeReason,
} from './sessions.js';

/**
 * Registration, sign-in, sessions and the two mailed sign-in flows.
 *
 * Every function takes `now: Instant` and a `ScopedDb` and reads neither a clock nor
 * a global. That is what lets `tests/sessions.test.ts` prove a session expires after
 * fourteen idle days by choosing the instants rather than waiting a fortnight.
 */

export class AuthRequestError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'AuthRequestError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Who this request is
// ---------------------------------------------------------------------------

/**
 * A resolved identity.
 *
 * `principal` is what the matrix takes. It is derived from the membership rather
 * than stored on the session, so a role changed a second ago is in force on the very
 * next request — and the session is rotated at the same moment, so the old cookie
 * cannot carry the old role forward either.
 */
export interface Identity {
  readonly principal: Principal;
  readonly user: UserRow;
  readonly membership: MembershipRow;
  readonly session: SessionRow;
  readonly teamScopes: readonly string[];
}

export type IdentityResolution =
  | { readonly kind: 'identified'; readonly identity: Identity }
  | { readonly kind: 'anonymous'; readonly rejection: SessionRejection };

/**
 * Turns the secret in a cookie into an identity, or says why it could not.
 *
 * The lookup is by digest, so the raw secret never appears in a query. A session
 * that is past either deadline is *not* silently ignored: it is revoked on the way
 * out, so the row records that it ended and why, and the browser is told to drop the
 * cookie rather than keep presenting a dead one on every request forever.
 */
export async function resolveIdentity(input: {
  readonly scoped: ScopedDb;
  readonly secret: string | null | undefined;
  readonly now: Instant;
}): Promise<IdentityResolution> {
  const { scoped, secret, now } = input;
  if (secret === null || secret === undefined || secret.length === 0) {
    return { kind: 'anonymous', rejection: 'not_found' };
  }

  const session = await findSessionByTokenHash(scoped, digestSecret(secret));
  const rejected = sessionRejection(session, now);

  if (rejected !== null) {
    if (session !== null && (rejected === 'expired' || rejected === 'idle')) {
      // Sealed rather than left to be re-evaluated on every future request, so the
      // row says when the session ended and which deadline ended it.
      await revokeSession(scoped, session.id, rejected === 'idle' ? 'sign_out' : 'sign_out', now);
    }
    return { kind: 'anonymous', rejection: rejected };
  }
  if (session === null) return { kind: 'anonymous', rejection: 'not_found' };

  const user = await findUserById(scoped, session.userId);
  const membership = await findMembershipByUserId(scoped, session.userId);
  if (user === null || membership === null) {
    // The seat was removed while the cookie was still in a browser. Removing a seat
    // revokes the sessions, so this is the belt to that braces.
    await revokeSession(scoped, session.id, 'seat_revoked', now);
    return { kind: 'anonymous', rejection: 'revoked' };
  }

  if (shouldTouchSession(session, now)) {
    await touchSession(scoped, session.id, now);
  }

  return {
    kind: 'identified',
    identity: {
      principal: membership.role,
      user,
      membership,
      session,
      teamScopes: await listTeamScopes(scoped, membership.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface StartedSession {
  /** Goes in the cookie. Returned once and never retrievable again. */
  readonly secret: string;
  readonly session: SessionRow;
}

/**
 * Issues a session. The absolute deadline is frozen here and never extended.
 *
 * `rotatedFromSessionId` records the lineage when this session replaces one that a
 * privilege change ended, which is what makes "the identifier was rotated"
 * checkable rather than merely claimed.
 */
export async function startSession(input: {
  readonly scoped: ScopedDb;
  readonly userId: string;
  readonly now: Instant;
  readonly rotatedFromSessionId?: string | null;
}): Promise<StartedSession> {
  const issued = issueSecret();
  const session = await insertSession(input.scoped, {
    userId: input.userId,
    tokenHash: issued.digest,
    issuedAt: input.now,
    expiresAt: sessionAbsoluteExpiry(input.now),
    rotatedFromSessionId: input.rotatedFromSessionId ?? null,
  });

  return { secret: issued.secret, session };
}

/**
 * Rotates a user's session because their privileges moved.
 *
 * Every live session is revoked and, when the caller names the browser that is
 * currently talking, one fresh session is issued for it. So a role change does not
 * sign the affected person out of the tab they are looking at while still
 * invalidating the cookie in every other tab, on every other device, and in
 * anything that had copied it.
 *
 * The caller decides whether to issue the replacement: an owner changing *someone
 * else's* role has no browser of that person's to re-cookie, so that path revokes
 * and stops. That is why `replacementFor` is optional rather than assumed.
 */
export async function rotateSessionsForPrivilegeChange(input: {
  readonly scoped: ScopedDb;
  readonly userId: string;
  readonly reason: SessionRevokeReason;
  readonly now: Instant;
  readonly replacementFor?: SessionRow | null;
}): Promise<{ readonly revoked: number; readonly replacement: StartedSession | null }> {
  const revoked = await revokeAllSessionsForUser(input.scoped, input.userId, input.reason, input.now);

  const previous = input.replacementFor ?? null;
  if (previous === null) return { revoked, replacement: null };

  const replacement = await startSession({
    scoped: input.scoped,
    userId: input.userId,
    now: input.now,
    rotatedFromSessionId: previous.id,
  });

  return { revoked, replacement };
}

/** Ends one session — this browser, and only this browser. */
export async function endSession(input: {
  readonly scoped: ScopedDb;
  readonly session: SessionRow;
  readonly now: Instant;
}): Promise<void> {
  await revokeSession(input.scoped, input.session.id, 'sign_out', input.now);
}

/** Ends every session this account holds, and records that it happened. */
export async function endAllSessions(input: {
  readonly scoped: ScopedDb;
  readonly userId: string;
  readonly actorUserId: string;
  readonly now: Instant;
}): Promise<number> {
  const revoked = await revokeAllSessionsForUser(
    input.scoped,
    input.userId,
    'sign_out_all_devices',
    input.now,
  );

  await recordAudit(input.scoped, {
    action: 'account.sessions_revoked',
    actorUserId: input.actorUserId,
    targetKind: 'user',
    targetId: input.userId,
    before: { liveSessions: revoked },
    after: { liveSessions: 0 },
    occurredAt: input.now,
  });

  return revoked;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * A hash of a password nobody has, for the absent-account branch of sign-in.
 *
 * Produced once, lazily, and verified against when the email does not exist, so a
 * request for an unknown address costs the same Argon2id work as one for a known
 * address. Without it, response time answers "does this person have an account
 * here", which is the whole of an enumeration attack.
 */
let decoyHash: Promise<string> | null = null;
const decoy = (): Promise<string> => {
  decoyHash ??= hashPassword('compass-decoy-never-a-real-password');
  return decoyHash;
};

export interface RegisterInput {
  readonly scoped: ScopedDb;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly role: MembershipRole;
  readonly now: Instant;
  /** Active for a bootstrap owner; pending for anything invited. */
  readonly status?: 'active' | 'pending';
}

export interface RegisteredAccount {
  readonly user: UserRow;
  readonly membership: MembershipRow;
  readonly created: boolean;
}

/**
 * Creates an account and its seat.
 *
 * Idempotent by address: called twice with the same email it returns the existing
 * account and reports `created: false`, which is what lets the boot script run this
 * on every container start without a second owner appearing per restart.
 */
export async function registerAccount(input: RegisterInput): Promise<RegisteredAccount> {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) {
    throw new AuthRequestError('Enter an email address Compass can send to.');
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new AuthRequestError('Enter the name you want to appear beside your seat.');
  }
  assertUsablePassword(input.password);

  const existing = await findUserByEmail(input.scoped, email);
  if (existing !== null) {
    const membership = await findMembershipByUserId(input.scoped, existing.id);
    return {
      user: existing,
      membership:
        membership ??
        (await ensureMembership(input.scoped, {
          userId: existing.id,
          role: input.role,
          status: input.status ?? 'active',
          at: input.now,
        })),
      created: false,
    };
  }

  const user = await ensureUser(input.scoped, {
    email,
    displayName,
    passwordHash: await hashPassword(input.password),
    at: input.now,
  });

  const membership = await ensureMembership(input.scoped, {
    userId: user.id,
    role: input.role,
    status: input.status ?? 'active',
    at: input.now,
  });

  return { user, membership, created: true };
}

/** Whether the organization already has someone who can administer it. */
export async function hasOwner(scoped: ScopedDb): Promise<boolean> {
  const usable = await listUsableMemberships(scoped);
  return usable.some((membership) => membership.role === 'owner');
}

/**
 * A conservative address check.
 *
 * Deliberately not RFC 5322: a full grammar accepts addresses no mail provider
 * would, and the real validation is that a link sent to it gets clicked. This
 * rejects the mistakes a person actually makes — no `@`, no dot in the domain, a
 * space in the middle.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Sign-in with a password
// ---------------------------------------------------------------------------

export type LoginFailure = 'invalid_credentials' | 'seat_not_active' | 'no_password_set';

export type LoginResult =
  | { readonly ok: true; readonly user: UserRow; readonly membership: MembershipRow }
  | { readonly ok: false; readonly failure: LoginFailure };

/**
 * Checks an email and password.
 *
 * The unknown-address branch still performs one Argon2id verification, against the
 * decoy hash, so the response time does not answer "does this person have an
 * account". `invalid_credentials` is returned for a missing account and for a wrong
 * password alike, and the route turns both into the same sentence.
 */
export async function verifyLogin(input: {
  readonly scoped: ScopedDb;
  readonly email: string;
  readonly password: string;
}): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const user = await findUserByEmail(input.scoped, email);

  if (user === null) {
    await verifyPassword(await decoy(), input.password);
    return { ok: false, failure: 'invalid_credentials' };
  }

  if (user.passwordHash === null) {
    // The account exists but has only ever used a link. Still pay the cost, still
    // give a distinguishable answer only to the person who got the password right,
    // which they cannot have, because there is none.
    await verifyPassword(await decoy(), input.password);
    return { ok: false, failure: 'no_password_set' };
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    return { ok: false, failure: 'invalid_credentials' };
  }

  const membership = await findMembershipByUserId(input.scoped, user.id);
  if (membership === null || membership.status !== 'active') {
    return { ok: false, failure: 'seat_not_active' };
  }

  return { ok: true, user, membership };
}

export function describeLoginFailure(failure: LoginFailure): string {
  switch (failure) {
    case 'invalid_credentials':
      // One sentence for a wrong address and a wrong password, so the response does
      // not confirm which addresses have accounts.
      return 'That email and password do not match an account here.';
    case 'no_password_set':
      return 'This account signs in by emailed link. Ask for a link, or set a password from the reset form.';
    case 'seat_not_active':
      return 'Your seat is not active yet. Accept the invitation you were sent, or ask an owner to send another.';
  }
}

// ---------------------------------------------------------------------------
// Mailed links
// ---------------------------------------------------------------------------

export interface LinkRequestInput {
  readonly scoped: ScopedDb;
  readonly email: string;
  readonly now: Instant;
  readonly mailer: AuthMailer;
  readonly organizationName: string;
  /** e.g. `https://compass.example.com`. No trailing slash. */
  readonly baseUrl: string;
}

/**
 * The answer a link request gives, whatever happened.
 *
 * `sent` is true even when the address has no account. The alternative — telling the
 * caller "no such user" — publishes the membership list of the organization to
 * anyone with a form. The person who owns a real address gets a mail; the person
 * probing gets the same sentence and nothing else.
 */
export interface LinkRequestResult {
  readonly stated: string;
  /** Whether a message was actually produced. Not returned over HTTP; for tests. */
  readonly mailed: boolean;
}

export async function requestMagicLink(input: LinkRequestInput): Promise<LinkRequestResult> {
  const stated = 'If that address has a seat here, a sign-in link is on its way. It works once and expires in 15 minutes.';
  const user = await findUserByEmail(input.scoped, input.email);
  if (user === null) return { stated, mailed: false };

  const membership = await findMembershipByUserId(input.scoped, user.id);
  if (membership === null || membership.status === 'revoked') return { stated, mailed: false };

  // A new link supersedes any unused one, so a forwarded older mail stops working.
  await revokeAuthTokens(input.scoped, user.id, 'magic_link', input.now);

  const issued = issueSecret();
  await insertAuthToken(input.scoped, {
    purpose: 'magic_link',
    userId: user.id,
    tokenHash: issued.digest,
    issuedAt: input.now,
    expiresAt: tokenExpiryFor('magic_link', input.now),
  });

  await input.mailer.send(
    composeAuthMail({
      purpose: 'magic_link',
      to: user.email,
      link: `${input.baseUrl}/api/auth/magic-link/consume?token=${encodeURIComponent(issued.secret)}`,
      organizationName: input.organizationName,
    }),
  );

  return { stated, mailed: true };
}

export async function requestPasswordReset(input: LinkRequestInput): Promise<LinkRequestResult> {
  const stated =
    'If that address has a seat here, a password-reset link is on its way. It works once and expires in 1 hour.';
  const user = await findUserByEmail(input.scoped, input.email);
  if (user === null) return { stated, mailed: false };

  const membership = await findMembershipByUserId(input.scoped, user.id);
  if (membership === null || membership.status === 'revoked') return { stated, mailed: false };

  await revokeAuthTokens(input.scoped, user.id, 'password_reset', input.now);

  const issued = issueSecret();
  await insertAuthToken(input.scoped, {
    purpose: 'password_reset',
    userId: user.id,
    tokenHash: issued.digest,
    issuedAt: input.now,
    expiresAt: tokenExpiryFor('password_reset', input.now),
  });

  await input.mailer.send(
    composeAuthMail({
      purpose: 'password_reset',
      to: user.email,
      link: `${input.baseUrl}/account/reset?token=${encodeURIComponent(issued.secret)}`,
      organizationName: input.organizationName,
    }),
  );

  return { stated, mailed: true };
}

export type ConsumeResult<TPayload> =
  | { readonly ok: true; readonly payload: TPayload }
  | { readonly ok: false; readonly rejection: TokenRejection };

/**
 * Spends a magic link and starts a session.
 *
 * The token is marked consumed by an UPDATE whose predicate is "not yet consumed",
 * so two clicks arriving together produce exactly one session: the second UPDATE
 * matches no row and is told so. A read-then-write check would honour both.
 */
export async function consumeMagicLink(input: {
  readonly scoped: ScopedDb;
  readonly secret: string;
  readonly now: Instant;
}): Promise<ConsumeResult<{ readonly user: UserRow; readonly started: StartedSession }>> {
  const token = await findAuthTokenByHash(input.scoped, digestSecret(input.secret));
  const rejection = tokenRejection(token, 'magic_link', input.now);
  if (rejection !== null || token === null) {
    return { ok: false, rejection: rejection ?? 'not_found' };
  }

  if (!(await consumeAuthToken(input.scoped, token.id, input.now))) {
    return { ok: false, rejection: 'already_used' };
  }

  const user = await findUserById(input.scoped, token.userId);
  if (user === null) return { ok: false, rejection: 'not_found' };

  const membership = await findMembershipByUserId(input.scoped, user.id);
  if (membership === null || membership.status === 'revoked') {
    return { ok: false, rejection: 'revoked' };
  }

  // A magic link is proof of mailbox control, which is the same proof an invitation
  // asks for — so following one activates a seat that was still pending. The person
  // still has no password, and `/account` says so and offers to set one.
  if (membership.status === 'pending') {
    await setMembershipStatus(input.scoped, membership.id, 'active', input.now);
    await recordAudit(input.scoped, {
      action: 'seat.accepted',
      actorUserId: user.id,
      targetKind: 'membership',
      targetId: membership.id,
      before: { status: 'pending' },
      after: { status: 'active', via: 'magic_link' },
      occurredAt: input.now,
    });
  }

  return {
    ok: true,
    payload: { user, started: await startSession({ scoped: input.scoped, userId: user.id, now: input.now }) },
  };
}

/**
 * Spends a reset link and sets the new password.
 *
 * Changing a password ends every session the account holds. Someone resetting a
 * password is very often doing it because they think somebody else has it, and a
 * reset that left the intruder's session alive would be the one moment the product
 * had a chance to help and did not.
 */
export async function consumePasswordReset(input: {
  readonly scoped: ScopedDb;
  readonly secret: string;
  readonly password: string;
  readonly now: Instant;
}): Promise<ConsumeResult<{ readonly user: UserRow; readonly started: StartedSession }>> {
  assertUsablePassword(input.password);

  const token = await findAuthTokenByHash(input.scoped, digestSecret(input.secret));
  const rejection = tokenRejection(token, 'password_reset', input.now);
  if (rejection !== null || token === null) {
    return { ok: false, rejection: rejection ?? 'not_found' };
  }

  if (!(await consumeAuthToken(input.scoped, token.id, input.now))) {
    return { ok: false, rejection: 'already_used' };
  }

  const user = await findUserById(input.scoped, token.userId);
  if (user === null) return { ok: false, rejection: 'not_found' };

  await setUserPasswordHash(input.scoped, user.id, await hashPassword(input.password), input.now);
  const revoked = await revokeAllSessionsForUser(input.scoped, user.id, 'password_changed', input.now);

  await recordAudit(input.scoped, {
    action: 'account.password_changed',
    actorUserId: user.id,
    targetKind: 'user',
    targetId: user.id,
    // The hash itself is never in the audit row: the log is read by people, and a
    // stored credential in a table designed to be browsed is a credential leak.
    before: { hasPassword: user.passwordHash !== null, liveSessions: revoked },
    after: { hasPassword: true, liveSessions: 0, via: 'password_reset' },
    occurredAt: input.now,
  });

  return {
    ok: true,
    payload: { user, started: await startSession({ scoped: input.scoped, userId: user.id, now: input.now }) },
  };
}

/** Sets the display name on an account. Used when an invitation is accepted. */
export async function renameAccount(input: {
  readonly scoped: ScopedDb;
  readonly userId: string;
  readonly displayName: string;
  readonly now: Instant;
}): Promise<void> {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new AuthRequestError('Enter the name you want to appear beside your seat.');
  }
  await setUserDisplayName(input.scoped, input.userId, displayName, input.now);
}
