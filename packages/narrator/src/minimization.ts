import type { NarrationItem, NarrationPayload, NarrationSection } from './payload.js';

/**
 * LLM data minimization: how much of the org reaches the model.
 *
 * The narration payload already withholds every raw-ingested-text field — a commit
 * message, a pull request body, a chat message never leave the process, and
 * `assertNoRawIngestedText` fails the build if one is added to the shape. What it does
 * still carry is *people's names*, because the report is about people and the sentences
 * name them.
 *
 * This module is the setting that answers "and who gets to know who works here".
 *
 * ## The three modes
 *
 *  - **`full`** — the payload goes as computed. Real names travel. The mode for an
 *    organization that has decided its provider relationship is fine.
 *  - **`redacted`** — every developer's name is replaced by a stable pseudonym on the
 *    way out, and the real names are put back *locally* after generation. The reader's
 *    page is the same page; the provider never learns a name. This is the default,
 *    because it costs the reader nothing.
 *  - **`none`** — no request is made at all. The report renders through the
 *    deterministic template renderer, which is the same renderer the grounding fallback
 *    uses, so there is one templated path in the repo rather than two.
 *
 * ## Why redaction happens to the payload and not to the prompt string
 *
 * The prompt is built *from* the payload, and the grounding validator checks the
 * returned prose against that same payload. Redact the payload and the two stay in
 * agreement: the model is shown `Wren Alder`, writes `Wren Alder`, and grounding
 * traces it. Redact the rendered prompt string instead and grounding would be
 * validating pseudonymous prose against a payload full of real names, rejecting every
 * section and falling back on every report.
 *
 * ## The asymmetry between redacting and restoring, which is deliberate
 *
 * Redaction is **greedy**: the full name is replaced, and then any remaining word of
 * that name is replaced with the matching word of the pseudonym. A ticket title that
 * happens to say `Fix Priya's regex` is ingested text Compass did not compose, and it
 * should not be the hole through which a name escapes.
 *
 * Restoration is **strict**: only the complete two-word pseudonym is turned back into a
 * name. A lone `Wren` in the returned prose is left as `Wren`.
 *
 * The asymmetry is the safe direction for each half to fail. A greedy restore would
 * have to decide whether a capitalised word in the model's prose is half a pseudonym or
 * an ordinary noun — and getting that wrong means rewriting `the Alder migration` into
 * `the Priya Raman migration`, which is a false attribution printed in a manager's
 * report. Leaving a pseudonym in place is merely a slightly odd sentence.
 */

export const MINIMIZATION_MODES = ['full', 'redacted', 'none'] as const;

export type MinimizationMode = (typeof MINIMIZATION_MODES)[number];

export const isMinimizationMode = (value: unknown): value is MinimizationMode =>
  typeof value === 'string' && (MINIMIZATION_MODES as readonly string[]).includes(value);

/**
 * One person's real name and the stand-in that travels instead.
 *
 * Supplied by the caller rather than derived here. The narrator sits above the
 * knowledge model and does not get to read a roster; the pipeline resolves the map from
 * the snapshot through `pseudonymMap` in `@compass/knowledge-model`, which is the one
 * place the scheme lives.
 */
export interface NameRedaction {
  readonly realName: string;
  readonly pseudonym: string;
}

/** Escapes a literal for use inside a RegExp. */
const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A whole-word, case-insensitive replacer for one literal.
 *
 * `\b` on both sides rather than a bare `replaceAll`, so `Ann` does not rewrite the
 * middle of `Announcement`. Case-insensitive because a model that lower-cased a name
 * still wrote the name.
 */
const wholeWord = (literal: string): RegExp => new RegExp(`\\b${escapeLiteral(literal)}\\b`, 'giu');

/** Name words worth substituting on their own. Initials and particles are not. */
const SUBSTITUTABLE_WORD = /^[\p{Lu}][\p{L}'-]{2,}$/u;

interface WordPair {
  readonly from: string;
  readonly to: string;
}

/**
 * The per-word substitutions for one assignment, longest first.
 *
 * Longest first matters: replacing `Ann` before `Annette` would leave `etteAlder`.
 * Sorting by descending length makes the pass order-independent in practice.
 */
function wordPairs(redaction: NameRedaction): readonly WordPair[] {
  const realWords = redaction.realName.split(/\s+/u).filter((word) => SUBSTITUTABLE_WORD.test(word));
  const pseudoWords = redaction.pseudonym.split(/\s+/u);

  return realWords
    .map((word, index) => ({
      from: word,
      // A name with more words than the pseudonym has (`Maria del Carmen Ruiz`) folds
      // its extra words onto the pseudonym's last, which is lossy for prettiness and
      // exact for the property that matters: the real word does not survive.
      to: pseudoWords[Math.min(index, pseudoWords.length - 1)] ?? pseudoWords[0] ?? 'Redacted',
    }))
    .sort((left, right) => right.from.length - left.from.length);
}

/**
 * Replaces every real name in one string, greedily.
 *
 * Full names first, then leftover words. Both passes run over every redaction before
 * moving on, so a two-person sentence is fully covered.
 */
export function redactText(value: string, redactions: readonly NameRedaction[]): string {
  if (redactions.length === 0 || value.length === 0) return value;

  let redacted = value;

  const byLongestName = [...redactions].sort((left, right) => right.realName.length - left.realName.length);

  for (const redaction of byLongestName) {
    redacted = redacted.replace(wholeWord(redaction.realName), redaction.pseudonym);
  }

  for (const redaction of byLongestName) {
    for (const pair of wordPairs(redaction)) {
      redacted = redacted.replace(wholeWord(pair.from), pair.to);
    }
  }

  return redacted;
}

/**
 * Puts the real names back, strictly.
 *
 * Complete pseudonyms only. See the module note for why the two directions are not
 * mirror images.
 */
export function restoreText(value: string, redactions: readonly NameRedaction[]): string {
  if (redactions.length === 0 || value.length === 0) return value;

  let restored = value;
  const byLongestPseudonym = [...redactions].sort(
    (left, right) => right.pseudonym.length - left.pseudonym.length,
  );

  for (const redaction of byLongestPseudonym) {
    restored = restored.replace(wholeWord(redaction.pseudonym), redaction.realName);
  }

  return restored;
}

const redactNullable = (value: string | null, redactions: readonly NameRedaction[]): string | null =>
  value === null ? null : redactText(value, redactions);

function redactItem(item: NarrationItem, redactions: readonly NameRedaction[]): NarrationItem {
  return {
    ...item,
    headline: redactText(item.headline, redactions),
    detail: redactText(item.detail, redactions),
    changeClause: redactNullable(item.changeClause, redactions),
    // Evidence labels are tracker keys, pull request numbers and SHAs. They are run
    // through anyway: a label is a short string and the cost of covering it is nothing,
    // while the cost of assuming no label ever carries a name is a leak nobody looks for.
    evidenceLabels: item.evidenceLabels.map((label) => redactText(label, redactions)),
    alignment:
      item.alignment === null
        ? null
        : {
            ...item.alignment,
            label: redactNullable(item.alignment.label, redactions),
            objectiveTitle: redactNullable(item.alignment.objectiveTitle, redactions),
            question: redactNullable(item.alignment.question, redactions),
            subjectLabels: item.alignment.subjectLabels.map((label) => redactText(label, redactions)),
          },
    // `stableId` is deliberately untouched. It is a digest, it carries no name, and it
    // is the identity the feedback loop keys on — rewriting it would silently orphan
    // every dismissal a manager has ever made.
  };
}

function redactSection(section: NarrationSection, redactions: readonly NameRedaction[]): NarrationSection {
  return {
    ...section,
    summary: redactNullable(section.summary, redactions),
    emptyStatement: redactText(section.emptyStatement, redactions),
    items: section.items.map((item) => redactItem(item, redactions)),
  };
}

/**
 * The payload with every developer name replaced by their pseudonym.
 *
 * A projection of a projection, and it names every field it touches for the same reason
 * `narrationPayload` does: a spread that copied strings through unexamined would go on
 * quietly working as fields were added, and the field added last would be the one that
 * leaked.
 */
export function redactPayload(
  payload: NarrationPayload,
  redactions: readonly NameRedaction[],
): NarrationPayload {
  if (redactions.length === 0) return payload;

  return {
    context: {
      ...payload.context,
      // The scope label is a team key, not a person — but a one-person team keyed by
      // somebody's name is exactly the case that would slip through an exemption.
      scopeLabel: redactText(payload.context.scopeLabel, redactions),
    },
    sections: payload.sections.map((section) => redactSection(section, redactions)),
  };
}

/**
 * Every real name still present in a string. Empty means the redaction was complete.
 *
 * The assertion form the acceptance criterion asks for — "a test asserts no real name
 * appears in the outbound request" — lives here rather than in the test, so the web
 * app, the worker and the CI gate all check the same thing the same way.
 */
export function realNamesIn(value: string, redactions: readonly NameRedaction[]): readonly string[] {
  return redactions
    .filter((redaction) => wholeWord(redaction.realName).test(value))
    .map((redaction) => redaction.realName);
}

export class RealNameLeakError extends Error {
  readonly leaked: readonly string[];

  constructor(where: string, leaked: readonly string[]) {
    super(
      `Redacted narration mode is on, but ${where} still names ${leaked.map((name) => `\`${name}\``).join(', ')}. ` +
        'The request must carry pseudonyms only; the real names are substituted back locally after generation. ' +
        'Nothing was sent.',
    );
    this.name = 'RealNameLeakError';
    this.leaked = leaked;
  }
}

/**
 * Refuses to let a request leave with a real name in it.
 *
 * Called on the built prompt, immediately before the first attempt, and it throws
 * rather than warns. In redacted mode the promise to the team is that their names do
 * not go to the provider, and a promise with a log line for a failure mode is not one.
 * The throw is caught by `narrateSection`'s own handler and degrades the report to the
 * template renderer, which is the correct outcome: a plainer page, and no leak.
 */
export function assertNoRealNames(
  where: string,
  value: string,
  redactions: readonly NameRedaction[],
): void {
  const leaked = realNamesIn(value, redactions);
  if (leaked.length > 0) throw new RealNameLeakError(where, leaked);
}

/** The sentence a `none`-mode report carries where a narration would have been. */
export const NO_LLM_STATEMENT =
  'This report was written by Compass’s own template renderer. Your organization has narration turned ' +
  'off, so no part of it was sent to a language model. Every section, figure and link is complete; only ' +
  'the wording is templated.';

/** The sentence a redacted-mode report can state when asked how it was produced. */
export const REDACTED_STATEMENT =
  'Narration ran in redacted mode: the model was shown pseudonyms in place of every name, and the real ' +
  'names were substituted back on this machine after the prose came home.';
