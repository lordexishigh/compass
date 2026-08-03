import {
  findDataKey,
  findIntegrationToken,
  listIntegrationTokens,
  saveDataKey,
  saveIntegrationToken,
  type IntegrationTokenKind,
  type ScopedDb,
  type StoredIntegrationToken,
} from '@compass/db';

import type { Instant } from '@compass/clock';

import {
  generateDataKey,
  reencryptUnderNewKey,
  resolveMasterKey,
  rewrapDataKey,
  seal,
  unseal,
  unwrapDataKey,
  wrapDataKey,
  type SealedValue,
} from './envelope.js';

/**
 * The only module that can turn a stored row back into a credential.
 *
 * `@compass/db` holds the two tables and reads and writes opaque strings; the master key never
 * reaches that layer. This is the seam where the key exists, and it is deliberately narrow:
 * four functions, one of which returns a plaintext, and that one is called by the connector
 * edge and by nothing else.
 *
 * ## The rule this file exists to make structural
 *
 * *No token, and no masked form of a token, is ever returned to a caller of the HTTP API.*
 * There is no "reveal" endpoint, no `maskedToken` field, no last-four. A masked token is not a
 * safe token — it is a confirmation that a token exists, a length, and a per-provider prefix,
 * which is most of what an attacker enumerating an integration wants. What the API returns
 * instead is `describeIntegrationToken`: whether a credential is present, which source it is
 * for, and when it expires. That answers every question a settings screen legitimately has.
 *
 * `tools/eslint-plugin-compass/rules/no-secret-disclosure.js` fails the build if a token field
 * name appears in a log statement or a response body anywhere in the workspace, and
 * `apps/web/tests/token-storage.test.ts` asserts the raw column value is not the plaintext.
 */

/** Bound into every token's ciphertext, so a row cannot be moved between fields or tenants. */
const tokenContext = (organizationId: string, sourceKey: string, tokenKind: IntegrationTokenKind): readonly string[] =>
  ['integration-token', organizationId, sourceKey, tokenKind];

/**
 * The organization's data key, unwrapped — creating and storing one on first use.
 *
 * Lazily created rather than written when the organization is: an organization that never
 * connects an integration never needs a key, and a key that exists for every tenant is a key
 * that has to be rotated for every tenant. The first `storeIntegrationToken` mints it.
 *
 * `masterKeyVersion` starts at 1 and is bumped by `rewrapOrganizationDataKey`. It is recorded
 * so an interrupted master-key rotation is a readable state rather than a set of rows that
 * mysteriously fail to open.
 */
async function dataKeyFor(scoped: ScopedDb, now: Instant): Promise<{ key: Buffer; version: number }> {
  const masterKey = resolveMasterKey();
  const existing = await findDataKey(scoped);

  if (existing !== null) {
    return {
      key: unwrapDataKey(existing.wrappedDataKey, masterKey, scoped.organizationId),
      version: existing.keyVersion,
    };
  }

  const dataKey = generateDataKey();
  const saved = await saveDataKey(
    scoped,
    {
      wrappedDataKey: wrapDataKey(dataKey, masterKey, scoped.organizationId),
      keyVersion: 1,
      masterKeyVersion: 1,
    },
    now,
  );
  return { key: dataKey, version: saved.keyVersion };
}

export interface StoreTokenInput {
  readonly sourceKey: string;
  readonly tokenKind: IntegrationTokenKind;
  /** The credential as the provider issued it. Sealed before it reaches the database. */
  readonly token: string;
  readonly expiresAt?: Instant | null;
}

/**
 * Seals a credential and stores it. Returns a description, never the value.
 *
 * The return type is the point: a caller that wanted to echo what it just stored physically
 * cannot, because the function does not hand it back. A `storeIntegrationToken` that returned
 * the row would be one refactor away from a route returning the row.
 */
export async function storeIntegrationToken(
  scoped: ScopedDb,
  input: StoreTokenInput,
  now: Instant,
): Promise<IntegrationTokenDescription> {
  if (input.token.trim().length === 0) {
    throw new TypeError('Refusing to store an empty integration token: an empty credential is not a credential.');
  }

  const { key, version } = await dataKeyFor(scoped, now);
  const sealed = seal({
    plaintext: input.token,
    key,
    context: tokenContext(scoped.organizationId, input.sourceKey, input.tokenKind),
  });

  const stored = await saveIntegrationToken(
    scoped,
    {
      sourceKey: input.sourceKey,
      tokenKind: input.tokenKind,
      sealedValue: sealed,
      keyVersion: version,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    },
    now,
  );

  return describeIntegrationToken(stored);
}

/**
 * Opens a stored credential.
 *
 * The one function in Compass that produces a token as a string, and the reason it is not
 * called `getToken`: `use` is what the caller is doing, and the intended shape is
 * `useIntegrationToken(...)` immediately followed by an outbound request, not a local that is
 * kept and later logged. Null when there is no such credential — an absent integration is a
 * state the caller has to handle, not an error to throw at a manager.
 */
export async function useIntegrationToken(
  scoped: ScopedDb,
  sourceKey: string,
  tokenKind: IntegrationTokenKind,
): Promise<string | null> {
  const stored = await findIntegrationToken(scoped, sourceKey, tokenKind);
  if (stored === null) return null;

  const record = await findDataKey(scoped);
  if (record === null) {
    throw new Error(
      `Organization ${scoped.organizationId} has a stored ${tokenKind} token for ${sourceKey} but no data key, so it ` +
        'cannot be decrypted. The credential has to be re-authorised.',
    );
  }

  const key = unwrapDataKey(record.wrappedDataKey, resolveMasterKey(), scoped.organizationId);
  return unseal({
    sealed: stored.sealedValue,
    key,
    context: tokenContext(scoped.organizationId, sourceKey, tokenKind),
  });
}

// ---------------------------------------------------------------------------
// What the API is allowed to say
// ---------------------------------------------------------------------------

/**
 * Everything an HTTP response may carry about a credential.
 *
 * No value, no mask, no length, no prefix, no digest. `present` and `expiresAt` are enough to
 * render "GitHub is connected; this token expires on Friday" and to render the honest failure
 * "no credential stored for this source", which are the only two things a settings screen has
 * to say.
 */
export interface IntegrationTokenDescription {
  readonly sourceKey: string;
  readonly tokenKind: IntegrationTokenKind;
  readonly present: true;
  /** Milliseconds since the epoch, or null when the credential does not expire. */
  readonly expiresAt: number | null;
  /** Which data-key version sealed it. Operational, and not a secret. */
  readonly keyVersion: number;
}

export const describeIntegrationToken = (stored: StoredIntegrationToken): IntegrationTokenDescription => ({
  sourceKey: stored.sourceKey,
  tokenKind: stored.tokenKind,
  present: true,
  expiresAt: stored.expiresAt,
  keyVersion: stored.keyVersion,
});

export const describeIntegrationTokens = async (
  scoped: ScopedDb,
): Promise<readonly IntegrationTokenDescription[]> =>
  (await listIntegrationTokens(scoped)).map(describeIntegrationToken);

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Rewraps the data key under a new master key. Touches no ciphertext.
 *
 * The rotation that happens on a schedule. Both master keys have to be available for the
 * duration — the old one to unwrap, the new one to wrap — which is why the signature takes
 * them explicitly instead of reading the environment twice: a deployment mid-rotation has two
 * values, and pretending there is only ever one is how the second half of a rotation loses the
 * ability to read the first half's rows.
 */
export async function rewrapOrganizationDataKey(
  scoped: ScopedDb,
  input: { readonly fromMasterKey: Buffer; readonly toMasterKey: Buffer },
  now: Instant,
): Promise<{ readonly masterKeyVersion: number }> {
  const existing = await findDataKey(scoped);
  if (existing === null) {
    // Nothing to rewrap is a success, not a failure: an organization with no integrations has
    // no key, and a rotation that threw here would fail on most tenants.
    return { masterKeyVersion: 0 };
  }

  const saved = await saveDataKey(
    scoped,
    {
      wrappedDataKey: rewrapDataKey(
        existing.wrappedDataKey,
        input.fromMasterKey,
        input.toMasterKey,
        scoped.organizationId,
      ),
      keyVersion: existing.keyVersion,
      masterKeyVersion: existing.masterKeyVersion + 1,
      rotatedAt: existing.rotatedAt,
    },
    now,
  );

  return { masterKeyVersion: saved.masterKeyVersion };
}

/**
 * Replaces the data key and re-encrypts every credential under it.
 *
 * The expensive rotation, for after a suspected compromise of the key itself. Every token is
 * re-sealed with the same additional authenticated data, so the binding to
 * `(organization, source, field)` survives — a rotation that dropped the AAD would produce rows
 * that opened under any of that organization's fields, which is a quiet weakening that nothing
 * would have noticed.
 *
 * The old key is held only as a local for the duration of the loop. If the process dies
 * halfway, the tokens already re-sealed carry the new `key_version` and the rest carry the old
 * one, and the *key row still holds the old wrapped key* — so a resumed rotation can still open
 * both halves. Writing the key row last is what makes that true.
 */
export async function rotateOrganizationDataKey(
  scoped: ScopedDb,
  now: Instant,
): Promise<{ readonly keyVersion: number; readonly tokensReencrypted: number }> {
  const masterKey = resolveMasterKey();
  const existing = await findDataKey(scoped);
  if (existing === null) return { keyVersion: 0, tokensReencrypted: 0 };

  const oldKey = unwrapDataKey(existing.wrappedDataKey, masterKey, scoped.organizationId);
  const newKey = generateDataKey();
  const nextVersion = existing.keyVersion + 1;

  const tokens = await listIntegrationTokens(scoped);
  let reencrypted = 0;

  for (const token of tokens) {
    const context = tokenContext(scoped.organizationId, token.sourceKey, token.tokenKind);
    const resealed: SealedValue = reencryptUnderNewKey({
      sealed: token.sealedValue,
      fromKey: oldKey,
      toKey: newKey,
      context,
    });

    await saveIntegrationToken(
      scoped,
      {
        sourceKey: token.sourceKey,
        tokenKind: token.tokenKind,
        sealedValue: resealed,
        keyVersion: nextVersion,
        expiresAt: token.expiresAt,
      },
      now,
    );
    reencrypted += 1;
  }

  // Last, on purpose: see the note above about an interrupted rotation.
  await saveDataKey(
    scoped,
    {
      wrappedDataKey: wrapDataKey(newKey, masterKey, scoped.organizationId),
      keyVersion: nextVersion,
      masterKeyVersion: existing.masterKeyVersion,
      rotatedAt: now,
    },
    now,
  );

  return { keyVersion: nextVersion, tokensReencrypted: reencrypted };
}
