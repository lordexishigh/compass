/**
 * No pipeline stage constructs a clock internally.
 *
 * Injecting a `Clock` into a stage is only marginally better than calling
 * `Date.now()`: the stage still decides *when* it reads time. Stages take the
 * already-resolved `now: Instant`; only the process edge (route handler, worker
 * trigger, test) may construct a clock.
 */

const CLOCK_CONSTRUCTORS = ['SystemClock', 'SimulatedClock', 'FixedClock'];
const CLOCK_FACTORIES = ['createSystemClock', 'createSimulatedClock', 'createFixedClock', 'systemClock'];

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow constructing a Clock inside a pipeline layer; `now` is passed in as a parameter.',
    },
    schema: [],
    messages: {
      forbidden:
        '`{{expression}}` constructs a clock inside a pipeline layer. Take `now: Instant` as an explicit parameter instead.',
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && CLOCK_CONSTRUCTORS.includes(node.callee.name)) {
          context.report({
            node,
            messageId: 'forbidden',
            data: { expression: `new ${node.callee.name}()` },
          });
        }
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && CLOCK_FACTORIES.includes(node.callee.name)) {
          context.report({
            node,
            messageId: 'forbidden',
            data: { expression: `${node.callee.name}()` },
          });
        }
      },
    };
  },
};

export default rule;
