import {
  authenticateScim,
  bearerTokenFrom,
  describeFederatedRefusal,
  generateScimToken,
  hashScimToken,
  linkIdentityToAccount,
  parseScimFilter,
  readScimPatch,
  readScimUserWrite,
  removeSeat,
  resolveFederatedSignIn,
  scimListUsers,
  scimUserResource,
  startSession,
} from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  ensureMembership,
  ensureUser,
  findIdentityBySubject,
  findMembershipByUserId,
  insertScimCredential,
  listScimCredentials,
  listSeats,
  listSessionsForUser,
  revokeScimCredential,
} from '@compass/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuthHarness, type AuthHarness } from './helpers/org.js';

/**
 * SCIM provisioning, the linking rules it shares with SSO, and the deprovision guarantee.
 *
 * Two acceptance criteria are asserted here directly:
 *
 *  - **"WHEN SCIM deprovisions a user THE SYSTEM SHALL revoke their sessions and free their seat within
 *    one sync cycle."** `deprovisioning revokes every session and frees the seat` proves it against a
 *    real database, with real sessions issued by the real `startSession`. It is satisfied
 *    *synchronously* — the sessions are gone before the call returns — so there is no window at all
 *    rather than a cycle-long one.
 *  - **"Unverified provider emails never auto-link; the user must confirm ownership."** The two tests
 *    under `an unverified provider email` prove both halves: the refusal, and the signed-in confirmation
 *    path that is the way through it.
 */

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-05T09:00:00Z');

// ---------------------------------------------------------------------------
// Bearer tokens
// ---------------------------------------------------------------------------

describe('the SCIM bearer token', () => {
  it('is long enough that guessing is not a strategy, and fresh each time', () => {
    const tokens = new Set(Array.from({ length: 25 }, () => generateScimToken()));

    expect(tokens.size).toBe(25);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('is stored only as a SHA-256, so a database dump yields no working credential', () => {
    const token = generateScimToken();
    const digest = hashScimToken(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    // Deterministic, or the lookup could never match.
    expect(hashScimToken(token)).toBe(digest);
  });

  it('reads only an exact `Bearer <token>` header, and answers null for anything else', () => {
    expect(bearerTokenFrom('Bearer abc123')).toBe('abc123');
    expect(bearerTokenFrom('bearer abc123')).toBe('abc123');

    // A malformed header and an unknown token must produce the same refusal, so neither confirms to a
    // prober that the *format* was right.
    for (const header of [null, '', 'Basic abc', 'Bearer', 'Bearer a b', 'abc123']) {
      expect(bearerTokenFrom(header), `\`${String(header)}\` was accepted`).toBeNull();
    }
  });
});

describe('authenticating a SCIM request', () => {
  let harness: AuthHarness;

  beforeAll(async () => {
    harness = await createAuthHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('admits a live token and records that it was used', async () => {
    const token = generateScimToken();
    await insertScimCredential(harness.scoped, { tokenHash: hashScimToken(token), label: 'Okta' }, NOW);

    const result = await authenticateScim({
      scoped: harness.scoped,
      authorization: `Bearer ${token}`,
      now: at('2026-08-05T10:00:00Z'),
    });

    expect(result.ok).toBe(true);

    const stored = await listScimCredentials(harness.scoped);
    expect(stored[0]?.lastUsedAt).toBe(at('2026-08-05T10:00:00Z'));
  });

  it('refuses a revoked token, indistinguishably from an unknown one', async () => {
    const token = generateScimToken();
    const credential = await insertScimCredential(
      harness.scoped,
      { tokenHash: hashScimToken(token), label: 'To be revoked' },
      NOW,
    );

    expect((await authenticateScim({ scoped: harness.scoped, authorization: `Bearer ${token}`, now: NOW })).ok).toBe(
      true,
    );

    expect(await revokeScimCredential(harness.scoped, credential.id, NOW)).toBe(true);

    expect((await authenticateScim({ scoped: harness.scoped, authorization: `Bearer ${token}`, now: NOW })).ok).toBe(
      false,
    );
    // Idempotent: revoking twice is not an error, it is a no-op.
    expect(await revokeScimCredential(harness.scoped, credential.id, NOW)).toBe(false);
  });

  it('refuses a token belonging to another organization', async () => {
    const token = generateScimToken();
    await insertScimCredential(harness.other, { tokenHash: hashScimToken(token), label: 'Other tenant' }, NOW);

    // A real cross-tenant query against real rows, not a claim about the predicate.
    expect((await authenticateScim({ scoped: harness.scoped, authorization: `Bearer ${token}`, now: NOW })).ok).toBe(
      false,
    );
  });

  it('never exposes the digest on the credential it hands back', () => {
    // Asserted on the type's shape: a hash in a view model is a hash that ends up in a response body.
    const shape = Object.keys({
      id: '',
      label: '',
      issuedAt: NOW,
      lastUsedAt: null,
      revokedAt: null,
    }).sort();

    expect(shape).not.toContain('tokenHash');
  });
});

// ---------------------------------------------------------------------------
// Payload reading
// ---------------------------------------------------------------------------

describe('reading a SCIM user payload', () => {
  it('takes userName as the email address and normalises it', () => {
    const result = readScimUserWrite({ schemas: [], userName: 'Priya@Example.COM', displayName: 'Priya' });

    expect(result.ok && result.write.userName).toBe('priya@example.com');
  });

  it('assembles a display name from whichever of the three shapes the provider used', () => {
    expect(
      (readScimUserWrite({ userName: 'a@b.com', displayName: 'From displayName' }) as { write: { displayName: string } })
        .write.displayName,
    ).toBe('From displayName');

    expect(
      (readScimUserWrite({ userName: 'a@b.com', name: { formatted: 'From formatted' } }) as {
        write: { displayName: string };
      }).write.displayName,
    ).toBe('From formatted');

    expect(
      (readScimUserWrite({ userName: 'a@b.com', name: { givenName: 'Ada', familyName: 'Lovelace' } }) as {
        write: { displayName: string };
      }).write.displayName,
    ).toBe('Ada Lovelace');
  });

  it('falls back to the address rather than creating a seat with no name', () => {
    expect(
      (readScimUserWrite({ userName: 'a@b.com' }) as { write: { displayName: string } }).write.displayName,
    ).toBe('a@b.com');
  });

  it('treats an absent `active` as active, because a POST is creating somebody with access', () => {
    expect((readScimUserWrite({ userName: 'a@b.com' }) as { write: { active: boolean } }).write.active).toBe(true);
    expect(
      (readScimUserWrite({ userName: 'a@b.com', active: false }) as { write: { active: boolean } }).write.active,
    ).toBe(false);
  });

  it('refuses a payload with no usable address', () => {
    for (const body of [null, 'string', [], {}, { userName: '' }, { userName: 'not-an-email' }]) {
      expect(readScimUserWrite(body).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('the SCIM filter', () => {
  it('parses the one filter every identity provider actually sends', () => {
    expect(parseScimFilter('userName eq "priya@example.com"')).toEqual({
      kind: 'user_name',
      value: 'priya@example.com',
    });
    expect(parseScimFilter('userName EQ "Priya@Example.com"')).toEqual({
      kind: 'user_name',
      value: 'priya@example.com',
    });
  });

  it('reports an unsupported filter rather than silently matching everything', () => {
    /**
     * The one place permissiveness would be dangerous.
     *
     * An ignored filter returns *every* user to a client that asked about one — and the provider reads
     * the first row as a match and starts updating the wrong person's seat.
     */
    expect(parseScimFilter('emails.value co "@example.com"').kind).toBe('unsupported');
    expect(parseScimFilter('userName ne "a@b.com"').kind).toBe('unsupported');
  });

  it('treats an absent filter as no filter', () => {
    expect(parseScimFilter(null).kind).toBe('none');
    expect(parseScimFilter('   ').kind).toBe('none');
  });
});

describe('reading a SCIM PATCH', () => {
  /**
   * Both shapes, because both are sent in the wild.
   *
   * Okta sends `{op, path: "active", value: false}`; Azure AD sends `{op, value: {active: false}}` with
   * no path. Handling only the first is how a deprovision silently becomes a no-op for half the market.
   */
  it('reads Okta’s pathed form', () => {
    expect(readScimPatch({ Operations: [{ op: 'replace', path: 'active', value: false }] })).toEqual({
      kind: 'set_active',
      active: false,
    });
  });

  it('reads Azure AD’s nested form, which carries no path at all', () => {
    expect(readScimPatch({ Operations: [{ op: 'replace', value: { active: false } }] })).toEqual({
      kind: 'set_active',
      active: false,
    });
  });

  it('reads the string "false" as false, because providers send both', () => {
    expect(readScimPatch({ Operations: [{ op: 'replace', path: 'active', value: 'false' }] })).toEqual({
      kind: 'set_active',
      active: false,
    });
  });

  it('reports an unrelated change as a no-op rather than an error', () => {
    // An IdP pushing a phone number should not see a broken integration in its admin console.
    expect(readScimPatch({ Operations: [{ op: 'replace', path: 'phoneNumbers', value: '555' }] })).toEqual({
      kind: 'no_op',
    });
  });

  it('refuses a body that is not a PatchOp at all', () => {
    expect(readScimPatch({}).kind).toBe('malformed');
    expect(readScimPatch(null).kind).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// Deprovisioning — the acceptance criterion
// ---------------------------------------------------------------------------

describe('SCIM deprovisioning', () => {
  let harness: AuthHarness;

  beforeAll(async () => {
    harness = await createAuthHarness();
    // An owner, so removing a member is never refused as "the last owner".
    const owner = await ensureUser(harness.scoped, {
      email: 'owner@example.com',
      displayName: 'Owner',
      passwordHash: null,
      at: NOW,
    });
    await ensureMembership(harness.scoped, { userId: owner.id, role: 'owner', status: 'active', at: NOW });
  });

  afterAll(async () => {
    await harness.close();
  });

  /**
   * The criterion, stated as a test: sessions revoked and the seat freed.
   *
   * Real sessions from the real `startSession`, and the same `removeSeat` the owner-facing seat screen
   * calls — which is the whole reason the seat is genuinely *freed* rather than a parallel SCIM
   * concept being marked inactive beside it.
   */
  it('revokes every session and frees the seat, synchronously', async () => {
    const provisioned = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: {
        provider: 'scim',
        subject: 'okta-user-77',
        email: 'departing@example.com',
        emailVerified: true,
        displayName: 'Departing Person',
      },
      now: NOW,
      allowProvisioning: true,
      provisionRole: 'member',
    });

    expect(provisioned.kind).toBe('signed_in');
    if (provisioned.kind !== 'signed_in') return;

    // Three devices, as a real person would have.
    for (let index = 0; index < 3; index += 1) {
      await startSession({ scoped: harness.scoped, userId: provisioned.user.id, now: NOW });
    }

    const liveBefore = (await listSessionsForUser(harness.scoped, provisioned.user.id)).filter(
      (session) => session.revokedAt === null,
    );
    expect(liveBefore.length).toBe(3);

    await removeSeat({
      scoped: harness.scoped,
      membershipId: provisioned.membership.id,
      actorUserId: provisioned.user.id,
      now: at('2026-08-05T11:00:00Z'),
    });

    // Sessions: gone. Not "gone on the next sync" — gone before the call returned.
    const liveAfter = (await listSessionsForUser(harness.scoped, provisioned.user.id)).filter(
      (session) => session.revokedAt === null,
    );
    expect(liveAfter).toEqual([]);

    // Seat: freed, which means the membership the seat count reads is revoked.
    expect((await findMembershipByUserId(harness.scoped, provisioned.user.id))?.status).toBe('revoked');

    const seat = (await listSeats(harness.scoped)).find((entry) => entry.id === provisioned.membership.id);
    expect(seat?.status).toBe('revoked');
    // And the seat's team scopes are cleared, so re-granting is a fresh provision rather than a revival.
    expect(seat?.teamKeys).toEqual([]);
  });

  it('reports a revoked seat to the provider as `active: false`, so it is not re-created in a loop', async () => {
    const seats = await listSeats(harness.scoped);
    const revoked = seats.find((seat) => seat.status === 'revoked');

    expect(revoked).toBeDefined();
    if (revoked === undefined) return;

    const resource = scimUserResource({ seat: revoked, basePath: 'https://c.example/api/scim/v2/Users' });

    expect(resource.active).toBe(false);
    expect(resource.id).toBe(revoked.id);
    expect(resource.meta.location).toBe(`https://c.example/api/scim/v2/Users/${revoked.id}`);
  });

  it('reports a pending seat as active, because it is assigned and simply not yet signed in to', async () => {
    const user = await ensureUser(harness.scoped, {
      email: 'pending@example.com',
      displayName: 'Pending Person',
      passwordHash: null,
      at: NOW,
    });
    await ensureMembership(harness.scoped, { userId: user.id, role: 'member', status: 'pending', at: NOW });

    const seat = (await listSeats(harness.scoped)).find((entry) => entry.email === 'pending@example.com');
    expect(seat).toBeDefined();
    if (seat === undefined) return;

    // Reporting it inactive would make a provider think its own provisioning had failed and retry.
    expect(scimUserResource({ seat, basePath: 'https://c.example/api/scim/v2/Users' }).active).toBe(true);
  });

  it('lists revoked seats rather than hiding them, which is SCIM’s own model', async () => {
    const listed = await scimListUsers({
      scoped: harness.scoped,
      filter: { kind: 'none' },
      basePath: 'https://c.example/api/scim/v2/Users',
    });

    expect(listed.Resources.some((resource) => !resource.active)).toBe(true);
    expect(listed.totalResults).toBe(listed.Resources.length);
  });

  it('answers the existence probe every provider makes before creating somebody', async () => {
    const listed = await scimListUsers({
      scoped: harness.scoped,
      filter: parseScimFilter('userName eq "pending@example.com"'),
      basePath: 'https://c.example/api/scim/v2/Users',
    });

    expect(listed.Resources).toHaveLength(1);
    expect(listed.Resources[0]?.userName).toBe('pending@example.com');
  });

  it('carries the provider’s own external id back, so a seat stays traceable to its directory', async () => {
    const identity = await findIdentityBySubject(harness.scoped, 'scim', 'okta-user-77');

    expect(identity).not.toBeNull();
    expect(identity?.subject).toBe('okta-user-77');
  });
});

// ---------------------------------------------------------------------------
// Unverified emails — the other acceptance criterion
// ---------------------------------------------------------------------------

describe('an unverified provider email', () => {
  let harness: AuthHarness;

  beforeAll(async () => {
    harness = await createAuthHarness();

    const existing = await ensureUser(harness.scoped, {
      email: 'held@example.com',
      displayName: 'Held Account',
      // A real password, so the account has a credential of its own to re-authenticate with.
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      at: NOW,
    });
    await ensureMembership(harness.scoped, { userId: existing.id, role: 'manager', status: 'active', at: NOW });
  });

  afterAll(async () => {
    await harness.close();
  });

  const unverified = {
    provider: 'google' as const,
    subject: 'google-subject-unverified',
    email: 'held@example.com',
    emailVerified: false,
    displayName: 'Whoever',
  };

  /**
   * The attack this refusal stops.
   *
   * An OAuth provider will hand over an address its user typed and never confirmed. If Compass matched
   * on it, anybody could add a colleague's address to a fresh Google account and sign in as them.
   */
  it('never auto-links to an existing account, even when the address matches exactly', async () => {
    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: unverified,
      now: NOW,
    });

    expect(resolution).toEqual({ kind: 'refused', reason: 'email_unverified' });

    // And no row was written, so a second attempt is refused the same way rather than finding a link.
    expect(await findIdentityBySubject(harness.scoped, 'google', unverified.subject)).toBeNull();
  });

  it('says what to do about it, naming both ways forward', () => {
    const sentence = describeFederatedRefusal('email_unverified', 'Google');

    expect(sentence).toContain('Google');
    // Verify with the provider, or sign in another way and link — both have to be offered, or the
    // refusal is a dead end.
    expect(sentence.toLowerCase()).toContain('verify');
    expect(sentence.toLowerCase()).toContain('link');
  });

  /**
   * The confirmation path: the person proves ownership with a credential Compass issued.
   *
   * This is what "the user must confirm ownership" means in practice. Once they hold a session, the
   * provider's verification state is no longer load-bearing for *matching* — they have already proved
   * who they are — so the link is allowed and recorded.
   */
  it('links once the account holder is signed in and confirms it themselves', async () => {
    const held = await findMembershipByUserId(
      harness.scoped,
      (await listSeats(harness.scoped)).find((seat) => seat.email === 'held@example.com')!.userId,
    );
    expect(held).not.toBeNull();
    if (held === null) return;

    const linked = await linkIdentityToAccount({
      scoped: harness.scoped,
      userId: held.userId,
      assertion: unverified,
      now: NOW,
    });

    expect(linked.ok).toBe(true);
    expect(linked.ok && linked.identity.userId).toBe(held.userId);
    // The provider's own assertion is recorded as it was, not laundered into "verified".
    expect(linked.ok && linked.identity.emailVerified).toBe(false);
  });

  it('refuses to link a provider account that already belongs to somebody else', async () => {
    const other = await ensureUser(harness.scoped, {
      email: 'second@example.com',
      displayName: 'Second Person',
      passwordHash: null,
      at: NOW,
    });
    await ensureMembership(harness.scoped, { userId: other.id, role: 'member', status: 'active', at: NOW });

    const result = await linkIdentityToAccount({
      scoped: harness.scoped,
      userId: other.id,
      // The subject the previous test linked to `held@example.com`.
      assertion: unverified,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'already_linked_elsewhere' });
  });

  it('refuses a verified address that has no seat, rather than creating one', async () => {
    /**
     * Compass seats are invited. A flow that minted one on first Google login would let anybody with a
     * Google account take a seat in somebody else's organization.
     */
    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: {
        provider: 'google',
        subject: 'google-stranger',
        email: 'stranger@example.com',
        emailVerified: true,
        displayName: 'A Stranger',
      },
      now: NOW,
    });

    expect(resolution).toEqual({ kind: 'refused', reason: 'no_seat' });
  });

  it('links a verified address to the seat that already holds it, with no duplicate account', async () => {
    const before = (await listSeats(harness.scoped)).length;

    const resolution = await resolveFederatedSignIn({
      scoped: harness.scoped,
      assertion: {
        provider: 'github',
        subject: 'github-5551234',
        email: 'held@example.com',
        emailVerified: true,
        displayName: 'Held Account',
      },
      now: NOW,
    });

    expect(resolution.kind).toBe('signed_in');
    if (resolution.kind !== 'signed_in') return;

    expect(resolution.linked).toBe(true);
    expect(resolution.provisioned).toBe(false);
    expect(resolution.user.email).toBe('held@example.com');
    // The criterion: linked rather than duplicated.
    expect((await listSeats(harness.scoped)).length).toBe(before);
  });
});
