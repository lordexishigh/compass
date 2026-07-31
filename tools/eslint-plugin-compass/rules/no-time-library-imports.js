/**
 * Bans date/time libraries in the guarded layers.
 *
 * `no-system-clock` only sees the built-ins; a `dayjs()` call with no argument
 * is just as much a wall-clock read, so the import itself is the thing to stop.
 */

const FORBIDDEN_MODULES = [
  'dayjs',
  'moment',
  'moment-timezone',
  'luxon',
  'date-fns',
  'date-fns-tz',
  '@js-joda/core',
  'js-joda',
  'perf_hooks',
  'node:perf_hooks',
  'temporal-polyfill',
];

const isForbidden = (source) =>
  FORBIDDEN_MODULES.some((moduleName) => source === moduleName || source.startsWith(`${moduleName}/`));

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow date/time libraries outside the Clock port; time enters through @compass/clock only.',
    },
    schema: [],
    messages: {
      forbidden:
        "'{{source}}' is a time source. Use @compass/clock (Instant, TimeWindow, zone helpers) so `now` stays injectable.",
    },
  },
  create(context) {
    const check = (node, source) => {
      if (typeof source === 'string' && isForbidden(source)) {
        context.report({ node, messageId: 'forbidden', data: { source } });
      }
    };

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const [argument] = node.arguments;
        if (argument && argument.type === 'Literal') check(node, argument.value);
      },
    };
  },
};

export default rule;
