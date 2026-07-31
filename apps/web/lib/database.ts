import { createDatabase, resolveDatabaseUrl, type CompassDatabase, type DatabaseHandle } from '@compass/db';

/**
 * The process's connection pool. One module, so nothing has to import a heavier one to
 * reach it.
 *
 * This used to live in `report-source.ts`, which was fine until two other callers needed
 * it. `lib/health.ts` in particular must not import the report path: `/api/health` is the
 * endpoint the container's own `HEALTHCHECK` polls and the one place an operator looks when
 * something is wrong, so it has to be the *lightest* and most robust route in the app —
 * not the one that transitively loads the analysis core, the narrator and the seeded
 * connector before it can answer "is the database reachable".
 *
 * ## One pool per process, cached across hot reloads
 *
 * Next.js re-evaluates modules on every edit in development. Without the symbol cache the
 * dev server opens a new pool per reload and PostgreSQL runs out of connections within a
 * few minutes of ordinary work. The same cache is what lets `/api/health` check
 * connectivity without opening and tearing down a pool on every ten-second interval.
 */
const POOL_KEY = Symbol.for('compass.web.database');
type PoolGlobal = typeof globalThis & { [POOL_KEY]?: DatabaseHandle };

export function database(): CompassDatabase {
  const cache = globalThis as PoolGlobal;
  const existing = cache[POOL_KEY];
  if (existing !== undefined) return existing.db;

  const handle = createDatabase(resolveDatabaseUrl('pooled'));
  cache[POOL_KEY] = handle;
  return handle.db;
}
