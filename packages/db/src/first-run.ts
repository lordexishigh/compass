import { Pool } from 'pg';

/**
 * The first-run gate: one cluster-wide lock, and one question.
 *
 * ## Why a lock at all
 *
 * Automatic seeding is the only write in Compass that two processes can decide to
 * perform at the same instant. `docker compose up` starts web and worker together, and
 * both reach a database that is empty; and a `docker compose up --scale worker=2`, or a
 * restart while the previous container is still draining, gives two workers the same
 * ordered startup. A read-then-write check ("is it empty?") does not survive any of
 * those — both processes read *empty*, both proceed, and the seed runs twice
 * concurrently.
 *
 * Every step of the seed is individually idempotent, so the second run would not
 * duplicate rows. What it would do is worse in a subtler way: two concurrent ingests of
 * the same window contend on the same entity rows for a minute or two, which is a
 * deadlock risk and a cold start that misses its own 60-second promise for reasons no
 * log line explains. So the lock is here to make the *second* process cheap, not to make
 * the first one correct.
 *
 * ## Why an advisory lock and not a marker row
 *
 * A marker row cannot be read before the schema that holds it exists, which is exactly
 * the state this runs in. `pg_try_advisory_lock` needs no schema, is scoped to the
 * database rather than to a table, and is released by the server if the holder's
 * connection dies — so a worker killed mid-seed does not leave the next one waiting
 * forever on a row that says `in_progress`.
 *
 * It is deliberately `try` rather than blocking. A second process should carry on
 * booting and let the first one seed, not sit on a connection until it finishes: the
 * work is not its to do, and its queue subscriptions are.
 *
 * ## The lock is held on its own connection
 *
 * A session-level advisory lock belongs to the connection that took it, and a pooled
 * `Pool.query()` may answer from a different connection each time — so a lock taken
 * through the pool would be released, or unlocked from the wrong session, at random.
 * This opens a single-connection pool of its own and keeps it for the duration, which is
 * also why the seed itself is free to use the ordinary pool underneath.
 */

/**
 * The lock key, chosen once and never derived.
 *
 * `pg_try_advisory_lock` takes a `bigint` in a namespace shared by the whole database,
 * so the only requirement is that nothing else in this database picks the same number.
 * Drizzle's own migration lock and pg-boss's maintenance locks both use their own
 * values; this is Compass's.
 */
export const FIRST_RUN_ADVISORY_LOCK_KEY = 4_192_016_401;

/** The table the "has this deployment been seeded" question is asked of. */
const REPORTS_TABLE = 'public.reports';

export interface FirstRunSession {
  /**
   * Whether a report already exists for this organization.
   *
   * Answers `false` — rather than throwing — against a database with no schema at all,
   * which is the state a genuine first run begins in. The question is asked of `reports`
   * and not of `organizations` on purpose: the tenant row is written early in the seed,
   * so an interrupted first run leaves an organization behind with nothing to read. A
   * stored report is the only row whose presence means "a manager could open `/` right
   * now and get what they came for".
   */
  hasStoredReport(organizationId: string): Promise<boolean>;
}

/**
 * Runs `work` while holding the first-run lock, or returns `null` if another process
 * holds it.
 *
 * `null` is a success, not a failure: it means somebody else is already doing this. The
 * caller distinguishes the two because the return type makes it impossible not to.
 */
export async function withFirstRunLock<T>(
  connectionString: string,
  work: (session: FirstRunSession) => Promise<T>,
): Promise<T | null> {
  // One connection, and only one: the lock is bound to it.
  const pool = new Pool({ connectionString, max: 1 });

  try {
    const client = await pool.connect();

    try {
      const acquired = await client.query<{ readonly locked: boolean }>(
        'select pg_try_advisory_lock($1) as locked',
        [FIRST_RUN_ADVISORY_LOCK_KEY],
      );

      if (acquired.rows[0]?.locked !== true) return null;

      try {
        return await work({
          hasStoredReport: async (organizationId: string): Promise<boolean> => {
            // Two round trips rather than one guarded statement. A `case when
            // to_regclass(...) is null then false else exists(select 1 from reports ...)`
            // reads as if it short-circuits and does not: Postgres parses and plans the
            // whole statement before executing any of it, so naming a table that does not
            // exist is an error regardless of the branch that would have been taken.
            const present = await client.query<{ readonly present: boolean }>(
              'select to_regclass($1) is not null as present',
              [REPORTS_TABLE],
            );
            if (present.rows[0]?.present !== true) return false;

            const stored = await client.query<{ readonly seeded: boolean }>(
              'select exists (select 1 from reports where organization_id = $1) as seeded',
              [organizationId],
            );
            return stored.rows[0]?.seeded === true;
          },
        });
      } finally {
        // Released explicitly rather than left to the connection closing, so the next
        // process finds the lock free immediately instead of when the socket does.
        await client.query('select pg_advisory_unlock($1)', [FIRST_RUN_ADVISORY_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
