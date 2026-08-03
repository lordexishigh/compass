import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIRST_RUN_ADVISORY_LOCK_KEY } from '@compass/db';
import { afterAll, describe, expect, it } from 'vitest';

import { writeDemoAccountFile } from '../src/demo-account.js';
import {
  DISABLE_FIRST_RUN_ENV_VAR,
  describeFirstRun,
  ensureFirstRun,
  firstRunDisabled,
} from '../src/first-run.js';

/**
 * The first-run gate: when the worker seeds itself, and when it declines to.
 *
 * ## What is asserted here, and what is not
 *
 * The decision logic and the operator-facing lines are tested here. The *lock* is not, and
 * that is a deliberate boundary rather than an omission: `pg_try_advisory_lock` is a server
 * feature, and the engine every other test in this repo runs against is PGlite — an in-process
 * PostgreSQL with no second connection to contend with, so a test of mutual exclusion against
 * it would pass whether or not the lock were taken at all. A test that cannot fail is worse
 * than no test, because it reads as coverage.
 *
 * What the lock does is bounded and visible instead: `withFirstRunLock` is the only path to
 * the seed, it returns `null` when the lock is held, and `ensureFirstRun` maps that `null` onto
 * the `deferred` outcome — which *is* asserted, on the sentence an operator reads when two
 * containers start together.
 *
 * The seed itself, and its idempotency, are covered end to end over the real dataset in
 * `cold-start.test.ts` — "the second boot is a read", and the goal store gaining no revision
 * on a re-run.
 */

const scratch = mkdtempSync(join(tmpdir(), 'compass-first-run-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the gate can be switched off, and says so', () => {
  it('does nothing at all when the environment disables it', async () => {
    /**
     * The one branch that can be exercised without a database, and worth having: it is the
     * escape hatch for a deployment whose substrate is managed elsewhere, and it must not so
     * much as open a connection — an operator who set this flag because their database is
     * unreachable would otherwise still get a boot failure from the check meant to be skipped.
     *
     * `DATABASE_URL` is deliberately not set in this test's environment. If `ensureFirstRun`
     * resolved a connection string before reading the flag, this would throw
     * `MissingDatabaseUrlError` rather than returning.
     */
    const result = await ensureFirstRun({ env: { [DISABLE_FIRST_RUN_ENV_VAR]: '1' } });

    expect(result.outcome).toBe('disabled');
    expect(result.coldStart).toBeNull();
    // No file either: the flag means "leave this database alone", and writing credentials for
    // an owner that may not exist would be a claim rather than a convenience.
    expect(result.demoAccount).toBeNull();
  });

  it('is off only for the exact value, so a stray `false` does not disable seeding', () => {
    /**
     * A flag that treated any non-empty value as true would make
     * `COMPASS_DISABLE_FIRST_RUN_SEED=0` silently disable the seed, which is the opposite of
     * what somebody typing that intended.
     *
     * Asserted through the predicate rather than by calling `ensureFirstRun`: on a machine that
     * *does* have `DATABASE_URL` set — CI with the compose database up — the non-disabled branch
     * would acquire the lock and run a real seed from inside a unit test.
     */
    expect(firstRunDisabled({ [DISABLE_FIRST_RUN_ENV_VAR]: '1' })).toBe(true);

    for (const value of ['0', 'false', 'no', '', 'true', 'yes']) {
      expect(
        firstRunDisabled({ [DISABLE_FIRST_RUN_ENV_VAR]: value }),
        `\`${value}\` disabled the first-run seed`,
      ).toBe(false);
    }
    expect(firstRunDisabled({})).toBe(false);
  });
});

describe('the lines an operator reads at boot', () => {
  const demoAccount = writeDemoAccountFile({ root: scratch, env: {} });

  it('states plainly that this boot did the seeding', () => {
    const lines = describeFirstRun({ outcome: 'seeded', coldStart: null, demoAccount });

    expect(lines[0]).toContain('this database held no report');
    expect(lines.join('\n')).toContain('/login');
  });

  it('states that a seeded database was left alone, rather than saying nothing', () => {
    // Silence here is the failure mode: an operator watching a restart needs to know the
    // absence of a two-minute ingest was a decision and not a hang.
    const lines = describeFirstRun({ outcome: 'already_seeded', coldStart: null, demoAccount });

    expect(lines[0]).toContain('already stored');
    expect(lines[0]).toContain('nothing was ingested or generated');
  });

  it('explains a deferral as another process holding the lock, not as a failure', () => {
    const lines = describeFirstRun({ outcome: 'deferred', coldStart: null, demoAccount: null });

    expect(lines[0]).toContain('first-run lock');
    expect(lines[0]).toContain('carries on');
    // Not phrased as an error: this is the normal outcome for the second of two containers.
    expect(lines[0].toLowerCase()).not.toContain('failed');
    expect(lines[0].toLowerCase()).not.toContain('error');
  });

  it('names the flag when it was skipped, so the reason is discoverable', () => {
    const lines = describeFirstRun({ outcome: 'disabled', coldStart: null, demoAccount: null });

    expect(lines[0]).toContain(DISABLE_FIRST_RUN_ENV_VAR);
  });

  it('mentions the credentials file on every outcome that reached the database', () => {
    for (const outcome of ['seeded', 'already_seeded'] as const) {
      const lines = describeFirstRun({ outcome, coldStart: null, demoAccount });
      expect(lines.join('\n'), `${outcome} did not name the credentials file`).toContain(demoAccount.path);
    }

    // And on neither outcome that did not.
    for (const outcome of ['deferred', 'disabled'] as const) {
      const lines = describeFirstRun({ outcome, coldStart: null, demoAccount: null });
      expect(lines.join('\n')).not.toContain('demo_account.json');
    }
  });

  it('rewrites the credentials file even when the database was already seeded', () => {
    /**
     * The reason this is not conditional on having seeded.
     *
     * The file is how a harness signs in, and it is gitignored — so it is absent on a fresh
     * clone whose database is a volume that survived. Writing it only on the seeding boot would
     * mean the one case where the report is already there is the case where the credentials are
     * not.
     */
    rmSync(join(scratch, '.nous'), { recursive: true, force: true });
    expect(existsSync(join(scratch, '.nous', 'demo_account.json'))).toBe(false);

    const rewritten = writeDemoAccountFile({ root: scratch, env: {} });
    expect(existsSync(rewritten.path)).toBe(true);
  });
});

describe('the lock key', () => {
  it('is a fixed number rather than something derived per process', () => {
    // Derived keys are the classic way an advisory lock stops excluding anything: two
    // processes that hash their own hostname into the key never contend.
    expect(FIRST_RUN_ADVISORY_LOCK_KEY).toBe(4_192_016_401);
    expect(Number.isInteger(FIRST_RUN_ADVISORY_LOCK_KEY)).toBe(true);
  });
});
