/**
 * @compass/narrator — narration and grounding.
 *
 * Layer position: above `renderers`, below `pipeline`. It is the only package that
 * talks to the Anthropic API, and it is deliberately *above* the renderers rather
 * than beside them, because its fallback is the deterministic template renderer —
 * `narrateReport` calls `renderReport` and returns its sections verbatim when
 * grounding fails, so there is one template path in the repo rather than two.
 *
 * It does not depend on `@compass/db`. The NarrationTrace rows and the Report row's
 * fallback flag are written by the pipeline, which is the layer that owns
 * persistence — the same arrangement the alignment audit trail uses, and the reason
 * a grounding test can run with no database at all.
 *
 * ## The three guarantees
 *
 * 1. **The model sees the projected section payload and nothing else.**
 *    `narrationPayload` names every field that travels, and
 *    `assertNoRawIngestedText` fails the build if a raw-text field is ever added to
 *    the shape.
 * 2. **The model originates no fact.** `validateGrounding` compares every quantity,
 *    date, identifier and name in the prose against the payload the request
 *    carried, and rejects on the first token it cannot trace.
 * 3. **A rejection degrades, never ships.** After `NARRATION_MAX_ATTEMPTS` the whole
 *    report renders from the template renderer and says so on the page.
 */
export {
  RAW_INGESTED_TEXT_FIELDS,
  RawIngestedTextError,
  assertNoRawIngestedText,
  narrationPayload,
  sectionRequests,
  type NarrationAlignment,
  type NarrationContext,
  type NarrationItem,
  type NarrationLadder,
  type NarrationPayload,
  type NarrationSection,
  type NarrationSectionRequest,
} from './payload.js';

export {
  DATA_NOT_INSTRUCTIONS_NOTICE,
  NARRATOR_SYSTEM_PROMPT,
  PROMPT_VERSION,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  buildSectionPrompt,
  escapeUntrusted,
  hashPrompt,
  renderPayloadBlock,
  type BuiltPrompt,
} from './prompt.js';

export {
  MINIMIZATION_MODES,
  NO_LLM_STATEMENT,
  REDACTED_STATEMENT,
  RealNameLeakError,
  assertNoRealNames,
  isMinimizationMode,
  realNamesIn,
  redactPayload,
  redactText,
  restoreText,
  type MinimizationMode,
  type NameRedaction,
} from './minimization.js';

export {
  UngroundedNarrationError,
  buildVocabulary,
  describeVerdict,
  validateGrounding,
  type GroundingVerdict,
  type GroundingVocabulary,
  type UntraceableToken,
} from './grounding.js';

export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_NARRATION_MODEL,
  NarrationUnavailableError,
  type NarrationRequest,
  type NarrationResponse,
  type NarratorPort,
} from './port.js';

export {
  DEFAULT_TIMEOUT_MS,
  AnthropicNarrator,
  MissingAnthropicKeyError,
  NARRATOR_ID,
  narratorFromEnvironment,
  type AnthropicNarratorOptions,
} from './anthropic-narrator.js';

export {
  NARRATED_RENDERER_ID,
  NARRATION_MAX_ATTEMPTS,
  narrateReport,
  type NarratedSection,
  type NarrateReportOptions,
  type NarrationAttemptOutcome,
  type NarrationFallback,
  type NarrationResult,
  type NarrationTraceRecord,
} from './narrate.js';
