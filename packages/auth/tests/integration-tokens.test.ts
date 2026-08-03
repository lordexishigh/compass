import { randomBytes } from 'node:crypto';

import {
  DATA_KEY_BYTES,
  ENVELOPE_SCHEME,
  EnvelopeDecryptionError,
  MASTER_KEY_ENV_VAR,
  MasterKeyUnavailableError,
  describeIntegrationTokens,
  generateDataKey,
  resolveMasterKey,
  rewrapDataKey,
  rewrapOrganizationDataKey,
  rotateOrganizationDataKey,
  seal,
  storeIntegrationToken,
  unseal,
  unwrapDataKey,
  useIntegrationToken,
  wrapDataKey,
} from '@compass/auth';
import { instantFromIso } from '@compass/clock';
import { findDataKey, findIntegrationToken } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Encrypted token storage, against the real engine.
 *
 * The acceptance criterion that shapes this file is "a test asserts the raw column value is not the
 * plaintext token", and it is asserted the only way that means anything: by reading the column with
 * SQL that knows nothing about the application, rather than by reading it back through the function
 * that would decrypt it.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const NOW = instantFromIso('2026-08-03T09:00:00Z');
const LATER = instantFromIso('2026-08-03T10:00:00Z');

/** A credential that looks like the real thing, so a substring search for it is meaningful. */
const GITHUB_TOKEN = 'ghp_9tKq2mXn4bZr7wLpV3sHdY8cA1eF6gJ0uT5i';
const REFRESH_TOKEN = 'ghr_R8xW2vN5bQ7mK1tZ9pL4jH6dS3fY0aC8eU';

let database: TestDatabase;
const originalMasterKey = process.env[MASTER_KEY_ENV_VAR];
const MASTER_KEY = randomBytes(DATA_KEY_BYTES).toString('base64');

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORG_A,
    name: 'Acme Platform',
    slug: 'acme-platform',
    timezone: 'Europe/London',
    at: new Date(Date.parse('2026-07-01T00:00:00Z')),
  });
  await database.seedOrganization({
    organizationId: ORG_B,
    name: 'Beta Robotics',
    slug: 'beta-robotics',
    timezone: 'Europe/London',
    at: new Date(Date.parse('2026-07-01T00:00:00Z')),
  });
  process.env[MASTER_KEY_ENV_VAR] = MASTER_KEY;
});

afterAll(async () => {
  if (originalMasterKey === undefined) delete process.env[MASTER_KEY_ENV_VAR];
  else process.env[MASTER_KEY_ENV_VAR] = originalMasterKey;
  await database.close();
});

afterEach(async () => {
  await database.client.query('delete from integration_tokens');
  await database.client.query('delete from organization_data_keys');
  process.env[MASTER_KEY_ENV_VAR] = MASTER_KEY;
});

/** The column as the database holds it, read without the application's help. */
async function rawSealedValue(sourceKey: string, tokenKind: string): Promise<string> {
  const rows = await database.client.query<{ sealed_value: string }>(
    'select sealed_value from integration_tokens where source_key = $1 and token_kind = $2',
    [sourceKey, tokenKind],
  );
  const value = rows.rows[0]?.sealed_value;
  if (value === undefined) throw new Error('no such token row');
  return value;
}

describe('the raw column is not the token', () => {
  it('stores ciphertext, and the plaintext appears nowhere in the row', async () => {
    const scoped = database.scopedFor(ORG_A);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);

    const raw = await rawSealedValue('primary-code', 'access');

    expect(raw).not.toBe(GITHUB_TOKEN);
    expect(raw).not.toContain(GITHUB_TOKEN);
    // Not even a prefix of it: `ghp_` is the provider tell, and a partial leak is a leak.
    expect(raw).not.toContain('ghp_');
    expect(raw.startsWith(`${ENVELOPE_SCHEME}.`)).toBe(true);
  });

  it('leaves the plaintext nowhere in the whole database, in any table', async () => {
    // The stronger form of the same claim: a token that leaked into an audit row, a settings blob
    // or a log table would satisfy the assertion above and still be a disclosure.
    const scoped = database.scopedFor(ORG_A);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'refresh', token: REFRESH_TOKEN }, NOW);

    const tables = await database.client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );

    const found: string[] = [];
    for (const { table_name: tableName } of tables.rows) {
      const textColumns = await database.client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1
            and data_type in ('text', 'character varying', 'jsonb', 'json')`,
        [tableName],
      );
      for (const { column_name: column } of textColumns.rows) {
        const hits = await database.client.query<{ count: string }>(
          `select count(*)::text as count from "${tableName}" where "${column}"::text like $1 or "${column}"::text like $2`,
          [`%${GITHUB_TOKEN}%`, `%${REFRESH_TOKEN}%`],
        );
        if (Number.parseInt(hits.rows[0]?.count ?? '0', 10) > 0) found.push(`${tableName}.${column}`);
      }
    }

    expect(found, 'these columns hold a token in the clear').toEqual([]);
  });

  it('produces a different ciphertext each time, so a repeat is not recognisable', async () => {
    // A deterministic ciphertext would let anyone with read access tell that two organizations hold
    // the *same* credential, or that a "rotated" token is the old one again.
    const scoped = database.scopedFor(ORG_A);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    const first = await rawSealedValue('primary-code', 'access');

    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, LATER);
    const second = await rawSealedValue('primary-code', 'access');

    expect(second).not.toBe(first);
    expect(await useIntegrationToken(scoped, 'primary-code', 'access')).toBe(GITHUB_TOKEN);
  });

  it('round-trips the exact bytes, so an integration is not quietly broken by the encryption', async () => {
    const scoped = database.scopedFor(ORG_A);
    for (const token of [GITHUB_TOKEN, 'a', 'with spaces and — an em dash', '{"nested":"json"}', '🔑 emoji']) {
      await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token }, NOW);
      expect(await useIntegrationToken(scoped, 'primary-code', 'access')).toBe(token);
    }
  });

  it('refuses to store an empty credential', async () => {
    const scoped = database.scopedFor(ORG_A);

    await expect(
      storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: '   ' }, NOW),
    ).rejects.toThrow(TypeError);
  });

  it('refuses a bare token written straight into the column, in the database itself', async () => {
    // The one guarantee here that survives a script, a migration or a 2am psql session.
    await expect(
      database.client.query(
        `insert into integration_tokens
           (id, organization_id, source_key, token_kind, sealed_value, key_version, created_at, updated_at)
         values ($1, $2, 'primary-code', 'access', $3, 1, now(), now())`,
        ['33333333-3333-4333-8333-333333333333', ORG_A, GITHUB_TOKEN],
      ),
    ).rejects.toThrow(/integration_tokens_sealed/);
  });
});

describe('the per-organization data key', () => {
  it('is minted on first use and wrapped, never stored bare', async () => {
    const scoped = database.scopedFor(ORG_A);
    expect(await findDataKey(scoped)).toBeNull();

    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);

    const record = await findDataKey(scoped);
    expect(record).not.toBeNull();
    expect(record?.keyVersion).toBe(1);
    expect(record?.masterKeyVersion).toBe(1);
    expect(record?.wrappedDataKey.startsWith(`${ENVELOPE_SCHEME}.`)).toBe(true);

    // The wrapped form does not contain the key material, and only opens under the master key.
    const master = resolveMasterKey();
    const dataKey = unwrapDataKey(record!.wrappedDataKey, master, ORG_A);
    expect(dataKey.length).toBe(DATA_KEY_BYTES);
    expect(record!.wrappedDataKey).not.toContain(dataKey.toString('base64'));
  });

  it('gives each organization its own key, so one tenant’s key opens only its own tokens', async () => {
    const scopedA = database.scopedFor(ORG_A);
    const scopedB = database.scopedFor(ORG_B);

    await storeIntegrationToken(scopedA, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    await storeIntegrationToken(scopedB, { sourceKey: 'primary-code', tokenKind: 'access', token: REFRESH_TOKEN }, NOW);

    const keyA = (await findDataKey(scopedA))!;
    const keyB = (await findDataKey(scopedB))!;
    expect(keyA.wrappedDataKey).not.toBe(keyB.wrappedDataKey);

    const master = resolveMasterKey();
    const materialA = unwrapDataKey(keyA.wrappedDataKey, master, ORG_A);
    const materialB = unwrapDataKey(keyB.wrappedDataKey, master, ORG_B);
    expect(materialA.equals(materialB)).toBe(false);

    // Each scope reads its own credential and nothing of the other's.
    expect(await useIntegrationToken(scopedA, 'primary-code', 'access')).toBe(GITHUB_TOKEN);
    expect(await useIntegrationToken(scopedB, 'primary-code', 'access')).toBe(REFRESH_TOKEN);
  });

  it('refuses to unwrap one organization’s key under another organization’s identity', async () => {
    // The additional authenticated data binds the wrapped key to its tenant, so a row copied
    // between organizations fails authentication rather than opening.
    const scopedA = database.scopedFor(ORG_A);
    await storeIntegrationToken(scopedA, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    const wrapped = (await findDataKey(scopedA))!.wrappedDataKey;

    expect(() => unwrapDataKey(wrapped, resolveMasterKey(), ORG_B)).toThrow(EnvelopeDecryptionError);
  });

  it('refuses to open a token row moved to another source or another field', async () => {
    const scoped = database.scopedFor(ORG_A);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    const sealed = await rawSealedValue('primary-code', 'access');

    // Move the ciphertext into the `refresh` row of the same source, which is the copy a
    // half-understood manual fix would make.
    await database.client.query(
      `insert into integration_tokens
         (id, organization_id, source_key, token_kind, sealed_value, key_version, created_at, updated_at)
       values ($1, $2, 'primary-code', 'refresh', $3, 1, now(), now())`,
      ['44444444-4444-4444-8444-444444444444', ORG_A, sealed],
    );

    await expect(useIntegrationToken(scoped, 'primary-code', 'refresh')).rejects.toThrow(EnvelopeDecryptionError);
  });

  it('will not store anything at all without a master key', async () => {
    delete process.env[MASTER_KEY_ENV_VAR];
    const scoped = database.scopedFor(ORG_A);

    await expect(
      storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW),
    ).rejects.toThrow(MasterKeyUnavailableError);
    // Nothing was written on the way to failing.
    expect(await findDataKey(database.scopedFor(ORG_A))).toBeNull();
  });

  it('refuses a master key of the wrong size rather than padding it', async () => {
    process.env[MASTER_KEY_ENV_VAR] = Buffer.from('too short').toString('base64');

    expect(() => resolveMasterKey()).toThrow(MasterKeyUnavailableError);
    expect(() => resolveMasterKey()).toThrow(/32 bytes/);
  });
});

describe('rotation', () => {
  it('rewraps under a new master key without touching a single ciphertext', async () => {
    const scoped = database.scopedFor(ORG_A);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    const ciphertextBefore = await rawSealedValue('primary-code', 'access');

    const oldMaster = resolveMasterKey();
    const newMaster = generateDataKey();
    const result = await rewrapOrganizationDataKey(scoped, { fromMasterKey: oldMaster, toMasterKey: newMaster }, LATER);

    expect(result.masterKeyVersion).toBe(2);
    expect(await rawSealedValue('primary-code', 'access'), 'no token is re-encrypted').toBe(ciphertextBefore);

    // The token still opens — under the new master key.
    process.env[MASTER_KEY_ENV_VAR] = newMaster.toString('base64');
    expect(await useIntegrationToken(scoped, 'primary-code', 'access')).toBe(GITHUB_TOKEN);

    // And no longer under the old one.
    process.env[MASTER_KEY_ENV_VAR] = oldMaster.toString('base64');
    await expect(useIntegrationToken(scoped, 'primary-code', 'access')).rejects.toThrow(EnvelopeDecryptionError);
  });

  it('rotates the data key, re-encrypts every token, and keeps every one readable', async () => {
    const scoped = database.scopedFor(ORG_A);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'refresh', token: REFRESH_TOKEN }, NOW);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-tracker', tokenKind: 'access', token: 'jira-abc-123' }, NOW);

    const before = await rawSealedValue('primary-code', 'access');
    const keyBefore = (await findDataKey(scoped))!;

    const result = await rotateOrganizationDataKey(scoped, LATER);

    expect(result.keyVersion).toBe(2);
    expect(result.tokensReencrypted).toBe(3);

    const keyAfter = (await findDataKey(scoped))!;
    expect(keyAfter.wrappedDataKey).not.toBe(keyBefore.wrappedDataKey);
    expect(keyAfter.rotatedAt).toBe(LATER);
    expect(await rawSealedValue('primary-code', 'access'), 'every ciphertext is new').not.toBe(before);

    expect(await useIntegrationToken(scoped, 'primary-code', 'access')).toBe(GITHUB_TOKEN);
    expect(await useIntegrationToken(scoped, 'primary-code', 'refresh')).toBe(REFRESH_TOKEN);
    expect(await useIntegrationToken(scoped, 'primary-tracker', 'access')).toBe('jira-abc-123');

    // Every token now carries the new version, so a half-finished rotation would be visible.
    const stored = await findIntegrationToken(scoped, 'primary-code', 'access');
    expect(stored?.keyVersion).toBe(2);
  });

  it('rotates one organization without disturbing another', async () => {
    const scopedA = database.scopedFor(ORG_A);
    const scopedB = database.scopedFor(ORG_B);
    await storeIntegrationToken(scopedA, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    await storeIntegrationToken(scopedB, { sourceKey: 'primary-code', tokenKind: 'access', token: REFRESH_TOKEN }, NOW);

    const keyBefore = (await findDataKey(scopedB))!;
    await rotateOrganizationDataKey(scopedA, LATER);

    expect((await findDataKey(scopedB))!.wrappedDataKey).toBe(keyBefore.wrappedDataKey);
    expect(await useIntegrationToken(scopedB, 'primary-code', 'access')).toBe(REFRESH_TOKEN);
  });

  it('treats an organization with no key as nothing to rotate rather than an error', async () => {
    // Most tenants have no integrations. A scheduled rotation that threw on them would fail
    // constantly and be switched off.
    const scoped = database.scopedFor(ORG_B);

    await expect(rotateOrganizationDataKey(scoped, LATER)).resolves.toEqual({ keyVersion: 0, tokensReencrypted: 0 });
    await expect(
      rewrapOrganizationDataKey(scoped, { fromMasterKey: resolveMasterKey(), toMasterKey: generateDataKey() }, LATER),
    ).resolves.toEqual({ masterKeyVersion: 0 });
  });

  it('rewraps a key through the pure helper without changing what it opens', () => {
    const dataKey = generateDataKey();
    const first = generateDataKey();
    const second = generateDataKey();

    const wrapped = wrapDataKey(dataKey, first, ORG_A);
    const rewrapped = rewrapDataKey(wrapped, first, second, ORG_A);

    expect(unwrapDataKey(rewrapped, second, ORG_A).equals(dataKey)).toBe(true);
    expect(() => unwrapDataKey(rewrapped, first, ORG_A)).toThrow(EnvelopeDecryptionError);
  });
});

describe('what the API is allowed to know', () => {
  it('describes a credential without any part of its value', async () => {
    const scoped = database.scopedFor(ORG_A);
    const described = await storeIntegrationToken(
      scoped,
      { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN, expiresAt: LATER },
      NOW,
    );

    expect(described).toEqual({
      sourceKey: 'primary-code',
      tokenKind: 'access',
      present: true,
      expiresAt: LATER,
      keyVersion: 1,
    });

    // Nothing in the serialised description contains the credential or a mask of it.
    const serialised = JSON.stringify(described);
    expect(serialised).not.toContain(GITHUB_TOKEN);
    expect(serialised).not.toContain('ghp_');
    expect(serialised).not.toContain(GITHUB_TOKEN.slice(-4));
  });

  it('lists every credential as a description and never as a value', async () => {
    const scoped = database.scopedFor(ORG_A);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'access', token: GITHUB_TOKEN }, NOW);
    await storeIntegrationToken(scoped, { sourceKey: 'primary-code', tokenKind: 'refresh', token: REFRESH_TOKEN }, NOW);

    const described = await describeIntegrationTokens(scoped);
    const serialised = JSON.stringify(described);

    expect(described).toHaveLength(2);
    for (const entry of described) {
      expect(Object.keys(entry).sort()).toEqual(['expiresAt', 'keyVersion', 'present', 'sourceKey', 'tokenKind']);
    }
    expect(serialised).not.toContain(GITHUB_TOKEN);
    expect(serialised).not.toContain(REFRESH_TOKEN);
  });

  it('answers null for a credential that was never stored, rather than throwing at a manager', async () => {
    const scoped = database.scopedFor(ORG_A);

    expect(await useIntegrationToken(scoped, 'never-configured', 'access')).toBeNull();
  });
});

describe('the envelope, on its own', () => {
  it('refuses a ciphertext whose additional authenticated data does not match', () => {
    const key = generateDataKey();
    const sealed = seal({ plaintext: GITHUB_TOKEN, key, context: ['integration-token', ORG_A, 'code', 'access'] });

    expect(unseal({ sealed, key, context: ['integration-token', ORG_A, 'code', 'access'] })).toBe(GITHUB_TOKEN);
    expect(() => unseal({ sealed, key, context: ['integration-token', ORG_B, 'code', 'access'] })).toThrow(
      EnvelopeDecryptionError,
    );
    expect(() => unseal({ sealed, key, context: ['integration-token', ORG_A, 'code', 'refresh'] })).toThrow(
      EnvelopeDecryptionError,
    );
  });

  it('encodes its context unambiguously, so two different contexts cannot collide', () => {
    const key = generateDataKey();
    // `['a', 'b:c']` and `['a:b', 'c']` would be the same bytes under a colon delimiter.
    const sealed = seal({ plaintext: 'secret', key, context: ['a', 'b:c'] });

    expect(() => unseal({ sealed, key, context: ['a:b', 'c'] })).toThrow(EnvelopeDecryptionError);
    expect(unseal({ sealed, key, context: ['a', 'b:c'] })).toBe('secret');
  });

  it('detects a single flipped bit in the ciphertext', () => {
    /**
     * The flip is applied to the decoded bytes and then re-encoded, not to the base64url text.
     *
     * Editing the last *character* of a base64url string does not reliably change the bytes it
     * decodes to — the final character can carry padding bits that are discarded — so a text-level
     * tamper was sometimes a no-op and this test failed roughly one run in three, on a fresh random
     * IV each time. Flipping a byte is exact.
     */
    const key = generateDataKey();
    const sealed = seal({ plaintext: GITHUB_TOKEN, key, context: ['x'] });
    const parts = sealed.split('.');

    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    ciphertext[0] = ciphertext[0]! ^ 0x01;
    parts[3] = ciphertext.toString('base64url');

    expect(() => unseal({ sealed: parts.join('.'), key, context: ['x'] })).toThrow(EnvelopeDecryptionError);
  });

  it('detects a flipped bit in the authentication tag as well', () => {
    // The other half of GCM: a tampered tag must fail rather than being ignored.
    const key = generateDataKey();
    const sealed = seal({ plaintext: GITHUB_TOKEN, key, context: ['x'] });
    const parts = sealed.split('.');

    const tag = Buffer.from(parts[2]!, 'base64url');
    tag[0] = tag[0]! ^ 0x01;
    parts[2] = tag.toString('base64url');

    expect(() => unseal({ sealed: parts.join('.'), key, context: ['x'] })).toThrow(EnvelopeDecryptionError);
  });

  it('refuses a scheme it does not know rather than guessing at the layout', () => {
    const key = generateDataKey();
    const sealed = seal({ plaintext: 'x', key, context: ['x'] });

    expect(() => unseal({ sealed: sealed.replace(ENVELOPE_SCHEME, 'v2:chacha'), key, context: ['x'] })).toThrow(
      /does not know how to open/,
    );
    expect(() => unseal({ sealed: 'not-an-envelope', key, context: ['x'] })).toThrow(/envelope layout/);
  });
});
