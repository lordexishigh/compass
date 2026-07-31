import { defineConfig } from 'drizzle-kit';

/**
 * Migrations run over the DIRECT session connection, never the pooled one:
 * role/session DDL and advisory locks misbehave through a transaction-mode
 * pooler.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT ?? 'postgresql://compass:compass@localhost:5432/compass',
  },
});
