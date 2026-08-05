import type { Instant } from '@compass/clock';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';

import { deterministicUuid } from '../entity-id.js';
import { fromDatabaseInstant, fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import {
  samlAssertionReplays,
  samlConnections,
  scimCredentials,
  userIdentities,
} from '../schema/federated-identity.js';
import type { MembershipRole } from './auth.js';
import { normalizeEmail } from './auth.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Reading and writing federated identity: SSO links, the SAML connection, the replay ledger, SCIM
 * tokens.
 *
 * Two operations here carry a guarantee that cannot live in a handler, and both are written so the
 * database decides rather than the caller:
 *
 *  - **`claimAssertionId`** is an INSERT against a unique index, and its boolean return *is* the
 *    replay verdict. A `SELECT` then `INSERT` would let two simultaneous posts of the same assertion
 *    both pass the check and both be signed in.
 *  - **`linkIdentity`** inserts against `(provider, subject)` uniqueness and reports whether it was
 *    the call that created the row, so a double-clicked sign-in button cannot produce two accounts.
 *
 * This file holds no policy. Whether an unverified email may auto-link is `resolveSsoSignIn` in
 * `@compass/auth`; whether an assertion's signature is good is `verifySamlAssertion`. A repository
 * that decided either would put the rule in the one layer that cannot be tested without a database.
 */

// ---------------------------------------------------------------------------
// Row ids
// ---------------------------------------------------------------------------

export type IdentityProvider = 'google' | 'github' | 'saml' | 'scim';

/**
 * Derived from `(organization, provider, subject)`, so a replayed link lands on the row it already
 * wrote rather than on a duplicate-key error the caller has to interpret.
 */
export const userIdentityRowId = (
  organizationId: string,
  provider: IdentityProvider,
  subject: string,
): string => deterministicUuid(`user-identity:${organizationId}:${provider}:${subject}`);

export const samlConnectionRowId = (organizationId: string): string =>
  deterministicUuid(`saml-connection:${organizationId}`);

export const samlAssertionReplayRowId = (organizationId: string, assertionId: string): string =>
  deterministicUuid(`saml-assertion:${organizationId}:${assertionId}`);

export const scimCredentialRowId = (organizationId: string, tokenHash: string): string =>
  deterministicUuid(`scim-credential:${organizationId}:${tokenHash}`);

// ---------------------------------------------------------------------------
// Federated identities
// ---------------------------------------------------------------------------

export interface StoredUserIdentity {
  readonly id: string;
  readonly userId: string;
  readonly provider: IdentityProvider;
  /** The provider's immutable id for this person. Never the email. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly linkedAt: Instant;
  readonly lastSignInAt: Instant | null;
}

const toStoredIdentity = (row: typeof userIdentities.$inferSelect): StoredUserIdentity => ({
  id: row.id,
  userId: row.userId,
  provider: row.provider,
  subject: row.subject,
  email: row.email,
  emailVerified: row.emailVerified,
  linkedAt: fromDatabaseInstant(row.linkedAt),
  lastSignInAt: fromNullableDatabaseInstant(row.lastSignInAt),
});

/** The identity this provider's subject maps to, or null when nobody has linked it. */
export async function findIdentityBySubject(
  scoped: ScopedDb,
  provider: IdentityProvider,
  subject: string,
): Promise<StoredUserIdentity | null> {
  const rows = await scoped
    .selectFrom(
      userIdentities,
      and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)),
    )
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toStoredIdentity(row);
}

/** This user's identity with one provider, or null. */
export async function findIdentityForUser(
  scoped: ScopedDb,
  provider: IdentityProvider,
  userId: string,
): Promise<StoredUserIdentity | null> {
  const rows = await scoped
    .selectFrom(userIdentities, and(eq(userIdentities.provider, provider), eq(userIdentities.userId, userId)))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toStoredIdentity(row);
}

/** Every identity linked to this account, for the screen that lists them and offers to unlink. */
export async function listIdentitiesForUser(
  scoped: ScopedDb,
  userId: string,
): Promise<readonly StoredUserIdentity[]> {
  const rows = await scoped
    .selectFrom(userIdentities, eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.provider));

  return rows.map(toStoredIdentity);
}

export interface LinkIdentityInput {
  readonly userId: string;
  readonly provider: IdentityProvider;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

/**
 * Links a provider identity to a local account.
 *
 * `ON CONFLICT (organization_id, provider, subject) DO UPDATE` refreshes the asserted email and
 * verification state — both are facts about the provider's current belief and do move — while leaving
 * `user_id` alone. **That last part is the security-relevant half:** if a conflicting link could
 * repoint `user_id`, then anybody who could make a provider assert an existing subject could take over
 * whichever account they liked. A subject belongs to the account it was first linked to, permanently.
 */
export async function linkIdentity(
  scoped: ScopedDb,
  input: LinkIdentityInput,
  now: Instant,
): Promise<StoredUserIdentity> {
  const at = toDatabaseInstant(now);
  const email = normalizeEmail(input.email);

  await scoped
    .insertInto(userIdentities, {
      id: userIdentityRowId(scoped.organizationId, input.provider, input.subject),
      userId: input.userId,
      provider: input.provider,
      subject: input.subject,
      email,
      emailVerified: input.emailVerified,
      linkedAt: at,
      lastSignInAt: null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [userIdentities.organizationId, userIdentities.provider, userIdentities.subject],
      // `userId` is deliberately absent. See the doc comment: a subject keeps the account it was
      // first linked to, or the provider becomes an account-takeover primitive.
      set: { email, emailVerified: input.emailVerified, updatedAt: at },
    })
    .execute();

  const stored = await findIdentityBySubject(scoped, input.provider, input.subject);
  if (stored === null) {
    throw new Error(
      `Linking ${input.provider} identity for user ${input.userId} wrote no row. This should be unreachable.`,
    );
  }
  return stored;
}

/** Records that this identity was just used to sign in, for the account screen to show. */
export async function touchIdentitySignIn(
  scoped: ScopedDb,
  identityId: string,
  now: Instant,
): Promise<void> {
  const at = toDatabaseInstant(now);
  await scoped
    .updateIn(userIdentities, { lastSignInAt: at, updatedAt: at }, eq(userIdentities.id, identityId))
    .execute();
}

/**
 * Removes one provider link, and answers whether there was one to remove.
 *
 * A delete rather than a soft delete: an identity row *is* a way into the account, so "unlinked" has
 * to mean the row is gone. The audit record is written by the caller, which is the layer that knows
 * who asked.
 */
export async function unlinkIdentity(
  scoped: ScopedDb,
  input: { readonly userId: string; readonly provider: IdentityProvider },
): Promise<boolean> {
  const removed = await scoped
    .deleteFrom(
      userIdentities,
      and(eq(userIdentities.userId, input.userId), eq(userIdentities.provider, input.provider)),
    )
    .returning({ id: userIdentities.id });

  return removed.length > 0;
}

// ---------------------------------------------------------------------------
// The SAML connection
// ---------------------------------------------------------------------------

export interface StoredSamlConnection {
  readonly id: string;
  readonly idpEntityId: string;
  readonly idpSsoUrl: string;
  /** Base64 DER, as it appears in IdP metadata. A public key: see the schema for why it is not sealed. */
  readonly idpCertificate: string;
  readonly defaultRole: MembershipRole;
  readonly disabledAt: Instant | null;
}

const toStoredConnection = (row: typeof samlConnections.$inferSelect): StoredSamlConnection => ({
  id: row.id,
  idpEntityId: row.idpEntityId,
  idpSsoUrl: row.idpSsoUrl,
  idpCertificate: row.idpCertificate,
  defaultRole: row.defaultRole,
  disabledAt: fromNullableDatabaseInstant(row.disabledAt),
});

export async function findSamlConnection(scoped: ScopedDb): Promise<StoredSamlConnection | null> {
  const rows = await scoped.selectFrom(samlConnections).limit(1);
  const row = rows[0];
  return row === undefined ? null : toStoredConnection(row);
}

export interface SamlConnectionInput {
  readonly idpEntityId: string;
  readonly idpSsoUrl: string;
  readonly idpCertificate: string;
  readonly defaultRole: MembershipRole;
}

/** Creates or replaces the organization's IdP configuration. */
export async function saveSamlConnection(
  scoped: ScopedDb,
  input: SamlConnectionInput,
  now: Instant,
): Promise<StoredSamlConnection> {
  const at = toDatabaseInstant(now);

  await scoped
    .insertInto(samlConnections, {
      id: samlConnectionRowId(scoped.organizationId),
      idpEntityId: input.idpEntityId,
      idpSsoUrl: input.idpSsoUrl,
      idpCertificate: input.idpCertificate,
      defaultRole: input.defaultRole,
      // Saving a configuration enables it. An operator who wanted it off would disable it, and
      // carrying a previous `disabled_at` forward would mean a re-save silently did nothing.
      disabledAt: null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: samlConnections.organizationId,
      set: {
        idpEntityId: input.idpEntityId,
        idpSsoUrl: input.idpSsoUrl,
        idpCertificate: input.idpCertificate,
        defaultRole: input.defaultRole,
        disabledAt: null,
        updatedAt: at,
      },
    })
    .execute();

  const stored = await findSamlConnection(scoped);
  if (stored === null) throw new Error('Saving the SAML connection wrote no row.');
  return stored;
}

/** Turns SAML off without forgetting which certificate was trusted. */
export async function disableSamlConnection(scoped: ScopedDb, now: Instant): Promise<boolean> {
  const at = toDatabaseInstant(now);
  const changed = await scoped
    .updateIn(samlConnections, { disabledAt: at, updatedAt: at }, isNull(samlConnections.disabledAt))
    .returning({ id: samlConnections.id });

  return changed.length > 0;
}

// ---------------------------------------------------------------------------
// The replay ledger
// ---------------------------------------------------------------------------

/**
 * Claims an assertion id, and answers whether this call was the one that claimed it.
 *
 * `false` means the id was already spent — a replay. This is an INSERT against
 * `saml_assertion_replays_org_assertion_key` with `ON CONFLICT DO NOTHING`, and the emptiness of the
 * `RETURNING` is the verdict. A `SELECT`-then-`INSERT` would let two simultaneous posts of the same
 * captured assertion both pass the check and both mint a session, which is precisely the attack the
 * ledger exists to stop.
 */
export async function claimAssertionId(
  scoped: ScopedDb,
  input: {
    readonly assertionId: string;
    readonly issuer: string;
    /** The end of the assertion's validity window, so the row can be pruned once it closes. */
    readonly notOnOrAfter: Instant;
  },
  now: Instant,
): Promise<boolean> {
  const at = toDatabaseInstant(now);

  const claimed = await scoped
    .insertInto(samlAssertionReplays, {
      id: samlAssertionReplayRowId(scoped.organizationId, input.assertionId),
      assertionId: input.assertionId,
      issuer: input.issuer,
      acceptedAt: at,
      notOnOrAfter: toDatabaseInstant(input.notOnOrAfter),
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: samlAssertionReplays.id });

  return claimed.length > 0;
}

/**
 * Drops ledger rows whose assertion window has closed.
 *
 * Safe because an assertion past `NotOnOrAfter` is refused by the freshness check whether or not its
 * row is present, so the row has no remaining work to do. Without this the table grows once per
 * sign-in forever.
 */
export async function pruneAssertionReplays(scoped: ScopedDb, before: Instant): Promise<number> {
  const removed = await scoped
    .deleteFrom(samlAssertionReplays, lt(samlAssertionReplays.notOnOrAfter, toDatabaseInstant(before)))
    .returning({ id: samlAssertionReplays.id });

  return removed.length;
}

// ---------------------------------------------------------------------------
// SCIM credentials
// ---------------------------------------------------------------------------

export interface StoredScimCredential {
  readonly id: string;
  readonly label: string;
  readonly issuedAt: Instant;
  readonly lastUsedAt: Instant | null;
  readonly revokedAt: Instant | null;
}

/**
 * The stored credential, without its digest.
 *
 * `tokenHash` is deliberately absent from the public shape. It is not a secret in the way the token
 * is, but nothing above this layer has any use for it — the only question anybody asks is "does this
 * presented token match a live row", which `findLiveScimCredential` answers — and a hash in a view
 * model is a hash that ends up in a response body.
 */
const toStoredCredential = (row: typeof scimCredentials.$inferSelect): StoredScimCredential => ({
  id: row.id,
  label: row.label,
  issuedAt: fromDatabaseInstant(row.issuedAt),
  lastUsedAt: fromNullableDatabaseInstant(row.lastUsedAt),
  revokedAt: fromNullableDatabaseInstant(row.revokedAt),
});

/**
 * The live credential matching this digest, or null.
 *
 * Looked up *by digest* so the raw token never appears in a query — the same rule sessions and mailed
 * tokens follow. `revoked_at IS NULL` is in the predicate rather than checked afterwards, so a revoked
 * token is indistinguishable from an unknown one to every caller.
 */
export async function findLiveScimCredential(
  scoped: ScopedDb,
  tokenHash: string,
): Promise<StoredScimCredential | null> {
  const rows = await scoped
    .selectFrom(
      scimCredentials,
      and(eq(scimCredentials.tokenHash, tokenHash), isNull(scimCredentials.revokedAt)),
    )
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toStoredCredential(row);
}

export async function listScimCredentials(scoped: ScopedDb): Promise<readonly StoredScimCredential[]> {
  const rows = await scoped.selectFrom(scimCredentials).orderBy(asc(scimCredentials.issuedAt));
  return rows.map(toStoredCredential);
}

/** Stores a new provisioning credential. Only the digest is written; the token is shown once. */
export async function insertScimCredential(
  scoped: ScopedDb,
  input: { readonly tokenHash: string; readonly label: string },
  now: Instant,
): Promise<StoredScimCredential> {
  const at = toDatabaseInstant(now);

  await scoped
    .insertInto(scimCredentials, {
      id: scimCredentialRowId(scoped.organizationId, input.tokenHash),
      tokenHash: input.tokenHash,
      label: input.label,
      issuedAt: at,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .execute();

  const stored = await findLiveScimCredential(scoped, input.tokenHash);
  if (stored === null) throw new Error('Storing the SCIM credential wrote no row.');
  return stored;
}

export async function touchScimCredential(
  scoped: ScopedDb,
  credentialId: string,
  now: Instant,
): Promise<void> {
  const at = toDatabaseInstant(now);
  await scoped
    .updateIn(scimCredentials, { lastUsedAt: at, updatedAt: at }, eq(scimCredentials.id, credentialId))
    .execute();
}

/** Revokes one credential, and answers whether it was live until now. */
export async function revokeScimCredential(
  scoped: ScopedDb,
  credentialId: string,
  now: Instant,
): Promise<boolean> {
  const at = toDatabaseInstant(now);
  const revoked = await scoped
    .updateIn(
      scimCredentials,
      { revokedAt: at, updatedAt: at },
      and(eq(scimCredentials.id, credentialId), isNull(scimCredentials.revokedAt)),
    )
    .returning({ id: scimCredentials.id });

  return revoked.length > 0;
}
