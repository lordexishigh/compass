import { sql } from 'drizzle-orm';

import type { CompassDatabase } from './scoped-db.js';

/**
 * How much work is waiting in the queue, by pg-boss state.
 *
 * ## Why this is not in `src/repositories`
 *
 * Everything under `repositories/` takes an organization scope as its first parameter, and
 * `tests/scoped-repositories.test.ts` enforces that by parsing the directory — which is exactly
 * right, because every Compass table carries an `organization_id` and a query without that
 * predicate is a cross-tenant read waiting to happen.
 *
 * The queue is the one thing in this database that genuinely has no organization. `pgboss.job`
 * belongs to pg-boss, whose schema has no tenant column and whose jobs are the *deployment's* work
 * rather than any organization's. Putting this in `repositories/` would have meant either weakening
 * that gate or inventing a scope parameter this function has nothing to do with — both worse than
 * putting the file where its shape is honest. The readiness payload labels the number accordingly:
 * queue depth is deployment-wide, and the two last-success instants beside it are per-organization.
 *
 * ## Why the table is read and never declared
 *
 * pg-boss owns and migrates its own schema. Declaring `pgboss.job` in `src/schema` would make it
 * Compass's: `migrations.test.ts` would demand it carry `organization_id`, the schema-vs-migration
 * drift tripwire would compare our column list against pg-boss's, and the next pg-boss upgrade would
 * fail tests that have no business having an opinion about it.
 */
export interface QueueDepth {
  /** Jobs accepted and not yet started. */
  readonly queued: number;
  /** Jobs a worker is running now. */
  readonly active: number;
  /** Jobs that exhausted their retries. The number worth alerting on. */
  readonly failed: number;
}

interface JobStateRow {
  readonly state: string;
  readonly count: string;
}

/**
 * The queue's depth, or null when there is no queue yet.
 *
 * ## Why a missing schema is not an error
 *
 * The web app can start before the worker has ever run, and pg-boss creates its schema on the
 * worker's first boot. "The queue does not exist yet" is a real and temporary state of a cold
 * deployment, so it is reported as `null` rather than thrown: a health endpoint that 500s because
 * the thing it monitors has not started is not a health endpoint.
 */
export async function readQueueDepth(database: CompassDatabase): Promise<QueueDepth | null> {
  try {
    const result = await database.execute(
      sql`select state::text as state, count(*)::text as count from pgboss.job group by state`,
    );

    // `execute` returns a driver-shaped result: node-postgres puts the rows on `.rows`, while
    // PGlite's drizzle adapter can return the array itself. Both are handled rather than one being
    // assumed, because the difference only shows up in whichever environment was not tested.
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as JobStateRow[];

    const total = (...states: readonly string[]): number =>
      rows
        .filter((row) => states.includes(row.state))
        .reduce((sum, row) => sum + Number.parseInt(row.count, 10), 0);

    return {
      // pg-boss has used both `created` and `retry` for "waiting"; counting both means a version
      // bump does not silently start reporting an empty queue.
      queued: total('created', 'retry'),
      active: total('active'),
      failed: total('failed'),
    };
  } catch {
    // The schema does not exist yet, or this deployment runs no worker at all.
    return null;
  }
}
