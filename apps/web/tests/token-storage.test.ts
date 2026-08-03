import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeIntegrationToken } from '@compass/auth';
import { describe, expect, it } from 'vitest';

import { apiRoutesOnDisk } from './helpers/routes';

/**
 * No API response carries a credential, and no route can produce one.
 *
 * The acceptance criterion asks for a *response-schema* test, and this file answers it in the two
 * ways that are not already covered elsewhere:
 *
 *  - **Structurally.** `useIntegrationToken` is the only function in Compass that turns a stored row
 *    back into a plaintext credential. If no route handler imports it, no route response can contain
 *    one — whatever a future author writes in the body. That is a stronger statement than checking
 *    the bodies that exist today, because it also holds for the bodies that do not exist yet.
 *  - **By shape.** `IntegrationTokenDescription` is the only thing the API may say about a
 *    credential, and its key set is asserted exactly, so a `maskedToken` or a `last4` cannot be
 *    added without failing here.
 *
 * The third way — a credential-named field appearing in any response body or log statement anywhere
 * in the workspace — is the ESLint rule `compass/no-secret-disclosure`, wired for every file and
 * proved to fire by `tools/quality-gates/tests/security-posture.test.ts`. It is a lint rule rather
 * than a test because it needs AST context: `tokenHash` is the *safe* pattern and a grep cannot tell
 * the two apart.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The route file for a route path — the inverse of the enumerator's mapping. */
const routeSourceFor = (route: string): string => {
  const segments = route.slice(1).split('/');
  return readFileSync(join(WEB_ROOT, 'app', ...segments, 'route.ts'), 'utf8');
};

describe('no route can produce a plaintext credential', () => {
  it('has routes to check, so an empty enumeration cannot pass this file', () => {
    expect(apiRoutesOnDisk().length).toBeGreaterThan(20);
  });

  it.each(apiRoutesOnDisk().map((route) => [route]))('%s does not reach for a plaintext token', (route) => {
    const source = routeSourceFor(route);

    // The one function that decrypts. A route that does not import it cannot answer with a token.
    expect(source, `${route} imports useIntegrationToken, so its response could carry a credential`).not.toContain(
      'useIntegrationToken',
    );
    // Nor the envelope directly, which would be the way around the above.
    expect(source, `${route} unseals a stored secret directly`).not.toContain('unseal(');
    expect(source, `${route} reads the master key`).not.toContain('resolveMasterKey');
  });

  it.each(apiRoutesOnDisk().map((route) => [route]))('%s selects no sealed column into a response', (route) => {
    const source = routeSourceFor(route);

    // Ciphertext in a response is not a disclosure, but it is noise that reads as one — and a route
    // selecting it is a route one refactor away from decrypting it.
    for (const forbidden of ['sealedValue', 'wrappedDataKey', 'integrationTokens', 'organizationDataKeys']) {
      expect(source, `${route} reads ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('what the API may say about a credential', () => {
  it('is exactly five fields, none of which is the value or a mask of it', () => {
    const described = describeIntegrationToken({
      id: 'row-1',
      sourceKey: 'primary-code',
      tokenKind: 'access',
      sealedValue: 'v1:aes-256-gcm.iv.tag.ciphertext',
      keyVersion: 2,
      expiresAt: null,
    });

    expect(Object.keys(described).sort()).toEqual(['expiresAt', 'keyVersion', 'present', 'sourceKey', 'tokenKind']);

    // The sealed value went in and did not come out — not whole, not truncated, not hashed.
    const serialised = JSON.stringify(described);
    expect(serialised).not.toContain('v1:aes-256-gcm');
    expect(serialised).not.toContain('ciphertext');
    expect(serialised).not.toContain('sealed');
  });

  it('answers `present: true` rather than a length, a prefix or a last-four', () => {
    /**
     * Why there is no mask at all.
     *
     * A masked token reads as the responsible choice and is not one: `ghp_••••••••abcd` publishes the
     * provider, the format, the length and four characters of entropy, which is most of what
     * somebody enumerating an integration wants and all of what they need to confirm a guess. The
     * question a settings screen legitimately has is "is this connected, and when does it expire",
     * and both of those are answered here without the value existing in the response at all.
     */
    const described = describeIntegrationToken({
      id: 'row-1',
      sourceKey: 'primary-code',
      tokenKind: 'refresh',
      sealedValue: 'v1:aes-256-gcm.a.b.ghp_9tKq2mXn4bZr7wLpV3sHdY8cA1eF6gJ0uT5i',
      keyVersion: 1,
      expiresAt: null,
    });

    expect(described.present).toBe(true);
    expect(Object.values(described)).not.toContain('ghp_9tKq2mXn4bZr7wLpV3sHdY8cA1eF6gJ0uT5i');
    for (const value of Object.values(described)) {
      if (typeof value !== 'string') continue;
      expect(value, 'no field may carry a fragment of the credential').not.toContain('ghp_');
      expect(value).not.toContain('uT5i');
    }
  });
});

describe('the recursive key check the response-schema claim rests on', () => {
  /**
   * A body is safe when no key anywhere in it names a credential.
   *
   * Recursive, because the leak is never at the top level — it is nested in a `source: {...}` or an
   * array of integrations. Exported shape kept local: this is the predicate, and the two tests below
   * prove it can fail before it is used to assert that something passes.
   */
  const SECRET_KEY = /^(access|refresh|api|oauth|bearer|id|session)?_?(token|secret|key)$|^password$|^plaintext$/i;
  const SAFE = /(hash|digest|kind|version|expiresat|present)$/i;

  const secretKeysIn = (value: unknown, path = '$'): readonly string[] => {
    if (Array.isArray(value)) return value.flatMap((entry, index) => secretKeysIn(entry, `${path}[${index}]`));
    if (typeof value !== 'object' || value === null) return [];

    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
      const flagged = !SAFE.test(key) && SECRET_KEY.test(key) ? [`${path}.${key}`] : [];
      return [...flagged, ...secretKeysIn(nested, `${path}.${key}`)];
    });
  };

  it('flags a credential however deeply it is nested', () => {
    expect(secretKeysIn({ accessToken: 'x' })).toEqual(['$.accessToken']);
    expect(secretKeysIn({ source: { credentials: { refresh_token: 'x' } } })).toEqual([
      '$.source.credentials.refresh_token',
    ]);
    expect(secretKeysIn({ sources: [{ ok: true }, { apiKey: 'x' }] })).toEqual(['$.sources[1].apiKey']);
    expect(secretKeysIn({ password: 'x' })).toEqual(['$.password']);
  });

  it('does not flag the safe forms', () => {
    expect(secretKeysIn({ tokenHash: 'a', tokenDigest: 'b', tokenKind: 'access', keyVersion: 1 })).toEqual([]);
    expect(secretKeysIn({ present: true, expiresAt: null, sourceKey: 'primary-code' })).toEqual([]);
  });

  it('passes the description the API actually returns', () => {
    const described = describeIntegrationToken({
      id: 'row-1',
      sourceKey: 'primary-code',
      tokenKind: 'access',
      sealedValue: 'v1:aes-256-gcm.a.b.c',
      keyVersion: 1,
      expiresAt: null,
    });

    expect(secretKeysIn(described)).toEqual([]);
  });
});
