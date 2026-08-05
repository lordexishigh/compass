import {
  InvalidBase32Error,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  normaliseRecoveryCode,
  totpCodeForStep,
  totpEnrollmentUri,
  totpStepFor,
  verifyTotpCode,
} from '@compass/auth';
import { addSeconds, instantFromEpochMillis, type Instant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

/**
 * TOTP and recovery codes, against the RFC's own vectors and the replay criterion.
 *
 * The interesting assertions here are not "does it produce six digits". They are:
 *
 *  - the algorithm matches **RFC 6238 Appendix B**, which is the only evidence that a hand-written
 *    implementation is the same one every authenticator app implements;
 *  - a code presented twice inside one time step is **refused**, which is the acceptance criterion and
 *    the property naive implementations lack;
 *  - a recovery code is single-use and never stored in the clear.
 */

/** RFC 6238 Appendix B publishes vectors for the ASCII secret `12345678901234567890`. */
const RFC_SECRET_BYTES = new TextEncoder().encode('12345678901234567890');
const RFC_SECRET = base32Encode(RFC_SECRET_BYTES);

const at = (epochSeconds: number): Instant => instantFromEpochMillis(epochSeconds * 1000);

describe('base32, because that is what an authenticator app reads', () => {
  it('round-trips the RFC secret', () => {
    expect([...base32Decode(RFC_SECRET)]).toEqual([...RFC_SECRET_BYTES]);
  });

  it('encodes the RFC secret to the published base32 form', () => {
    // `12345678901234567890` in base32. If this drifts, every code below is wrong for a real app.
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('tolerates how a person retypes a secret: lower case, spaces, padding', () => {
    const typed = ` ${RFC_SECRET.toLowerCase().slice(0, 8)} ${RFC_SECRET.toLowerCase().slice(8)} ==`;
    expect([...base32Decode(typed)]).toEqual([...RFC_SECRET_BYTES]);
  });

  it('refuses a malformed secret rather than silently truncating it', () => {
    // A truncated secret produces codes that never match, and a person locked out with no reason.
    expect(() => base32Decode('ABC!DEF')).toThrow(InvalidBase32Error);
  });

  it('generates a secret an app can read', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    // 20 bytes is 160 bits, which is 32 base32 characters.
    expect(secret).toHaveLength(32);
    expect(generateTotpSecret()).not.toBe(secret);
  });
});

describe('the algorithm matches RFC 6238 Appendix B', () => {
  /**
   * The published SHA-1 vectors, truncated to six digits.
   *
   * The RFC tabulates eight digits; every consumer app shows six, so the expected values are the last
   * six of the published figures. Asserting these is the whole reason a hand-written implementation is
   * defensible — it is checked against the specification rather than against itself.
   */
  const VECTORS: readonly (readonly [number, string])[] = [
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ];

  it.each(VECTORS)('at unix time %i the code is %s', (epochSeconds, expected) => {
    expect(totpCodeForStep(RFC_SECRET, totpStepFor(at(epochSeconds)))).toBe(expected);
  });

  it('produces exactly six digits, zero-padded', () => {
    for (const [epochSeconds] of VECTORS) {
      const code = totpCodeForStep(RFC_SECRET, totpStepFor(at(epochSeconds)));
      expect(code).toHaveLength(TOTP_DIGITS);
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });

  it('advances the step every 30 seconds and not before', () => {
    const start = at(1_111_111_080);
    expect(totpStepFor(start)).toBe(totpStepFor(addSeconds(start, TOTP_STEP_SECONDS - 1)));
    expect(totpStepFor(addSeconds(start, TOTP_STEP_SECONDS))).toBe(totpStepFor(start) + 1);
  });
});

describe('a valid code is accepted once and only once', () => {
  const NOW = at(1_111_111_111);
  const codeNow = () => totpCodeForStep(RFC_SECRET, totpStepFor(NOW));

  it('accepts a correct code and reports the step it belongs to', () => {
    const verdict = verifyTotpCode({ secret: RFC_SECRET, code: codeNow(), now: NOW, lastUsedStep: null });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    // The caller persists this. It is what makes the replay below fail.
    expect(verdict.step).toBe(totpStepFor(NOW));
  });

  it('refuses the same code a second time inside the same time step', () => {
    /**
     * The acceptance criterion, and the property the signature exists to force.
     *
     * The first verification returns its step; feeding that back as `lastUsedStep` is how a caller
     * records the code as spent. A second presentation of the *same* code — a double-submitted form, or
     * somebody replaying one they intercepted — is refused, and Compass cannot tell those apart so it
     * refuses both.
     */
    const first = verifyTotpCode({ secret: RFC_SECRET, code: codeNow(), now: NOW, lastUsedStep: null });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    const replay = verifyTotpCode({
      secret: RFC_SECRET,
      code: codeNow(),
      now: NOW,
      lastUsedStep: first.step,
    });

    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('a replayed code was accepted');
    expect(replay.reason).toBe('replayed');
  });

  it('accepts the next step’s code after the clock moves on', () => {
    const spentStep = totpStepFor(NOW);
    const later = addSeconds(NOW, TOTP_STEP_SECONDS);

    const verdict = verifyTotpCode({
      secret: RFC_SECRET,
      code: totpCodeForStep(RFC_SECRET, totpStepFor(later)),
      now: later,
      lastUsedStep: spentStep,
    });

    expect(verdict.ok).toBe(true);
  });

  it('refuses an *earlier* step’s code even though it is inside the drift window', () => {
    /**
     * The subtler replay, and the reason the check is `<=` rather than `===`.
     *
     * A ±1-step window means the previous step's code is still arithmetically valid. If a person has
     * already signed in with step N, a code from step N−1 is equally a replay — and a naive "is this the
     * exact step we already used" test would let it through.
     */
    const previous = totpCodeForStep(RFC_SECRET, totpStepFor(NOW) - 1);

    const verdict = verifyTotpCode({
      secret: RFC_SECRET,
      code: previous,
      now: NOW,
      lastUsedStep: totpStepFor(NOW),
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('replayed');
  });

  it('accepts one step of clock drift in each direction', () => {
    // A person whose phone is a few seconds off must not be locked out.
    for (const offset of [-1, 0, 1]) {
      const verdict = verifyTotpCode({
        secret: RFC_SECRET,
        code: totpCodeForStep(RFC_SECRET, totpStepFor(NOW) + offset),
        now: NOW,
        lastUsedStep: null,
      });
      expect(verdict.ok, `a code ${offset} step away was refused`).toBe(true);
    }
  });

  it('refuses a code two steps away', () => {
    const verdict = verifyTotpCode({
      secret: RFC_SECRET,
      code: totpCodeForStep(RFC_SECRET, totpStepFor(NOW) + 2),
      now: NOW,
      lastUsedStep: null,
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('no_match');
  });

  it('tolerates how a person types a code, and refuses one that is not six digits', () => {
    const spaced = ` ${codeNow().slice(0, 3)} ${codeNow().slice(3)} `;
    expect(verifyTotpCode({ secret: RFC_SECRET, code: spaced, now: NOW, lastUsedStep: null }).ok).toBe(true);

    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34']) {
      const verdict = verifyTotpCode({ secret: RFC_SECRET, code: bad, now: NOW, lastUsedStep: null });
      expect(verdict.ok, `\`${bad}\` was accepted`).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('malformed');
    }
  });

  it('refuses a code for another secret', () => {
    const other = generateTotpSecret();
    const verdict = verifyTotpCode({
      secret: RFC_SECRET,
      code: totpCodeForStep(other, totpStepFor(NOW)),
      now: NOW,
      lastUsedStep: null,
    });

    expect(verdict.ok).toBe(false);
  });
});

describe('the enrollment URI an authenticator app scans', () => {
  it('carries the secret, the issuer and the parameters an app needs', () => {
    const uri = totpEnrollmentUri({ secret: RFC_SECRET, accountEmail: 'owner@example.com' });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=Compass');
    // Stated rather than left to an app's defaults: an app assuming SHA-256 would show wrong codes.
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain(`digits=${TOTP_DIGITS}`);
    expect(uri).toContain(`period=${TOTP_STEP_SECONDS}`);
  });

  it('names the issuer in the label as well as the parameter', () => {
    // Older apps read only the label; newer ones only the parameter. Both, so neither shows an
    // unlabelled account.
    const uri = totpEnrollmentUri({ secret: RFC_SECRET, accountEmail: 'owner@example.com' });
    expect(decodeURIComponent(uri)).toContain('Compass:owner@example.com');
  });

  it('escapes an address that would otherwise break the URI', () => {
    const uri = totpEnrollmentUri({ secret: RFC_SECRET, accountEmail: 'a+b/c@example.com' });
    expect(uri).not.toContain('a+b/c@example.com');
    expect(decodeURIComponent(uri)).toContain('a+b/c@example.com');
  });
});

describe('recovery codes', () => {
  it('issues a batch a person can read off paper', () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    // Ten distinct codes, not one repeated ten times.
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('excludes the characters a person misreads', () => {
    // No 0/O, no 1/I/L. Somebody typing these has just lost their phone.
    const alphabet = new Set(generateRecoveryCodes(200).join('').replace(/-/g, ''));
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      expect(alphabet.has(ambiguous), `${ambiguous} is ambiguous on paper`).toBe(false);
    }
  });

  it('is never stored in the clear', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normaliseRecoveryCode(code));
  });

  it('hashes the same however the code was typed', () => {
    const code = generateRecoveryCode();

    // An authenticator screen shows `ABCD-EFGH`; a person may type `abcdefgh`. Both are the same code.
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code.replace('-', ''))).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(` ${code} `)).toBe(hashRecoveryCode(code));
  });

  it('identifies which stored hash was used, so the caller can spend that one', () => {
    /**
     * Returning the hash rather than a boolean is what makes single-use implementable.
     *
     * A boolean would leave the caller to guess which of ten codes had just been consumed, and the
     * natural wrong answer is to consume none — which turns ten single-use codes into ten codes that
     * work forever.
     */
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    const used = codes[4] as string;

    expect(matchRecoveryCode({ code: used, hashes })).toBe(hashRecoveryCode(used));
  });

  it('refuses a code once its hash is no longer among the unspent ones', () => {
    // Which is how the repository enforces single use: the spent row is not passed in again.
    const codes = generateRecoveryCodes();
    const used = codes[0] as string;
    const remaining = codes.slice(1).map(hashRecoveryCode);

    expect(matchRecoveryCode({ code: used, hashes: remaining })).toBeNull();
  });

  it('refuses a code that was never issued, and an empty list', () => {
    const hashes = generateRecoveryCodes().map(hashRecoveryCode);

    expect(matchRecoveryCode({ code: 'ZZZZ-ZZZZ', hashes })).toBeNull();
    expect(matchRecoveryCode({ code: generateRecoveryCode(), hashes: [] })).toBeNull();
  });
});
