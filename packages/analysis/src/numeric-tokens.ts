/**
 * The numeric-token extractor, and the sentence splitter it is used with.
 *
 * There is exactly one of each in Compass, and they live here, in the pure core,
 * because two different consumers need to agree about them absolutely:
 *
 *  - the **grounding validator** rejects a narration whose numbers are not in the
 *    structured report it was given; and
 *  - the **deterministic template renderer** must never print a metric without an
 *    interpretation, which is checked by asserting that every numeric token in
 *    the rendered prose shares a sentence with a clause drawn from the documented
 *    interpretation-template set.
 *
 * Those two checks are only meaningful if they tokenise identically. A second
 * copy of the regex would drift the first time somebody widened one of them, and
 * the failure mode is silent: a narration would pass grounding while the renderer
 * test still said the prose was interpreted. So there is one definition, it is
 * exported, and both callers import it.
 *
 * ## What counts as a numeric token
 *
 * A *quantity* — something a manager could dispute. `62%`, `24`, `3.5`, `1,240`.
 *
 * Deliberately **not** tokens, because they are names rather than measurements:
 *
 *  - identifiers that merely contain digits — `DEV-501`, `#9201`, `7a8b9c0`, `R2`,
 *    `T13`, `W1`, `v2`;
 *  - ISO dates and date fragments — `2026-07-30` is one identifier for one day,
 *    not the three quantities 2026, 07 and 30.
 *
 * `extractDateTokens` handles dates separately, so a consumer that does need to
 * ground them can, without every consumer having to.
 *
 * The rule that produces that behaviour is a single one: a digit run is a
 * quantity only when nothing letter-like, digit-like or identifier-joining sits
 * immediately either side of it.
 */

/** Characters that, immediately before a digit run, make it part of a name. */
const IDENTIFIER_BEFORE = String.raw`\p{L}\p{N}_#$@/\\.'\-`;

/** Characters that, immediately after a digit run, make it part of a name. */
const IDENTIFIER_AFTER = String.raw`\p{L}\p{N}_/\\'\-`;

/**
 * A quantity: an optionally comma-grouped or decimal digit run with an optional
 * percent sign, bounded on both sides by something that is not identifier-like.
 */
export const NUMERIC_TOKEN_PATTERN = new RegExp(
  `(?<![${IDENTIFIER_BEFORE}])(?:\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)%?(?![${IDENTIFIER_AFTER}])`,
  'gu',
);

/** An ISO-8601 civil date, which the quantity pattern deliberately skips. */
export const DATE_TOKEN_PATTERN = /(?<![\p{L}\p{N}_-])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}_-])/gu;

export interface NumericToken {
  /** The token exactly as it appears — `62%`, `1,240`, `3.5`. */
  readonly text: string;
  /** The token as a number: separators stripped, percent read as its face value. */
  readonly value: number;
  readonly start: number;
  readonly end: number;
}

/** Every quantity in a piece of text, in the order it appears. */
export function extractNumericTokens(text: string): readonly NumericToken[] {
  const tokens: NumericToken[] = [];
  // A fresh RegExp per call: the exported one is `g`, and sharing `lastIndex`
  // across calls would make the second call on the same string return nothing.
  const pattern = new RegExp(NUMERIC_TOKEN_PATTERN.source, NUMERIC_TOKEN_PATTERN.flags);

  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    if (match.index === undefined) continue;
    tokens.push({
      text: raw,
      value: Number.parseFloat(raw.replaceAll(',', '').replace('%', '')),
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return tokens;
}

/** Every ISO civil date in a piece of text, in the order it appears. */
export function extractDateTokens(text: string): readonly string[] {
  const pattern = new RegExp(DATE_TOKEN_PATTERN.source, DATE_TOKEN_PATTERN.flags);
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

export interface Sentence {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Sentences, for the "same sentence as its interpretation" rule.
 *
 * Two boundaries only: a line break, and a terminator (`.`, `!`, `?`) followed by
 * whitespace or the end of the text. A full stop between two digits is a decimal
 * point and is not a boundary — otherwise `3.5 points` would split, and the half
 * carrying the number would lose the half carrying its meaning.
 *
 * There is no abbreviation dictionary and there will not be one: Compass writes
 * its own prose, and a renderer that needed `e.g.` handling would be a renderer
 * emitting text nobody had checked.
 */
export function splitSentences(text: string): readonly Sentence[] {
  const sentences: Sentence[] = [];

  const push = (from: number, to: number): void => {
    const slice = text.slice(from, to);
    const leading = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed.length === 0) return;
    sentences.push({ text: trimmed, start: from + leading, end: from + leading + trimmed.length });
  };

  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== '.' && character !== '!' && character !== '?' && character !== '\n') continue;

    if (character === '.') {
      const before = text[index - 1] ?? '';
      const after = text[index + 1] ?? '';
      if (/\d/.test(before) && /\d/.test(after)) continue;
    }
    if (character !== '\n' && index + 1 < text.length && !/\s/.test(text[index + 1] ?? '')) continue;

    push(start, index + 1);
    start = index + 1;
  }
  push(start, text.length);

  return sentences;
}

export interface SentenceNumbers {
  readonly sentence: Sentence;
  readonly tokens: readonly NumericToken[];
}

/**
 * Each sentence paired with the quantities inside it — the shape both the
 * grounding validator and the renderer's interpretation test walk.
 */
export function numericTokensBySentence(text: string): readonly SentenceNumbers[] {
  return splitSentences(text).map((sentence) => ({
    sentence,
    tokens: extractNumericTokens(sentence.text).map((token) => ({
      ...token,
      start: sentence.start + token.start,
      end: sentence.start + token.end,
    })),
  }));
}

/** Sentences that state a quantity. What has to carry an interpretation. */
export function sentencesWithNumbers(text: string): readonly SentenceNumbers[] {
  return numericTokensBySentence(text).filter((entry) => entry.tokens.length > 0);
}
