import { randomBytes } from 'node:crypto';

import { argon2Verify, argon2id } from 'hash-wasm';

/**
 * Password hashing. Argon2id, with the parameters written down.
 *
 * ## The parameters, and why these
 *
 * | parameter    | value      | why |
 * | ------------ | ---------- | --- |
 * | algorithm    | Argon2id   | The hybrid. Argon2i alone is weak to time-memory trade-offs; Argon2d alone is weak to side channels. RFC 9106 names Argon2id as the choice when you do not have a specific reason for another. |
 * | memory cost  | 19456 KiB  | 19 MiB. The OWASP minimum for the `t=2, p=1` configuration. Memory is what makes a GPU farm expensive; iterations alone are not. |
 * | time cost    | 2          | Iterations. The pair (19 MiB, 2) is one of the four OWASP-published equivalents. |
 * | parallelism  | 1          | One lane. A route handler hashing a password is already on one request's thread, and lanes above 1 buy nothing here while making the cost harder to reason about. |
 * | output       | 32 bytes   | 256 bits of tag. |
 * | salt         | 16 bytes   | Fresh from `node:crypto.randomBytes` on every single hash. Never reused, never derived from the email, never a constant. |
 *
 * These are exported as `ARGON2ID_PARAMETERS` so the test suite can assert the *stored*
 * hash actually encodes them, rather than trusting that this comment describes the call
 * below. `describePasswordHash` reads them back out of the PHC string.
 *
 * ## Why WASM and not a native binding
 *
 * `hash-wasm` compiles Argon2 to WebAssembly and inlines it, so the package contains no
 * platform-specific binary. That matters for two concrete failures this project would
 * otherwise have shipped:
 *
 *  - **`next build` cannot bundle a `.node` file.** A native binding reaches webpack as
 *    bytes and the build fails with `Module parse failed: Unexpected character`.
 *    `serverExternalPackages` does not cover it, because the binary lives in a *separate*
 *    per-platform package that the externals list does not name.
 *  - **`docker compose up` must work on a clean checkout.** A native addon pulls
 *    per-platform optional dependencies into `pnpm-lock.yaml`, and a lockfile resolved on
 *    one platform then installed with `--frozen-lockfile` on another is exactly the sort
 *    of thing that breaks a build nobody can reproduce locally.
 *
 * The cost is one thing: `hash-wasm` will not invent the salt, so this file generates it.
 * That is a real responsibility and it is discharged in exactly one place, below.
 *
 * ## What is never done
 *
 * A plaintext or reversible password is never stored, logged, returned in a response, or
 * put in an error message. The only functions here take a password and give back a digest
 * or a boolean; neither ever echoes its input. `hashPassword`'s result is a PHC string —
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>` — which carries its own parameters, so
 * raising the cost later verifies old hashes without a migration.
 */

export const ARGON2ID_PARAMETERS = {
  algorithm: 'argon2id',
  /** KiB of memory per hash. */
  memoryCost: 19_456,
  /** Passes over that memory. */
  timeCost: 2,
  /** Lanes. */
  parallelism: 1,
  /** Bytes of tag. */
  outputLength: 32,
  /** Bytes of per-hash salt, drawn from the OS CSPRNG. */
  saltLength: 16,
} as const;

/**
 * The floor a password has to clear, and the ceiling that stops a denial of service.
 *
 * 12 characters rather than a composition rule (one upper, one digit, one symbol):
 * length is the property that actually resists guessing, and composition rules reliably
 * produce `Password1!`. 128 is the upper bound because Argon2id costs real CPU and an
 * unbounded field is a free way to burn a core.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export class WeakPasswordError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'WeakPasswordError';
    this.detail = detail;
  }
}

/**
 * Checks a candidate password and says what is wrong in the user's own terms.
 *
 * Returns the reason rather than throwing, so a form can show it beside the field. The
 * reason never quotes the password back.
 */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Enter a password.';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. Length is what resists guessing; a longer ordinary phrase beats a short cryptic one.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (password.trim().length === 0) {
    return 'A password of only spaces is not one.';
  }
  return null;
}

export function assertUsablePassword(password: unknown): asserts password is string {
  const problem = passwordProblem(password);
  if (problem !== null) throw new WeakPasswordError(problem);
}

/**
 * Hashes a password with the parameters above. Returns a PHC string.
 *
 * The salt is 16 fresh bytes from the OS CSPRNG on every call. It is generated here and
 * nowhere else, and it is never derived from anything — a salt derived from the email
 * would be the same salt for the same person forever, which is most of what a salt exists
 * to prevent.
 */
export async function hashPassword(password: string): Promise<string> {
  assertUsablePassword(password);

  return argon2id({
    password,
    salt: randomBytes(ARGON2ID_PARAMETERS.saltLength),
    iterations: ARGON2ID_PARAMETERS.timeCost,
    parallelism: ARGON2ID_PARAMETERS.parallelism,
    memorySize: ARGON2ID_PARAMETERS.memoryCost,
    hashLength: ARGON2ID_PARAMETERS.outputLength,
    // The PHC string, so the stored value carries the parameters it was computed with.
    outputType: 'encoded',
  });
}

/**
 * Whether a password matches a stored hash.
 *
 * A null hash — an account that has only ever signed in by link — is a non-match rather
 * than an error. The parameters come from the stored string rather than from the constants
 * above, which is what lets the cost be raised without a migration.
 */
export async function verifyPassword(storedHash: string | null, password: string): Promise<boolean> {
  if (storedHash === null || storedHash.length === 0) return false;
  if (typeof password !== 'string' || password.length === 0) return false;

  try {
    return await argon2Verify({ password, hash: storedHash });
  } catch {
    // A malformed hash is a corrupt row, not a correct password. Swallowed rather than
    // propagated because the alternative is a 500 that tells an attacker the address
    // exists and its row is broken.
    return false;
  }
}

/**
 * The parameters a PHC string actually encodes.
 *
 * Exists so a test can prove the hash on disk was produced with the documented cost,
 * which is the one claim in this file a comment cannot make true. Returns null for
 * anything that is not an Argon2 PHC string.
 */
export function describePasswordHash(storedHash: string): {
  readonly algorithm: string;
  readonly version: number;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly saltLength: number;
  readonly outputLength: number;
} | null {
  // $argon2id$v=19$m=19456,t=2,p=1$<b64 salt>$<b64 tag>
  const match = /^\$(argon2(?:id|i|d))\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(storedHash);
  if (match === null) return null;

  const [, algorithm, version, memoryCost, timeCost, parallelism, salt, tag] = match;
  if (
    algorithm === undefined ||
    version === undefined ||
    memoryCost === undefined ||
    timeCost === undefined ||
    parallelism === undefined ||
    salt === undefined ||
    tag === undefined
  ) {
    return null;
  }

  return {
    algorithm,
    version: Number.parseInt(version, 10),
    memoryCost: Number.parseInt(memoryCost, 10),
    timeCost: Number.parseInt(timeCost, 10),
    parallelism: Number.parseInt(parallelism, 10),
    saltLength: Buffer.from(salt, 'base64').length,
    outputLength: Buffer.from(tag, 'base64').length,
  };
}
