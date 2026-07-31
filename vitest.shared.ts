import { fileURLToPath } from 'node:url';
import type { ViteUserConfig } from 'vitest/config';

/**
 * One place that maps every workspace package to its *source*, so tests always
 * run against `src/` and `pnpm test` never depends on a prior `pnpm build`.
 *
 * Order matters: vite alias entries are matched in order, so the deeper
 * `/testkit` entry has to come before its package root.
 */
const resolveSource = (relative: string): string =>
  fileURLToPath(new URL(`./packages/${relative}`, import.meta.url));

const resolveToolSource = (relative: string): string =>
  fileURLToPath(new URL(`./tools/${relative}`, import.meta.url));

export const compassAliases: ReadonlyArray<{ find: string; replacement: string }> = [
  { find: '@compass/smoke', replacement: resolveToolSource('smoke/src/index.ts') },
  { find: '@compass/connector-port/testkit', replacement: resolveSource('connector-port/src/testkit/index.ts') },
  { find: '@compass/connector-port', replacement: resolveSource('connector-port/src/index.ts') },
  { find: '@compass/clock', replacement: resolveSource('clock/src/index.ts') },
  { find: '@compass/seed-connector', replacement: resolveSource('seed-connector/src/index.ts') },
  { find: '@compass/db/testing', replacement: resolveSource('db/src/testing/pglite.ts') },
  { find: '@compass/db', replacement: resolveSource('db/src/index.ts') },
  { find: '@compass/auth', replacement: resolveSource('auth/src/index.ts') },
  { find: '@compass/knowledge-model', replacement: resolveSource('knowledge-model/src/index.ts') },
  { find: '@compass/memos/testkit', replacement: resolveSource('memos/src/testkit/index.ts') },
  { find: '@compass/memos', replacement: resolveSource('memos/src/index.ts') },
  { find: '@compass/ingest', replacement: resolveSource('ingest/src/index.ts') },
  { find: '@compass/analysis', replacement: resolveSource('analysis/src/index.ts') },
  { find: '@compass/renderers', replacement: resolveSource('renderers/src/index.ts') },
  { find: '@compass/delivery/testkit', replacement: resolveSource('delivery/src/testkit/index.ts') },
  { find: '@compass/delivery', replacement: resolveSource('delivery/src/index.ts') },
  { find: '@compass/narrator/testkit', replacement: resolveSource('narrator/src/testkit/index.ts') },
  { find: '@compass/narrator', replacement: resolveSource('narrator/src/index.ts') },
  { find: '@compass/pipeline', replacement: resolveSource('pipeline/src/index.ts') },
];

/**
 * Shared Vitest configuration for every workspace package.
 *
 * `name` is what `pnpm test` prints per package, which is how the run reports
 * per-package results. `passWithNoTests` stays false on purpose: a package that
 * silently has no tests must fail the run rather than look green.
 */
export function compassVitestConfig(name: string, overrides: ViteUserConfig = {}): ViteUserConfig {
  const { test: testOverrides, resolve: resolveOverrides, ...rest } = overrides;
  return {
    ...rest,
    resolve: {
      alias: [...compassAliases],
      ...resolveOverrides,
    },
    test: {
      name,
      environment: 'node',
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      passWithNoTests: false,
      ...testOverrides,
    },
  };
}
