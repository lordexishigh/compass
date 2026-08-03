import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for the secrets Compass has to be able to *use*.
 *
 * ## Why this exists at all, when everything else is hashed
 *
 * Session cookies, mailed links and share tokens are stored as SHA-256 digests, because
 * Compass only ever needs to recognise them (`secrets.ts` explains that trade at length). An
 * integration's OAuth access and refresh tokens are the opposite case: Compass has to present
 * the actual bytes to GitHub tomorrow morning, so a digest is useless and the plaintext has to
 * be recoverable. Recoverable is not the same as readable — hence this.
 *
 * ## The envelope
 *
 *   master key (KMS / `COMPASS_KMS_MASTER_KEY`)
 *     └── wraps a per-organization data key (32 random bytes, one row per org)
 *           └── encrypts each token value (AES-256-GCM, fresh 96-bit IV per value)
 *
 * Three properties come out of that shape, and each is the reason for one of the layers:
 *
 *  - **The database alone is worthless.** A dump contains wrapped data keys and ciphertext
 *    and no master key, so it decrypts to nothing.
 *  - **A tenant is a blast radius.** One organization's data key opens that organization's
 *    tokens and no other's, so a partial compromise stays partial.
 *  - **Rotation is cheap in the direction it is usually needed.** Rotating the *master* key
 *    rewraps one small row per organization and touches no ciphertext (`rewrapDataKey`).
 *    Rotating a *data* key re-encrypts that organization's tokens (`reencryptUnderNewKey`),
 *    which is the expensive one and is therefore the one you only do after an incident.
 *
 * ## AES-256-GCM, with the row's coordinates as additional authenticated data
 *
 * GCM is authenticated, so a tampered ciphertext fails to decrypt rather than decrypting to
 * garbage that gets sent to GitHub as a credential. The AAD binds each ciphertext to
 * `(organization, source, field)`: without it, a row copied from one organization's
 * `refresh_token` into another's `access_token` would still decrypt under a shared key, and the
 * database would have been persuaded to lie about whose credential it holds. With it, the
 * copied row fails authentication.
 *
 * ## What is deliberately not here
 *
 * No key derivation from a password, and no default key. `resolveMasterKey` throws when
 * `COMPASS_KMS_MASTER_KEY` is absent or malformed, so a deployment that has not been given a
 * key cannot store a token at all. The alternative — a built-in fallback key — is
 * indistinguishable from storing the tokens in plaintext, because the fallback would be in the
 * repository.
 */

export const MASTER_KEY_ENV_VAR = 'COMPASS_KMS_MASTER_KEY';

/** AES-256: 32 bytes of key, 12 bytes of IV (the GCM-recommended size), 16 bytes of tag. */
export const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const CIPHER = 'aes-256-gcm';

/**
 * The version stamped on every value this module writes.
 *
 * Stored beside the ciphertext so that a future scheme change can decrypt old rows instead of
 * orphaning them. `unseal` refuses a version it does not know rather than guessing at the
 * layout, because guessing at the layout of an authenticated ciphertext produces an
 * authentication failure that reads like key loss.
 */
export const ENVELOPE_SCHEME = 'v1:aes-256-gcm';

export class MasterKeyUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'MasterKeyUnavailableError';
    this.detail = detail;
  }
}

export class EnvelopeDecryptionError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'EnvelopeDecryptionError';
    this.detail = detail;
  }
}

/**
 * The master key, from the environment.
 *
 * 32 bytes, base64. In a deployment with a real KMS this is the place the KMS client goes and
 * every caller already routes through it; the interface — "give me the key material that wraps
 * data keys" — does not change, which is why the rest of this module never reads
 * `process.env`.
 */
export function resolveMasterKey(environment: Record<string, string | undefined> = process.env): Buffer {
  const configured = environment[MASTER_KEY_ENV_VAR];
  if (configured === undefined || configured.trim().length === 0) {
    throw new MasterKeyUnavailableError(
      `${MASTER_KEY_ENV_VAR} is not set, so Compass has no key to wrap an organization's data key with and will not ` +
        'store an integration token at all. Generate one with `openssl rand -base64 32` and set it on both the web ' +
        'and worker processes. There is deliberately no built-in default: a fallback key committed to the repository ' +
        'would be indistinguishable from storing the tokens in plaintext.',
    );
  }

  const key = Buffer.from(configured.trim(), 'base64');
  if (key.length !== DATA_KEY_BYTES) {
    throw new MasterKeyUnavailableError(
      `${MASTER_KEY_ENV_VAR} must be ${DATA_KEY_BYTES} bytes of base64 (44 characters, as \`openssl rand -base64 32\` ` +
        `produces); the value provided decodes to ${key.length} bytes.`,
    );
  }
  return key;
}

/** A fresh per-organization data key. Never stored unwrapped, never logged, never returned. */
export const generateDataKey = (): Buffer => randomBytes(DATA_KEY_BYTES);

/**
 * One encrypted value, as it is stored.
 *
 * A single opaque string rather than three columns, because the parts are meaningless apart:
 * a row with the ciphertext but not the tag is not "partially recoverable", it is unusable, and
 * three nullable columns invite a write path that fills two of them.
 *
 * Layout: `v1:aes-256-gcm.<iv>.<tag>.<ciphertext>`, each part base64url.
 */
export type SealedValue = string;

export interface SealInput {
  /** The plaintext. The only place in the process where it exists as a string. */
  readonly plaintext: string;
  /** 32 bytes. Either a data key (for a token) or the master key (for a data key). */
  readonly key: Buffer;
  /** Bound into the ciphertext, so a row moved between tenants or fields fails to open. */
  readonly context: readonly string[];
}

export function seal(input: SealInput): SealedValue {
  assertKey(input.key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, input.key, iv);
  cipher.setAAD(aad(input.context));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [ENVELOPE_SCHEME, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

export interface UnsealInput {
  readonly sealed: SealedValue;
  readonly key: Buffer;
  readonly context: readonly string[];
}

/**
 * Recovers a plaintext, or throws.
 *
 * Never returns a partial or a placeholder. A failure here means one of: the wrong key, a
 * tampered row, or a row written under a scheme this build does not know — and every one of
 * those has to stop the caller, because the alternative is presenting corrupted bytes to
 * GitHub as a credential and reporting the resulting 401 as "the integration is broken".
 */
export function unseal(input: UnsealInput): string {
  assertKey(input.key);

  const parts = input.sealed.split('.');
  if (parts.length !== 4) {
    throw new EnvelopeDecryptionError('A stored secret is not in the envelope layout, so it cannot be decrypted.');
  }
  const [scheme, encodedIv, encodedTag, encodedCiphertext] = parts as [string, string, string, string];
  if (scheme !== ENVELOPE_SCHEME) {
    throw new EnvelopeDecryptionError(
      `A stored secret was sealed under scheme \`${scheme}\`, which this build does not know how to open.`,
    );
  }

  try {
    const decipher = createDecipheriv(CIPHER, input.key, Buffer.from(encodedIv, 'base64url'));
    decipher.setAAD(aad(input.context));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // The underlying message is "Unsupported state or unable to authenticate data", which
    // tells an operator nothing about which of the three causes it was.
    throw new EnvelopeDecryptionError(
      'A stored secret failed authentication. That means the wrapping key is not the one it was sealed with, or the ' +
        'row has been altered, or it was moved between organizations — the ciphertext is bound to the organization, ' +
        'source and field it was written for, so a row that has travelled will not open.',
    );
  }
}

/** Wraps a data key under the master key. The only form a data key is ever stored in. */
export const wrapDataKey = (dataKey: Buffer, masterKey: Buffer, organizationId: string): SealedValue =>
  seal({ plaintext: dataKey.toString('base64'), key: masterKey, context: ['data-key', organizationId] });

export function unwrapDataKey(wrapped: SealedValue, masterKey: Buffer, organizationId: string): Buffer {
  const key = Buffer.from(unseal({ sealed: wrapped, key: masterKey, context: ['data-key', organizationId] }), 'base64');
  assertKey(key);
  return key;
}

/**
 * Rewraps an existing data key under a new master key.
 *
 * The cheap half of rotation, and the half that is needed on a schedule: the data key itself
 * does not change, so no ciphertext is touched and no integration has to be re-authorised. One
 * row per organization.
 */
export const rewrapDataKey = (
  wrapped: SealedValue,
  fromMasterKey: Buffer,
  toMasterKey: Buffer,
  organizationId: string,
): SealedValue => wrapDataKey(unwrapDataKey(wrapped, fromMasterKey, organizationId), toMasterKey, organizationId);

/**
 * Re-encrypts one sealed value from an old data key to a new one.
 *
 * The expensive half of rotation — every token of that organization — so it is a deliberate
 * act after a suspected data-key compromise rather than something that happens on a timer.
 * The plaintext exists as a local for the duration of one call and is not returned.
 */
export const reencryptUnderNewKey = (input: {
  readonly sealed: SealedValue;
  readonly fromKey: Buffer;
  readonly toKey: Buffer;
  readonly context: readonly string[];
}): SealedValue =>
  seal({
    plaintext: unseal({ sealed: input.sealed, key: input.fromKey, context: input.context }),
    key: input.toKey,
    context: input.context,
  });

/**
 * The additional authenticated data for one value.
 *
 * JSON rather than a delimiter, so `['a', 'b:c']` and `['a:b', 'c']` cannot produce the same
 * bytes: JSON quotes and escapes each element, so the encoding of a context is unambiguous
 * without reserving a character that could appear in a source key.
 */
const aad = (context: readonly string[]): Buffer => Buffer.from(JSON.stringify(context), 'utf8');

function assertKey(key: Buffer): void {
  if (key.length !== DATA_KEY_BYTES) {
    throw new MasterKeyUnavailableError(
      `An encryption key must be exactly ${DATA_KEY_BYTES} bytes; this one is ${key.length}.`,
    );
  }
}
