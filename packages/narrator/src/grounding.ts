import {
  PROSE_CAPITALISED_VOCABULARY,
  extractProseTokens,
  personNameWords,
  type ProseToken,
  type ProseTokenKind,
  type SectionKey,
} from '@compass/analysis';

import type { NarrationSectionRequest } from './payload.js';

/**
 * The grounding validator: the LLM may choose the words, never the facts.
 *
 * It has two halves. `extractProseTokens` (in the pure core, beside the
 * tokeniser the template renderer's interpretation check uses) reads the prose
 * and returns every disputable token. This file builds the **vocabulary** — the
 * set of facts the model was actually shown — and compares.
 *
 * The vocabulary is built from the exact object that was serialised into the
 * request, not from the structured report it was projected out of. That is the
 * whole basis of the guarantee: "every token exists in the payload" is only worth
 * asserting if "the payload" means the bytes the model saw. Ground against the
 * full report and the validator would happily accept a sprint point total the
 * model was never told, which is precisely a fabrication.
 *
 * ## How each kind is compared, and why not just `includes()`
 *
 * A single substring test would be wrong in both directions.
 *
 *  - **Quantities** compare by *value*: `1,240` in the prose matches `1240` in the
 *    payload, and `62%` matches the integer 62. A string test rejects correct
 *    prose.
 *  - **Pull requests** compare as `#883` and never as the bare number 883, so a
 *    sprint carrying 883 points cannot license an invented PR reference.
 *  - **Commit SHAs** compare by prefix in *both* directions, because the report
 *    labels a commit by its first seven characters while a payload may carry more.
 *  - **Tracker keys** compare exactly and case-sensitively: `chk-701` is not
 *    `CHK-701`, and a model that changed the case changed the identifier.
 *  - **Names** compare on word boundaries, case-insensitively, and fall back to
 *    per-word checking so a two-word run reports only the word that is wrong —
 *    `Prya Raman` names `Prya`, not the whole phrase.
 *
 * ## Fail closed
 *
 * A rejection is not an error state. It costs a manager a slightly plainer page,
 * because `narrate.ts` falls back to the deterministic template renderer and the
 * report row records that it did. An acceptance of a fabricated token costs the
 * product its entire reason to exist. Everything ambiguous therefore resolves to
 * rejection.
 */

export interface GroundingVocabulary {
  /** Every quantity in the payload, by value. `62%` and `62` are one entry. */
  readonly numbers: ReadonlySet<number>;
  readonly dates: ReadonlySet<string>;
  readonly trackerKeys: ReadonlySet<string>;
  /** `OBJ-Q2-BILL`. Exact, so a verdict cannot be moved to another objective. */
  readonly objectiveKeys: ReadonlySet<string>;
  /** `#883`, with the hash — the bare number is deliberately not enough. */
  readonly pullRequests: ReadonlySet<string>;
  readonly commitShas: readonly string[];
  /** Every word in every string, folded to lower case. Names check against this. */
  readonly words: ReadonlySet<string>;
  /** Every string in the payload, folded, joined — multi-word name runs check here. */
  readonly text: string;
}

export interface UntraceableToken {
  readonly kind: ProseTokenKind;
  /** The token exactly as the model wrote it. Named in the failure message. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Why it could not be traced, in the product's own voice. */
  readonly reason: string;
}

export interface GroundingVerdict {
  readonly grounded: boolean;
  readonly sectionKey: SectionKey;
  readonly tokenCount: number;
  readonly untraceable: readonly UntraceableToken[];
}

// ---------------------------------------------------------------------------
// Building the vocabulary
// ---------------------------------------------------------------------------

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * Every quantity, date and identifier reachable in the payload.
 *
 * Numbers are collected from two places: numeric *values* in the JSON (`ageDays:
 * 6`, `confidence: 0.62`) and numeric *tokens* inside strings (`62%` in a
 * headline). Both are needed — a payload states some figures as fields and others
 * inside the sentences the analysis core composed, and a narration may quote
 * either.
 */
export function buildVocabulary(request: NarrationSectionRequest): GroundingVocabulary {
  const numbers = new Set<number>();
  const dates = new Set<string>();
  const trackerKeys = new Set<string>();
  const objectiveKeys = new Set<string>();
  const pullRequests = new Set<string>();
  const commitShas: string[] = [];
  const words = new Set<string>();
  const strings: string[] = [];

  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;

    if (typeof value === 'number') {
      if (Number.isFinite(value)) numbers.add(value);
      return;
    }
    if (typeof value === 'boolean') return;

    if (typeof value === 'string') {
      strings.push(value);
      for (const match of value.matchAll(new RegExp(WORD_PATTERN.source, WORD_PATTERN.flags))) {
        words.add(match[0].toLowerCase());
      }
      // Reuse the prose extractor on payload strings so the two sides of the
      // comparison tokenise identically. A second regex here is exactly how the
      // validator would start accepting tokens the extractor rejects.
      for (const token of extractProseTokens(value)) {
        recordToken(token, { numbers, dates, trackerKeys, objectiveKeys, pullRequests, commitShas });
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  };

  visit(request);

  return {
    numbers,
    dates,
    trackerKeys,
    objectiveKeys,
    pullRequests,
    commitShas,
    words,
    text: strings.join('\n').toLowerCase(),
  };
}

function recordToken(
  token: ProseToken,
  into: {
    numbers: Set<number>;
    dates: Set<string>;
    trackerKeys: Set<string>;
    objectiveKeys: Set<string>;
    pullRequests: Set<string>;
    commitShas: string[];
  },
): void {
  switch (token.kind) {
    case 'number':
    case 'percentage':
      if (token.value !== null) into.numbers.add(token.value);
      return;
    case 'date':
      into.dates.add(token.normalized);
      return;
    case 'tracker_key':
      into.trackerKeys.add(token.normalized);
      return;
    case 'objective_key':
      into.objectiveKeys.add(token.normalized);
      return;
    case 'pull_request':
      into.pullRequests.add(token.normalized);
      return;
    case 'commit_sha':
      into.commitShas.push(token.normalized);
      return;
    case 'person_name':
      return;
  }
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/** A whole-word, case-insensitive containment test over the payload's text. */
function containsWord(vocabulary: GroundingVocabulary, phrase: string): boolean {
  const folded = phrase.toLowerCase();
  if (!folded.includes(' ')) return vocabulary.words.has(folded);

  const escaped = folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(vocabulary.text);
}

/** True when some payload SHA is a prefix of this one, or the reverse. */
function shaMatches(vocabulary: GroundingVocabulary, sha: string): boolean {
  return vocabulary.commitShas.some((known) => known.startsWith(sha) || sha.startsWith(known));
}

function checkToken(
  token: ProseToken,
  vocabulary: GroundingVocabulary,
): readonly UntraceableToken[] {
  const reject = (reason: string, text = token.text): readonly UntraceableToken[] => [
    { kind: token.kind, text, start: token.start, end: token.end, reason },
  ];

  switch (token.kind) {
    case 'number':
    case 'percentage':
      if (token.value !== null && vocabulary.numbers.has(token.value)) return [];
      return reject('no field or sentence in this section states that quantity');

    case 'date':
      if (vocabulary.dates.has(token.normalized)) return [];
      return reject('this section names no such date');

    case 'tracker_key':
      if (vocabulary.trackerKeys.has(token.normalized)) return [];
      return reject('no claim in this section carries that tracker key');

    case 'objective_key':
      if (vocabulary.objectiveKeys.has(token.normalized)) return [];
      return reject('this section resolves no verdict against that objective');

    case 'pull_request':
      if (vocabulary.pullRequests.has(token.normalized)) return [];
      return reject('no claim in this section cites that pull request');

    case 'commit_sha':
      if (shaMatches(vocabulary, token.normalized)) return [];
      return reject('no evidence in this section cites that revision');

    case 'person_name': {
      // The whole run first: a real name in the payload grounds as one phrase.
      if (containsWord(vocabulary, token.text)) return [];

      // Otherwise word by word, skipping the ones on the capitalised-vocabulary
      // list. That list is what makes the greedy run safe: the extractor cannot
      // tell whether the first word of a sentence-initial run is grammar or a
      // first name, so it emits both and this decides. `Ask` is transparent;
      // `Priya` and `Raman` are not, and a fabricated `Prya` is named below.
      const missing = personNameWords(token).filter(
        (word) => !PROSE_CAPITALISED_VOCABULARY.has(word) && !containsWord(vocabulary, word),
      );

      if (missing.length === 0) return [];

      // Report the failing *word*, so a misspelling in one half of a name points at
      // the half that is wrong rather than at the whole phrase.
      return missing.map((word) => ({
        kind: token.kind,
        text: word,
        start: token.start,
        end: token.end,
        reason: 'this section names nobody and nothing by that name',
      }));
    }
  }
}

/**
 * Validates one section's narration against the payload it was written from.
 *
 * Returns every untraceable token rather than the first, because a narration that
 * invented three numbers should be reported as having invented three — a
 * first-failure report makes the retry look like it fixed the problem when it
 * only fixed the earliest symptom.
 */
export function validateGrounding(prose: string, request: NarrationSectionRequest): GroundingVerdict {
  const vocabulary = buildVocabulary(request);
  const tokens = extractProseTokens(prose);
  const untraceable = tokens.flatMap((token) => checkToken(token, vocabulary));

  return {
    grounded: untraceable.length === 0,
    sectionKey: request.section.key,
    tokenCount: tokens.length,
    untraceable,
  };
}

export class UngroundedNarrationError extends Error {
  readonly verdict: GroundingVerdict;

  constructor(verdict: GroundingVerdict) {
    super(describeVerdict(verdict));
    this.name = 'UngroundedNarrationError';
    this.verdict = verdict;
  }
}

/**
 * The failure message, naming every offending token.
 *
 * The acceptance criterion is that the CI test fails *naming the token*, so the
 * name is built here rather than at each call site — the pipeline log, the CI
 * gate and the thrown error then all say the same sentence.
 */
export function describeVerdict(verdict: GroundingVerdict): string {
  if (verdict.grounded) {
    return `The \`${verdict.sectionKey}\` narration is grounded: all ${verdict.tokenCount} tokens trace to the payload.`;
  }

  const named = verdict.untraceable
    .map((token) => `\`${token.text}\` (${token.kind.replace(/_/g, ' ')}) — ${token.reason}`)
    .join('\n  - ');

  return (
    `The \`${verdict.sectionKey}\` narration states ${verdict.untraceable.length} thing(s) its payload does not:\n  - ${named}\n` +
    'Narration may choose emphasis, ordering and wording. It may not originate a fact.'
  );
}
