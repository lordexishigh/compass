/**
 * Deterministic local text similarity, for alignment scoring.
 *
 * The semantic tier needs a confidence score, and that score must not depend on a
 * model version, a network call, a locale or a host. So it is a Sørensen–Dice
 * coefficient over normalised token sets: pure arithmetic on the two strings in
 * front of it, identical on every machine forever. `docs/ARCHITECTURE.md` states
 * the rule this file implements — the Anthropic API narrates an already-computed
 * report and never decides one, so a model upgrade cannot move an alignment
 * verdict.
 *
 * Case folding uses `toLowerCase()` with no locale argument on purpose:
 * `toLocaleLowerCase()` would make the Turkish dotless i change a verdict, which
 * is exactly the class of drift determinism exists to prevent.
 *
 * ## Why this is a second copy
 *
 * `packages/seed-connector/src/text.ts` holds the same arithmetic, because the
 * seed generator has to *design* the traceability classes before this layer can
 * resolve them, and the analysis package declares zero dependencies — an import
 * either way would put a connector in this package's manifest or a report engine
 * in the seed's. The two are held together by evidence rather than by an import:
 * `tests/alignment.test.ts` resolves every commit in the generated dataset and
 * asserts the class distribution equals the one `seed/generated/manifest.json`
 * recorded. If either copy drifts, that count moves and the test names it.
 */

/**
 * Words carrying no attribution signal. Kept short and closed: a long list starts
 * making similarity decisions of its own, and this is meant to be a measure of
 * shared vocabulary, not a language model.
 *
 * Identical to `STOPWORDS` in `packages/seed-connector/src/text.ts`.
 */
export const ALIGNMENT_STOPWORDS: ReadonlySet<string> = new Set([
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
export function alignmentTokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length > 1 && !ALIGNMENT_STOPWORDS.has(token));
}

export function alignmentTokenSet(text: string): ReadonlySet<string> {
  return new Set(alignmentTokens(text));
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

/** The tokens two texts share, sorted — the evidence a semantic verdict shows. */
export function sharedAlignmentTokens(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): readonly string[] {
  return [...left].filter((token) => right.has(token)).sort();
}

/**
 * A score rounded to four decimal places.
 *
 * Dice is a ratio of small integers, so it is exactly representable far more
 * often than not — but `2/13` is not, and an unrounded score would put a
 * seventeen-digit float in a persisted report payload and in a rendered sentence.
 * Four places is finer than any threshold Compass compares against and is stable
 * under every IEEE-754 implementation, so rounding here cannot change a verdict
 * while leaving the number quotable.
 */
export function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

/**
 * Tracker keys as they appear in prose: `CHK-701`, `PLAT-742`.
 *
 * Two or more leading capitals so a bare `A-1` in a sentence is not mistaken for
 * a ticket, and a word boundary at each end so `WEB-12x` does not match. The
 * pattern is deliberately conservative and deliberately the same one
 * `packages/ingest/src/naming.ts` used to write `commits.ticket_key`: a false
 * positive here attributes a commit to work it has nothing to do with, and the
 * report would state that as fact.
 */
export const ALIGNMENT_TICKET_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/;

export interface TicketKeyMatch {
  readonly key: string;
  /** Where in the searched string the key starts. The evidence panel underlines it. */
  readonly offset: number;
  readonly length: number;
}

/** The first tracker key in a piece of text, with the offset it was found at. */
export function findTicketKey(text: string | null): TicketKeyMatch | null {
  if (text === null) return null;
  const pattern = new RegExp(ALIGNMENT_TICKET_KEY_PATTERN.source);
  const match = pattern.exec(text);
  if (match?.[0] === undefined || match.index === undefined) return null;
  return { key: match[0], offset: match.index, length: match[0].length };
}
