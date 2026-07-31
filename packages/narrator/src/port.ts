/**
 * The narrator port.
 *
 * Modelled on `@compass/connector-port`: an interface plus a testkit of fakes,
 * so every layer above it is written against the contract rather than against
 * Anthropic's SDK. Three things follow from that, and each one is a requirement
 * of this task rather than a preference.
 *
 * **The request is strings.** `system` and `user` are already-rendered text, so a
 * test can assert on the exact bytes that would leave the process — which is how
 * "no raw commit message is present in the request" becomes checkable rather than
 * inspected.
 *
 * **There is no tool surface.** The port has no field for tools, no field for a
 * URL, no field for a file. A narrator cannot be *configured* with tool access
 * because the shape it is called through cannot express one, and
 * `anthropic-narrator.ts` accordingly never sends a `tools` key.
 *
 * **The pipeline is testable without a network.** `testkit/` ships a deterministic
 * narrator and an always-fabricating one; the fallback test needs the second and
 * the determinism gate needs the first.
 */

/**
 * The narration model.
 *
 * `docs/ARCHITECTURE.md` names claude-sonnet-5 for narration, and this is the
 * constant it refers to. It lives beside the port rather than beside the Anthropic
 * client so the orchestration layer can default to it without importing the SDK.
 */
export const DEFAULT_NARRATION_MODEL = 'claude-sonnet-5';

/** Per section. A six-section report is therefore bounded at 6× this. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1600;

export interface NarrationRequest {
  /** Model id, recorded on the NarrationTrace so a bump is auditable. */
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  /** Which of the six sections this call is for. Trace and log only. */
  readonly sectionKey: string;
  /** 1-based. The bounded-retry loop counts with this. */
  readonly attempt: number;
}

export interface NarrationResponse {
  /** The prose, exactly as the model produced it. Never post-edited for facts. */
  readonly prose: string;
  /** The model that actually answered — not necessarily the one asked for. */
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /**
   * Set when the provider declined rather than answered.
   *
   * Claude's safety classifiers can return a successful HTTP 200 with
   * `stop_reason: 'refusal'` and an empty body. That is not an exception and must
   * not be treated as prose: it is a narration that did not happen, and it takes
   * the same fail-closed path a grounding rejection does.
   */
  readonly refusal: string | null;
}

export interface NarratorPort {
  /** Recorded on every NarrationTrace: `anthropic`, `fake:grounded`, … */
  readonly narratorId: string;
  narrate(request: NarrationRequest): Promise<NarrationResponse>;
}

export class NarrationUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NarrationUnavailableError';
  }
}
