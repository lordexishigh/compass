import type { Instant } from '@compass/clock';

import {
  InvalidAssertionError,
  parseAssertion,
  resolveWindow,
  type MemoAssertion,
  type ResolvedWindow,
} from './assertion.js';

/**
 * Extraction: prose in, one typed assertion or an explicit refusal out.
 *
 * ## The refusal is the feature
 *
 * A manager types one line. Either it maps onto one of the five kinds Compass can act on, or
 * it does not — and when it does not, **the manager is told**. That sentence is the whole
 * difference between a product that accepts write access and one that pretends to.
 *
 * The tempting alternative is to file anything unrecognised as a `context_note`: nothing ever
 * fails, no manager ever sees an error, and every instruction appears to land. It is also a
 * lie. "Deprioritise billing until the vendor answers" filed as a note changes nothing about
 * tomorrow's report, and the manager has no way to discover that — they told the system and
 * the system said nothing. So `context_note` is a kind a manager can *choose*, never a bucket
 * the parser falls into, and unrecognised input produces `REFUSAL_SENTENCE`.
 *
 * ## Why there are two extractors behind one port
 *
 * `DeterministicExtractor` is rule-based and always available. `AnthropicExtractor` calls
 * Claude and handles the phrasings rules miss. The deterministic one is not a stub or a
 * fallback of last resort — it is the reason this feature exists in a container with no API
 * key at all, which is the same promise narration keeps by rendering from the template when
 * `ANTHROPIC_API_KEY` is absent. A differentiator that only works with a paid key is not
 * available in the default deployment.
 *
 * Both go through `parseAssertion`. The model's output is untrusted in exactly the way an
 * ingested ticket title is untrusted, so it is validated, never coerced, and a validation
 * failure becomes a refusal rather than a repaired memo.
 */

/**
 * The exact sentence an unrepresentable line gets back.
 *
 * Asserted verbatim by the fixture suite, and deliberately in the first person and
 * lower-case-contraction voice the rest of the product uses when it is talking about its own
 * limits. Not "invalid input", not "parse error" — those describe the manager's typing. This
 * describes Compass's vocabulary, which is where the shortcoming actually is.
 */
export const REFUSAL_SENTENCE = "I can't represent that yet";

/** Why a line was refused, for the log and the screen's second line. */
export type RefusalReason =
  | 'no_kind_matched'
  | 'schema_rejected'
  | 'window_rejected'
  | 'extractor_unavailable'
  | 'empty_input';

export interface ExtractionRefusal {
  readonly status: 'refused';
  /** Always `REFUSAL_SENTENCE`. The manager-facing half. */
  readonly message: typeof REFUSAL_SENTENCE;
  readonly reason: RefusalReason;
  /** One sentence naming what could not be represented. Shown beneath the refusal. */
  readonly detail: string;
}

export interface ExtractionSuccess {
  readonly status: 'extracted';
  readonly assertion: MemoAssertion;
  readonly window: ResolvedWindow;
  /** Which extractor produced it, recorded on the memo for auditability. */
  readonly extractorId: string;
}

export type ExtractionOutcome = ExtractionSuccess | ExtractionRefusal;

export const isRefusal = (outcome: ExtractionOutcome): outcome is ExtractionRefusal =>
  outcome.status === 'refused';

export interface ExtractionRequest {
  /** Verbatim, as the manager typed it. Never pre-normalised. */
  readonly rawText: string;
  /** The instant the memo was submitted — relative dates resolve against this. */
  readonly now: Instant;
  /** IANA zone the manager's "Thursday" is a Thursday in. */
  readonly timezone: string;
}

/**
 * What an extractor returns: a candidate object to validate, or nothing.
 *
 * Deliberately `unknown` rather than `MemoAssertion`. An extractor is a *source of
 * candidates*, not an authority on the schema — typing this as the validated shape would let
 * a rule-based extractor bypass the validator by construction, and would mean the Claude
 * extractor had to cast its way to the same place.
 */
export interface ExtractorPort {
  readonly extractorId: string;
  /** `null` when the extractor could not place the line in any kind. */
  extract(request: ExtractionRequest): Promise<unknown | null>;
}

const refuse = (reason: RefusalReason, detail: string): ExtractionRefusal => ({
  status: 'refused',
  message: REFUSAL_SENTENCE,
  reason,
  detail,
});

/**
 * The one extraction entry point: run the extractor, then validate what it said.
 *
 * Every path that produces a memo goes through here, which is what makes "invalid output is
 * rejected, not coerced" true of the Claude extractor and the rule-based one at once. A
 * caller cannot skip the validator, because the caller never sees the extractor's raw output.
 */
export async function extractMemo(
  extractor: ExtractorPort,
  request: ExtractionRequest,
): Promise<ExtractionOutcome> {
  if (request.rawText.trim().length === 0) {
    return refuse('empty_input', 'The memo was empty, so there was nothing to represent.');
  }

  let candidate: unknown | null;
  try {
    candidate = await extractor.extract(request);
  } catch (cause) {
    // An extractor that could not answer is not a refusal *of the memo* — the manager's line
    // may be perfectly representable. Stated as its own reason so the screen can say "try
    // again" rather than "Compass cannot express this", which would be a false statement
    // about the product's vocabulary.
    return refuse(
      'extractor_unavailable',
      `Compass could not read the memo just now: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (candidate === null) {
    return refuse(
      'no_kind_matched',
      'It does not map onto any of the five things Compass can act on: somebody being out, work being ' +
        'dropped from a sprint, work changing priority, an outside party blocking us, or a note for context.',
    );
  }

  let assertion: MemoAssertion;
  try {
    assertion = parseAssertion(candidate);
  } catch (cause) {
    if (cause instanceof InvalidAssertionError) {
      return refuse('schema_rejected', cause.detail);
    }
    throw cause;
  }

  let window: ResolvedWindow;
  try {
    window = resolveWindow(assertion);
  } catch (cause) {
    if (cause instanceof InvalidAssertionError) {
      return refuse('window_rejected', cause.detail);
    }
    throw cause;
  }

  return { status: 'extracted', assertion, window, extractorId: extractor.extractorId };
}
