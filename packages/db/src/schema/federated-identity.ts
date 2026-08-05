import { boolean, index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { membershipRole, organizations, users } from './tables.js';

/**
 * Identities somebody else vouches for: OAuth SSO, SAML, and SCIM's view of a seat.
 *
 * ## Why one table for four providers rather than four tables
 *
 * The *rules* are identical — a provider names a subject, Compass matches it to a local user, and the
 * pair is unique forever — and the differences are all in the handshake, which lives in
 * `@compass/auth` where it can be tested without a database. Four tables would be four chances to
 * implement "one identity per provider per person" slightly differently, and the linking bug that
 * matters is the one where two rows claim the same person.
 *
 * ## `subject` is the provider's own stable id, never the email
 *
 * This is the load-bearing column and the reason the table exists at all. An email address is
 * **mutable and reassignable**: a colleague changes their surname, or leaves and their address is
 * given to somebody new. Keying a federated identity on the address means the second person inherits
 * the first person's Compass account. So the key is the provider's immutable subject — Google's `sub`,
 * GitHub's numeric `id`, the SAML `NameID` — and the email is stored beside it as a *fact asserted at
 * link time*, used for the first match and never as the identity afterwards.
 *
 * ## `email_verified` is stored, not assumed
 *
 * Recorded as the provider asserted it, because the linking rule turns on it: an unverified provider
 * email is never auto-linked to an existing account. Storing the assertion means the decision is
 * auditable after the fact rather than being a branch that ran once and left no trace.
 */

/**
 * Where an identity came from.
 *
 * `scim` is in the same enum as the three sign-in providers, which is worth stating: a SCIM record is
 * not a way to sign in, it is the IdP's *directory* assertion about who should hold a seat. Keeping it
 * here rather than in a table of its own is what makes deprovisioning traceable — the row that says
 * "Okta created this seat" is the row that says "Okta removed it".
 */
export const identityProvider = pgEnum('identity_provider', ['google', 'github', 'saml', 'scim']);

export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: identityProvider('provider').notNull(),
    /** The provider's immutable id for this person. See the header: never the email. */
    subject: text('subject').notNull(),
    /** The address the provider asserted at link time, normalised. A fact, not the key. */
    email: text('email').notNull(),
    /** As the provider asserted it. False forbids auto-linking to an existing account. */
    emailVerified: boolean('email_verified').notNull(),
    linkedAt: instantColumn('linked_at').notNull(),
    /** Null until this identity has actually been used to sign in. */
    lastSignInAt: instantColumn('last_sign_in_at'),
    ...recordTimestamps(),
  },
  (table) => [
    /**
     * One local user per (provider, subject). The anti-duplication guarantee, in the database.
     *
     * A read-then-insert in a handler would let two concurrent first sign-ins from the same Google
     * account both create a user — which is exactly the duplicate account the acceptance criterion
     * forbids, and the race is easy to hit because a person who clicks the button twice produces it.
     */
    uniqueIndex('user_identities_org_provider_subject_key').on(
      table.organizationId,
      table.provider,
      table.subject,
    ),
    /**
     * And one identity per provider per person, from the other direction.
     *
     * Without this, one Compass account could accumulate two Google identities, and "sign out of
     * everything and unlink Google" would leave a second Google door open that no screen listed.
     */
    uniqueIndex('user_identities_org_provider_user_key').on(
      table.organizationId,
      table.provider,
      table.userId,
    ),
    index('user_identities_org_user_idx').on(table.organizationId, table.userId),
  ],
);

/**
 * The IdP an organization federates to, and the certificate its assertions are checked against.
 *
 * One row per organization. A second IdP is a real requirement for some buyers and deliberately not
 * modelled: with two, every assertion has to be tried against both certificates, and "which IdP
 * signed this" becomes a guess made by trial decryption. One row keeps the verification path a single
 * lookup by issuer, and a deployment that needs two can add a `saml_connections` row per issuer
 * without changing anything above it — the unique index below is the only thing that would move.
 *
 * ## `certificate` is a public key, so it is stored in the clear
 *
 * Unlike an OAuth token there is nothing to protect: it is the IdP's *public* signing certificate,
 * published in their metadata. Envelope-encrypting it would suggest to a reader that it were a
 * secret and would make sign-in depend on the KMS being reachable, for no gain.
 */
export const samlConnections = pgTable(
  'saml_connections',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** The IdP's `EntityID`. Every assertion's `Issuer` must equal this exactly. */
    idpEntityId: text('idp_entity_id').notNull(),
    /** Where a person is sent to sign in. */
    idpSsoUrl: text('idp_sso_url').notNull(),
    /** Base64 DER (an X.509 certificate as it appears in IdP metadata, no PEM armour). */
    idpCertificate: text('idp_certificate').notNull(),
    /**
     * The role a seat created by SAML or SCIM gets.
     *
     * Never `owner`. An IdP that could mint owners would mean anybody who can add a user to a
     * directory group can take over the Compass organization, which is a privilege escalation
     * dressed as provisioning. The check constraint in the migration enforces it, so no handler and
     * no future importer can widen it.
     */
    defaultRole: membershipRole('default_role').notNull(),
    /** Null while enabled. Set rather than deleting the row, so the certificate stays auditable. */
    disabledAt: instantColumn('disabled_at'),
    ...recordTimestamps(),
  },
  (table) => [uniqueIndex('saml_connections_org_key').on(table.organizationId)],
);

/**
 * Every assertion id Compass has already accepted. The replay guarantee, as rows.
 *
 * ## Why this is a table and not a cache
 *
 * A SAML assertion is a bearer credential valid for its whole `NotOnOrAfter` window — minutes,
 * typically. Anyone who captures one (a proxy log, a browser history, a shared terminal) can post it
 * again inside that window and be signed in as its subject. The only defence is remembering which
 * ids have been spent, and "remembering" has to survive a deploy and be shared between the web and
 * worker processes, so it is a row.
 *
 * **The unique index is the whole mechanism.** Acceptance is an INSERT: if it succeeds this is the
 * first presentation, and if it violates the constraint it is a replay. That is what makes the
 * guarantee hold under concurrency — two simultaneous posts of the same assertion both pass any
 * SELECT-then-INSERT check, and exactly one wins an INSERT.
 *
 * `not_on_or_after` is kept so the ledger can be pruned: an id whose window has closed is refused by
 * the freshness check anyway, so its row has no further work to do.
 */
export const samlAssertionReplays = pgTable(
  'saml_assertion_replays',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** The assertion's own `ID` attribute. */
    assertionId: text('assertion_id').notNull(),
    issuer: text('issuer').notNull(),
    acceptedAt: instantColumn('accepted_at').notNull(),
    /** The end of the assertion's validity window, so a spent row can be pruned once closed. */
    notOnOrAfter: instantColumn('not_on_or_after').notNull(),
    ...recordTimestamps(),
  },
  (table) => [
    // See the header: this index *is* the replay defence, not an optimisation of it.
    uniqueIndex('saml_assertion_replays_org_assertion_key').on(table.organizationId, table.assertionId),
    index('saml_assertion_replays_org_expiry_idx').on(table.organizationId, table.notOnOrAfter),
  ],
);

/**
 * The bearer token an IdP's SCIM client authenticates with.
 *
 * Only the digest is stored, exactly as `sessions.token_hash` and `auth_tokens.token_hash` are: the
 * token is shown once when it is issued and a stolen backup must not yield a working provisioning
 * credential. A SCIM token is a high-value one — it can create and remove seats — so the same rule
 * applies with more force, not less.
 *
 * `revoked_at` rather than a delete, so "this token was used to remove a seat last March" stays
 * answerable after the token is rotated.
 */
export const scimCredentials = pgTable(
  'scim_credentials',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** SHA-256 of the bearer token, hex. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** What the operator called it, so a rotation can name which one is being replaced. */
    label: text('label').notNull(),
    issuedAt: instantColumn('issued_at').notNull(),
    lastUsedAt: instantColumn('last_used_at'),
    revokedAt: instantColumn('revoked_at'),
    ...recordTimestamps(),
  },
  (table) => [
    uniqueIndex('scim_credentials_org_token_key').on(table.organizationId, table.tokenHash),
    index('scim_credentials_org_revoked_idx').on(table.organizationId, table.revokedAt),
  ],
);

/** True when this SAML connection is in force. Read this rather than the row's presence. */
export const samlConnectionIsEnabled = (row: { readonly disabledAt: unknown }): boolean =>
  row.disabledAt === null || row.disabledAt === undefined;
