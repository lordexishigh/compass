/**
 * Bans every direct read of the system clock.
 *
 * This is an AST rule, not a grep, so it also catches the forms a regex misses:
 * `new (Date)()`, `Date['now']()`, and `const { now } = Date`.
 *
 * It does NOT ban `new Date(epochMillis)` or `Date.parse(iso)` — those are pure
 * conversions of a value that was already obtained from the Clock port.
 *
 * Companion rule: `no-time-library-imports` (a wall-clock read hidden inside
 * dayjs/luxon/moment is invisible to this rule).
 */

/** @type {ReadonlyMap<string, readonly string[]>} */
const FORBIDDEN_MEMBERS = new Map([
  ['Date', ['now']],
  ['performance', ['now', 'timeOrigin']],
  ['process', ['hrtime', 'uptime']],
]);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct system-clock reads; `now` must arrive through the Clock port as an explicit parameter.',
    },
    schema: [],
    messages: {
      forbidden:
        '`{{expression}}` reads the system clock. Accept `now: Instant` as a parameter, or use a Clock from @compass/clock at the process edge.',
    },
  },
  create(context) {
    /**
     * @param {import('estree').Node} node
     * @param {string} expression
     */
    const report = (node, expression) => {
      context.report({ node, messageId: 'forbidden', data: { expression } });
    };

    /** @param {import('estree').Node} node */
    const staticName = (node) => {
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      return null;
    };

    return {
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) {
          report(node, 'new Date()');
        }
      },
      MemberExpression(node) {
        if (node.object.type !== 'Identifier') return;
        const forbiddenProperties = FORBIDDEN_MEMBERS.get(node.object.name);
        if (!forbiddenProperties) return;
        const property = node.computed ? staticName(node.property) : staticName(node.property);
        if (property && forbiddenProperties.includes(property)) {
          report(node, `${node.object.name}.${property}`);
        }
      },
      VariableDeclarator(node) {
        if (!node.init || node.init.type !== 'Identifier' || node.id.type !== 'ObjectPattern') return;
        const forbiddenProperties = FORBIDDEN_MEMBERS.get(node.init.name);
        if (!forbiddenProperties) return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const name = staticName(property.key);
          if (name && forbiddenProperties.includes(name)) {
            report(property, `${node.init.name}.${name}`);
          }
        }
      },
    };
  },
};

export default rule;
