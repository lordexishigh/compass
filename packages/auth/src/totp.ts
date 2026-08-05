import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { toEpochMillis, type Instant } from '@compass/clock';

/**
 * TOTP (RFC 6238) and recovery codes, as pure functions.
 *
 * ## Why this is a module of functions and not a class holding state
 *
 * The one property that makes a second factor worth having is that **a code cannot be used twice**.
 * Everything else — the shared secret, the 30-second step, the six digits — is standard and
 * uninteresting; replay is where naive implementations fail, because the obvious `verify(secret, code)`
 * signature has nowhere to record that a code has already been spent.
 *
 * So `verifyTotpCode` takes the *last step already consumed* as an argument and returns the step it
 * accepted. The caller persists that number. A replay inside the same 30 seconds therefore arrives with
 * `lastUsedStep === step` and is refused, and the refusal is a property of the signature rather than of
 * anybody remembering to check. There is no way to call this function correctly and still accept a
 * replay.
 *
 * ## Why implemented rather than taken from a library
 *
 * The algorithm is an HMAC, a truncation and a modulo — twenty lines, all of it in RFC 4226 §5.3 — and
 * `node:crypto` supplies the only primitive that matters. A dependency here would be a supply-chain
 * surface on the authentication path in exchange for code shorter than its own import statement. The
 * vectors in RFC 6238 Appendix B are asserted directly in `tests/totp.test.ts`, which is a stronger
 * guarantee than trusting a package's own test suite.
 *
 * ## No clock read
 *
 * `now` is a parameter, like everywhere else in Compass. That is what lets the replay test step time
 * deliberately instead of sleeping thirty seconds, and it is enforced by `compass/no-system-clock` over
 * this package.
 */

/** RFC 6238's default, and every authenticator app's assumption. */
export const TOTP_STEP_SECONDS = 30;

/** Six digits. RFC 4226 permits 6–8; every consumer authenticator app shows six. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of `now` are accepted.
 *
 * One, meaning a ±30-second window. This is a real trade and worth stating: zero would reject a person
 * whose phone clock is two seconds slow, and a larger window multiplies the number of codes valid at
 * any instant — with replay rejection in place the exposure is one *unused* code per step, but the
 * window is still the thing that decides how long a shoulder-surfed code stays useful. One step is
 * what RFC 6238 §5.2 suggests and what the major providers use.
 */
export const TOTP_ACCEPTED_DRIFT_STEPS = 1;

/** 20 bytes — the SHA-1 block size RFC 4226 specifies for the shared secret. */
export const TOTP_SECRET_BYTES = 20;

/** Recovery codes issued per batch. Ten is what a person can print on one line each. */
export const RECOVERY_CODE_COUNT = 10;

// ---------------------------------------------------------------------------
// Base32, because that is what authenticator apps read
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32, unpadded.
 *
 * Authenticator apps take the secret as base32 and nothing else, so this is not a stylistic choice.
 * Unpadded because every app rejects or ignores `=` in an `otpauth://` URI.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export class InvalidBase32Error extends Error {
  constructor(character: string) {
    super(
      `\`${character}\` is not a base32 character, so this cannot be a TOTP secret. Compass refuses to ` +
        'guess at a malformed secret: a silently-truncated one would produce codes that never match and ' +
        'a person locked out with no stated reason.',
    );
    this.name = 'InvalidBase32Error';
  }
}

export function base32Decode(encoded: string): Uint8Array {
  // Whitespace and lower case are what a person retypes; padding is what some apps add.
  const normalised = encoded.replace(/[\s=]/g, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new InvalidBase32Error(character);

    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

/** A fresh shared secret, base32 for the authenticator app. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(TOTP_SECRET_BYTES));

/** Which 30-second step an instant falls in. The counter RFC 4226 hashes. */
export const totpStepFor = (now: Instant): number =>
  Math.floor(toEpochMillis(now) / 1000 / TOTP_STEP_SECONDS);

/**
 * The code for one step. RFC 4226 §5.3: HMAC-SHA1, dynamic truncation, modulo 10^digits.
 *
 * Exported because the tests assert it against the RFC's own vectors, and because the enrollment flow
 * has to be able to show a person the code their app should be showing — a "codes do not match" screen
 * that cannot say what Compass expected is a screen nobody can debug.
 */
export function totpCodeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);

  // The counter as a 64-bit big-endian integer. `writeBigUInt64BE` rather than two 32-bit halves: the
  // hand-rolled version is where an implementation quietly breaks in 2038.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', Buffer.from(key)).update(counter).digest();

  // Dynamic truncation: the low nibble of the last byte selects the offset.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export type TotpVerdict =
  | {
      readonly ok: true;
      /**
       * The step the accepted code belongs to. **The caller must persist this** as the new
       * `lastUsedStep`; that is what makes the next replay fail.
       */
      readonly step: number;
    }
  | { readonly ok: false; readonly reason: 'malformed' | 'no_match' | 'replayed' };

const digitsOnly = /^[0-9]+$/;

/** Constant-time compare of two equal-length codes. */
const codesMatch = (left: string, right: string): boolean =>
  left.length === right.length && timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

/**
 * Verifies a code, and refuses one that has already been spent.
 *
 * `lastUsedStep` is the step of the last code this user successfully presented, or null if none. Any
 * candidate step at or below it is refused as `replayed` — which covers the criterion's case (the same
 * code inside one time step) and also the subtler one: a code from an *earlier* step inside the drift
 * window, which is equally a replay and which a naive "was it this exact step" check would let through.
 *
 * Steps are tried newest first so the common case is one HMAC.
 */
export function verifyTotpCode(input: {
  readonly secret: string;
  readonly code: string;
  readonly now: Instant;
  readonly lastUsedStep: number | null;
  readonly driftSteps?: number;
}): TotpVerdict {
  const code = input.code.replace(/[\s-]/g, '');
  if (code.length !== TOTP_DIGITS || !digitsOnly.test(code)) return { ok: false, reason: 'malformed' };

  const drift = input.driftSteps ?? TOTP_ACCEPTED_DRIFT_STEPS;
  const current = totpStepFor(input.now);

  let matchedStep: number | null = null;
  for (let offset = drift; offset >= -drift; offset -= 1) {
    const step = current + offset;
    if (codesMatch(code, totpCodeForStep(input.secret, step))) {
      matchedStep = step;
      break;
    }
  }

  if (matchedStep === null) return { ok: false, reason: 'no_match' };

  // The whole point of the signature. A code is a one-time password; presenting it twice is either a
  // double-submitted form or somebody replaying an intercepted code, and Compass cannot tell which —
  // so it refuses both.
  if (input.lastUsedStep !== null && matchedStep <= input.lastUsedStep) {
    return { ok: false, reason: 'replayed' };
  }

  return { ok: true, step: matchedStep };
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears twice — once as a label prefix and once as a parameter — which looks redundant and
 * is not: older apps read only the label, newer ones only the parameter, and an app that reads neither
 * shows the account with no indication of which service it belongs to.
 */
export function totpEnrollmentUri(input: {
  readonly secret: string;
  readonly accountEmail: string;
  readonly issuer?: string;
}): string {
  const issuer = input.issuer ?? 'Compass';
  const label = `${issuer}:${input.accountEmail}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Recovery codes: the way back in when the phone is gone.
 *
 * ## Format
 *
 * Ten groups of `xxxx-xxxx` from an unambiguous alphabet — no `0`/`O`, no `1`/`I`/`l` — because these
 * are read off paper by a person who has just lost their phone and is not in a mood to distinguish a
 * zero from an O. 40 bits per code, which is not a password: a recovery code is single-use, rate
 * limited by the sign-in limiter, and there are only ten of them.
 *
 * ## Hashed at rest, and why not Argon2
 *
 * `hashRecoveryCode` is SHA-256, deliberately, and this is the one place in Compass where a fast hash
 * is the right answer. Argon2 exists to make *guessing a human-chosen password* expensive; a recovery
 * code is 40 bits of machine randomness, so an offline attacker's cost is set by the search space and
 * not by the hash. What a slow hash would buy instead is a login path that does ten Argon2
 * verifications — one per stored code — to check a single submission, which is a denial-of-service
 * lever pointed at the authentication endpoint. This is the same reasoning `digestSecret` uses for
 * session and mailed-link tokens, and it is the same function.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const recoveryGroup = (): string => {
  const bytes = randomBytes(4);
  return [...bytes].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join('');
};

/** One code, in the shape a person reads back: `ABCD-EFGH`. */
export const generateRecoveryCode = (): string => `${recoveryGroup()}-${recoveryGroup()}`;

export const generateRecoveryCodes = (count: number = RECOVERY_CODE_COUNT): readonly string[] =>
  Array.from({ length: count }, generateRecoveryCode);

/**
 * The stored form. Normalised first, so the hash does not depend on how somebody typed it.
 *
 * Case and hyphens are cosmetic — an authenticator screen shows `abcd-efgh` and a person may type
 * `ABCDEFGH` — so both sides normalise identically and a correct code is never refused for its
 * punctuation.
 */
export const normaliseRecoveryCode = (code: string): string =>
  code.replace(/[\s-]/g, '').toUpperCase();

export const hashRecoveryCode = (code: string): string =>
  createHmac('sha256', 'compass:recovery-code').update(normaliseRecoveryCode(code), 'utf8').digest('hex');

/**
 * Finds which stored hash a submitted code matches, or null.
 *
 * Returns the *hash* rather than a boolean so the caller can mark that exact row spent — which is what
 * makes a recovery code single-use. A boolean would leave the caller guessing which of ten codes was
 * just consumed, and the natural wrong answer is to consume none.
 *
 * Every candidate is compared even after a match, so the work is independent of position in the list.
 *
 * ## Why the comparison is unconditional
 *
 * `timingSafeEqual` throws when its arguments differ in length, so the obvious way to write this is to
 * guard it with a length check — and that guard is precisely what breaks the property the paragraph above
 * claims. A short-circuiting `&&` skips the comparison entirely for any stored value of another width,
 * making the work depend on the data rather than on the code being checked.
 *
 * Both sides are therefore decoded from hex into a *fixed-width* buffer, which is sound because these
 * hashes are always 32-byte SHA-256 digests. A stored value that is somehow malformed decodes to fewer
 * bytes and is zero-padded into the same width rather than skipped: it cannot match a real digest, and it
 * costs exactly as much to reject as a correct one does.
 */
export function matchRecoveryCode(input: {
  readonly code: string;
  /** The unspent hashes for this user. Spent ones must not be passed in. */
  readonly hashes: readonly string[];
}): string | null {
  const submitted = Buffer.from(hashRecoveryCode(input.code), 'hex');
  let found: string | null = null;

  for (const candidate of input.hashes) {
    // Fixed width by construction, so every iteration reaches `timingSafeEqual`. `Buffer.from(…, 'hex')`
    // stops at the first non-hex character and `copy` truncates anything longer, so `stored` is always
    // exactly as wide as `submitted` whatever the row holds.
    const stored = Buffer.alloc(submitted.length);
    Buffer.from(candidate, 'hex').copy(stored);

    if (timingSafeEqual(stored, submitted)) {
      found = candidate;
    }
  }

  return found;
}
