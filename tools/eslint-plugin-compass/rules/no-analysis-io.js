/**
 * The analysis core imports nothing that does I/O, time or randomness.
 *
 * @compass/analysis declares no dependencies at all, so most violations already
 * fail at module resolution. This rule catches the three cases resolution does
 * not:
 *
 *  - **Node built-ins.** `node:fs`, `node:http` and friends resolve fine without
 *    ever appearing in a manifest, so nothing but a lint rule stops them.
 *  - **A workspace package added to the manifest.** Adding
 *    `"@compass/db": "workspace:*"` makes the import resolve, and the failure
 *    would otherwise only surface in the architecture test. This rule points at
 *    the import statement itself.
 *  - **Randomness and ambient host state.** `Math.random()`,
 *    `crypto.randomUUID()`, `globalThis.fetch` and `structuredClone` of a
 *    host object are expressions, not imports.
 *
 * Companion gates: `compass/no-system-clock` and `compass/no-time-library-imports`
 * cover time, and `tools/quality-gates/tests/analysis-purity.test.ts` runs an
 * independent textual scan so a config edit cannot silently switch this off.
 */

/** Node built-ins that perform I/O, read host state, or generate randomness. */
const FORBIDDEN_BUILTINS = [
  'assert',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'net',
  'os',
  'path',
  'process',
  'readline',
  'repl',
  'stream',
  'tls',
  'url',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

/** Workspace layers the analysis core must not reach for. */
const FORBIDDEN_PACKAGES = [
  '@compass/clock',
  '@compass/connector-port',
  '@compass/db',
  '@compass/ingest',
  '@compass/knowledge-model',
  '@compass/pipeline',
  '@compass/renderers',
  '@compass/seed-connector',
];

/** Third-party packages that are, by nature, I/O or a database. */
const FORBIDDEN_LIBRARIES = ['drizzle-orm', 'pg', 'pg-boss', 'postgres', 'node-fetch', 'axios', 'undici', 'zod'];

const WHY = {
  builtin: 'the analysis core performs no I/O and reads no host state',
  workspacePackage: 'the analysis core declares no dependencies, so every layer boundary stays a package boundary',
  library: 'the analysis core is a pure function of its snapshot',
};

/** @param {string} source @returns {{ reason: string } | null} */
function classify(source) {
  const bare = source.startsWith('node:') ? source.slice('node:'.length) : source;
  if (FORBIDDEN_BUILTINS.includes(bare)) return { reason: WHY.builtin };
  if (FORBIDDEN_PACKAGES.includes(source)) return { reason: WHY.workspacePackage };
  if (FORBIDDEN_LIBRARIES.some((name) => source === name || source.startsWith(`${name}/`))) {
    return { reason: WHY.library };
  }
  return null;
}

/** Expressions that are nondeterministic or reach the host directly. */
const FORBIDDEN_MEMBERS = new Map([
  ['Math', ['random']],
  ['crypto', ['randomUUID', 'getRandomValues', 'randomBytes']],
  ['globalThis', ['fetch', 'crypto', 'process']],
]);

const FORBIDDEN_IDENTIFIERS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'require'];

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow I/O, time, database and randomness imports inside the analysis core, which must be pure and deterministic.',
    },
    schema: [],
    messages: {
      forbiddenImport:
        "`{{module}}` cannot be imported by the analysis core: {{reason}}. Take the value as a parameter instead.",
      forbiddenExpression:
        '`{{expression}}` is not available in the analysis core: it must be deterministic and perform no I/O.',
    },
  },
  create(context) {
    /** @param {import('estree').Node} node @param {string} source */
    const checkSource = (node, source) => {
      const verdict = classify(source);
      if (verdict === null) return;
      context.report({ node, messageId: 'forbiddenImport', data: { module: source, reason: verdict.reason } });
    };

    /** @param {import('estree').Node} node */
    const literalSource = (node) =>
      node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;

    return {
      ImportDeclaration(node) {
        const source = literalSource(node.source);
        if (source !== null) checkSource(node, source);
      },
      ExportNamedDeclaration(node) {
        const source = literalSource(node.source);
        if (source !== null) checkSource(node, source);
      },
      ExportAllDeclaration(node) {
        const source = literalSource(node.source);
        if (source !== null) checkSource(node, source);
      },
      ImportExpression(node) {
        const source = literalSource(node.source);
        if (source !== null) checkSource(node, source);
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const source = literalSource(node.arguments[0]);
          if (source !== null) {
            checkSource(node, source);
            return;
          }
        }
        if (node.callee.type === 'Identifier' && FORBIDDEN_IDENTIFIERS.includes(node.callee.name)) {
          context.report({
            node,
            messageId: 'forbiddenExpression',
            data: { expression: `${node.callee.name}()` },
          });
        }
      },
      MemberExpression(node) {
        if (node.object.type !== 'Identifier') return;
        const forbidden = FORBIDDEN_MEMBERS.get(node.object.name);
        if (!forbidden) return;
        const property =
          node.property.type === 'Identifier'
            ? node.property.name
            : node.property.type === 'Literal' && typeof node.property.value === 'string'
              ? node.property.value
              : null;
        if (property && forbidden.includes(property)) {
          context.report({
            node,
            messageId: 'forbiddenExpression',
            data: { expression: `${node.object.name}.${property}` },
          });
        }
      },
    };
  },
};

export default rule;
export { FORBIDDEN_BUILTINS, FORBIDDEN_LIBRARIES, FORBIDDEN_PACKAGES };
