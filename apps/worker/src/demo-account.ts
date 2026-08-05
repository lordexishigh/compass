import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEMO_ACCOUNT_LOGIN_PATH,
  configuredOwnerPassword,
  resolveOwnerCredentials,
  type OwnerEnvironment,
} from '@compass/auth';
import { findRepositoryRoot } from '@compass/seed-connector';

/**
 * The machine-readable credentials file.
 *
 * ## What it is for
 *
 * Automated verification has to be able to sign in. Every flow worth checking — seats,
 * the roster, feedback, time travel — sits behind a session, so a harness that can only
 * reach `/` can only check the one page that needs no session. Publishing the
 * credentials in prose on `/account` solves that for a human and not for a script, which
 * is what this file is: the same two strings, in the one shape a script can read without
 * parsing a page.
 *
 * ## Why exactly three keys
 *
 * `{email, password, login_path}` and nothing else. The shape is a contract with a
 * consumer that is not in this repository, so an extra field is not a free addition —
 * it is a thing somebody's parser may or may not tolerate. `login_path` is included
 * rather than assumed because the endpoint that accepts these two strings is a decision
 * of this codebase, and a harness should not have to guess it from a convention.
 *
 * ## Why writing a password to disk is acceptable here, and where it is not
 *
 * `.nous/` is gitignored, so the file cannot be committed, and it is written with owner
 * only permissions. What makes it *safe* rather than merely hidden is what the password
 * usually is: the published demonstration credential from `@compass/auth`, which is in
 * the source, in the README and on `/account` — writing it to a file discloses nothing.
 *
 * A deployment that has configured `COMPASS_OWNER_PASSWORD` is a different case, and the
 * file is deliberately still written with that value: this runs from the seed and the
 * cold start, which are development and demonstration entry points, and a harness
 * pointed at a configured deployment needs the credential that actually opens the seat —
 * a file that silently held the *wrong* password would be worse than one that holds a
 * real one. `writtenCredentialsAreDefault` is on the result so the caller can say so out
 * loud in its log line, which `describeDemoAccountFile` does.
 */

export const DEMO_ACCOUNT_DIRECTORY_NAME = '.nous';
export const DEMO_ACCOUNT_FILE_NAME = 'demo_account.json';

/**
 * Where the credentials are POSTed.
 *
 * `/login` rather than `/api/auth/login`: the two are the same handler reached by two
 * addresses, and this is the stable one. See `apps/web/app/login/route.ts` for why the alias
 * exists.
 *
 * Re-exported rather than declared. The value lives in `@compass/auth` because three packages
 * have to agree on it — this writer, the role matrix, and the route on disk — and a literal in
 * each would be three chances for a harness to POST at a 404.
 */
export { DEMO_ACCOUNT_LOGIN_PATH };

/** Exactly the shape the file holds. No optional fields, no extras. */
export interface DemoAccountFile {
  readonly email: string;
  readonly password: string;
  readonly login_path: string;
}

export interface WrittenDemoAccount {
  readonly path: string;
  readonly contents: DemoAccountFile;
  /** False when the deployment configured its own owner, so the log line can say so. */
  readonly writtenCredentialsAreDefault: boolean;
}

/**
 * The repository root, found by walking up rather than counting levels.
 *
 * The same resolver the seed loader uses, so this file lands beside `seed/` whether the
 * caller is `tsx src/…` under a workspace script or `node dist/…` in the container.
 */
export const repositoryRoot = (): string => findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));

export const demoAccountDirectory = (root: string = repositoryRoot()): string =>
  join(root, DEMO_ACCOUNT_DIRECTORY_NAME);

export const demoAccountPath = (root: string = repositoryRoot()): string =>
  join(demoAccountDirectory(root), DEMO_ACCOUNT_FILE_NAME);

/**
 * The contents, from the same resolver the bootstrap provisions the seat with.
 *
 * Reading `resolveOwnerCredentials` rather than the demonstration constants is what keeps
 * the file and the seat in step: a deployment that set `COMPASS_OWNER_PASSWORD` gets a
 * file holding the password that works, and there is no path by which the two disagree.
 */
export function demoAccountContents(
  env: OwnerEnvironment = process.env,
  generatedPassword: string | null = null,
): DemoAccountFile {
  const credentials = resolveOwnerCredentials(env, generatedPassword);

  return {
    email: credentials.email,
    password: credentials.password,
    login_path: DEMO_ACCOUNT_LOGIN_PATH,
  };
}

/**
 * Writes the file, creating `.nous/` if it is not there.
 *
 * Idempotent and unconditional: it is rewritten on every seed and every cold start rather
 * than only when it is missing, so a stale file left by an earlier run with different
 * credentials cannot outlive them. Two spaces and a trailing newline because a person
 * does read this file, usually while working out why their harness cannot sign in.
 */
export function writeDemoAccountFile(
  options: {
    readonly root?: string;
    readonly env?: OwnerEnvironment;
    /**
     * The password this boot minted, from `bootstrapOwner`'s `generatedPassword`.
     *
     * Required whenever `COMPASS_OWNER_PASSWORD` is unset, because it is then the only copy in
     * existence — the database holds an Argon2id digest and nothing that can be read back.
     */
    readonly generatedPassword?: string | null;
  } = {},
): WrittenDemoAccount | null {
  const root = options.root ?? repositoryRoot();
  const env = options.env ?? process.env;
  const generated = options.generatedPassword ?? null;

  /**
   * Nothing configured and nothing minted: leave the existing file alone and say nothing.
   *
   * This is the second and later boot of an unconfigured deployment. The seat exists on a
   * password minted by the boot that created it, and *this* process cannot learn it. The old
   * behaviour — rewrite unconditionally from `resolveOwnerCredentials` — was safe only while a
   * literal default made every boot agree; with a generated password it would overwrite a
   * working credential with one the database has never seen, which is precisely the "file
   * silently holding the wrong password" this module's own comment warns against.
   */
  if (configuredOwnerPassword(env) === null && generated === null) return null;

  const contents = demoAccountContents(env, generated);
  const path = demoAccountPath(root);

  mkdirSync(demoAccountDirectory(root), { recursive: true });
  // 0o600: readable by the account that ran the seed and by nobody else on the machine.
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  return {
    path,
    contents,
    writtenCredentialsAreDefault: configuredOwnerPassword(env) === null,
  };
}

/** One line an operator can read to know the harness has what it needs. */
export function describeDemoAccountFile(written: WrittenDemoAccount): string {
  const provenance = written.writtenCredentialsAreDefault
    ? 'the owner password generated for this first run'
    : 'this deployment’s configured owner credentials';

  return (
    `[compass] wrote ${written.path} with ${provenance} — ` +
    `POST {email, password} to ${written.contents.login_path} to sign in.`
  );
}
