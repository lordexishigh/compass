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
 * Application queries use the POOLED url. Migrations and pg-boss maintenance
 * use DATABASE_URL_DIRECT: a transaction-mode pooler cannot run session DDL or
 * hold the advisory locks a migration runner needs.
 */
export function resolveDatabaseUrl(kind: 'pooled' | 'direct', env: NodeJS.ProcessEnv = process.env): string {
  const variable = kind === 'pooled' ? 'DATABASE_URL' : 'DATABASE_URL_DIRECT';
  const value = env[variable] ?? (kind === 'pooled' ? env['DATABASE_URL_DIRECT'] : env['DATABASE_URL']);
  if (!value || value.trim().length === 0) {
    throw new MissingDatabaseUrlError(variable);
  }
  return value;
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
