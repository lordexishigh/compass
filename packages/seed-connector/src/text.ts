/**
 * Deterministic local text similarity.
 *
 * The semantic traceability class needs a score, and that score must not depend
 * on a model version, a network call or a locale. So it is a Sørensen–Dice
 * coefficient over normalised token sets: pure arithmetic on the two strings in
 * front of it, identical on every machine forever.
 *
 * Case folding uses `toLowerCase()` with no locale argument on purpose —
 * `toLocaleLowerCase()` would make the Turkish dotless i change an alignment
 * verdict, which is exactly the class of drift determinism exists to prevent.
 */

/**
 * Words carrying no attribution signal. Kept short and closed: a long list
 * starts making similarity decisions of its own, and this is meant to be a
 * measure of shared vocabulary, not a language model.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'onto',
  'or',
  'our',
  'so',
  'that',
  'the',
  'this',
  'to',
  'up',
  'we',
  'with',
]);

/**
 * Splits on anything that is not a letter, digit or an internal hyphen, folds
 * case, and drops stopwords and single characters.
 */
export function normalizeTokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function tokenSet(text: string): ReadonlySet<string> {
  return new Set(normalizeTokens(text));
}

/** Sørensen–Dice over two token sets: `2|A ∩ B| / (|A| + |B|)`, in [0, 1]. */
export function diceSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return (2 * shared) / (left.size + right.size);
}

/** The tokens two texts share, in sorted order — the evidence a verdict shows. */
export function sharedTokens(left: ReadonlySet<string>, right: ReadonlySet<string>): readonly string[] {
  return [...left].filter((token) => right.has(token)).sort();
}

/** `Guest checkout retries a declined card` → `guest-checkout-retries-a-declined`. */
export function slugify(text: string, maxWords = 5): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, maxWords)
    .join('-');
}
