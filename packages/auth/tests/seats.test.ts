import {
  AUDIT_ACTIONS,
  LastOwnerError,
  TOKEN_TTL_LABEL,
  acceptInvite,
  changeSeat,
  consumeMagicLink,
  consumePasswordReset,
  inviteSeat,
  readSeats,
  registerAccount,
  removeSeat,
  requestMagicLink,
  requestPasswordReset,
  resendInvite,
  resolveIdentity,
  revokeInvite,
  startSession,
  verifyLogin,
} from '@compass/auth';
import { MILLIS_PER_DAY, MILLIS_PER_HOUR, MILLIS_PER_MINUTE, addMillis } from '@compass/clock';
import { listAuditLogEntries, listLiveAuthTokens, type ScopedDb } from '@compass/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { T0, createAuthHarness, mailContext, tokenFromLink, type AuthHarness } from './helpers/org.js';

/**
 * The seat lifecycle: invite, resend, revoke, change role, remove — and the audit rows
 * every one of them writes.
 *
 * The single-use guarantee is asserted the only way it can honestly be: by using a token
 * twice and requiring the second attempt to fail. Every expiry assertion drives the
 * injected instant rather than waiting.
 */

let harness: AuthHarness;
let scoped: ScopedDb;
let owner: { readonly userId: string; readonly displayName: string; readonly membershipId: string };

beforeEach(async () => {
  harness = await createAuthHarness();
  scoped = harness.scoped;

  const registered = await registerAccount({
    scoped,
    email: 'owner@example.com',
    displayName: 'Dana Okoro',
    password: 'the-first-owner-passphrase',
    role: 'owner',
    status: 'active',
    now: T0,
  });
  owner = {
    userId: registered.user.id,
    displayName: registered.user.displayName,
    membershipId: registered.membership.id,
  };
});

afterEach(async () => {
  await harness.close();
});

const invite = (email: string, role: 'owner' | 'manager' | 'member' | 'viewer' = 'member', teamKeys: string[] = ['platform']) =>
  inviteSeat({
    scoped,
    email,
    role,
    teamKeys,
    actor: { userId: owner.userId, displayName: owner.displayName },
    now: T0,
    ...mailContext(harness.mailer),
  });

describe('inviting a seat', () => {
  it('creates a pending Membership and mails a single-use expiring token', async () => {
    const result = await invite('priya@example.com', 'manager', ['platform']);

    expect(result.membership.status).toBe('pending');
    expect(result.membership.role).toBe('manager');
    expect(result.seat.teamKeys).toEqual(['platform']);

    // Seven days, from the documented table rather than from a literal here.
    expect(result.expiresAt).toBe(addMillis(T0, 7 * MILLIS_PER_DAY));

    const message = harness.mailer.lastTo('priya@example.com');
    expect(message, 'no invitation was mailed').not.toBeNull();
    expect(message?.purpose).toBe('invite');
    // The link, the inviter and the stated lifetime all have to be in what a person reads.
    expect(message?.body).toContain(result.link);
    expect(message?.body).toContain('Dana Okoro');
    expect(message?.body).toContain(TOKEN_TTL_LABEL.invite);

    // Exactly one live token, so a revoke has one thing to chase.
    const live = await listLiveAuthTokens(scoped, result.membership.userId, 'invite');
    expect(live).toHaveLength(1);
  });

  it('stores only the digest of the mailed secret', async () => {
    const result = await invite('priya@example.com');
    const secret = tokenFromLink(result.link);

    const rows = await harness.database.client.query<{ token_hash: string }>('select token_hash from auth_tokens');

    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.token_hash).not.toBe(secret);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('writes an audit row naming the actor, the target and the after state', async () => {
    const result = await invite('priya@example.com', 'viewer', ['platform']);

    const entries = await listAuditLogEntries(scoped);
    const entry = entries.find((row) => row.action === 'seat.invited' && row.targetId === result.membership.id);

    expect(entry, 'no audit row for the invitation').toBeDefined();
    expect(entry?.actorUserId).toBe(owner.userId);
    expect(entry?.targetKind).toBe('membership');
    expect(entry?.before).toBeNull();
    expect(entry?.after).toMatchObject({ email: 'priya@example.com', role: 'viewer', status: 'pending' });
    expect(entry?.occurredAt).toBe(T0);
  });

  it('refuses to invite an address that already has a seat, and says what to do instead', async () => {
    await invite('priya@example.com');

    await expect(invite('priya@example.com')).rejects.toThrow(/already has a member seat/i);
  });

  it('normalises the address, so one person cannot hold two seats by capitalisation', async () => {
    await invite('Priya@Example.com');

    const seats = await readSeats(scoped);
    expect(seats.map((seat) => seat.email)).toContain('priya@example.com');
    await expect(invite('PRIYA@EXAMPLE.COM')).rejects.toThrow(/already has/i);
  });

  it('refuses an address that is not one', async () => {
    await expect(invite('not-an-address')).rejects.toThrow(/email address/i);
  });
});

describe('accepting an invitation', () => {
  it('activates the seat, sets the password and signs the person in', async () => {
    const invited = await invite('priya@example.com', 'manager');
    const secret = tokenFromLink(invited.link);

    const accepted = await acceptInvite({
      scoped,
      secret,
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    expect(accepted.membership.status).toBe('active');
    expect(accepted.user.displayName).toBe('Priya Raman');

    // The password works, which is the only proof the hash was written correctly.
    const login = await verifyLogin({ scoped, email: 'priya@example.com', password: 'priyas-own-long-passphrase' });
    expect(login.ok).toBe(true);

    // And the session it issued resolves with the invited role.
    const resolved = await resolveIdentity({
      scoped,
      secret: accepted.started.secret,
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });
    expect(resolved.kind === 'identified' ? resolved.identity.principal : null).toBe('manager');
  });

  it('refuses the second use of the same invitation', async () => {
    const invited = await invite('priya@example.com');
    const secret = tokenFromLink(invited.link);

    const first = await acceptInvite({
      scoped,
      secret,
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });
    expect(first.ok).toBe(true);

    const second = await acceptInvite({
      scoped,
      secret,
      displayName: 'Someone Else',
      password: 'a-different-long-passphrase',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });

    expect(second.ok).toBe(false);
    expect(second.ok === false ? second.rejection : null).toBe('already_used');
  });

  it('refuses an invitation that has expired', async () => {
    const invited = await invite('priya@example.com');

    const tooLate = await acceptInvite({
      scoped,
      secret: tokenFromLink(invited.link),
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, 7 * MILLIS_PER_DAY),
    });

    expect(tooLate.ok).toBe(false);
    expect(tooLate.ok === false ? tooLate.rejection : null).toBe('expired');
  });
});

describe('resending an invitation', () => {
  it('issues a new token and revokes the previous one', async () => {
    const first = await invite('priya@example.com');
    const firstSecret = tokenFromLink(first.link);

    const second = await resendInvite({
      scoped,
      membershipId: first.membership.id,
      actor: { userId: owner.userId, displayName: owner.displayName },
      now: addMillis(T0, MILLIS_PER_HOUR),
      ...mailContext(harness.mailer),
    });

    expect(second.link).not.toBe(first.link);
    expect(second.expiresAt).toBe(addMillis(T0, MILLIS_PER_HOUR + 7 * MILLIS_PER_DAY));

    // Exactly one live token — never two.
    expect(await listLiveAuthTokens(scoped, first.membership.userId, 'invite')).toHaveLength(1);

    // The superseded link no longer works.
    const withOld = await acceptInvite({
      scoped,
      secret: firstSecret,
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });
    expect(withOld.ok).toBe(false);
    expect(withOld.ok === false ? withOld.rejection : null).toBe('revoked');

    // The new one does.
    const withNew = await acceptInvite({
      scoped,
      secret: tokenFromLink(second.link),
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });
    expect(withNew.ok).toBe(true);

    const entries = await listAuditLogEntries(scoped);
    expect(entries.some((row) => row.action === 'seat.invite_resent')).toBe(true);
  });

  it('refuses to resend for a seat that is not a pending invitation', async () => {
    await expect(
      resendInvite({
        scoped,
        membershipId: owner.membershipId,
        actor: { userId: owner.userId, displayName: owner.displayName },
        now: T0,
        ...mailContext(harness.mailer),
      }),
    ).rejects.toThrow(/not a pending invitation/i);
  });
});

describe('revoking a pending invitation makes its token unusable', () => {
  it('refuses the mailed link afterwards, and says it was withdrawn', async () => {
    const invited = await invite('priya@example.com');
    const secret = tokenFromLink(invited.link);

    await revokeInvite({
      scoped,
      membershipId: invited.membership.id,
      actorUserId: owner.userId,
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    const attempt = await acceptInvite({
      scoped,
      secret,
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });

    expect(attempt.ok).toBe(false);
    // `revoked`, not `not_found` and not `expired`: the person clicking needs to know an
    // owner took it back rather than that they mistyped it.
    expect(attempt.ok === false ? attempt.rejection : null).toBe('revoked');

    expect(await listLiveAuthTokens(scoped, invited.membership.userId, 'invite')).toHaveLength(0);

    const entries = await listAuditLogEntries(scoped);
    const entry = entries.find((row) => row.action === 'seat.invite_revoked');
    expect(entry?.before).toMatchObject({ status: 'pending' });
    expect(entry?.after).toMatchObject({ status: 'revoked' });
  });
});

describe('changing a role', () => {
  it('applies the new role on the next request and rotates that user’s session', async () => {
    const invited = await invite('priya@example.com', 'member');
    const accepted = await acceptInvite({
      scoped,
      secret: tokenFromLink(invited.link),
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    // Two devices, so the rotation has something to prove.
    const secondDevice = await startSession({
      scoped,
      userId: accepted.user.id,
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });

    const changed = await changeSeat({
      scoped,
      membershipId: invited.membership.id,
      role: 'manager',
      actorUserId: owner.userId,
      now: addMillis(T0, 3 * MILLIS_PER_HOUR),
    });

    expect(changed.membership.role).toBe('manager');
    expect(changed.changed).toEqual(['role']);
    expect(changed.sessionsRevoked).toBe(2);
    // The owner changed somebody else's seat, so there is no browser of theirs to re-cookie.
    expect(changed.replacementSession).toBeNull();

    for (const secret of [accepted.started.secret, secondDevice.secret]) {
      const resolved = await resolveIdentity({ scoped, secret, now: addMillis(T0, 4 * MILLIS_PER_HOUR) });
      expect(resolved.kind, 'every prior session must be invalid').toBe('anonymous');
    }

    // Signing in again gets the new role, read from the membership.
    const login = await verifyLogin({ scoped, email: 'priya@example.com', password: 'priyas-own-long-passphrase' });
    expect(login.ok && login.membership.role).toBe('manager');

    const entries = await listAuditLogEntries(scoped);
    const entry = entries.find((row) => row.action === 'seat.role_changed');
    expect(entry?.before).toMatchObject({ role: 'member' });
    expect(entry?.after).toMatchObject({ role: 'manager' });
  });

  it('records a team-scope change separately from a role change', async () => {
    const invited = await invite('priya@example.com', 'manager', ['platform']);

    const changed = await changeSeat({
      scoped,
      membershipId: invited.membership.id,
      teamKeys: ['payments', 'platform'],
      actorUserId: owner.userId,
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    expect(changed.changed).toEqual(['teamKeys']);
    expect(changed.teamKeys).toEqual(['payments', 'platform']);

    const entries = await listAuditLogEntries(scoped);
    const entry = entries.find((row) => row.action === 'seat.team_scopes_changed');
    expect(entry?.before).toMatchObject({ teamKeys: ['platform'] });
    expect(entry?.after).toMatchObject({ teamKeys: ['payments', 'platform'] });
    expect(entries.some((row) => row.action === 'seat.role_changed')).toBe(false);
  });

  it('refuses to demote the last owner', async () => {
    await expect(
      changeSeat({
        scoped,
        membershipId: owner.membershipId,
        role: 'manager',
        actorUserId: owner.userId,
        now: T0,
      }),
    ).rejects.toThrow(LastOwnerError);
  });

  it('allows the demotion once a second owner exists', async () => {
    const second = await invite('second-owner@example.com', 'owner', []);
    await acceptInvite({
      scoped,
      secret: tokenFromLink(second.link),
      displayName: 'Marcus Hale',
      password: 'the-second-owner-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    const changed = await changeSeat({
      scoped,
      membershipId: owner.membershipId,
      role: 'manager',
      actorUserId: owner.userId,
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
    });

    expect(changed.membership.role).toBe('manager');
  });
});

describe('removing a seat', () => {
  it('ends every session and revokes every outstanding link', async () => {
    const invited = await invite('priya@example.com', 'member');
    const accepted = await acceptInvite({
      scoped,
      secret: tokenFromLink(invited.link),
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    await requestPasswordReset({
      scoped,
      email: 'priya@example.com',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
      ...mailContext(harness.mailer),
    });

    const removed = await removeSeat({
      scoped,
      membershipId: invited.membership.id,
      actorUserId: owner.userId,
      now: addMillis(T0, 3 * MILLIS_PER_HOUR),
    });

    expect(removed.sessionsRevoked).toBe(1);
    expect(
      (await resolveIdentity({ scoped, secret: accepted.started.secret, now: addMillis(T0, 4 * MILLIS_PER_HOUR) }))
        .kind,
    ).toBe('anonymous');

    // No outstanding link of any kind survives a removal.
    for (const purpose of ['invite', 'magic_link', 'password_reset'] as const) {
      expect(await listLiveAuthTokens(scoped, accepted.user.id, purpose), purpose).toHaveLength(0);
    }

    // The password no longer signs in, because the seat is not active.
    const login = await verifyLogin({ scoped, email: 'priya@example.com', password: 'priyas-own-long-passphrase' });
    expect(login.ok).toBe(false);
    expect(login.ok === false ? login.failure : null).toBe('seat_not_active');
  });

  it('keeps the rows so the audit log still names who did what', async () => {
    const invited = await invite('priya@example.com');
    await removeSeat({
      scoped,
      membershipId: invited.membership.id,
      actorUserId: owner.userId,
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    const seats = await readSeats(scoped);
    const seat = seats.find((candidate) => candidate.id === invited.membership.id);

    expect(seat, 'the row must survive removal').toBeDefined();
    expect(seat?.status).toBe('revoked');
    expect(seat?.teamKeys).toEqual([]);
  });

  it('refuses to remove the last owner', async () => {
    await expect(
      removeSeat({ scoped, membershipId: owner.membershipId, actorUserId: owner.userId, now: T0 }),
    ).rejects.toThrow(LastOwnerError);
  });
});

describe('mailed sign-in links', () => {
  it('works once and only once', async () => {
    const invited = await invite('priya@example.com');
    await acceptInvite({
      scoped,
      secret: tokenFromLink(invited.link),
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    const requested = await requestMagicLink({
      scoped,
      email: 'priya@example.com',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
      ...mailContext(harness.mailer),
    });
    expect(requested.mailed).toBe(true);

    const message = harness.mailer.lastTo('priya@example.com');
    const secret = tokenFromLink(message?.link ?? '');

    const first = await consumeMagicLink({ scoped, secret, now: addMillis(T0, 2 * MILLIS_PER_HOUR + 60_000) });
    expect(first.ok).toBe(true);

    const second = await consumeMagicLink({ scoped, secret, now: addMillis(T0, 2 * MILLIS_PER_HOUR + 120_000) });
    expect(second.ok).toBe(false);
    expect(second.ok === false ? second.rejection : null).toBe('already_used');
  });

  it('expires after the documented fifteen minutes', async () => {
    const invited = await invite('priya@example.com');
    await acceptInvite({
      scoped,
      secret: tokenFromLink(invited.link),
      displayName: 'Priya Raman',
      password: 'priyas-own-long-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    await requestMagicLink({
      scoped,
      email: 'priya@example.com',
      now: addMillis(T0, 2 * MILLIS_PER_HOUR),
      ...mailContext(harness.mailer),
    });
    const secret = tokenFromLink(harness.mailer.lastTo('priya@example.com')?.link ?? '');

    const tooLate = await consumeMagicLink({
      scoped,
      secret,
      now: addMillis(T0, 2 * MILLIS_PER_HOUR + 15 * MILLIS_PER_MINUTE),
    });

    expect(tooLate.ok).toBe(false);
    expect(tooLate.ok === false ? tooLate.rejection : null).toBe('expired');
  });

  it('answers the same way for an address with no seat, so the form is not a membership oracle', async () => {
    const result = await requestMagicLink({
      scoped,
      email: 'nobody@example.com',
      now: T0,
      ...mailContext(harness.mailer),
    });

    expect(result.mailed).toBe(false);
    expect(harness.mailer.lastTo('nobody@example.com')).toBeNull();
    // Same sentence as the success path.
    expect(result.stated).toContain('If that address has a seat here');
  });
});

describe('password reset links', () => {
  it('is refused on its second use, and expires after the documented hour', async () => {
    await requestPasswordReset({
      scoped,
      email: 'owner@example.com',
      now: T0,
      ...mailContext(harness.mailer),
    });
    const secret = tokenFromLink(harness.mailer.lastTo('owner@example.com')?.link ?? '');

    const first = await consumePasswordReset({
      scoped,
      secret,
      password: 'a-brand-new-passphrase',
      now: addMillis(T0, MILLIS_PER_MINUTE),
    });
    expect(first.ok).toBe(true);

    const second = await consumePasswordReset({
      scoped,
      secret,
      password: 'yet-another-passphrase',
      now: addMillis(T0, 2 * MILLIS_PER_MINUTE),
    });
    expect(second.ok).toBe(false);
    expect(second.ok === false ? second.rejection : null).toBe('already_used');

    // The first password is gone and the second never took effect.
    expect((await verifyLogin({ scoped, email: 'owner@example.com', password: 'a-brand-new-passphrase' })).ok).toBe(
      true,
    );
    expect(
      (await verifyLogin({ scoped, email: 'owner@example.com', password: 'the-first-owner-passphrase' })).ok,
    ).toBe(false);
    expect((await verifyLogin({ scoped, email: 'owner@example.com', password: 'yet-another-passphrase' })).ok).toBe(
      false,
    );
  });

  it('expires one hour after it was sent', async () => {
    await requestPasswordReset({ scoped, email: 'owner@example.com', now: T0, ...mailContext(harness.mailer) });
    const secret = tokenFromLink(harness.mailer.lastTo('owner@example.com')?.link ?? '');

    const tooLate = await consumePasswordReset({
      scoped,
      secret,
      password: 'a-brand-new-passphrase',
      now: addMillis(T0, MILLIS_PER_HOUR),
    });

    expect(tooLate.ok).toBe(false);
    expect(tooLate.ok === false ? tooLate.rejection : null).toBe('expired');
  });

  it('ends every other session, and records the change without storing the hash', async () => {
    const laptop = await startSession({ scoped, userId: owner.userId, now: T0 });
    const phone = await startSession({ scoped, userId: owner.userId, now: addMillis(T0, 1000) });

    await requestPasswordReset({ scoped, email: 'owner@example.com', now: T0, ...mailContext(harness.mailer) });
    const secret = tokenFromLink(harness.mailer.lastTo('owner@example.com')?.link ?? '');

    const reset = await consumePasswordReset({
      scoped,
      secret,
      password: 'a-brand-new-passphrase',
      now: addMillis(T0, MILLIS_PER_MINUTE),
    });
    expect(reset.ok).toBe(true);

    for (const dead of [laptop.secret, phone.secret]) {
      expect((await resolveIdentity({ scoped, secret: dead, now: addMillis(T0, 2 * MILLIS_PER_MINUTE) })).kind).toBe(
        'anonymous',
      );
    }

    const entries = await listAuditLogEntries(scoped);
    const entry = entries.find((row) => row.action === 'account.password_changed');
    expect(entry).toBeDefined();
    // The audit log is browsed by people. A credential must never be in it.
    expect(JSON.stringify(entry?.after ?? {})).not.toContain('$argon2');
    expect(JSON.stringify(entry?.after ?? {})).not.toContain('a-brand-new-passphrase');
  });

  it('supersedes an earlier unused link when a second is requested', async () => {
    await requestPasswordReset({ scoped, email: 'owner@example.com', now: T0, ...mailContext(harness.mailer) });
    const firstSecret = tokenFromLink(harness.mailer.lastTo('owner@example.com')?.link ?? '');

    await requestPasswordReset({
      scoped,
      email: 'owner@example.com',
      now: addMillis(T0, MILLIS_PER_MINUTE),
      ...mailContext(harness.mailer),
    });

    const withFirst = await consumePasswordReset({
      scoped,
      secret: firstSecret,
      password: 'a-brand-new-passphrase',
      now: addMillis(T0, 2 * MILLIS_PER_MINUTE),
    });

    expect(withFirst.ok).toBe(false);
    expect(withFirst.ok === false ? withFirst.rejection : null).toBe('revoked');
  });
});

describe('the audit vocabulary', () => {
  it('covers every act the task names', () => {
    for (const required of [
      'seat.role_changed',
      'seat.invite_revoked',
      'config.changed',
      'share_link.revoked',
      'report.exported',
      'data.deleted',
    ]) {
      expect(AUDIT_ACTIONS as readonly string[], `${required} is missing from the vocabulary`).toContain(required);
    }
  });
});

describe('tenant isolation', () => {
  it('never lets one organization read another’s seats', async () => {
    await invite('priya@example.com');

    expect((await readSeats(harness.other)).length).toBe(0);
    expect((await listAuditLogEntries(harness.other)).length).toBe(0);
  });
});
