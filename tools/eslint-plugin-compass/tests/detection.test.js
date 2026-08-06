import { describe, expect, it } from 'vitest';

import rule, {
  CREDENTIAL_PHRASES,
  SAFE_SUFFIXES,
  isCredentialName,
  literalString,
  words,
} from '../rules/no-credential-literal.js';

/**
 * The detection surface of `no-credential-literal`, asserted directly.
 *
 * ## Why this exists beside the `RuleTester` suite
 *
 * `rules.test.js` runs the rule through ESLint over fixture source, which is the right way to
 * prove it reports in the right places. It cannot prove the *classifier* is intact, because a
 * `RuleTester` case only fails when the rule's verdict changes on the exact snippet written in
 * it — and the invalid cases there are a dozen snippets, not the shape of the vocabulary.
 *
 * The specific hazard this guards is the reason the file was edited at all: that file carries a
 * standing instruction to keep credential-shaped text out of its own source, and every such
 * tidy-up is an edit near `CREDENTIAL_PHRASES` and `SAFE_SUFFIXES` made for reasons that have
 * nothing to do with detection. Deleting one phrase while rewording a comment above it would
 * silently stop the build catching a whole class of credential, and no existing test would go
 * red unless it happened to use that exact word. So the vocabulary is pinned here, and the
 * classifier is exercised against real credential shapes and real benign names on both sides.
 *
 * ## The shapes below are names, never values
 *
 * Every fixture here is a *binding name* — `FALLBACK_API_KEY`, `stripeClientSecret`. That is
 * not squeamishness about the invariant next door, it is what the rule reads: it decides on the
 * name and only then asks whether the initialiser is a literal. A test full of realistic secret
 * *values* would be testing something this rule does not do.
 */

describe('the credential vocabulary is not quietly narrowed', () => {
  /**
   * The list, pinned. A phrase removed here is a class of credential the build stops catching,
   * and it should take a deliberate edit to this array to do it — not a stray comment reflow.
   */
  it('still recognises every phrase it was built to recognise', () => {
    expect([...CREDENTIAL_PHRASES].sort()).toEqual(
      [
        'api key',
        'client secret',
        'data key',
        'master key',
        'passphrase',
        'password',
        'private key',
        'signing key',
        'secret',
        'token',
      ].sort(),
    );
  });
});

describe('a credential-named binding is still recognised', () => {
  // Real spellings from real codebases, in all four casings the splitter has to handle.
  const CREDENTIAL_NAMES = [
    'DEMO_OWNER_PASSWORD',
    'FALLBACK_API_KEY',
    'apiKey',
    'apiToken',
    'stripeClientSecret',
    'signingSecret',
    'MASTER_KEY',
    'DATA_KEY',
    'accessToken',
    'userPassphrase',
    'PRIVATE_KEY',
    'webhookSecret',
    'SIGNING_KEY',
  ];

  it.each(CREDENTIAL_NAMES)('%s is a credential name', (name) => {
    expect(isCredentialName(name)).toBe(true);
  });
});

describe('a benign name is still spared', () => {
  /**
   * Every entry is a shape that exists in this repository and that an earlier draft of the rule
   * reported. A false positive here is not a harmless over-catch: a rule that fires on
   * `credentials: 'same-origin'` gets switched off within a week, and then catches nothing.
   */
  const BENIGN_NAMES = [
    'OWNER_PASSWORD_ENV_VAR',
    'RESEND_API_KEY_ENV_VAR',
    'ownerPasswordEnvVar',
    'passwordHash',
    'tokenDigest',
    'passwordProblem',
    'secretMessage',
    'credentials',
    'ORGANIZATION_METADATA_KEY',
    'PLAN_METADATA_KEY',
    'PASSWORD_MIN_LENGTH',
    'monkeyPatch',
    'tokenPrefix',
    'secretRegex',
    'apiKeyPlaceholder',
  ];

  it.each(BENIGN_NAMES)('%s is not a credential name', (name) => {
    expect(isCredentialName(name)).toBe(false);
  });

  /**
   * The `…_ENV_VAR` names, pinned to the reason they actually pass.
   *
   * `SAFE_SUFFIXES` used to carry `envvar` and `envvars` for these, and neither could ever
   * fire — `words()` splits on `_` and on case, so both spellings end in `var`. The entries
   * were dead and the names passed for an entirely different reason: the phrase test finds no
   * credential word at the end of them. Removing dead entries is only safe if the live reason
   * is under test, so it is asserted here rather than inferred.
   */
  it('spares an environment-variable name by the phrase test, not by a suffix entry', () => {
    for (const name of ['OWNER_PASSWORD_ENV_VAR', 'ownerPasswordEnvVar']) {
      expect(words(name).at(-1), `${name} does not end in the word this test assumes`).toBe('var');
      expect(SAFE_SUFFIXES, 'the dead envvar exemption is back').not.toContain('envvar');
      expect(SAFE_SUFFIXES, `${name} is being spared by a suffix entry after all`).not.toContain('var');
      expect(isCredentialName(name)).toBe(false);
    }
  });

  it('tells a metadata key from a data key, which is the whole reason names are split into words', () => {
    // `ORGANIZATION_METADATA_KEY` ends with the characters `datakey`. A substring match would
    // report every Stripe metadata field in the billing package.
    expect(words('ORGANIZATION_METADATA_KEY').at(-2)).toBe('metadata');
    expect(isCredentialName('ORGANIZATION_METADATA_KEY')).toBe(false);
    expect(isCredentialName('DATA_KEY')).toBe(true);
  });
});

describe('what counts as a literal is unchanged', () => {
  const quasi = (raw) => ({ value: { cooked: raw, raw } });

  it('reads a plain string literal', () => {
    expect(literalString({ type: 'Literal', value: 'a-value' })).toBe('a-value');
  });

  it('reads a template literal with no interpolation, which is the same thing in other quotes', () => {
    expect(literalString({ type: 'TemplateLiteral', expressions: [], quasis: [quasi('a-value')] })).toBe('a-value');
  });

  it('refuses an interpolated template, which is composed at runtime rather than baked in', () => {
    expect(
      literalString({ type: 'TemplateLiteral', expressions: [{ type: 'Identifier' }], quasis: [quasi('a-')] }),
    ).toBeNull();
  });

  it('refuses a call and a member read', () => {
    expect(literalString({ type: 'CallExpression' })).toBeNull();
    expect(literalString({ type: 'MemberExpression' })).toBeNull();
  });
});

describe('the module still presents the shape the plugin registry expects', () => {
  /**
   * `index.js` maps rule names to modules and `eslint.config.js` switches them on. A renamed or
   * dropped export does not error — the rule simply never runs, which is the failure mode that
   * looks like a clean build.
   */
  it('exports a rule with meta and create', () => {
    expect(typeof rule.create).toBe('function');
    expect(rule.meta.type).toBe('problem');
    expect(Object.keys(rule.meta.messages)).toEqual(['literal']);
  });
});
