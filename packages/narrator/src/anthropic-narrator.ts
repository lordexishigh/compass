import Anthropic from '@anthropic-ai/sdk';

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_NARRATION_MODEL,
  NarrationUnavailableError,
  type NarrationRequest,
  type NarrationResponse,
  type NarratorPort,
} from './port.js';

/**
 * The one place in Compass that talks to the Anthropic API.
 *
 * ## No tools, and why that is structural rather than a setting
 *
 * `messages.create` is called with `model`, `max_tokens`, `system`, `messages`,
 * `thinking` and `output_config` — and nothing else. There is no `tools` array, no
 * `mcp_servers`, no `container`, no `betas`. Tool use on the Messages API is
 * opt-in: a request with no `tools` key cannot produce a `tool_use` block, so the
 * narrator has no way to search the web, fetch a URL, run code or read a file. The
 * *only* network egress in this file is the single POST to the Messages endpoint.
 *
 * ## No sampling parameters
 *
 * `temperature`, `top_p` and `top_k` are **removed** on the Claude 5 family and
 * return a 400. Output is steered by the prompt and by `effort` instead. This is
 * the current API, not a simplification: an older narrator that passed
 * `temperature: 0` would fail every request.
 *
 * ## Thinking off, effort low
 *
 * Narration is a rewriting task over a payload that already contains every
 * decision, so extended reasoning buys nothing and costs a multiple of the tokens.
 * Thinking is therefore disabled explicitly — on Claude Sonnet 5, omitting the
 * field would enable adaptive thinking, which is a change in the current API from
 * earlier models and the kind of default that silently triples a bill.
 *
 * ## A refusal is not an exception
 *
 * The Claude 5 family runs safety classifiers that can decline a request and
 * return **HTTP 200** with `stop_reason: 'refusal'` and an empty content array.
 * Reading `content[0]` unconditionally would throw on a perfectly successful
 * response, so `stop_reason` is checked first and a refusal is reported as a
 * narration that did not happen. The caller's fail-closed path then renders the
 * report from the template renderer, which is the correct outcome: Compass does
 * not retry its way around a classifier.
 */

export const NARRATOR_ID = 'anthropic';

export interface AnthropicNarratorOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly maxOutputTokens?: number;
  /** Milliseconds. A narration that has not answered is a fallback, not a hang. */
  readonly timeoutMs?: number;
  /** Injected in tests. Never constructed from `process.env` below this line. */
  readonly client?: Pick<Anthropic, 'messages'>;
}

/** Default request timeout: a manager waiting on `/` will not wait longer. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export class AnthropicNarrator implements NarratorPort {
  readonly narratorId = NARRATOR_ID;

  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(options: AnthropicNarratorOptions) {
    this.model = options.model ?? DEFAULT_NARRATION_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Two attempts, not the SDK's default of two *retries*: a narration is
        // already retried by the grounding loop above, and a request that is
        // rate-limited is better answered by the template renderer today than by
        // a page that takes a minute to load.
        maxRetries: 1,
      });
  }

  async narrate(request: NarrationRequest): Promise<NarrationResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        // Narration reasons about nothing; the analysis core already did.
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
      });
    } catch (cause) {
      throw new NarrationUnavailableError(
        `The Anthropic API did not answer for the \`${request.sectionKey}\` section: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }

    if (message.stop_reason === 'refusal') {
      return {
        prose: '',
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        refusal: `the model declined to narrate this section (${message.stop_details?.category ?? 'no category given'})`,
      };
    }

    return {
      prose: textOf(message),
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      refusal: null,
    };
  }
}

/**
 * The text blocks, joined.
 *
 * Filtered by block type rather than indexed, because a response's `content` is a
 * discriminated union and the first block is not guaranteed to be text.
 */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export class MissingAnthropicKeyError extends Error {
  constructor() {
    super(
      'ANTHROPIC_API_KEY is not set, so narration is unavailable. This is not a failure: Compass renders ' +
        'complete six-section reports through the deterministic template renderer without it.',
    );
    this.name = 'MissingAnthropicKeyError';
  }
}

/**
 * A narrator when the key is configured, and `null` when it is not.
 *
 * Null rather than throwing, because an absent key is the *documented* zero-config
 * state: `docker compose up` with no `.env` must still serve a report. The edge
 * calls this, gets null, and the pipeline renders from the template — which is the
 * same path a grounding rejection takes, so the unconfigured case is exercised by
 * every test that exercises the fallback.
 */
export function narratorFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: Omit<AnthropicNarratorOptions, 'apiKey'> = {},
): AnthropicNarrator | null {
  const apiKey = environment['ANTHROPIC_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) return null;

  return new AnthropicNarrator({
    ...options,
    apiKey,
    model: options.model ?? environment['COMPASS_NARRATION_MODEL']?.trim() ?? DEFAULT_NARRATION_MODEL,
  });
}
