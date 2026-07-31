import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  MissingInstantError,
  assertPipelineContext,
  definePipelineStage,
  runPipeline,
  runStage,
  type PipelineContext,
} from '@compass/pipeline';

const context: PipelineContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  now: instantFromIso('2026-07-30T08:00:00Z'),
  window: timeWindow(instantFromIso('2026-07-29T00:00:00Z'), instantFromIso('2026-07-30T00:00:00Z')),
  timezone: 'Europe/London',
};

describe('pipeline stages', () => {
  it('receive the instant as a parameter', async () => {
    const stage = definePipelineStage<string, string>('echo-instant', (input, ctx) => `${input}@${ctx.now}`);

    expect(await runStage(stage, 'report', context)).toBe(`report@${context.now}`);
  });

  it('cannot be defined without accepting a context', () => {
    // A stage that takes only its input has nowhere to receive `now` from, so it
    // would have to find the time itself.
    expect(() => definePipelineStage('clockless', ((input: string) => input) as never)).toThrow(TypeError);
    expect(() => definePipelineStage('', (input: string, _ctx) => input)).toThrow(TypeError);
  });

  it('refuse to run without a usable instant', async () => {
    const stage = definePipelineStage<string, string>('needs-now', (input, _ctx) => input);

    await expect(runStage(stage, 'x', undefined as unknown as PipelineContext)).rejects.toThrow(MissingInstantError);
    await expect(runStage(stage, 'x', { ...context, now: undefined as never })).rejects.toThrow(MissingInstantError);
    await expect(runStage(stage, 'x', { ...context, now: 'now' as never })).rejects.toThrow(MissingInstantError);
    await expect(runStage(stage, 'x', { ...context, window: undefined as never })).rejects.toThrow(
      MissingInstantError,
    );
  });

  it('name the offending stage when the instant is missing', () => {
    expect(() => assertPipelineContext('materialize-snapshot', { ...context, now: Number.NaN as never })).toThrow(
      /materialize-snapshot/,
    );
  });

  it('thread one context through every stage in order', async () => {
    const seen: string[] = [];
    const stages = ['ingest', 'snapshot', 'analyse'].map((name) =>
      definePipelineStage<string[], string[]>(name, (input, ctx) => {
        seen.push(`${name}:${ctx.now}`);
        return [...input, name];
      }),
    );

    const result = await runPipeline(stages as never, [], context);

    expect(result).toEqual(['ingest', 'snapshot', 'analyse']);
    expect(seen).toEqual([`ingest:${context.now}`, `snapshot:${context.now}`, `analyse:${context.now}`]);
  });

  it('are frozen once defined', () => {
    expect(Object.isFrozen(definePipelineStage('x', (input: number, _ctx) => input))).toBe(true);
  });
});
