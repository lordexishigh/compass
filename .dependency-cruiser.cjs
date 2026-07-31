/**
 * Architecture rules: the layer order is a dependency fact, not a convention.
 *
 *   clock -> connector-port -> db -> knowledge-model -> ingest
 *                                              -> analysis -> renderers -> pipeline
 *
 * A package may only depend on packages to its left. `analysis` is the strictest
 * case: it may depend on nothing at all, including node builtins and the clock.
 * Resolution uses tsconfig.tests.json so `@compass/*` maps to each package's
 * `src/`, which means these rules hold on a clean checkout with no build.
 */
const forbidUpward = (name, from, to) => ({
  name,
  severity: 'error',
  comment: `${from} sits below ${to} in the layer order and must not depend on it.`,
  from: { path: `^packages/(${from})/src` },
  to: { path: `^packages/(${to})/src` },
});

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the layer order meaningless.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'analysis-is-pure',
      severity: 'error',
      comment:
        'The analysis core is a pure function of (snapshot, instant, config): no I/O, no time, no third-party code.',
      from: { path: '^packages/analysis/src' },
      to: { dependencyTypes: ['core', 'npm', 'npm-dev', 'npm-optional', 'npm-peer'] },
    },
    {
      name: 'analysis-imports-no-compass-package',
      severity: 'error',
      comment:
        'The analysis core declares zero dependencies — it re-declares the Instant brand structurally instead.',
      from: { path: '^packages/analysis/src' },
      to: { path: '^packages/(?!analysis)[^/]+/src' },
    },
    {
      name: 'no-seed-connector-below-the-port',
      severity: 'error',
      comment:
        'Nothing downstream of the port may know a seeded provider exists; connectors are resolved at the edge.',
      from: { path: '^packages/(ingest|knowledge-model|analysis|pipeline|renderers|db)/src' },
      to: { path: '^packages/seed-connector' },
    },
    forbidUpward('clock-depends-on-nothing', 'clock', '(?!clock)[a-z-]+'),
    forbidUpward(
      'connector-port-stays-above-clock-only',
      'connector-port',
      'db|knowledge-model|ingest|analysis|renderers|pipeline|seed-connector',
    ),
    forbidUpward('db-stays-below-the-model', 'db', 'knowledge-model|ingest|analysis|renderers|pipeline'),
    forbidUpward('knowledge-model-stays-below-ingest', 'knowledge-model', 'ingest|analysis|renderers|pipeline'),
    forbidUpward('ingest-stays-below-analysis', 'ingest', 'analysis|renderers|pipeline'),
    forbidUpward('renderers-stay-below-the-pipeline', 'renderers', 'pipeline|ingest|db'),
    {
      name: 'no-cross-package-relative-imports',
      severity: 'error',
      comment: 'Layer boundaries are package boundaries: import @compass/<pkg>, never ../../<pkg>/src.',
      from: { path: '^packages/([^/]+)/src' },
      to: {
        path: '^packages/([^/]+)/src',
        pathNot: '^packages/$1/src',
        // Without this the rule matched every legitimate `@compass/clock` import
        // too: the `tsConfig` resolution below maps the package specifier onto
        // `packages/clock/src/index.ts`, so the *resolved path* is identical to what
        // `../../clock/src/index.ts` would produce — and the rule could never pass,
        // which is why nothing ever ran it.
        //
        // The discriminator is how the import was written, not where it landed. A
        // package specifier resolved through tsconfig `paths` is tagged
        // `aliased-tsconfig-paths`; a genuine relative import is only `local`. Both
        // carry `local`, so this has to exclude the alias rather than require
        // `local`.
        dependencyTypesNot: ['aliased-tsconfig-paths'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.tests.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
    },
    exclude: { path: '(^|/)(node_modules|dist|\\.next|tests|fixtures)/' },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
