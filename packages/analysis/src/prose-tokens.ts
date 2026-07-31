import {
  extractNumericTokens,
  type NumericToken,
} from './numeric-tokens.js';
import { ALIGNMENT_TICKET_KEY_PATTERN } from './alignment-text.js';

/**
 * The prose-grounding extractor: every disputable token in a piece of prose.
 *
 * This is the half of the grounding rule that reads the *prose*. The other half —
 * the vocabulary a token has to be found in — is built from the structured
 * payload by `@compass/narrator`, which is also where the two are compared. The
 * split is deliberate: extraction is pure text analysis and belongs in the
 * zero-dependency core beside `numeric-tokens.ts`, which it is built on so that
 * the grounding validator and the renderer's interpretation check cannot disagree
 * about what "states a quantity" means.
 *
 * ## What is extracted, and why each kind is separate
 *
 * Seven kinds, because each one is grounded by a different comparison and a single
 * "is this string in the payload" test would be wrong for most of them:
 *
 *  - **`number`** and **`percentage`** — compared by *value*, so `1,240` in the
 *    prose matches `1240` in the payload and `62%` matches the integer 62. A
 *    string comparison would reject both.
 *  - **`date`** — an ISO civil date is one identifier for one day, never the three
 *    quantities 2026, 08 and 14.
 *  - **`pull_request`** — `#883` is grounded only by a payload that says `#883`.
 *    Deliberately *not* by the bare number 883: a sprint that happens to carry 883
 *    points must not make up a pull request number.
 *  - **`commit_sha`** — compared by prefix in both directions, because the report
 *    labels a commit by its first seven characters while the payload may carry the
 *    full revision id.
 *  - **`tracker_key`** — `CHK-701`, matched case-sensitively and exactly.
 *  - **`person_name`** — the one kind with no machine-checkable shape, handled
 *    below.
 *
 * ## Person names
 *
 * There is no reliable regex for a person's name, so this does the only honest
 * thing available: it treats **every capitalised word run as a claim that has to
 * be traceable**, and leans on the fact that Compass prose is written from the
 * payload. A capitalised run that is not in the payload is either a fabricated
 * name or a word this extractor should have known about — and both are worth
 * failing on, because the failure is a fallback to the deterministic renderer
 * rather than a wrong report.
 *
 * Two rules keep that from firing on ordinary English:
 *
 *  1. A **single** capitalised word at the start of a sentence is grammar, not a
 *     name, and is skipped. `Nothing is blocked` claims nothing about a person.
 *  2. A single capitalised word anywhere is skipped when it is in
 *     `PROSE_CAPITALISED_VOCABULARY` — the closed set of words Compass itself
 *     writes capitalised (its own name, the six section titles, `Sprint`,
 *     weekdays, months) plus the sentence-openers that can follow a dash or a
 *     semicolon.
 *
 * A run of **two or more** capitalised words is always a candidate, whatever the
 * words are, because that is the shape a fabricated name takes and no sentence
 * Compass writes contains an ungrounded two-word proper noun.
 *
 * ## Fail-closed, on purpose
 *
 * Where a shape is ambiguous this extractor over-matches rather than under-matches.
 * `defaced` is seven characters of hex and would be read as a commit SHA; a
 * report whose prose contained it would be rejected and rendered by the template
 * renderer. That is the correct trade: a false rejection costs a manager nothing
 * but a slightly plainer page, and a false acceptance costs them the one thing
 * this product sells.
 */

export const PROSE_TOKEN_KINDS = [
  'number',
  'percentage',
  'date',
  'pull_request',
  'commit_sha',
  'tracker_key',
  'objective_key',
  'person_name',
] as const;

export type ProseTokenKind = (typeof PROSE_TOKEN_KINDS)[number];

export interface ProseToken {
  readonly kind: ProseTokenKind;
  /** The token exactly as it appears in the prose — `62%`, `#883`, `Priya Raman`. */
  readonly text: string;
  /**
   * The comparison form. Numbers carry their value as a string with separators
   * stripped; everything else carries the text a vocabulary lookup uses.
   */
  readonly normalized: string;
  /** Set on `number` and `percentage` only. */
  readonly value: number | null;
  readonly start: number;
  readonly end: number;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** `#883`. Bounded so `PLAT-1#2` and `#883a` are not pull requests. */
export const PULL_REQUEST_TOKEN_PATTERN = /(?<![\p{L}\p{N}_#-])#(\d{1,7})(?![\p{L}\p{N}_-])/gu;

/**
 * A commit revision id or the seven-character prefix a report labels one by.
 *
 * Lower case only: `commitEvidence` slices a lowercase hex revision id, and
 * accepting upper case would read every seven-letter acronym as a SHA.
 */
export const COMMIT_SHA_TOKEN_PATTERN = /(?<![\p{L}\p{N}_-])[0-9a-f]{7,40}(?![\p{L}\p{N}_-])/gu;

/** `CHK-701`. The same shape the ingest layer used to write `commits.ticket_key`. */
export const TRACKER_KEY_TOKEN_PATTERN = new RegExp(ALIGNMENT_TICKET_KEY_PATTERN.source, 'g');

/**
 * A goal-node id: `OBJ-Q2-BILL`.
 *
 * The eighth kind, and the one the seven-kind list in the acceptance criteria does
 * not name — added because an alignment verdict is the most consequential sentence
 * Compass writes and the objective it names is the checkable part of it. A narration
 * that moved an OFF-GOAL flag from `OBJ-Q2-BILL` to `OBJ-Q1-LEGACY` would accuse the
 * same work of serving a different dead objective, and none of the other seven kinds
 * would notice.
 *
 * **Two or more hyphen groups** is the discriminator that keeps this from colliding
 * with the kinds above it: `CHK-701`, `DEV-501` and the product's own `OFF-GOAL` all
 * have exactly one, so they are read as a tracker key or as text and never as an
 * objective. `OBJ-Q2-BILL` has two.
 */
export const OBJECTIVE_KEY_TOKEN_PATTERN = /\b[A-Z][A-Z0-9]{1,9}(?:-[A-Z0-9]{1,12}){2,}\b/g;

/** An ISO civil date, extracted here so it is one token rather than three numbers. */
export const PROSE_DATE_TOKEN_PATTERN = /(?<![\p{L}\p{N}_-])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}_-])/gu;

/**
 * One capitalised word, including the forms real surnames take.
 *
 * `\p{Lu}\p{Ll}` rather than `[A-Z][a-z]` so a name outside Latin-1 is still seen,
 * and the trailing `\p{Ll}+` requirement is what stops `PLAT`, `OFF`, `R2` and `T13`
 * being read as names.
 *
 * Three shapes are allowed, each for a reason:
 *
 *  - an optional `O'`/`D'` prefix, so `O’Brien` is one word rather than `Brien`;
 *  - internal hyphens, so `Anne-Marie` is one word;
 *  - **no** apostrophe *suffix*, which is the subtle one. An apostrophe may only be
 *    followed by an uppercase letter. That is what keeps `Priya Raman's` from
 *    capturing the possessive `'s` — the run ends at `Raman`, so grounding compares
 *    the name against the payload rather than the name-plus-clitic, which no payload
 *    contains.
 */
const CAPITALISED_WORD = String.raw`(?:\p{Lu}['’])?\p{Lu}\p{Ll}+(?:-\p{Lu}?\p{Ll}+)*`;

/** A run of capitalised words, optionally with a middle initial. */
export const PERSON_NAME_TOKEN_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_-])${CAPITALISED_WORD}(?:[ ](?:${CAPITALISED_WORD}|\\p{Lu}\\.))*`,
  'gu',
);

/**
 * The words Compass writes capitalised that are not people.
 *
 * This list does two jobs, and the second is the important one.
 *
 * In the **extractor**, it suppresses a lone capitalised word mid-sentence, so
 * `so Compass will not give you a date` claims nothing about a person.
 *
 * In the **grounding validator**, it makes these words *transparent* inside a
 * multi-word run. That is what resolves the one genuinely ambiguous case in name
 * detection: at the start of a sentence, `Ask Priya Raman to review it` and
 * `Priya Raman merged it` are the same shape, and nothing local can tell whether
 * the first capitalised word is grammar or a first name. So the extractor stops
 * guessing — it emits the greedy run `Ask Priya Raman` — and grounding checks the
 * run's *substantive* words, skipping the ones on this list. `Ask` is transparent,
 * `Priya` and `Raman` must be in the payload, and a fabricated `Prya` is still
 * named. Guessing in the extractor instead would either glue `Ask` onto every
 * imperative recommendation (rejecting correct prose on every report) or drop the
 * first word of every sentence-initial name (leaving fabricated first names
 * unchecked).
 *
 * Closed and small on purpose: the product's own vocabulary, the calendar, the
 * sentence-openers, and the imperative verbs the recommendation engine starts a
 * step with. A word missing from here does not produce a wrong report — it produces
 * a rejected narration and a template render.
 */
export const PROSE_CAPITALISED_VOCABULARY: ReadonlySet<string> = new Set([
  // The product and its fixed furniture.
  'Compass',
  'Yesterday',
  'Progress',
  'Blockers',
  'Risks',
  'Recommendations',
  'Wins',
  'Evidence',
  'Sprint',
  'Kanban',
  'Velocity',
  'Projected',
  'Between',
  'Done',
  'Review',
  'In',
  'To',
  'Backlog',
  'Blocked',
  'Merged',
  'Released',
  'Reached',
  'Open',
  'Closed',
  'Draft',
  // The calendar.
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  // Sentence-openers that can follow a dash, a semicolon or a colon.
  'And',
  'As',
  'At',
  'Because',
  'Both',
  'But',
  'By',
  'Each',
  'Every',
  'For',
  'From',
  'However',
  'If',
  'Instead',
  'It',
  'Its',
  'Last',
  'Neither',
  'Nobody',
  'None',
  'Nor',
  'Not',
  'Nothing',
  'On',
  'One',
  'Only',
  'Or',
  'Since',
  'So',
  'That',
  'The',
  'Their',
  'There',
  'These',
  'This',
  'Those',
  'Two',
  'Until',
  'What',
  'When',
  'Where',
  'Which',
  'While',
  'Who',
  'With',
  'Your',
  // The imperative verbs a recommendation step opens with. `generateRecommendations`
  // writes "actor + one-step action", and the action is a verb phrase.
  'Add',
  'Ask',
  'Assign',
  'Check',
  'Close',
  'Confirm',
  'Consider',
  'Decide',
  'Drop',
  'Escalate',
  'Find',
  'Follow',
  'Give',
  'Keep',
  'Merge',
  'Move',
  'Note',
  'Pair',
  'Pick',
  'Raise',
  'Reassign',
  'Release',
  'Remove',
  'Reopen',
  'Send',
  'Split',
  'Start',
  'Stop',
  'Take',
  'Tell',
  'Unblock',
  'Watch',
  'Write',
]);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Span {
  readonly start: number;
  readonly end: number;
}

const overlaps = (span: Span, taken: readonly Span[]): boolean =>
  taken.some((other) => span.start < other.end && other.start < span.end);

/**
 * Offsets at which a new sentence begins.
 *
 * A single capitalised word here is grammar rather than a name. Computed from the
 * text directly rather than from `splitSentences`, because what is needed is the
 * *offset* of each opening word and a decimal point inside a number must not count
 * as a boundary.
 */
function sentenceStartOffsets(text: string): ReadonlySet<number> {
  const starts = new Set<number>();
  let expecting = true;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (/\s/.test(character)) continue;

    if (expecting) {
      starts.add(index);
      expecting = false;
    }

    if (character === '\n') {
      expecting = true;
      continue;
    }
    if (character === '.' || character === '!' || character === '?') {
      const before = text[index - 1] ?? '';
      const after = text[index + 1] ?? '';
      // `3.5` is one number, not the end of a sentence.
      if (character === '.' && /\d/.test(before) && /\d/.test(after)) continue;
      expecting = true;
    }
  }

  return starts;
}

const matchesOf = (text: string, pattern: RegExp): readonly RegExpMatchArray[] =>
  [...text.matchAll(new RegExp(pattern.source, pattern.flags))].filter((match) => match.index !== undefined);

/**
 * Every disputable token in a piece of prose, in the order it appears.
 *
 * Extraction is ordered from the most specific shape to the least, and a span
 * already claimed by an earlier kind is never re-read: `#883` is a pull request
 * and not also the number 883, and `2026-08-14` is a date and not also three
 * numbers. Without that, grounding would demand a payload contain both readings
 * of the same characters and would reject correct prose.
 */
export function extractProseTokens(prose: string): readonly ProseToken[] {
  const taken: Span[] = [];
  const tokens: ProseToken[] = [];

  const claim = (token: ProseToken): void => {
    tokens.push(token);
    taken.push({ start: token.start, end: token.end });
  };

  // 1. Dates, tracker keys, pull requests and SHAs: unambiguous shapes first.
  for (const match of matchesOf(prose, PROSE_DATE_TOKEN_PATTERN)) {
    const text = match[0];
    claim({ kind: 'date', text, normalized: text, value: null, start: match.index!, end: match.index! + text.length });
  }

  // Objective keys before tracker keys: `OBJ-Q2-BILL` contains no tracker-key
  // match, but claiming the longer identifier first keeps the ordering honest if
  // either pattern is ever widened.
  for (const match of matchesOf(prose, OBJECTIVE_KEY_TOKEN_PATTERN)) {
    const text = match[0];
    const span = { start: match.index!, end: match.index! + text.length };
    if (overlaps(span, taken)) continue;
    claim({ kind: 'objective_key', text, normalized: text, value: null, ...span });
  }

  for (const match of matchesOf(prose, TRACKER_KEY_TOKEN_PATTERN)) {
    const text = match[0];
    const span = { start: match.index!, end: match.index! + text.length };
    if (overlaps(span, taken)) continue;
    claim({ kind: 'tracker_key', text, normalized: text, value: null, ...span });
  }

  for (const match of matchesOf(prose, PULL_REQUEST_TOKEN_PATTERN)) {
    const text = match[0];
    const span = { start: match.index!, end: match.index! + text.length };
    if (overlaps(span, taken)) continue;
    claim({ kind: 'pull_request', text, normalized: `#${match[1] ?? ''}`, value: null, ...span });
  }

  for (const match of matchesOf(prose, COMMIT_SHA_TOKEN_PATTERN)) {
    const text = match[0];
    const span = { start: match.index!, end: match.index! + text.length };
    if (overlaps(span, taken)) continue;
    claim({ kind: 'commit_sha', text, normalized: text.toLowerCase(), value: null, ...span });
  }

  // 2. Quantities, via the one tokeniser the renderer's interpretation check uses.
  for (const numeric of extractNumericTokens(prose)) {
    const span = { start: numeric.start, end: numeric.end };
    if (overlaps(span, taken)) continue;
    claim(numericToken(numeric));
  }

  // 3. Names last: whatever characters are left.
  const sentenceStarts = sentenceStartOffsets(prose);
  for (const match of matchesOf(prose, PERSON_NAME_TOKEN_PATTERN)) {
    const text = match[0];
    const span = { start: match.index!, end: match.index! + text.length };
    if (overlaps(span, taken)) continue;

    const words = text.split(' ');
    if (words.length === 1) {
      if (sentenceStarts.has(span.start)) continue;
      if (PROSE_CAPITALISED_VOCABULARY.has(text)) continue;
    }
    claim({ kind: 'person_name', text, normalized: text, value: null, ...span });
  }

  return tokens.sort((left, right) => left.start - right.start || left.end - right.end);
}

function numericToken(numeric: NumericToken): ProseToken {
  const isPercentage = numeric.text.endsWith('%');
  return {
    kind: isPercentage ? 'percentage' : 'number',
    text: numeric.text,
    normalized: String(numeric.value),
    value: numeric.value,
    start: numeric.start,
    end: numeric.end,
  };
}

/** The words of a name run — what grounding falls back to when the run is absent. */
export function personNameWords(token: ProseToken): readonly string[] {
  if (token.kind !== 'person_name') return [];
  return token.text.split(' ').filter((word) => !word.endsWith('.'));
}
