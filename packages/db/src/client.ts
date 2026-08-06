import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.js';
import type { CompassDatabase } from './scoped-db.js';

export interface DatabaseHandle {
  readonly db: CompassDatabase;
  readonly pool: Pool;
  close(): Promise<void>;
}

export class MissingDatabaseUrlError extends Error {
  constructor(variable: string) {
    super(
      `${variable} is not set. Copy .env.example to .env, or run \`docker compose up -d postgres\` for local defaults.`,
    );
    this.name = 'MissingDatabaseUrlError';
  }
}

/**
 * The names a direct (non-pooler) connection string arrives under, in preference order.
 *
 * `DATABASE_URL_DIRECT` is what `.env.example` documents and stays first. The two aliases are
 * not speculative generality — they are what managed providers actually provision, and getting
 * this wrong is silent in the worst way. A Supabase project hands out `DIRECT_URL`, and the
 * production deployment of this app was provisioned with `DIRECT_URL` and `MIGRATE_DATABASE_URL`
 * and no `DATABASE_URL_DIRECT` at all. `pnpm db:migrate` therefore refused on a checkout holding
 * a perfectly good direct connection string, so nobody's deploy ever applied a migration — and
 * production sat seven behind, with `/merged` answering a framework 500 because the column
 * `0021` adds was not there.
 *
 * Order matters for one reason beyond taste: `MIGRATE_DATABASE_URL` is by convention the
 * dedicated DDL string, so it outranks the general-purpose `DIRECT_URL`.
 */
const DIRECT_URL_VARIABLES = ['DATABASE_URL_DIRECT', 'MIGRATE_DATABASE_URL', 'DIRECT_URL'] as const;

/**
 * Application queries use the POOLED url. Migrations and pg-boss maintenance
 * use a DIRECT url: a transaction-mode pooler cannot run session DDL or
 * hold the advisory locks a migration runner needs.
 *
 * The pooled fallback to a direct url is deliberate and one-directional. A deployment with only
 * a direct string works, slightly less efficiently; the reverse — running migrations over the
 * pooler — is the failure this split exists to prevent, so `direct` never falls back to
 * `DATABASE_URL`. That fallback used to exist and was worse than the error it avoided: role and
 * session DDL is silently dropped by a transaction-mode pooler, so migrations would report
 * success having applied nothing.
 */
export function resolveDatabaseUrl(kind: 'pooled' | 'direct', env: NodeJS.ProcessEnv = process.env): string {
  const names = kind === 'pooled' ? (['DATABASE_URL', ...DIRECT_URL_VARIABLES] as const) : DIRECT_URL_VARIABLES;

  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value;
  }

  throw new MissingDatabaseUrlError(kind === 'pooled' ? 'DATABASE_URL' : DIRECT_URL_VARIABLES.join(' / '));
}

export function createDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema }) as unknown as CompassDatabase;
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
