import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase, resolveDatabaseUrl } from './client.js';

/**
 * Where drizzle-kit writes the generated SQL and its journal.
 *
 * Built by joining paths rather than `new URL('../drizzle', import.meta.url)`:
 * bundlers read that form as a module reference and fail to resolve a directory.
 */
export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/**
 * Applies every pending migration over the DIRECT session connection.
 *
 * drizzle's migrator records what it has applied in `drizzle.__drizzle_migrations`,
 * so a second run is a no-op — `pnpm db:migrate` is safe to re-run and safe to
 * run on every boot.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDatabase(connectionString);
  try {
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

const entryPoint = process.argv[1];
const isEntryPoint = entryPoint !== undefined && pathToFileURL(entryPoint).href === import.meta.url;

if (isEntryPoint) {
  // `resolveDatabaseUrl` throws when the environment is not configured, so it
  // belongs inside the same handler as the migration itself. Left at the top
  // level it escapes as an unhandled rejection and Node prints a stack trace
  // over the one line the operator actually needs to read.
  void (async () => {
    try {
      await runMigrations(resolveDatabaseUrl('direct'));
      console.info('[compass] migrations applied');
    } catch (error: unknown) {
      console.error(`[compass] migration failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  })();
}
