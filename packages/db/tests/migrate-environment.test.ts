import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRootEnvironment } from '../src/migrate.js';

/**
 * Which file wins, for the one command that runs DDL.
 *
 * `loadRootEnvironment` applies the *first* assignment it sees for a name and skips the rest, so
 * the file order is the precedence and it necessarily reads backwards — highest priority first.
 * That inverts silently: with the list the other way round nothing throws, no test that only
 * checks "a value was loaded" fails, and the function simply resolves the wrong database.
 *
 * On this module the consequence is the sharp one. A developer with committed defaults in `.env`
 * and a scratch database in `.env.local` runs `pnpm db:migrate` and applies DDL to the shared
 * database. So the precedence is asserted in both directions rather than described in a comment —
 * the comment claiming it was already there while the code did the opposite is exactly how this
 * shipped.
 *
 * The function takes its root and its environment as parameters for this test's benefit, which is
 * also why the test cannot corrupt the real `process.env` or read the repository's own `.env`.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'compass-env-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (file: string, body: string): void => writeFileSync(join(root, file), body, 'utf8');

describe('the migration runner reads the environment in the documented order', () => {
  it('lets `.env.local` beat `.env`, so a local override aims the migration where it was meant', () => {
    write('.env', 'DATABASE_URL_DIRECT=postgresql://shared/committed-default');
    write('.env.local', 'DATABASE_URL_DIRECT=postgresql://localhost/scratch');

    const env: NodeJS.ProcessEnv = {};
    loadRootEnvironment(root, env);

    expect(
      env['DATABASE_URL_DIRECT'],
      'a developer overriding the shared default in .env.local must not have DDL applied to the shared database',
    ).toBe('postgresql://localhost/scratch');
  });

  it('lets a real environment variable beat both files', () => {
    write('.env', 'DATABASE_URL_DIRECT=postgresql://shared/committed-default');
    write('.env.local', 'DATABASE_URL_DIRECT=postgresql://localhost/scratch');

    // What CI and a hosted deploy do: pass the connection string directly.
    const env: NodeJS.ProcessEnv = { DATABASE_URL_DIRECT: 'postgresql://ci/target' };
    loadRootEnvironment(root, env);

    expect(env['DATABASE_URL_DIRECT']).toBe('postgresql://ci/target');
  });

  it('still takes a name that only one of the two files declares', () => {
    // The ordering must not turn into "`.env` is ignored when `.env.local` exists".
    write('.env', 'MIGRATE_DATABASE_URL=postgresql://shared/migrate\nDATABASE_URL=postgresql://shared/pooled');
    write('.env.local', 'DATABASE_URL=postgresql://localhost/pooled');

    const env: NodeJS.ProcessEnv = {};
    loadRootEnvironment(root, env);

    expect(env['MIGRATE_DATABASE_URL']).toBe('postgresql://shared/migrate');
    expect(env['DATABASE_URL']).toBe('postgresql://localhost/pooled');
  });

  it('treats an empty assignment as unset, so a blank line in `.env.local` does not mask `.env`', () => {
    write('.env', 'DATABASE_URL_DIRECT=postgresql://shared/committed-default');
    write('.env.local', 'DATABASE_URL_DIRECT=');

    const env: NodeJS.ProcessEnv = {};
    loadRootEnvironment(root, env);

    expect(env['DATABASE_URL_DIRECT']).toBe('postgresql://shared/committed-default');
  });

  it('is silent when neither file exists, which is the normal case in CI', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadRootEnvironment(root, env)).not.toThrow();
    expect(Object.keys(env)).toEqual([]);
  });

  it('strips surrounding quotes without touching a `#` inside the value', () => {
    // A password can legitimately contain `#`; treating it as a comment would truncate the string
    // into a connection that fails to authenticate rather than one that fails to parse.
    write('.env.local', 'DATABASE_URL_DIRECT="postgresql://u:pa#ss@host:5432/db"');

    const env: NodeJS.ProcessEnv = {};
    loadRootEnvironment(root, env);

    expect(env['DATABASE_URL_DIRECT']).toBe('postgresql://u:pa#ss@host:5432/db');
  });
});
