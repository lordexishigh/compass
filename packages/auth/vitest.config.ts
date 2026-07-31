import { compassVitestConfig } from '../../vitest.shared.js';

export default compassVitestConfig('@compass/auth', {
  test: {
    // Two slow things live in this suite and neither is avoidable: PGlite boots a
    // real PostgreSQL 17 in-process, and Argon2id is *deliberately* expensive.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
