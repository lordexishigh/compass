import { compassVitestConfig } from '../../vitest.shared.js';

/**
 * Thirty reports are generated per run — three teams and the merged view across ten
 * simulated days — and each one builds a snapshot over the whole seeded dataset. That
 * is a few seconds rather than a few milliseconds, so the per-test budget is raised
 * for the same reason `tools/quality-gates` raises its own.
 */
export default compassVitestConfig('@compass/golden', {
  test: { testTimeout: 120_000, hookTimeout: 120_000 },
});
