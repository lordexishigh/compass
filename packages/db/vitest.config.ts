import { compassVitestConfig } from '../../vitest.shared.js';

export default compassVitestConfig('@compass/db', {
  test: {
    // PGlite boots a real PostgreSQL 17 in-process; migrations are slower than unit tests.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
