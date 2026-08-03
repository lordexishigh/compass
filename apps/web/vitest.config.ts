import react from '@vitejs/plugin-react';

import { compassVitestConfig } from '../../vitest.shared.js';

/**
 * The web suite, with a per-test timeout that fits what these tests actually do.
 *
 * ## Why the default was too short
 *
 * A dozen suites here boot a real PostgreSQL 17 through PGlite — Postgres compiled to WebAssembly,
 * a genuine engine in its own memory per instance. Vitest runs one fork per CPU, so several engines
 * start at once, and the casualty was never one of the database suites: it was
 * `edge-failure.test.ts`, which mocks the database away entirely and asks a route to fail fast. It
 * timed out at vitest's default five seconds while the machine was busy starting WebAssembly
 * elsewhere — a failure about the host, not about the code.
 *
 * `beta-security-hardening` added three more database-backed suites and tipped it over.
 *
 * ## Why a timeout and not a worker cap
 *
 * Capping `maxForks` was tried first and was worse in every respect: the suite took several times
 * longer and *more* tests timed out, because fewer forks means each one runs more files back to back
 * and the contention moves rather than disappearing.
 *
 * Raising the timeout costs nothing real, and it is worth being precise about why: none of these
 * tests asserts a *duration*. `edge-failure.test.ts` asserts a status code and a body — that a
 * broken database produces a stated 503 rather than a framework 500 — and five seconds was vitest's
 * default rather than a claim anybody made. Thirty seconds is generous enough to absorb a loaded
 * machine and still short enough that a genuinely hung test fails the run instead of holding CI.
 *
 * `hookTimeout` matches: `beforeAll` in the database suites migrates a fresh engine, and the ones
 * written before this passed their own explicit 120s or 180s. Setting it here means the next suite
 * does not have to remember to.
 */
export default {
  ...compassVitestConfig('@compass/web', {
    test: {
      testTimeout: 30_000,
      hookTimeout: 180_000,
    },
  }),
  plugins: [react()],
};
