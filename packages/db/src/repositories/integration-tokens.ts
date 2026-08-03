import { and, eq } from 'drizzle-orm';

import { deterministicUuid } from '../entity-id.js';
import { fromNullableDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { integrationTokens, organizationDataKeys } from '../schema/security.js';
import type { ScopedDb } from '../scoped-db.js';

import type { Instant } from '@compass/clock';

/**
 * Reads and writes for the two encrypted-credential tables.
 *
 * ## This module has no idea what a token is
 *
 * Every value that crosses this boundary is a sealed string. There is no key parameter, no
 * cipher, no `plaintext` in the vocabulary — `@compass/db` sits below `@compass/auth` in the
 * layer order, so it *cannot* import the envelope even if a future change wanted to, and the
 * seal and unseal happen one layer up in `@compass/auth/integration-tokens`.
 *
 * That is not layering pedantry. It is what makes "no API response contains a token" a
 * structural fact rather than a discipline: the functions below return `sealedValue`, so a
 * route that spread a row into a response would publish ciphertext bound to an organization
 * that route cannot decrypt. The failure mode of forgetting is an unreadable string, not a
 * working credential.
 */

export type IntegrationTokenKind = 'access' | 'refresh';

export interface StoredDataKey {
  readonly id: string;
  readonly wrappedDataKey: string;
  readonly keyVersion: number;
  readonly masterKeyVersion: number;
  readonly rotatedAt: Instant | null;
}

export interface StoredIntegrationToken {
  readonly id: string;
  readonly sourceKey: string;
  readonly tokenKind: IntegrationTokenKind;
  /** Ciphertext in the envelope layout. Never a credential until `@compass/auth` opens it. */
  readonly sealedValue: string;
  readonly keyVersion: number;
  readonly expiresAt: Instant | null;
}

/** Deterministic ids, so a re-store is an update of one row rather than a second row. */
export const dataKeyRowId = (organizationId: string): string =>
  deterministicUuid(`organization-data-key:${organizationId}`);

export const integrationTokenRowId = (
  organizationId: string,
  sourceKey: string,
  tokenKind: IntegrationTokenKind,
): string => deterministicUuid(`integration-token:${organizationId}:${sourceKey}:${tokenKind}`);

export async function findDataKey(scoped: ScopedDb): Promise<StoredDataKey | null> {
  const rows = await scoped.selectFrom(organizationDataKeys).limit(1);
  const row = rows[0];
  if (row === undefined) return null;

  return {
    id: row.id,
    wrappedDataKey: row.wrappedDataKey,
    keyVersion: row.keyVersion,
    masterKeyVersion: row.masterKeyVersion,
    rotatedAt: fromNullableDatabaseInstant(row.rotatedAt),
  };
}

export interface DataKeyInput {
  readonly wrappedDataKey: string;
  readonly keyVersion: number;
  readonly masterKeyVersion: number;
  /** Set when the data key itself changed, as opposed to being rewrapped. */
  readonly rotatedAt?: Instant | null;
}

/**
 * Writes the organization's wrapped data key, replacing whatever was there.
 *
 * An upsert on the organization's unique constraint rather than an insert, because both
 * rotations end here: rewrapping under a new master key and replacing the data key outright
 * both produce "this is the wrapped key now". Two code paths writing one row through one
 * function is what keeps them from disagreeing about `key_version`.
 */
export async function saveDataKey(scoped: ScopedDb, input: DataKeyInput, now: Instant): Promise<StoredDataKey> {
  const id = dataKeyRowId(scoped.organizationId);
  const at = toDatabaseInstant(now);
  const rotatedAt = input.rotatedAt === undefined || input.rotatedAt === null ? null : toDatabaseInstant(input.rotatedAt);

  await scoped
    .insertInto(organizationDataKeys, {
      id,
      wrappedDataKey: input.wrappedDataKey,
      keyVersion: input.keyVersion,
      masterKeyVersion: input.masterKeyVersion,
      rotatedAt,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [organizationDataKeys.organizationId],
      set: {
        wrappedDataKey: input.wrappedDataKey,
        keyVersion: input.keyVersion,
        masterKeyVersion: input.masterKeyVersion,
        rotatedAt,
        updatedAt: at,
      },
    })
    .execute();

  const saved = await findDataKey(scoped);
  if (saved === null) {
    throw new Error('The data key was written but could not be read back, so its state is unknown.');
  }
  return saved;
}

export async function findIntegrationToken(
  scoped: ScopedDb,
  sourceKey: string,
  tokenKind: IntegrationTokenKind,
): Promise<StoredIntegrationToken | null> {
  const predicate = and(eq(integrationTokens.sourceKey, sourceKey), eq(integrationTokens.tokenKind, tokenKind));
  const rows = await scoped.selectFrom(integrationTokens, predicate).limit(1);
  const row = rows[0];
  return row === undefined ? null : toStoredToken(row);
}

export const listIntegrationTokens = async (scoped: ScopedDb): Promise<readonly StoredIntegrationToken[]> => {
  const rows = await scoped.selectFrom(integrationTokens).orderBy(integrationTokens.sourceKey);
  return rows.map(toStoredToken);
};

export interface IntegrationTokenInput {
  readonly sourceKey: string;
  readonly tokenKind: IntegrationTokenKind;
  readonly sealedValue: string;
  readonly keyVersion: number;
  readonly expiresAt?: Instant | null;
}

/**
 * Stores one sealed credential, replacing the previous one for that (source, kind).
 *
 * Replacing rather than appending, and this is the one table in Compass where that is the
 * right shape: a superseded refresh token is not history, it is a live credential somebody
 * else could use. Everything append-only in this schema exists so a *claim* stays checkable;
 * keeping a rotated token would only mean the blast radius of a dump included every
 * credential the organization had ever held.
 */
export async function saveIntegrationToken(
  scoped: ScopedDb,
  input: IntegrationTokenInput,
  now: Instant,
): Promise<StoredIntegrationToken> {
  const at = toDatabaseInstant(now);
  const expiresAt =
    input.expiresAt === undefined || input.expiresAt === null ? null : toDatabaseInstant(input.expiresAt);

  await scoped
    .insertInto(integrationTokens, {
      id: integrationTokenRowId(scoped.organizationId, input.sourceKey, input.tokenKind),
      sourceKey: input.sourceKey,
      tokenKind: input.tokenKind,
      sealedValue: input.sealedValue,
      keyVersion: input.keyVersion,
      expiresAt,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [integrationTokens.organizationId, integrationTokens.sourceKey, integrationTokens.tokenKind],
      set: { sealedValue: input.sealedValue, keyVersion: input.keyVersion, expiresAt, updatedAt: at },
    })
    .execute();

  const saved = await findIntegrationToken(scoped, input.sourceKey, input.tokenKind);
  if (saved === null) {
    throw new Error('The integration token was written but could not be read back, so its state is unknown.');
  }
  return saved;
}

/** Forgets a credential entirely — what a disconnected integration leaves behind. */
export async function deleteIntegrationToken(
  scoped: ScopedDb,
  sourceKey: string,
  tokenKind: IntegrationTokenKind,
): Promise<void> {
  await scoped
    .deleteFrom(
      integrationTokens,
      and(eq(integrationTokens.sourceKey, sourceKey), eq(integrationTokens.tokenKind, tokenKind)),
    )
    .execute();
}

const toStoredToken = (row: typeof integrationTokens.$inferSelect): StoredIntegrationToken => ({
  id: row.id,
  sourceKey: row.sourceKey,
  tokenKind: row.tokenKind as IntegrationTokenKind,
  sealedValue: row.sealedValue,
  keyVersion: row.keyVersion,
  expiresAt: fromNullableDatabaseInstant(row.expiresAt),
});
