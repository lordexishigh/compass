import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { MIGRATIONS_FOLDER, type CompassDatabase } from '@compass/db';

export interface TestDatabase {
  readonly db: CompassDatabase;
  readonly client: PGlite;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A real PostgreSQL 17 in-process, so migrations, check constraints and the
 * organization predicate are exercised against the actual engine rather than a
 * mock. No Docker, no fixtures directory, no shared state between tests.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client);

  return {
    db: db as unknown as CompassDatabase,
    client,
    migrate: async () => {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    close: async () => {
      await client.close();
    },
  };
}
