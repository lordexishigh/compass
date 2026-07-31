import { compassVitestConfig } from '../../vitest.shared.js';

export default compassVitestConfig('@compass/knowledge-model', {
  test: {
    // These suites boot a real PostgreSQL 17 in-process through PGlite and apply every
    // migration in `beforeAll`. That crossed the default 10s hook timeout once the
    // configuration tables landed, and it will keep growing with the schema — so the
    // budget matches `@compass/db` and `@compass/auth`, which do the same thing.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
