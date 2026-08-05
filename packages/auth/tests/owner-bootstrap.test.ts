import {
  DEMO_OWNER_EMAIL,
  DEMO_OWNER_NAME,
  DEMO_OWNER_PASSWORD,
  OWNER_EMAIL_ENV_VAR,
  OWNER_NAME_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
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

describe('neither variable set: the demonstration deployment', () => {
  it('resolves the published demonstration credentials', () => {
    const credentials = resolveOwnerCredentials({});

    expect(credentials.email).toBe(DEMO_OWNER_EMAIL);
    expect(credentials.password).toBe(DEMO_OWNER_PASSWORD);
    expect(credentials.displayName).toBe(DEMO_OWNER_NAME);
    expect(credentials.isDefault).toBe(true);
  });

  it('is not a problem, because the whole zero-config path depends on it', () => {
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
    expect(resolveOwnerCredentials(env).isDefault).toBe(true);
    expect(resolveOwnerCredentials(env).email).toBe(DEMO_OWNER_EMAIL);
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
   * The defect this whole describe block exists for, stated as the thing that was wrong
   * rather than as the guard that now prevents it: resolution still pairs a real address with
   * the published password, so nothing may act on it without consulting the problem first.
   */
  it('still resolves to the combination that made this dangerous, so the guard is load-bearing', () => {
    const half = { [OWNER_EMAIL_ENV_VAR]: 'owner@acme.example' };
    const credentials = resolveOwnerCredentials(half);

    expect(credentials.email).toBe('owner@acme.example');
    expect(credentials.password).toBe(DEMO_OWNER_PASSWORD);
    expect(ownerConfigurationProblem(half)).not.toBeNull();
  });

  it('never echoes the configured password back in the sentence', () => {
    const secret = 'the-operators-own-configured-passphrase';
    const problem = ownerConfigurationProblem({ [OWNER_PASSWORD_ENV_VAR]: secret });

    expect(problem).not.toContain(secret);
  });
});
