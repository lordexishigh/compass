import { compassVitestConfig } from '../../vitest.shared.js';

/**
 * These gates read the workspace from disk and shell ESLint over it, so they are
 * slower than a unit test and get a longer per-test budget.
 */
export default compassVitestConfig('@compass/quality-gates', {
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
