import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId, recordTimestamps } from './columns.js';
import { organizations } from './tables.js';

/**
 * The two tables that hold an integration's credentials, and hold them encrypted.
 *
 * ## Why the tokens are not columns on `source_configs`
 *
 * `source_configs.settings` is a `jsonb` blob that gets read, logged, diffed and returned by
 * the roster endpoints. Putting an access token in it would mean the token's safety depended
 * on every future caller of that column remembering it was in there — and the first serializer
 * that spread `settings` into a response would publish it. A separate table with no read path
 * that returns plaintext is the structural version of the same rule: `/api/roster` cannot leak
 * a token because it does not select from a table that has one.
 *
 * ## What is in the columns
 *
 * Nothing readable. `wrapped_data_key` is a data key sealed under the KMS master key, and
 * `sealed_value` is a token sealed under that data key — both in `@compass/auth`'s envelope
 * layout, both AES-256-GCM, both bound by additional authenticated data to the organization
 * (and, for a token, to its source and field) so a row copied between tenants or between
 * columns fails to authenticate rather than decrypting into somebody else's credential.
 *
 * The encryption itself is not here. `@compass/db` sits *below* `@compass/auth` in the layer
 * order, so this package stores opaque strings and never holds a key: the seal and unseal
 * happen in `@compass/auth/integration-tokens`, which is the only module that can turn one of
 * these rows back into a credential. That is why the repository beside this file has no
 * `plaintext` in its vocabulary at all.
 */

/**
 * One wrapped data key per organization — the middle layer of the envelope.
 *
 * `key_version` counts data-key rotations. It is stored on the key row *and* stamped on every
 * token sealed under it, so a rotation that is interrupted halfway is a readable state ("these
 * four tokens are still at version 2") rather than a set of rows that fail to decrypt for no
 * discoverable reason.
 *
 * `master_key_version` is the other rotation, and it is separate because the two are different
 * operations with different costs: rewrapping under a new master key touches this row only,
 * while rotating the data key re-encrypts every token. Recording them apart is what lets an
 * operator answer "has the master key rotation finished" without decrypting anything.
 */
export const organizationDataKeys = pgTable(
  'organization_data_keys',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** A data key sealed under the master key. The only form it is ever stored in. */
    wrappedDataKey: text('wrapped_data_key').notNull(),
    keyVersion: integer('key_version').notNull(),
    masterKeyVersion: integer('master_key_version').notNull(),
    /** When the data key itself was last replaced, as opposed to rewrapped. */
    rotatedAt: instantColumn('rotated_at'),
    ...recordTimestamps(),
  },
  (table) => [
    // One live key per organization. A second row would mean two candidate keys and no
    // statement about which one a token was sealed with.
    unique('organization_data_keys_org_key').on(table.organizationId),
    check('organization_data_keys_version_positive', sql`${table.keyVersion} >= 1`),
    check('organization_data_keys_master_version_positive', sql`${table.masterKeyVersion} >= 1`),
  ],
);

/** The credential kinds an integration hands over. Closed, and constrained in the database. */
export const INTEGRATION_TOKEN_KINDS = ['access', 'refresh'] as const;

/**
 * One encrypted credential.
 *
 * ## `expires_at` is in the clear, and that is deliberate
 *
 * The refresh scheduler has to know when an access token dies, and decrypting every token on
 * every scheduler tick to find out would mean the master key was in memory during routine
 * work. An expiry is not a secret — it says when, not what — so it is a plain column and the
 * secret stays sealed.
 *
 * ## No `last_used_at`
 *
 * Tempting, and left out: it would be a write on every outbound API call, and the fact it
 * would record is already in `ingest_runs`, which says which sources answered and when. A
 * second, coarser copy of that fact is how the two come to disagree.
 */
export const integrationTokens = pgTable(
  'integration_tokens',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** The source this credential belongs to, as `source_configs` spells it. */
    sourceKey: text('source_key').notNull(),
    /** `access` | `refresh`. */
    tokenKind: text('token_kind').notNull(),
    /** The token, sealed under this organization's data key. Never plaintext. */
    sealedValue: text('sealed_value').notNull(),
    /** Which data-key version sealed it. Mismatch with the key row means mid-rotation. */
    keyVersion: integer('key_version').notNull(),
    /** In the clear, so the refresh scheduler need not decrypt. Null when it does not expire. */
    expiresAt: instantColumn('expires_at'),
    ...recordTimestamps(),
  },
  (table) => [
    unique('integration_tokens_org_source_kind_key').on(table.organizationId, table.sourceKey, table.tokenKind),
    index('integration_tokens_org_expiry_idx').on(table.organizationId, table.expiresAt),
    check('integration_tokens_kind', sql`${table.tokenKind} in ('access', 'refresh')`),
    check('integration_tokens_version_positive', sql`${table.keyVersion} >= 1`),
    // A sealed value always carries the scheme prefix the envelope writes. A row holding a
    // bare token — pasted in by hand, written by a path that forgot to seal — is refused by
    // the database rather than stored and later read back as a working credential.
    check('integration_tokens_sealed', sql`${table.sealedValue} like 'v1:aes-256-gcm.%'`),
  ],
);
