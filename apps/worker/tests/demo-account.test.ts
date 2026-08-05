import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEMO_OWNER_EMAIL,
  OWNER_EMAIL_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
  generateOwnerPassword,
} from '@compass/auth';

/**
 * The password a first boot would have minted.
 *
 * Generated once for the whole suite rather than per call, because it stands in for
 * `bootstrapOwner`'s `generatedPassword` - the single copy of a value the database only holds a
 * hash of. There is no `DEMO_OWNER_PASSWORD` to import any more: an unconfigured deployment has
 * no password until one is minted for it.
 */
const GENERATED = generateOwnerPassword();
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEMO_ACCOUNT_FILE_NAME,
  DEMO_ACCOUNT_LOGIN_PATH,
  demoAccountContents,
  demoAccountPath,
  describeDemoAccountFile,
  writeDemoAccountFile,
  type WrittenDemoAccount,
} from '../src/demo-account.js';

/**
 * The machine-readable credentials file.
 *
 * This is a contract with a consumer that is not in this repository — a verification harness
 * reads the file, POSTs two of its fields to the third, and expects a session. So the
 * assertions here are deliberately literal about the shape: exactly three keys, spelled the way
 * they are spelled, because an extra field or a renamed one is a break for somebody whose
 * parser we cannot see.
 *
 * Written into a scratch directory rather than the repository root: a test that wrote the real
 * file would dirty the working tree, and on a machine with configured owner credentials it
 * would overwrite the operator's own file with every run.
 */

/**
 * `writeDemoAccountFile`, asserted to have actually written.
 *
 * It returns null when it cannot know the password — an unconfigured deployment on its second
 * boot — and every call in this suite supplies one, so a null here is a defect rather than a
 * case to handle. Narrowing once keeps the assertions below reading as assertions.
 */
const requireWritten = (options: Parameters<typeof writeDemoAccountFile>[0]): WrittenDemoAccount => {
  const written = writeDemoAccountFile(options);
  if (written === null) throw new Error('writeDemoAccountFile declined to write with a password supplied.');
  return written;
};
const scratch = mkdtempSync(join(tmpdir(), 'compass-demo-account-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('.nous/demo_account.json', () => {
  it('holds exactly the three documented keys, and nothing else', () => {
    const written = requireWritten({ root: scratch, env: {}, generatedPassword: GENERATED });
    const parsed = JSON.parse(readFileSync(written.path, 'utf8')) as Record<string, unknown>;

    // The whole shape, asserted as a set. A fourth key would pass a per-field check.
    expect(Object.keys(parsed).sort()).toEqual(['email', 'login_path', 'password']);
    expect(parsed).toEqual({
      email: DEMO_OWNER_EMAIL,
      password: GENERATED,
      login_path: '/login',
    });
  });

  it('lands at `.nous/demo_account.json` under the given root', () => {
    expect(demoAccountPath(scratch)).toBe(join(scratch, '.nous', DEMO_ACCOUNT_FILE_NAME));
    expect(DEMO_ACCOUNT_FILE_NAME).toBe('demo_account.json');
  });

  it('publishes the login path the route actually serves', () => {
    // `/login` and not `/api/auth/login`: the short address is the stable one, and the two are
    // the same handler. If this drifted, a harness would POST at a 404 and report the product
    // unable to authenticate.
    expect(DEMO_ACCOUNT_LOGIN_PATH).toBe('/login');
    expect(demoAccountContents({}, GENERATED).login_path).toBe('/login');
  });

  it('writes the credentials the bootstrap actually provisions, not a hardcoded pair', () => {
    // The other end of the same wire. `resolveOwnerCredentials` is what `bootstrapOwner` uses to
    // create the seat, so reading it here is what stops the file publishing a password that does
    // not open the account.
    const configured = demoAccountContents({
      [OWNER_EMAIL_ENV_VAR]: 'ops@acme.example',
      [OWNER_PASSWORD_ENV_VAR]: 'a-configured-passphrase',
    });

    expect(configured.email).toBe('ops@acme.example');
    expect(configured.password).toBe('a-configured-passphrase');
    expect(configured.login_path).toBe('/login');
  });

  it('is rewritten rather than appended, so stale credentials cannot outlive a change', () => {
    requireWritten({ root: scratch, env: {}, generatedPassword: GENERATED });
    const second = requireWritten({
      root: scratch,
      env: { [OWNER_EMAIL_ENV_VAR]: 'ops@acme.example', [OWNER_PASSWORD_ENV_VAR]: 'a-configured-passphrase' },
    });

    const parsed = JSON.parse(readFileSync(second.path, 'utf8')) as Record<string, unknown>;
    expect(parsed['email']).toBe('ops@acme.example');
    expect(parsed['password']).toBe('a-configured-passphrase');
    // And it is still one JSON document, not two concatenated.
    expect(readFileSync(second.path, 'utf8').trimEnd().endsWith('}')).toBe(true);
  });

  it('is readable by its owner and nobody else, where the platform enforces that', () => {
    const written = requireWritten({ root: scratch, env: {}, generatedPassword: GENERATED });
    const mode = statSync(written.path).mode & 0o777;

    // Windows does not implement POSIX permission bits, so the assertion is that no *other*
    // user is granted access where the bits mean something. On Windows the mode reads 0o666
    // regardless of what was requested, which is a platform fact rather than a defect here.
    if (process.platform !== 'win32') {
      expect(mode & 0o077).toBe(0);
    }
    expect(mode & 0o400).not.toBe(0);
  });

  it('says out loud whether the password it wrote is the published demonstration one', () => {
    const demonstration = describeDemoAccountFile(
      requireWritten({ root: scratch, env: {}, generatedPassword: GENERATED }),
    );
    const configured = describeDemoAccountFile(
      requireWritten({
        root: scratch,
        env: { [OWNER_EMAIL_ENV_VAR]: 'ops@acme.example', [OWNER_PASSWORD_ENV_VAR]: 'a-configured-passphrase' },
      }),
    );

    expect(demonstration).toContain('generated for this first run');
    expect(demonstration).toContain('/login');
    expect(configured).toContain('configured owner credentials');
    // The log line never carries the password itself — it goes to a terminal and often to a log
    // aggregator, and the file is where the secret belongs.
    expect(demonstration).not.toContain(GENERATED);
    expect(configured).not.toContain('a-configured-passphrase');
  });
});
