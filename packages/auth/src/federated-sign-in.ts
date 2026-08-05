import type { Instant } from '@compass/clock';
import {
  ensureMembership,
  ensureUser,
  findIdentityBySubject,
  findMembershipByUserId,
  findUserByEmail,
  findUserById,
  linkIdentity,
  normalizeEmail,
  setMembershipStatus,
  touchIdentitySignIn,
  type IdentityProvider,
  type MembershipRole,
  type MembershipRow,
  type ScopedDb,
  type StoredUserIdentity,
  type UserRow,
} from '@compass/db';

import { recordAudit } from './audit.js';

/**
 * Turning "some provider vouches for this person" into "this Compass account".
 *
 * One implementation for Google, GitHub and SAML, and that is the point rather than a convenience:
 * the account-matching rules are where the security lives, and three copies of them would be three
 * chances to get "never auto-link an unverified address" subtly different. The protocol differences
 * live in `oauth.ts` and `saml.ts`; by the time anything reaches here it is a normalised assertion.
 *
 * ## The four rules, in the order they are applied
 *
 * 1. **A known subject is that person, full stop.** If `(provider, subject)` already has a row, the
 *    account it points at is the account — the asserted email is not consulted at all. This is what
 *    makes a colleague's address change harmless: the identity is the provider's immutable id, so
 *    renaming their mailbox does not detach them from their own history, and being *given* somebody's
 *    old address does not attach the new person to it.
 * 2. **An unverified address never matches an existing account.** Refused, with a distinct reason so
 *    the screen can offer the way back. An OAuth provider will hand over an address its user typed
 *    and never confirmed; treating that as mailbox proof means typing a colleague's address and
 *    becoming them. The way back is deliberately *not* automated here — the person signs in through a
 *    channel they already control and links the provider from `/account`, which is an ownership
 *    confirmation made by somebody who is already known to be the account holder.
 * 3. **A verified address matches, and links.** One row, no duplicate account. A *pending* seat is
 *    activated at the same moment, because a verified address is the same proof an invitation asks
 *    for — the same reasoning `consumeMagicLink` uses when it activates a pending seat.
 * 4. **No match and no provisioning means no account.** Compass seats are invited. A flow that minted
 *    one on first Google login would let anybody with a Google account take a seat in somebody else's
 *    organization. SAML may provision (`allowProvisioning`), because there the assertion comes from
 *    the organization's *own* identity provider rather than from a consumer account — and even then
 *    never as an owner, which the schema enforces with a check constraint.
 *
 * ## What this deliberately does not do
 *
 * It does not mint a session and it does not check the second factor. It returns the user and the
 * membership exactly as `verifyLogin` does, and for the same reason: the caller is the layer that
 * knows whether a code is still owed, and a federated sign-in that minted its own session would be
 * the one path where the second factor and the session rules were reimplemented.
 */

/** A provider's normalised claim about one person. */
export interface FederatedAssertion {
  readonly provider: IdentityProvider;
  /** The provider's immutable id for this person. Never the address. */
  readonly subject: string;
  readonly email: string;
  /** As the provider asserted it. False refuses at rule 2. */
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export type FederatedRefusal =
  /** The provider did not confirm the address. Rule 2. */
  | 'email_unverified'
  /** Nobody here holds that address, and this provider may not create seats. Rule 4. */
  | 'no_seat'
  /** The seat was removed. A revoked membership is not re-activated by signing in. */
  | 'seat_revoked';

export type FederatedSignIn =
  | {
      readonly kind: 'signed_in';
      readonly user: UserRow;
      readonly membership: MembershipRow;
      readonly identity: StoredUserIdentity;
      /** True when this assertion created the account, which only SAML provisioning can do. */
      readonly provisioned: boolean;
      /** True when a pending invitation was accepted by this sign-in. */
      readonly seatActivated: boolean;
      /** True when the identity row is new, so the caller can audit a first link. */
      readonly linked: boolean;
    }
  | { readonly kind: 'refused'; readonly reason: FederatedRefusal };

export interface FederatedSignInInput {
  readonly scoped: ScopedDb;
  readonly assertion: FederatedAssertion;
  readonly now: Instant;
  /**
   * Whether this provider may create an account for an address nobody holds.
   *
   * False for Google and GitHub. True only for SAML, where the assertion comes from the
   * organization's own IdP — and `provisionRole` is then the role, which the database refuses to let
   * be `owner`.
   */
  readonly allowProvisioning?: boolean;
  readonly provisionRole?: MembershipRole;
}

/** Why a refusal happened, in the product's voice. One wording, so three screens cannot disagree. */
export function describeFederatedRefusal(reason: FederatedRefusal, providerName: string): string {
  switch (reason) {
    case 'email_unverified':
      return (
        `${providerName} did not confirm that this email address belongs to you, so Compass will not ` +
        'use it to find your account — an unconfirmed address is not proof of anything. Verify the ' +
        `address with ${providerName}, or sign in with your password and link ${providerName} from ` +
        'your account screen.'
      );
    case 'no_seat':
      return (
        'That address does not have a seat here. Compass seats are invited rather than self-serve, so ' +
        'ask an owner to send you one — the invitation works with this sign-in method.'
      );
    case 'seat_revoked':
      return 'That seat has been removed. Ask an owner for a new invitation.';
  }
}

export async function resolveFederatedSignIn(input: FederatedSignInInput): Promise<FederatedSignIn> {
  const { scoped, assertion, now } = input;
  const email = normalizeEmail(assertion.email);

  // ---------------------------------------------------------------------
  // Rule 1 — a known subject is that person.
  // ---------------------------------------------------------------------
  const existingIdentity = await findIdentityBySubject(scoped, assertion.provider, assertion.subject);

  if (existingIdentity !== null) {
    const user = await findUserById(scoped, existingIdentity.userId);
    const membership = user === null ? null : await findMembershipByUserId(scoped, user.id);

    // The account was erased while the provider still knows the subject. Treated as no seat rather
    // than as a broken link: there is nothing to sign into and nothing to repair.
    if (user === null || membership === null) return { kind: 'refused', reason: 'no_seat' };
    if (membership.status === 'revoked') return { kind: 'refused', reason: 'seat_revoked' };

    /**
     * The stored email is refreshed, and the *verification state* with it.
     *
     * Worth the write: it keeps the account screen honest about which address the provider currently
     * asserts. It cannot repoint the link — `linkIdentity` never updates `user_id` — so refreshing it
     * grants nothing even if the provider starts asserting somebody else's address.
     */
    const identity = await linkIdentity(
      scoped,
      {
        userId: user.id,
        provider: assertion.provider,
        subject: assertion.subject,
        email,
        emailVerified: assertion.emailVerified,
      },
      now,
    );

    const seatActivated = membership.status === 'pending';
    if (seatActivated) {
      await activatePendingSeat({ scoped, membershipId: membership.id, userId: user.id, now, provider: assertion.provider });
    }

    await touchIdentitySignIn(scoped, identity.id, now);

    return {
      kind: 'signed_in',
      user,
      membership: seatActivated
        ? ((await findMembershipByUserId(scoped, user.id)) ?? { ...membership, status: 'active' })
        : membership,
      identity,
      provisioned: false,
      seatActivated,
      linked: false,
    };
  }

  // ---------------------------------------------------------------------
  // Rule 2 — an unverified address never matches an existing account.
  // ---------------------------------------------------------------------
  if (!assertion.emailVerified) return { kind: 'refused', reason: 'email_unverified' };

  // ---------------------------------------------------------------------
  // Rule 3 — a verified address matches, and links.
  // ---------------------------------------------------------------------
  const matched = await findUserByEmail(scoped, email);

  if (matched !== null) {
    const membership =
      (await findMembershipByUserId(scoped, matched.id)) ??
      // A user row with no membership is a half-finished bootstrap rather than a seat. Refusing is
      // the safe direction: inventing a membership here would be provisioning by accident.
      null;

    if (membership === null) return { kind: 'refused', reason: 'no_seat' };
    if (membership.status === 'revoked') return { kind: 'refused', reason: 'seat_revoked' };

    const identity = await linkIdentity(
      scoped,
      {
        userId: matched.id,
        provider: assertion.provider,
        subject: assertion.subject,
        email,
        emailVerified: true,
      },
      now,
    );

    await recordAudit(scoped, {
      action: 'account.identity_linked',
      actorUserId: matched.id,
      targetKind: 'user',
      targetId: matched.id,
      before: { provider: assertion.provider, linked: false },
      // The subject is recorded and the address is not re-recorded: the audit log is read by people,
      // and what a reader needs is *which* provider account, not a second copy of the mailbox.
      after: { provider: assertion.provider, linked: true, subject: assertion.subject, via: 'verified_email' },
      occurredAt: now,
    });

    const seatActivated = membership.status === 'pending';
    if (seatActivated) {
      await activatePendingSeat({
        scoped,
        membershipId: membership.id,
        userId: matched.id,
        now,
        provider: assertion.provider,
      });
    }

    await touchIdentitySignIn(scoped, identity.id, now);

    return {
      kind: 'signed_in',
      user: matched,
      membership: seatActivated
        ? ((await findMembershipByUserId(scoped, matched.id)) ?? { ...membership, status: 'active' })
        : membership,
      identity,
      provisioned: false,
      seatActivated,
      linked: true,
    };
  }

  // ---------------------------------------------------------------------
  // Rule 4 — no match. Only SAML may create a seat.
  // ---------------------------------------------------------------------
  if (input.allowProvisioning !== true) return { kind: 'refused', reason: 'no_seat' };

  const role: MembershipRole = input.provisionRole ?? 'member';

  const user = await ensureUser(scoped, {
    email,
    displayName: assertion.displayName.trim().length > 0 ? assertion.displayName.trim() : email,
    /**
     * No password, and never a generated one.
     *
     * A provisioned account signs in through the IdP. Inventing a password would create a credential
     * nobody knows, which cannot be used and cannot be revoked — and would make `verifyLogin`'s
     * "this account signs in by link" branch lie about how the account works.
     */
    passwordHash: null,
    at: now,
  });

  const membership = await ensureMembership(scoped, { userId: user.id, role, status: 'active', at: now });

  const identity = await linkIdentity(
    scoped,
    {
      userId: user.id,
      provider: assertion.provider,
      subject: assertion.subject,
      email,
      emailVerified: true,
    },
    now,
  );

  await recordAudit(scoped, {
    action: 'seat.provisioned',
    // Null actor, and honest: an assertion carries no Compass session to attribute the act to. What
    // *is* known is which provider asserted it, which is in `after`.
    actorUserId: null,
    targetKind: 'membership',
    targetId: membership.id,
    before: { exists: false },
    after: { role, status: 'active', provider: assertion.provider, subject: assertion.subject },
    occurredAt: now,
  });

  await touchIdentitySignIn(scoped, identity.id, now);

  return {
    kind: 'signed_in',
    user,
    membership,
    identity,
    provisioned: true,
    seatActivated: false,
    linked: true,
  };
}

/**
 * Accepts a pending invitation, because a verified address is the proof an invitation asks for.
 *
 * The same act `consumeMagicLink` performs, and it is recorded the same way — `seat.accepted` with
 * the channel in `after`, so the audit log distinguishes "clicked the emailed link" from "signed in
 * with Google" rather than flattening both into "accepted".
 */
async function activatePendingSeat(input: {
  readonly scoped: ScopedDb;
  readonly membershipId: string;
  readonly userId: string;
  readonly now: Instant;
  readonly provider: IdentityProvider;
}): Promise<void> {
  await setMembershipStatus(input.scoped, input.membershipId, 'active', input.now);

  await recordAudit(input.scoped, {
    action: 'seat.accepted',
    actorUserId: input.userId,
    targetKind: 'membership',
    targetId: input.membershipId,
    before: { status: 'pending' },
    after: { status: 'active', via: input.provider },
    occurredAt: input.now,
  });
}

/**
 * Links a provider to the account of somebody who is *already signed in*.
 *
 * This is the ownership confirmation rule 2 points at, and it is a different act from a sign-in: the
 * person has already proved who they are with a credential Compass issued, so the provider's
 * verification state is no longer load-bearing for *matching* — it only records what the provider
 * says. What matters instead is that the subject is not already somebody else's, which the unique
 * index enforces and this checks first so the answer is a sentence rather than a constraint violation.
 */
export type IdentityLinkResult =
  | { readonly ok: true; readonly identity: StoredUserIdentity }
  | { readonly ok: false; readonly reason: 'already_linked_elsewhere' };

export async function linkIdentityToAccount(input: {
  readonly scoped: ScopedDb;
  readonly userId: string;
  readonly assertion: FederatedAssertion;
  readonly now: Instant;
}): Promise<IdentityLinkResult> {
  const existing = await findIdentityBySubject(
    input.scoped,
    input.assertion.provider,
    input.assertion.subject,
  );

  if (existing !== null && existing.userId !== input.userId) {
    return { ok: false, reason: 'already_linked_elsewhere' };
  }

  const identity = await linkIdentity(
    input.scoped,
    {
      userId: input.userId,
      provider: input.assertion.provider,
      subject: input.assertion.subject,
      email: normalizeEmail(input.assertion.email),
      emailVerified: input.assertion.emailVerified,
    },
    input.now,
  );

  await recordAudit(input.scoped, {
    action: 'account.identity_linked',
    actorUserId: input.userId,
    targetKind: 'user',
    targetId: input.userId,
    before: { provider: input.assertion.provider, linked: existing !== null },
    after: {
      provider: input.assertion.provider,
      linked: true,
      subject: input.assertion.subject,
      via: 'signed_in_confirmation',
    },
    occurredAt: input.now,
  });

  return { ok: true, identity };
}
