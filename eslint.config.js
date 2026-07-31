import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import compass from '@compass/eslint-plugin';

/**
 * Packages in which reading the system clock is a build failure.
 *
 * `packages/clock` is deliberately included: `SystemClock` is the single legal
 * caller of `Date.now()` in the repo and carries one documented
 * `eslint-disable-next-line` for it. `tools/quality-gates` asserts that exactly
 * one such disable comment exists anywhere in the workspace, so the exemption
 * cannot silently spread.
 */
export const CLOCK_GUARDED_SOURCES = [
  'packages/clock/src/**/*.ts',
  'packages/ingest/src/**/*.ts',
  'packages/knowledge-model/src/**/*.ts',
  'packages/analysis/src/**/*.ts',
  'packages/pipeline/src/**/*.ts',
];

/** Layers that must never construct a clock — `now` is always a parameter. */
export const CLOCK_INJECTION_SOURCES = [
  'packages/ingest/src/**/*.ts',
  'packages/knowledge-model/src/**/*.ts',
  'packages/analysis/src/**/*.ts',
  'packages/pipeline/src/**/*.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'packages/db/drizzle/**',
      'tools/quality-gates/fixtures/**',
      // Written by `next build` and explicitly marked "should not be edited".
      // It carries triple-slash references we are in no position to change.
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: { compass },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },
  {
    files: CLOCK_GUARDED_SOURCES,
    rules: {
      'compass/no-system-clock': 'error',
      'compass/no-time-library-imports': 'error',
    },
  },
  {
    files: CLOCK_INJECTION_SOURCES,
    rules: {
      'compass/no-clock-instantiation': 'error',
    },
  },
  {
    // The analysis core is pure: no I/O, no time, no randomness.
    files: ['packages/analysis/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The analysis core must not read process state.' },
        { name: 'fetch', message: 'The analysis core must not perform I/O.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'The analysis core must be deterministic.' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
);
