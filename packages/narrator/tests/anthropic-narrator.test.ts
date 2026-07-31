import { describe, expect, it } from 'vitest';

import { AnthropicNarrator, DEFAULT_NARRATION_MODEL, narratorFromEnvironment } from '@compass/narrator';

/**
 * The client's contract with the Messages API.
 *
 * These assert on the *request object* handed to `messages.create`, which is why
 * the client is injectable. The criterion — "the narrator is configured with no
 * tools and no ability to fetch external content" — is a statement about what is in
 * that object, and the only honest way to check it is to look.
 */

interface Recorded {
  readonly params: Record<string, unknown>;
}

function stubClient(
  reply: Partial<{
    content: readonly unknown[];
    stop_reason: string;
    stop_details: unknown;
    model: string;
  }> = {},
): { client: { messages: { create: (params: Record<string, unknown>) => Promise<unknown> } }; calls: Recorded[] } {
  const calls: Recorded[] = [];

  return {
    calls,
    client: {
      messages: {
        create: (params: Record<string, unknown>) => {
          calls.push({ params });
          return Promise.resolve({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: reply.model ?? DEFAULT_NARRATION_MODEL,
            content: reply.content ?? [{ type: 'text', text: 'Sprint 43 is 62% complete.' }],
            stop_reason: reply.stop_reason ?? 'end_turn',
            stop_details: reply.stop_details ?? null,
            usage: { input_tokens: 900, output_tokens: 40 },
          });
        },
      },
    },
  };
}

const request = {
  model: DEFAULT_NARRATION_MODEL,
  system: 'you are the narration stage',
  user: 'write the progress section',
  maxOutputTokens: 1600,
  sectionKey: 'progress',
  attempt: 1,
};

describe('the request carries no tool surface', () => {
  it('sends no tools, no MCP servers, no container and no betas', async () => {
    const { client, calls } = stubClient();
    await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);

    const params = calls[0]?.params ?? {};
    for (const forbidden of ['tools', 'tool_choice', 'mcp_servers', 'container', 'betas', 'skills']) {
      expect(params, `the narration request carries \`${forbidden}\``).not.toHaveProperty(forbidden);
    }
  });

  it('sends only the keys narration needs', async () => {
    const { client, calls } = stubClient();
    await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);

    expect(Object.keys(calls[0]?.params ?? {}).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
      'thinking',
    ]);
  });

  it('sends no sampling parameters, which the Claude 5 family rejects', async () => {
    const { client, calls } = stubClient();
    await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);

    const params = calls[0]?.params ?? {};
    for (const removed of ['temperature', 'top_p', 'top_k']) {
      expect(params, `\`${removed}\` returns a 400 on this model`).not.toHaveProperty(removed);
    }
  });

  it('disables thinking explicitly rather than by omission', async () => {
    const { client, calls } = stubClient();
    await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);

    // Omitting `thinking` enables adaptive thinking on this model family, which
    // would multiply the token cost of a rewriting task that reasons about nothing.
    expect(calls[0]?.params['thinking']).toEqual({ type: 'disabled' });
    expect(calls[0]?.params['output_config']).toEqual({ effort: 'low' });
  });

  it('passes the system prompt and the user message through unedited', async () => {
    const { client, calls } = stubClient();
    await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);

    expect(calls[0]?.params['system']).toBe(request.system);
    expect(calls[0]?.params['messages']).toEqual([{ role: 'user', content: request.user }]);
    expect(calls[0]?.params['max_tokens']).toBe(1600);
  });
});

describe('reading the response', () => {
  it('joins the text blocks and reports usage', async () => {
    const { client } = stubClient({
      content: [
        { type: 'text', text: 'Sprint 43 is 62% complete.' },
        { type: 'text', text: 'It is behind the pace.' },
      ],
    });

    const response = await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);
    expect(response.prose).toBe('Sprint 43 is 62% complete.\nIt is behind the pace.');
    expect(response.inputTokens).toBe(900);
    expect(response.outputTokens).toBe(40);
    expect(response.refusal).toBeNull();
  });

  it('does not index content[0] on a refusal', async () => {
    // A classifier decline is HTTP 200 with an empty content array. Reading
    // `content[0].text` here would throw on a successful response.
    const { client } = stubClient({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
    });

    const response = await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);
    expect(response.prose).toBe('');
    expect(response.refusal).toContain('declined');
    expect(response.refusal).toContain('cyber');
  });

  it('survives a refusal with no category', async () => {
    const { client } = stubClient({ content: [], stop_reason: 'refusal', stop_details: null });
    const response = await new AnthropicNarrator({ apiKey: 'k', client: client as never }).narrate(request);
    expect(response.refusal).toContain('no category given');
  });

  it('wraps a transport failure as a narration outage naming the section', async () => {
    const throwing = {
      messages: {
        create: () => Promise.reject(new Error('connect ETIMEDOUT')),
      },
    };

    await expect(
      new AnthropicNarrator({ apiKey: 'k', client: throwing as never }).narrate(request),
    ).rejects.toThrow(/`progress`.*ETIMEDOUT/s);
  });
});

describe('resolving a narrator from the environment', () => {
  it('returns null when the key is absent, so the report is templated', () => {
    expect(narratorFromEnvironment({})).toBeNull();
    expect(narratorFromEnvironment({ ANTHROPIC_API_KEY: '' })).toBeNull();
    expect(narratorFromEnvironment({ ANTHROPIC_API_KEY: '   ' })).toBeNull();
  });

  it('returns a narrator when the key is present', () => {
    const narrator = narratorFromEnvironment({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(narrator?.narratorId).toBe('anthropic');
  });

  it('lets the model be overridden without a second client', () => {
    const { client, calls } = stubClient({ model: 'claude-opus-5' });
    const narrator = new AnthropicNarrator({ apiKey: 'k', model: 'claude-opus-5', client: client as never });

    return narrator.narrate({ ...request, model: 'claude-opus-5' }).then((response) => {
      expect(calls[0]?.params['model']).toBe('claude-opus-5');
      expect(response.model).toBe('claude-opus-5');
    });
  });
});
