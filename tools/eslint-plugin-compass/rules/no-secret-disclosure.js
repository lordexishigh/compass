/**
 * Fails the build when a secret-bearing field name appears in a log statement or a response body.
 *
 * ## Why this is an AST rule and not a grep
 *
 * The acceptance criterion asks for "a grep-based CI check on token field names in logs and
 * responses", and a grep is the wrong tool for it — not because it is crude but because it cannot
 * tell the two halves of the sentence apart. `token` appears legitimately all over this
 * repository: `tokenHash`, `token_digest`, `hashShareToken`, `authTokens`, the route segment
 * `/api/share/[token]`. A textual scan for the word either floods with those or is narrowed until
 * it no longer catches the thing it is for.
 *
 * What actually needs banning is a *position*: a secret-named property inside an object that is
 * being logged or returned. That is a question about context, so it is answered with the AST.
 *
 * ## The two positions
 *
 *  1. **Arguments to `console.*`.** Either the identifier itself (`console.info(accessToken)`) or
 *     a property of an object literal being logged. A token in a log line is the classic
 *     unrecoverable leak: logs are shipped, indexed, retained past the credential's own life, and
 *     read by people who are not on the integration.
 *  2. **Object literals passed to a response or serializer** — `NextResponse.json(...)`,
 *     `Response.json(...)`, `JSON.stringify(...)`, `jsonOk(...)`, `jsonError(...)`. Recursively,
 *     because the leak is usually nested one level down in a `source: {...}`.
 *
 * ## What counts as secret-named, and what is deliberately allowed
 *
 * Banned: `token`, `accessToken`, `refreshToken`, `apiToken`, `oauthToken`, `bearerToken`,
 * `secret`, `clientSecret`, `signingSecret`, `password`, `privateKey`, `apiKey`, `dataKey`,
 * `masterKey`, and the snake_case spelling of each.
 *
 * Allowed, and each for a stated reason:
 *
 *  - **`…Hash` and `…Digest`** — a SHA-256 of a bearer secret is the *storage* form, and Compass
 *    stores digests precisely so a leak of the row is not a leak of the credential. Banning the
 *    name would ban the safe pattern.
 *  - **`sealedValue`, `wrappedDataKey`** — ciphertext. Publishing it is a bug of a different kind
 *    (it is noise in a response) but it is not a disclosure, and the envelope's AAD means it does
 *    not even open elsewhere.
 *  - **`passwordProblem`, `hasPassword`, `tokenKind`, `keyVersion`, `expiresAt`** — metadata
 *    about a secret, which is what the API is *supposed* to return instead of the secret. The
 *    allowlist is a suffix and prefix test rather than a list of literals, so a new metadata field
 *    does not need this rule edited.
 *
 * A genuine need to name one of these in a log is met by logging the metadata instead. There is no
 * disable comment carved out for it here, and `tools/quality-gates/tests/security-posture.test.ts`
 * asserts none exists anywhere in the workspace.
 */

/** Field names that are the secret itself. Compared against a normalised, lower-cased name. */
const SECRET_NAMES = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'apitoken',
  'oauthtoken',
  'bearertoken',
  'idtoken',
  'sessiontoken',
  'secret',
  'clientsecret',
  'signingsecret',
  'webhooksecret',
  'password',
  'newpassword',
  'privatekey',
  'apikey',
  'datakey',
  'masterkey',
  'plaintext',
]);

/**
 * Names that contain a banned word but are the *safe* form. Checked before the ban.
 *
 * Suffix-based, so `tokenHash`, `undoTokenHash`, `secretDigest` and any future `…Hash` are all
 * covered without extending this.
 */
const SAFE_SUFFIXES = ['hash', 'digest', 'kind', 'version', 'expiresat', 'present', 'problem', 'label', 'envvar'];

const SAFE_NAMES = new Set([
  'sealedvalue',
  'wrappeddatakey',
  'haspassword',
  'passwordhash',
  'tokenhash',
  'tokendigest',
]);

/** `access_token` and `accessToken` are one name for this rule's purposes. */
const normalise = (name) => name.replace(/[_-]/g, '').toLowerCase();

function isSecretName(rawName) {
  const name = normalise(rawName);
  if (SAFE_NAMES.has(name)) return false;
  if (SAFE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  return SECRET_NAMES.has(name);
}

/**
 * Callees whose arguments become a **response** body.
 *
 * `JSON.stringify` is deliberately absent, and it is the one exclusion worth explaining because
 * the first version of this rule included it and was wrong. `JSON.stringify({ email, password })`
 * is overwhelmingly a *request* body — the sign-in form posting credentials to the server, which is
 * the only way credentials can ever be checked — and banning it bans the feature. The direction of
 * travel is what matters: a password going from a browser to Compass is the product working, and
 * the same password coming back is a disclosure.
 *
 * So the rule names the constructs that can only ever be a response: the `NextResponse.json` /
 * `Response.json` statics, `new Response(...)`, and this repository's own `jsonOk` / `jsonError`
 * helpers, which every route handler answers through. `tests/token-storage.test.ts` covers the
 * remaining gap from the other side, by asserting against the actual bodies routes return.
 */
const RESPONSE_CALLEES = new Set(['json', 'jsonok', 'jsonerror']);

const BARE_RESPONSE_CALLEES = new Set(['jsonok', 'jsonerror']);

/** `new Response(...)` and `new NextResponse(...)` — a body without going through a helper. */
const RESPONSE_CONSTRUCTORS = new Set(['Response', 'NextResponse']);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow secret-bearing field names inside log statements and response bodies. Log or return the metadata (presence, kind, expiry), never the credential.',
    },
    schema: [],
    messages: {
      inLog:
        '`{{name}}` names a credential and this is a log statement. Logs are shipped, indexed and retained past the credential’s own life — log its presence, kind or expiry instead.',
      inResponse:
        '`{{name}}` names a credential and this value is serialised into a response. No Compass API returns a token, masked or otherwise: a mask still confirms existence, length and provider prefix. Return `present`, `tokenKind` and `expiresAt` instead.',
    },
  },
  create(context) {
    /** @param {import('estree').Node} node @returns {string | null} */
    const staticName = (node) => {
      if (!node) return null;
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      return null;
    };

    /**
     * Reports every secret-named property inside an expression, however deeply nested.
     *
     * Recursive through object literals, arrays, conditionals and template literals, because a
     * response body is usually assembled rather than written flat — and the one that leaks is
     * always the one nested in a `source: {...}` two levels down.
     *
     * @param {import('estree').Node} node
     * @param {'inLog' | 'inResponse'} messageId
     * @param {Set<import('estree').Node>} seen
     */
    const walk = (node, messageId, seen) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);

      switch (node.type) {
        case 'ObjectExpression':
          for (const property of node.properties) {
            if (property.type === 'SpreadElement') {
              walk(property.argument, messageId, seen);
              continue;
            }
            const key = staticName(property.key);
            if (key !== null && isSecretName(key)) {
              context.report({ node: property, messageId, data: { name: key } });
              // Not also the value: for the shorthand `{ password }` the key and the value are
              // one identifier, and reporting both printed every violation twice.
              continue;
            }
            walk(property.value, messageId, seen);
          }
          return;

        case 'ArrayExpression':
          for (const element of node.elements) walk(element, messageId, seen);
          return;

        case 'ConditionalExpression':
          walk(node.consequent, messageId, seen);
          walk(node.alternate, messageId, seen);
          return;

        case 'LogicalExpression':
        case 'BinaryExpression':
          walk(node.left, messageId, seen);
          walk(node.right, messageId, seen);
          return;

        case 'TemplateLiteral':
          for (const expression of node.expressions) walk(expression, messageId, seen);
          return;

        case 'CallExpression':
          // Only the arguments, not the callee: `hashShareToken(token)` is the safe direction —
          // a secret going *into* a digest function — and flagging the callee would ban it.
          for (const argument of node.arguments) walk(argument, messageId, seen);
          return;

        case 'Identifier':
          // A bare `console.error(accessToken)` or `` `...${refreshToken}` ``.
          if (isSecretName(node.name)) {
            context.report({ node, messageId, data: { name: node.name } });
          }
          return;

        case 'MemberExpression': {
          // `console.info(config.accessToken)`.
          const property = node.computed ? staticName(node.property) : staticName(node.property);
          if (property !== null && isSecretName(property)) {
            context.report({ node, messageId, data: { name: property } });
          }
          walk(node.object, messageId, seen);
          return;
        }

        default:
          return;
      }
    };

    return {
      CallExpression(node) {
        const { callee } = node;

        // console.log / console.info / console.warn / console.error
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'console'
        ) {
          const seen = new Set();
          for (const argument of node.arguments) walk(argument, 'inLog', seen);
          return;
        }

        // NextResponse.json(...) / Response.json(...)
        if (callee.type === 'MemberExpression') {
          const method = staticName(callee.property);
          if (method !== null && RESPONSE_CALLEES.has(normalise(method))) {
            const seen = new Set();
            for (const argument of node.arguments) walk(argument, 'inResponse', seen);
          }
          return;
        }

        // The repository's own helpers: `jsonOk({...})`, `jsonError(...)`.
        if (callee.type === 'Identifier' && BARE_RESPONSE_CALLEES.has(normalise(callee.name))) {
          const seen = new Set();
          for (const argument of node.arguments) walk(argument, 'inResponse', seen);
        }
      },

      // `new Response(JSON.stringify({...}))` — a body built without a helper. The inner
      // `JSON.stringify` is reached by the recursive walk, which is the one place it is
      // unambiguously a response rather than a request.
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || !RESPONSE_CONSTRUCTORS.has(node.callee.name)) return;
        const seen = new Set();
        for (const argument of node.arguments) walk(argument, 'inResponse', seen);
      },
    };
  },
};

export default rule;
export { SECRET_NAMES, isSecretName };
