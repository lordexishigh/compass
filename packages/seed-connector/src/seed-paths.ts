import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the seed lives on disk.
 *
 * One constant, used by the generator, the loader, the manifest writer and the
 * no-binary-blob test alike — so `seed/` cannot mean one directory to the
 * generator and another to the gate that polices it.
 */
export const SEED_DIRECTORY_NAME = 'seed';
export const SEED_FIXTURES_DIRECTORY_NAME = 'fixtures';
export const SEED_GENERATED_DIRECTORY_NAME = 'generated';
export const SEED_MANIFEST_FILE_NAME = 'MANIFEST.md';

/** Overrides the discovered location; set by tests that generate into a scratch dir. */
export const SEED_DIRECTORY_ENV_VAR = 'COMPASS_SEED_DIR';

export class SeedDirectoryNotFoundError extends Error {
  constructor(startedFrom: string) {
    super(
      `Could not find the repository root above ${startedFrom}: no ancestor directory contains pnpm-workspace.yaml. ` +
        `Set ${SEED_DIRECTORY_ENV_VAR} to point at the seed directory explicitly.`,
    );
    this.name = 'SeedDirectoryNotFoundError';
  }
}

/** The nearest ancestor holding `pnpm-workspace.yaml`. */
export function findRepositoryRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new SeedDirectoryNotFoundError(startDirectory);
    current = parent;
  }
}

/**
 * Resolves `<repo>/seed`, honouring the environment override. Works from both
 * `src/` under Vitest and `dist/` under a built worker, because it walks up
 * rather than counting directory levels.
 */
export function resolveSeedDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SEED_DIRECTORY_ENV_VAR];
  if (override !== undefined && override.length > 0) return resolve(override);
  return join(findRepositoryRoot(dirname(fileURLToPath(import.meta.url))), SEED_DIRECTORY_NAME);
}

export const seedFixturesDirectory = (seedDirectory: string): string =>
  join(seedDirectory, SEED_FIXTURES_DIRECTORY_NAME);

export const seedGeneratedDirectory = (seedDirectory: string): string =>
  join(seedDirectory, SEED_GENERATED_DIRECTORY_NAME);

export const seedManifestPath = (seedDirectory: string): string => join(seedDirectory, SEED_MANIFEST_FILE_NAME);
