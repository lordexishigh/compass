/**
 * Fails the build when shipped source assigns a string literal to a credential-named binding.
 *
 * ## The defect this exists for
 *
 * `packages/auth/src/bootstrap.ts` carried an `export const DEMO_OWNER_PASSWORD` initialised
 * to a fixed string — a working owner password, in a published package, defended as a
 * documented demonstration default. It was reachable by any deployment that forgot to set
 * `COMPASS_OWNER_PASSWORD`, which is the definition of a hardcoded credential however the
 * comment above it reads. Nothing in the build objected, because every existing gate here
 * asks about *disclosure* — `no-secret-disclosure` bans a credential going into a log line
 * or a response body — and none asked whether one was sitting in the source to begin with.
 *
 * ## Why an AST rule and not a secret scanner
 *
 * `gitleaks` already runs over history and catches credentials that *look* like credentials:
 * a `ghp_`-prefixed token, an `sk_live_` key, a connection string with a password in it. It
 * could not catch the owner password above, because that string looked like nothing. It had no
 * provider prefix and low entropy — it was only a credential because of the *name it was bound
 * to*, and a name is a syntactic fact.
 *
 * So the two gates are complementary rather than redundant: entropy and provider shape for
 * the values that betray themselves, and this rule for the ones that only a binding name
 * gives away.
 *
 * ## What is flagged
 *
 * A non-empty string literal (or a template literal with no interpolation, which is the same
 * thing) assigned to a name that ends in a credential word. `<value>` below stands for any
 * such literal:
 *
 *   const DEMO_OWNER_PASSWORD = '<value>'   // variable
 *   const config = { apiKey: '<value>' }    // object property
 *   class C { #signingSecret = '<value>' }  // class field
 *   function f(password = '<value>') {}     // default parameter
 *
 * The values are elided rather than spelled out, and that is this file's one invariant beyond
 * the rule itself: **no credential-shaped literal is written here.** It costs the examples
 * nothing, because the argument above is precisely that the value is irrelevant — a binding
 * name is what makes a credential — so a worked example needs no value to be complete. And
 * writing one would put the repository's only credential-shaped assignment inside the rule
 * that exists to ban them, which is how a secret scan starts reporting its own gates and stops
 * being read. `apps/web/tests/helpers/fixture-credentials.ts` states the same rule for the
 * suites; `tests/rules.test.js` beside this file is the one place shapes are written out in
 * full, because there they are the thing under test.
 *
 * Suffix-matched rather than exact, which is the difference from `no-secret-disclosure`'s
 * vocabulary: that rule asks "is this field *the* credential" of a flat name like `token`,
 * and a credential *constant* is almost always qualified — `DEMO_OWNER_PASSWORD`,
 * `FALLBACK_API_KEY`, `defaultClientSecret`.
 *
 * ## What is deliberately allowed, and why each
 *
 *  - **`…_ENV_VAR` and any `…EnvVar`.** `OWNER_PASSWORD_ENV_VAR = 'COMPASS_OWNER_PASSWORD'`
 *    holds the *name* of a variable, not its value. This is the pattern the fix uses, so
 *    banning it would ban the remedy.
 *  - **`…Hash`, `…Digest`.** The storage form. Compass stores digests precisely so a leak of
 *    the row is not a leak of the credential.
 *  - **`…Problem`, `…Label`, `…Kind`, `…Version`, `…Message`, `…Placeholder`, `…Pattern`,
 *    `…Prefix`, `…Regex`.** Metadata and prose *about* a credential — `passwordProblem`
 *    returns the sentence shown to a person whose password was refused.
 *  - **The empty string.** `''` is the absence of a credential, and it is how a config object
 *    states "not set" before an environment read replaces it.
 *  - **Anything not a literal.** `process.env[OWNER_PASSWORD_ENV_VAR]`, a function call, a
 *    concatenation with a variable in it. The rule is about a constant baked into the build,
 *    not about the identifier being named `password`.
 *
 * ## Scope
 *
 * Registered in `eslint.config.js` over the `SHIPPED_SOURCES` globs — every package's and app's
 * own source, and nothing else. Test files legitimately hold fixture credentials (a `ghp_`-shaped token whose
 * whole job is to be searched for in a database column), and pointing this rule at them would
 * either flood or force the fixtures into a shape that no longer tests anything. The tests
 * that hold such values name them as explicit fixture constants for a reader's benefit; the
 * boundary that matters to the build is this one.
 */

/**
 * Credential phrases a binding name may end with, as space-separated words.
 *
 * Matched against the *trailing words* of the name rather than as a substring, which is not
 * pedantry — `ORGANIZATION_METADATA_KEY` ends with the characters `datakey` and is a Stripe
 * metadata field name, not a data key. Splitting into words first is what tells
 * `DATA_KEY` from `METADATA_KEY` and `apiKey` from `monkeyPatch`.
 *
 * `credential`/`credentials` is deliberately **absent**. In this codebase and in web code
 * generally its overwhelming use is `fetch(url, { credentials: 'same-origin' })` — a request
 * mode, not a secret — and the name is too generic to carry a rule. A real credential
 * constant is qualified by what it opens: a password, a secret, a token, a key.
 */
const CREDENTIAL_PHRASES = [
  'password',
  'passphrase',
  'secret',
  'token',
  'api key',
  'private key',
  'master key',
  'data key',
  'signing key',
  'client secret',
];

/**
 * Suffixes that make a credential-named binding safe. Checked before the ban, and checked
 * against the *whole* normalised name so `ownerPasswordEnvVar` is allowed while
 * `envVarPassword` is not.
 */
const SAFE_SUFFIXES = [
  'envvar',
  'envvars',
  'hash',
  'digest',
  'kind',
  'version',
  'problem',
  'label',
  'message',
  'placeholder',
  'pattern',
  'prefix',
  'regex',
  'length',
  'name',
  'names',
  'path',
  'field',
  'header',
  'error',
  'reason',
  'statement',
];

/**
 * A binding name as lower-cased words: `OWNER_PASSWORD` and `ownerPassword` both become
 * `owner password`, and `#signingSecret` becomes `signing secret`.
 */
function words(rawName) {
  return rawName
    .replace(/[_\-#$]+/g, ' ')
    // camelCase and PascalCase boundaries, and the ALLCAPSWord case (`APIKey` → `API Key`).
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Whether a binding name claims to hold a credential. */
function isCredentialName(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0) return false;

  const parts = words(rawName);
  if (parts.length === 0) return false;

  const last = parts[parts.length - 1];
  if (SAFE_SUFFIXES.includes(last)) return false;

  // Longest phrase first, so `client secret` is considered before bare `secret` — they reach
  // the same verdict here, but the ordering keeps the list readable as intent rather than as
  // a set of coincidences.
  return CREDENTIAL_PHRASES.some((phrase) => {
    const phraseWords = phrase.split(' ');
    if (phraseWords.length > parts.length) return false;
    return phraseWords.every((word, index) => parts[parts.length - phraseWords.length + index] === word);
  });
}

/**
 * Values that name a location rather than open one.
 *
 * `{ password: '/api/auth/login' }` is a route table keyed by sign-in mode, and
 * `sign-in-panel.tsx` has one. A credential is never a path or a URL, so recognising the
 * shape is cheaper and clearer than special-casing the file.
 */
const isLocation = (value) => /^(?:\/|https?:\/\/|mailto:)/.test(value);

/**
 * The literal string a node is, or null if it is not one.
 *
 * A template literal with no expressions is a string literal written with different quotes,
 * and treating it otherwise would leave an obvious way around the rule.
 */
function literalString(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow string-literal credentials in shipped source. Read the value from an environment variable and fail with the variable’s name when it is missing.',
    },
    schema: [],
    messages: {
      literal:
        '`{{name}}` is assigned a string literal in shipped source, which makes it a credential compiled into the build and reachable by any deployment that did not override it. Read it from an environment variable and throw an error naming that variable when it is unset — see `RESEND_API_KEY` in `packages/delivery/src/transport.ts`. A comment calling it a demonstration default does not change what it opens.',
    },
  },
  create(context) {
    const report = (node, name) => {
      context.report({ node, messageId: 'literal', data: { name } });
    };

    /** The static name of a property key or a binding target. */
    const bindingName = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.type === 'Identifier') return node.name;
      if (node.type === 'PrivateIdentifier') return node.name;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      return null;
    };

    /**
     * One binding, checked. `value` may be absent (`let password;`), which is not a literal
     * and so not this rule's business.
     */
    const check = (nameNode, valueNode, reportNode) => {
      const name = bindingName(nameNode);
      if (name === null || !isCredentialName(name)) return;

      const value = literalString(valueNode);
      // The empty string is the absence of a credential, not one.
      if (value === null || value.length === 0) return;
      if (isLocation(value)) return;

      report(reportNode ?? valueNode, name);
    };

    return {
      // const PASSWORD = '<value>'
      VariableDeclarator(node) {
        check(node.id, node.init, node);
      },

      // { apiKey: '<value>' } — including inside a nested config object, because the visitor
      // reaches every Property in the file rather than only top-level ones.
      Property(node) {
        if (node.computed) return;
        check(node.key, node.value, node);
      },

      // class C { #signingSecret = '<value>' }
      PropertyDefinition(node) {
        if (node.computed) return;
        check(node.key, node.value, node);
      },

      // function f(password = '<value>') {}
      AssignmentPattern(node) {
        check(node.left, node.right, node);
      },

      // this.#token = '<value>' — a later assignment, not an initialiser.
      AssignmentExpression(node) {
        if (node.operator !== '=') return;
        const { left } = node;
        if (left.type === 'MemberExpression' && !left.computed) {
          check(left.property, node.right, node);
          return;
        }
        if (left.type === 'Identifier') check(left, node.right, node);
      },
    };
  },
};

export default rule;
export { CREDENTIAL_PHRASES, isCredentialName, literalString, words };
