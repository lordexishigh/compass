import type { NarrationRequest, NarrationResponse, NarratorPort } from '../port.js';

/**
 * Narrator fakes, following `@compass/connector-port/src/testkit`.
 *
 * Three of them, because three different tests need three different lies:
 *
 *  - `groundedNarrator` echoes facts drawn *out of the prompt*, so the pipeline can
 *    be exercised end to end and the determinism gate can run without a network;
 *  - `fabricatingNarrator` invents a number, a name and a pull request every time,
 *    so the fail-closed criterion can be asserted rather than reasoned about;
 *  - `recordingNarrator` wraps another and keeps every request, so a test can
 *    assert on the exact bytes that would have left the process.
 *
 * They live in the package they fake rather than in each caller's test folder,
 * because the fallback assertion belongs to more than one package: the pipeline
 * tests, the web view's tests and the CI grounding gate all need the same stub, and
 * three hand-rolled copies would drift.
 */

export interface FakeNarratorOptions {
  readonly narratorId?: string;
  readonly model?: string;
}

/** The payload block the prompt fenced, parsed back out of the request text. */
export function payloadFromRequest(request: NarrationRequest): Record<string, unknown> {
  const open = request.user.indexOf('<untrusted-report-data>');
  const close = request.user.indexOf('</untrusted-report-data>');
  if (open === -1 || close === -1) {
    throw new Error('The narration request carries no fenced payload block; the prompt builder changed shape.');
  }
  const json = request.user.slice(open + '<untrusted-report-data>'.length, close).trim();
  return JSON.parse(json) as Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A narrator that only ever restates the payload.
 *
 * It reads the fenced block back out of the prompt and echoes the headlines and
 * change clauses it finds. Every token it emits therefore came from the payload by
 * construction, which is exactly what makes it a useful stand-in: a test using it
 * exercises the *validating* path rather than skipping it, and if the grounding
 * validator ever developed a false positive this narrator would trip it.
 */
export function groundedNarrator(options: FakeNarratorOptions = {}): NarratorPort {
  const model = options.model ?? 'fake-grounded-1';

  return {
    narratorId: options.narratorId ?? 'fake:grounded',
    narrate(request: NarrationRequest): Promise<NarrationResponse> {
      const payload = payloadFromRequest(request);
      const section = asRecord(payload['section']);
      const items = asList(section['items']).map(asRecord);

      const lead =
        items.length === 0
          ? asText(section['emptyStatement'])
          : asText(section['summary']).length > 0
            ? asText(section['summary'])
            : `${asText(section['title'])} carries what follows.`;

      const paragraphs = items.map((item) => {
        const clause = asText(item['changeClause']);
        return [asText(item['headline']), clause.length > 0 ? `${clause}.` : '', asText(item['detail'])]
          .filter((part) => part.length > 0)
          .join(' ');
      });

      return Promise.resolve({
        prose: [lead, ...paragraphs].filter((part) => part.length > 0).join('\n\n'),
        model,
        inputTokens: request.user.length,
        outputTokens: 128,
        refusal: null,
      });
    },
  };
}

/** What `fabricatingNarrator` invents. Asserted on by name in the fallback test. */
export const FABRICATED_TOKENS: readonly string[] = Object.freeze([
  '#999917',
  'PLAT-909909',
  '99.7%',
  'Wendell Fitzcarraldo',
  '2031-12-25',
  'deadbee1234',
]);

/**
 * A narrator that fabricates on every attempt, forever.
 *
 * It writes fluent, confident prose containing a pull request that does not exist,
 * a tracker key nobody filed, a percentage nobody measured, a person who does not
 * work here, a date years away and a revision that was never pushed. Nothing it
 * produces may ever reach a page — that is the whole assertion, and it holds for
 * every one of the three attempts rather than only the first.
 */
export function fabricatingNarrator(options: FakeNarratorOptions = {}): NarratorPort {
  const model = options.model ?? 'fake-fabricating-1';
  let calls = 0;

  return {
    narratorId: options.narratorId ?? 'fake:fabricating',
    narrate(request: NarrationRequest): Promise<NarrationResponse> {
      calls += 1;
      const payload = payloadFromRequest(request);
      const section = asRecord(payload['section']);

      return Promise.resolve({
        prose: [
          `${asText(section['title'])} is in excellent shape this morning.`,
          '',
          `${FABRICATED_TOKENS[3]} shipped ${FABRICATED_TOKENS[1]} as ${FABRICATED_TOKENS[0]}, ` +
            `taking the team to ${FABRICATED_TOKENS[2]} of the quarter's target.`,
          '',
          `Revision ${FABRICATED_TOKENS[5]} is expected to release on ${FABRICATED_TOKENS[4]}. ` +
            `This is attempt ${calls}, and the answer will not change.`,
        ].join('\n'),
        model,
        inputTokens: request.user.length,
        outputTokens: 96,
        refusal: null,
      });
    },
  };
}

/** A narrator that declines, the way a safety classifier does. */
export function refusingNarrator(options: FakeNarratorOptions = {}): NarratorPort {
  return {
    narratorId: options.narratorId ?? 'fake:refusing',
    narrate(): Promise<NarrationResponse> {
      return Promise.resolve({
        prose: '',
        model: options.model ?? 'fake-refusing-1',
        inputTokens: null,
        outputTokens: null,
        refusal: 'the model declined to narrate this section (cyber)',
      });
    },
  };
}

/** A narrator whose transport never answers. */
export function unavailableNarrator(options: FakeNarratorOptions = {}): NarratorPort {
  return {
    narratorId: options.narratorId ?? 'fake:unavailable',
    narrate(): Promise<NarrationResponse> {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    },
  };
}

export interface RecordingNarrator extends NarratorPort {
  /** Every request handed to the wrapped narrator, in order. */
  readonly requests: readonly NarrationRequest[];
}

/**
 * Wraps a narrator and keeps every request.
 *
 * This is what makes "the request contains no raw commit message" an assertion over
 * bytes rather than a claim about the code: the test narrates a report built from a
 * dataset whose commit messages it knows, then greps every recorded `system` and
 * `user` string for them.
 */
export function recordingNarrator(inner: NarratorPort): RecordingNarrator {
  const requests: NarrationRequest[] = [];

  return {
    narratorId: inner.narratorId,
    requests,
    narrate(request: NarrationRequest): Promise<NarrationResponse> {
      requests.push(request);
      return inner.narrate(request);
    },
  };
}
