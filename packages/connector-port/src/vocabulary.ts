/**
 * Provider-neutrality, enforced mechanically.
 *
 * The first live connector will want to smuggle its own identifiers through a
 * field called `sha` or `issue_number`, and once one leaks the promise that
 * downstream layers cannot tell a seeded provider from a live one is gone. So
 * the vocabulary check is part of the conformance suite, not a review checklist.
 *
 * Neutral vocabulary the port does use: repository, revision, branch, tag,
 * pull request, review, issue, sprint, message, conversation, identity.
 */

/** Whole words that may never appear in a DTO field name. */
export const BANNED_TOKENS: readonly string[] = [
  'github',
  'gitlab',
  'bitbucket',
  'gitea',
  'jira',
  'atlassian',
  'confluence',
  'slack',
  'asana',
  'trello',
  'clickup',
  'shortcut',
  'gerrit',
  'perforce',
  'devops',
  'sha',
  'oid',
  'iid',
  'epic',
  'ts',
];

/** Compound names that may never appear once separators and case are stripped. */
export const BANNED_PHRASES: readonly string[] = [
  'accountid',
  'customfield',
  'htmlurl',
  'nodeid',
  'storypoints',
  'issuekey',
  'issuenumber',
  'boardid',
  'channelid',
  'threadts',
  'epiclink',
  'mergerequest',
  'apiurl',
  'selflink',
];

export interface ProviderVocabularyViolation {
  /** Where in the record the offending name sits, e.g. `$.authorIdentity.accountId`. */
  readonly path: string;
  readonly name: string;
  readonly term: string;
}

/** Splits `authorIdentity`, `author_identity` and `author-identity` alike. */
export function tokenizeFieldName(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((chunk) => chunk.split(/(?<=[A-Za-z])(?=\d)/))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.toLowerCase());
}

/** Returns the offending term, or null when the name is provider-neutral. */
export function providerVocabularyIn(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const phrase = BANNED_PHRASES.find((candidate) => normalized.includes(candidate));
  if (phrase) return phrase;
  const tokens = tokenizeFieldName(name);
  return BANNED_TOKENS.find((candidate) => tokens.includes(candidate)) ?? null;
}

/** Walks any value (record, array, nested object) and reports every offending key. */
export function findProviderVocabularyViolations(value: unknown, path = '$'): readonly ProviderVocabularyViolation[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findProviderVocabularyViolations(entry, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const violations: ProviderVocabularyViolation[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const term = providerVocabularyIn(key);
    if (term) {
      violations.push({ path: `${path}.${key}`, name: key, term });
    }
    violations.push(...findProviderVocabularyViolations(nested, `${path}.${key}`));
  }
  return violations;
}
