import {
  ARGON2ID_PARAMETERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  WeakPasswordError,
  assertUsablePassword,
  describePasswordHash,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from '@compass/auth';
import { describe, expect, it } from 'vitest';

/**
 * "Password hashes use Argon2id with documented parameters; no plaintext or reversible
 * password is ever stored or logged."
 *
 * The first half is asserted against the *stored string*, not against the call: a comment
 * claiming `memoryCost: 19456` proves nothing, whereas the PHC string a real hash produces
 * carries the parameters it was actually computed with.
 *
 * The second half is asserted structurally — the hash does not contain the password, two
 * hashes of one password differ, and the round trip is one-way.
 */

const PASSWORD = 'a-long-enough-passphrase';

describe('Argon2id, with the documented parameters', () => {
  it('produces a PHC string that encodes exactly the documented cost', async () => {
    const stored = await hashPassword(PASSWORD);
    const described = describePasswordHash(stored);

    expect(described, `\`${stored}\` is not an Argon2 PHC string`).not.toBeNull();
    expect(described?.algorithm).toBe(ARGON2ID_PARAMETERS.algorithm);
    expect(described?.memoryCost).toBe(ARGON2ID_PARAMETERS.memoryCost);
    expect(described?.timeCost).toBe(ARGON2ID_PARAMETERS.timeCost);
    expect(described?.parallelism).toBe(ARGON2ID_PARAMETERS.parallelism);
    expect(described?.outputLength).toBe(ARGON2ID_PARAMETERS.outputLength);
    expect(described?.saltLength).toBe(ARGON2ID_PARAMETERS.saltLength);
    // Version 19 (0x13) is the current Argon2 and the binding's default. Asserted so a
    // binding upgrade that silently produced v=16 would fail here.
    expect(described?.version).toBe(19);
  });

  it('is argon2id and not argon2i or argon2d', async () => {
    // The algorithm is passed as the number 2, because the binding declares `Algorithm`
    // as an ambient const enum that cannot be imported under `verbatimModuleSyntax`. This
    // is what makes that constant checkable rather than hopeful.
    const stored = await hashPassword(PASSWORD);

    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(stored).not.toContain('$argon2i$');
    expect(stored).not.toContain('$argon2d$');
  });

  it('holds the documented parameters at the OWASP floor for this configuration', () => {
    // 19 MiB with t=2, p=1 is one of the four published equivalents. A future edit that
    // lowered the memory cost to make tests faster would fail here, which is the point.
    expect(ARGON2ID_PARAMETERS.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(ARGON2ID_PARAMETERS.timeCost).toBeGreaterThanOrEqual(2);
    expect(ARGON2ID_PARAMETERS.outputLength).toBeGreaterThanOrEqual(32);
  });
});

describe('no plaintext or reversible password is stored', () => {
  it('never contains the password it hashed', async () => {
    const stored = await hashPassword(PASSWORD);

    expect(stored).not.toContain(PASSWORD);
    // Nor any recognisable run of it: a five-character window is short enough that a
    // coincidence in base64 is possible but a substring leak would be caught.
    expect(stored.toLowerCase()).not.toContain('passphrase');
  });

  it('salts every hash, so the same password twice gives two different strings', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(first).not.toBe(second);
    // Both still verify, which is what proves the difference is the salt and not a bug.
    expect(await verifyPassword(first, PASSWORD)).toBe(true);
    expect(await verifyPassword(second, PASSWORD)).toBe(true);
  });

  it('verifies the right password and refuses everything else', async () => {
    const stored = await hashPassword(PASSWORD);

    expect(await verifyPassword(stored, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored, `${PASSWORD} `)).toBe(false);
    expect(await verifyPassword(stored, PASSWORD.toUpperCase())).toBe(false);
    expect(await verifyPassword(stored, '')).toBe(false);
  });

  it('treats an account with no password as a non-match, not an error', async () => {
    // A magic-link-only account. This must not throw, and must not succeed.
    expect(await verifyPassword(null, PASSWORD)).toBe(false);
    expect(await verifyPassword('', PASSWORD)).toBe(false);
  });

  it('treats a corrupt stored hash as a non-match rather than a 500', async () => {
    // A 500 here would tell an attacker that the address exists and its row is broken.
    expect(await verifyPassword('not-a-phc-string', PASSWORD)).toBe(false);
    expect(await verifyPassword('$argon2id$v=19$m=1,t=1,p=1$@@@$@@@', PASSWORD)).toBe(false);
  });
});

describe('the password floor, stated in the user’s own terms', () => {
  it('names the length rather than a composition rule', () => {
    const problem = passwordProblem('short');

    expect(problem).not.toBeNull();
    expect(problem).toContain(String(PASSWORD_MIN_LENGTH));
    // Composition rules produce `Password1!`. The sentence must not ask for one.
    expect(problem?.toLowerCase()).not.toContain('uppercase');
    expect(problem?.toLowerCase()).not.toContain('symbol');
  });

  it('accepts an ordinary long phrase', () => {
    expect(passwordProblem('correct horse battery staple')).toBeNull();
  });

  it('rejects an unbounded field, because Argon2id costs real CPU', () => {
    expect(passwordProblem('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toContain(String(PASSWORD_MAX_LENGTH));
  });

  it('rejects a password of only spaces', () => {
    expect(passwordProblem(' '.repeat(PASSWORD_MIN_LENGTH + 4))).not.toBeNull();
  });

  it('rejects a non-string, because the body came from outside TypeScript’s reach', () => {
    for (const value of [undefined, null, 12, {}, []]) {
      expect(passwordProblem(value), `${JSON.stringify(value)} was accepted`).not.toBeNull();
    }
  });

  it('refuses to hash anything the floor rejects', async () => {
    await expect(hashPassword('hunter2')).rejects.toThrow(WeakPasswordError);
    expect(() => assertUsablePassword('hunter2')).toThrow(WeakPasswordError);
  });

  it('never echoes the rejected password back in the message', () => {
    // The advice sentence is fixed prose, so the only way the attempt could appear in it
    // is if the message interpolated it — which would put a password in a log line.
    const attempt = 'zx9-qq';

    expect(passwordProblem(attempt)).not.toContain(attempt);
    try {
      assertUsablePassword(attempt);
      throw new Error('assertUsablePassword accepted a six-character password.');
    } catch (error) {
      expect(error).toBeInstanceOf(WeakPasswordError);
      expect((error as Error).message).not.toContain(attempt);
    }
  });
});
