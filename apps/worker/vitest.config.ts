import { compassVitestConfig } from '../../vitest.shared.js';

/**
 * The worker suite, with the same per-test timeout as the web suite and for the same reason.
 *
 * See `apps/web/vitest.config.ts` for the full argument; it applies here unchanged. The short
 * version: these suites boot real PostgreSQL 17 engines through PGlite, vitest runs one fork
 * per CPU, and a test that asserts no duration was failing at vitest's default five seconds
 * because the machine was busy starting WebAssembly in another fork.
 *
 * The casualty here was `ingest-schedule.test.ts`, whose model-projection test times out on a
 * loaded machine and passes on an idle one — it asserts that the job writes into the knowledge
 * model and journals the run, which is a statement about behaviour and not about speed. The
 * database-backed tests in this package that were written before this each carry their own
 * explicit `120_000`; the ones that do not were relying on the default being enough, which is
 * how a suite acquires a flake nobody can reproduce.
 */
export default compassVitestConfig('@compass/worker', {
  test: {
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
