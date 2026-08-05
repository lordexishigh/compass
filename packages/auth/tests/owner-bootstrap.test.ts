import {
  DEMO_OWNER_EMAIL,
  DEMO_OWNER_NAME,
  GENERATED_PASSWORD_BYTES,
  MissingOwnerPasswordError,
  OWNER_EMAIL_ENV_VAR,
  OWNER_NAME_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
  configuredOwnerPassword,
  generateOwnerPassword,
  ownerConfigurationProblem,
  ownerCredentialsAreDefault,
  resolveOwnerCredentials,
} from '@compass/auth';
import { describe, expect, it } from 'vitest';

/**
 * The three states the owner environment can be in, and the one that used to be silent.
 *
 * Pure: every function here reads an explicit environment object, so this file needs no
 * database and asserts nothing about provisioning. The database-backed half — that
 * `bootstrapOwner` refuses to provision rather than reporting the problem and carrying on —
 * lives in `apps/worker/tests/cold-start.test.ts`, next to the boot script that calls it.
 */

const CONFIGURED = {
  [OWNER_EMAIL_ENV_VAR]: 'owner@acme.example',
  [OWNER_PASSWORD_ENV_VAR]: 'a-configured-owner-passphrase',
} as const;

describe('there is no password in the source to fall back to', () => {
  /**
   * The defect this file now pins first.
   *
   * `DEMO_OWNER_PASSWORD = 'compass-demo-owner'` was a working owner password compiled into a
   * published package, reachable by any deployment that never set `COMPASS_OWNER_PASSWORD`.
   * `compass/no-credential-literal` fails the build on its return; these assert the behaviour
   * that replaced it, which is what would let somebody quietly reintroduce a default without
   * the literal.
   */
  it('refuses to invent one, naming the variable to set', () => {
    expect(() => resolveOwnerCredentials({})).toThrow(MissingOwnerPasswordError);
    expect(() => resolveOwnerCredentials({})).toThrow(OWNER_PASSWORD_ENV_VAR);
  });

  it('reports no configured password rather than substituting a value', () => {
    expect(configuredOwnerPassword({})).toBeNull();
    expect(configuredOwnerPassword({ [OWNER_PASSWORD_ENV_VAR]: '' })).toBeNull();
  });

  it('resolves against a supplied first-run password, and marks it as unconfigured', () => {
    const generated = generateOwnerPassword();
    const credentials = resolveOwnerCredentials({}, generated);

    expect(credentials.email).toBe(DEMO_OWNER_EMAIL);
    expect(credentials.password).toBe(generated);
    expect(credentials.displayName).toBe(DEMO_OWNER_NAME);
    // Still not a configured deployment: `/api/health` and `/account` must keep saying so.
    expect(credentials.isDefault).toBe(true);
  });

  it('generates a password long enough to clear the product’s own floor, and never twice', () => {
    const first = generateOwnerPassword();
    const second = generateOwnerPassword();

    // base64url of 18 bytes is 24 characters, comfortably past PASSWORD_MIN_LENGTH.
    expect(first.length).toBeGreaterThanOrEqual(GENERATED_PASSWORD_BYTES);
    expect(first.length).toBeGreaterThanOrEqual(12);
    expect(first).not.toBe(second);
    // base64url only, so it survives a JSON file, a log line and a shell without quoting.
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is not a configuration problem, because the zero-config path depends on it', () => {
    expect(ownerConfigurationProblem({})).toBeNull();
  });

  /**
   * `docker-compose.yml` passes `${COMPASS_OWNER_EMAIL:-}` through, so an unset variable
   * arrives as the empty string rather than as `undefined`. If empty were treated as "set",
   * `docker compose up` with nothing configured would be the half-configured state below and
   * would refuse to boot — which is the zero-config promise broken by a shell default.
   */
  it('treats the empty string the compose file passes as unset, not as configured', () => {
    const env = { [OWNER_EMAIL_ENV_VAR]: '', [OWNER_PASSWORD_ENV_VAR]: '', [OWNER_NAME_ENV_VAR]: '' };

    expect(ownerConfigurationProblem(env)).toBeNull();
    expect(configuredOwnerPassword(env)).toBeNull();
    expect(resolveOwnerCredentials(env, generateOwnerPassword()).isDefault).toBe(true);
    expect(resolveOwnerCredentials(env, generateOwnerPassword()).email).toBe(DEMO_OWNER_EMAIL);
  });
});

describe('both variables set: a configured deployment', () => {
  it('resolves what was configured and reports itself as not default', () => {
    const credentials = resolveOwnerCredentials(CONFIGURED);

    expect(credentials.email).toBe('owner@acme.example');
    expect(credentials.password).toBe('a-configured-owner-passphrase');
    expect(credentials.isDefault).toBe(false);
    expect(ownerCredentialsAreDefault(CONFIGURED)).toBe(false);
  });

  it('is not a problem, and a display name remains optional', () => {
    expect(ownerConfigurationProblem(CONFIGURED)).toBeNull();
    expect(resolveOwnerCredentials(CONFIGURED).displayName).toBe(DEMO_OWNER_NAME);
    expect(
      ownerConfigurationProblem({ ...CONFIGURED, [OWNER_NAME_ENV_VAR]: 'Ada Lovelace' }),
    ).toBeNull();
  });
});

describe('one variable set: the state that used to fail open', () => {
  it('refuses an address paired with the published password, naming the missing variable', () => {
    const problem = ownerConfigurationProblem({ [OWNER_EMAIL_ENV_VAR]: 'owner@acme.example' });

    expect(problem).not.toBeNull();
    expect(problem).toContain(OWNER_PASSWORD_ENV_VAR);
    expect(problem).toContain(OWNER_EMAIL_ENV_VAR);
  });

  it('refuses a password with no address, naming the other missing variable', () => {
    const problem = ownerConfigurationProblem({
      [OWNER_PASSWORD_ENV_VAR]: 'a-configured-owner-passphrase',
    });

    expect(problem).not.toBeNull();
    expect(problem).toContain(OWNER_EMAIL_ENV_VAR);
  });

  /**
   * Why the guard is still load-bearing now that the literal is gone.
   *
   * Removing `DEMO_OWNER_PASSWORD` narrowed this failure but did not close it. A half-configured
   * deployment no longer pairs a real address with a password published in this repository — but
   * it still pairs a real address with a password the operator did not choose and will only see
   * if they read a log, while `/api/health` reports the seat as configured-looking. That is a
   * misconfiguration either way, so `bootstrapOwner` still refuses to provision on it.
   */
  it('would still resolve a real address against a password nobody chose', () => {
    const half = { [OWNER_EMAIL_ENV_VAR]: 'owner@acme.example' };
    const generated = generateOwnerPassword();
    const credentials = resolveOwnerCredentials(half, generated);

    expect(credentials.email).toBe('owner@acme.example');
    expect(credentials.password).toBe(generated);
    expect(ownerConfigurationProblem(half)).not.toBeNull();
  });

  it('never echoes the configured password back in the sentence', () => {
    const secret = 'the-operators-own-configured-passphrase';
    const problem = ownerConfigurationProblem({ [OWNER_PASSWORD_ENV_VAR]: secret });

    expect(problem).not.toContain(secret);
  });
});
