import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase, resolveDatabaseUrl } from './client.js';

/** The repository root, three levels up from `packages/db/src`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Loads the monorepo's own `.env` files, the way `apps/web/next.config.ts` already does.
 *
 * ## Why this is here, and why its absence was expensive
 *
 * Every environment file Compass documents lives at the repository root — `.env.example` says
 * "copy this to `.env`" and sits beside the compose file. But `pnpm db:migrate` runs
 * `tsx src/migrate.ts` with its cwd inside `packages/db`, and nothing had ever read those files
 * for it. So on a checkout with a perfectly good direct connection string at the root, the
 * migrate command answered *"DATABASE_URL_DIRECT is not set"* and exited 1.
 *
 * The consequence was not a broken command; it was a broken *deployment*. Nobody's deploy applied
 * a migration, production drifted seven behind the schema its code expected, and the first thing
 * anybody saw was `/merged` returning a framework 500 from a `SELECT` naming a column that had
 * never been added. A migration runner that cannot find the database on a correctly configured
 * machine is a migration runner nobody runs.
 *
 * Precedence matches the web app's exactly, and it is the part worth getting right: `.env.local`
 * wins over `.env`, and **anything already in `process.env` wins over both**. CI and a hosted
 * deploy pass the connection string as a real environment variable, and a `.env.local` left on a
 * developer's machine must never redirect a migration at a database it was not aimed at.
 */
function loadRootEnvironment(): void {
  for (const file of ['.env', '.env.local']) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      // Absent is the normal case in CI and on a hosted deploy, which pass the environment
      // directly. A missing file is not a failure and must not be reported as one.
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (assignment === null) continue;

      const name = assignment[1]!;
      // Surrounding quotes are stripped; nothing inside them is. A connection string can contain
      // `#`, so this deliberately does not treat one as a trailing comment.
      const value = assignment[2]!.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');

      const existing = process.env[name];
      if (existing !== undefined && existing.length > 0) continue;
      process.env[name] = value;
    }
  }
}

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
      // Before the resolve, not before the import: the loader must not run for a caller that
      // imported `runMigrations` as a library and passed its own connection string.
      loadRootEnvironment();
      await runMigrations(resolveDatabaseUrl('direct'));
      console.info('[compass] migrations applied');
    } catch (error: unknown) {
      console.error(`[compass] migration failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  })();
}
