import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
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
  // `@compass/auth` takes `now: Instant` on every function that cares about time, which
  // is what lets the session-expiry suites choose instants instead of waiting 30 days. A
  // single `Date.now()` in here would make those tests unwritable, so it is a build gate.
  'packages/auth/src/**/*.ts',
  'packages/ingest/src/**/*.ts',
  'packages/knowledge-model/src/**/*.ts',
  'packages/analysis/src/**/*.ts',
  'packages/pipeline/src/**/*.ts',
];

/**
 * The pure core. Nothing under here may import I/O, a database, a clock or a
 * randomness source, and `compass/no-analysis-io` says so at the import site.
 *
 * This is one of two independent gates: `tools/quality-gates` runs a textual
 * scan over the same tree, so a `files` glob edited here cannot silently switch
 * enforcement off.
 */
export const PURE_ANALYSIS_SOURCES = ['packages/analysis/src/**/*.ts'];

/** Layers that must never construct a clock — `now` is always a parameter. */
export const CLOCK_INJECTION_SOURCES = [
  'packages/auth/src/**/*.ts',
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
      /**
       * No credential in a log line and none in a response body, anywhere in the workspace.
       *
       * Applied to *every* file rather than to a guarded path list, unlike the clock and purity
       * rules above. Those describe a property of one layer; this one describes a property of the
       * product, and a leak is unrecoverable wherever it happens — a token in a worker log is
       * exactly as shipped, indexed and retained as a token in a route's response.
       *
       * The rule reads positions rather than words: a secret-named property inside a `console.*`
       * argument or inside something being serialised. That is why `tokenHash`, `token_digest` and
       * the `/api/share/[token]` route segment do not trip it, and why a `masked` token would.
       */
      'compass/no-secret-disclosure': 'error',
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
    files: PURE_ANALYSIS_SOURCES,
    rules: {
      'compass/no-analysis-io': 'error',
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
    plugins: { 'jsx-a11y': jsxA11y },
    /**
     * WCAG at the markup site, beside the audit that runs over the rendered page.
     *
     * `tests/accessibility.test.tsx` runs axe over real renders and is the stronger check — it sees
     * the tree a reader meets, including everything composed from props. It also only sees the
     * surfaces it renders. This catches the other half: the mistakes that are visible in the JSX
     * itself, in every component, including one added tomorrow that no test yet renders.
     *
     * The recommended set is taken as-is rather than curated, and then three rules are raised or
     * added because they map to acceptance criteria for this product:
     */
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      /**
       * A click handler with no key handler is the classic keyboard trap — the control works for a
       * mouse and does not exist for a keyboard. "Every interactive element is reachable and operable
       * by keyboard" is an acceptance criterion, so these are errors rather than warnings.
       */
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/interactive-supports-focus': 'error',
      /**
       * `aria-hidden` on something focusable produces a control a sighted keyboard user can tab to
       * and a screen-reader user cannot hear. The report is full of legitimately hidden decoration —
       * the ladder marks, the spine's separators — so the distinction has to be enforced rather than
       * remembered.
       */
      'jsx-a11y/no-aria-hidden-on-focusable': 'error',
      /**
       * Turned off deliberately, with the reason recorded.
       *
       * `no-onchange` is about a long-obsolete IE/Safari behaviour and the rule is deprecated in the
       * plugin itself; React's `onChange` is an input event, which is the accessible choice.
       */
      'jsx-a11y/no-onchange': 'off',
      /**
       * Look three levels down for a label's text, not two.
       *
       * The default depth of 2 rejects `<label><input/><span><span>Title</span></span></label>`, which
       * is the shape every radio option on the privacy screen uses — a title line and a description
       * line stacked beside the control. That markup is *correct*: the label wraps its input, so the
       * label's whole text content becomes the control's accessible name, description included.
       * Rewriting it to satisfy a depth counter would flatten a two-line option into one, so the
       * counter moves instead. The rule still fails a label with no text at all, which is what it is
       * for.
       */
      'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
      /**
       * Police *mouse* handlers on non-interactive elements, not keyboard ones.
       *
       * The hazard this rule exists for is a `<div onClick>` that a keyboard cannot reach. A
       * keyboard handler on a container is the opposite of that hazard — it is usually the remedy.
       * The in-app feedback panel is a `<form>` with `onKeyDown` for Escape-to-close, where every
       * control inside is natively interactive and the form itself is never the thing being
       * activated; under the default handler list that correct pattern is an error and the only way
       * to satisfy it is to make the panel less operable.
       */
      'jsx-a11y/no-noninteractive-element-interactions': [
        'error',
        { handlers: ['onClick', 'onMouseDown', 'onMouseUp'] },
      ],
    },
  },
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
);
