import { isInstant, type Instant, type TimeWindow } from '@compass/clock';

/**
 * Pipeline stages.
 *
 * Every stage receives the already-resolved instant in its context. No stage
 * constructs a clock — `compass/no-clock-instantiation` fails the build if one
 * tries — and `runStage` rejects a context whose `now` is missing or malformed,
 * so a stage can never quietly fall back to the host clock.
 */
export interface PipelineContext {
  readonly organizationId: string;
  /** The instant the report is being generated *for*. Time travel sets this. */
  readonly now: Instant;
  readonly window: TimeWindow;
  readonly timezone: string;
}

export interface PipelineStage<TInput, TOutput> {
  readonly name: string;
  run(input: TInput, context: PipelineContext): Promise<TOutput> | TOutput;
}

export class MissingInstantError extends Error {
  constructor(stageName: string, detail: string) {
    super(
      `Stage \`${stageName}\` was invoked without a usable instant (${detail}). ` +
        'Pipeline stages never read a clock; `now` must be passed in.',
    );
    this.name = 'MissingInstantError';
  }
}

export function definePipelineStage<TInput, TOutput>(
  name: string,
  run: (input: TInput, context: PipelineContext) => Promise<TOutput> | TOutput,
): PipelineStage<TInput, TOutput> {
  if (name.trim().length === 0) {
    throw new TypeError('A pipeline stage needs a name.');
  }
  if (run.length < 2) {
    throw new TypeError(
      `Stage \`${name}\` must accept (input, context): the instant is a parameter, never something a stage finds for itself.`,
    );
  }
  return Object.freeze({ name, run });
}

export function assertPipelineContext(stageName: string, context: PipelineContext | undefined): PipelineContext {
  if (!context) {
    throw new MissingInstantError(stageName, 'no context was supplied');
  }
  if (!isInstant(context.now)) {
    throw new MissingInstantError(stageName, `now was ${String(context.now)}`);
  }
  if (!context.window || !isInstant(context.window.start) || !isInstant(context.window.end)) {
    throw new MissingInstantError(stageName, 'the window is not a pair of instants');
  }
  return context;
}

export async function runStage<TInput, TOutput>(
  stage: PipelineStage<TInput, TOutput>,
  input: TInput,
  context: PipelineContext,
): Promise<TOutput> {
  return await stage.run(input, assertPipelineContext(stage.name, context));
}

/** Runs stages in order, threading one context through all of them. */
export async function runPipeline<TInput>(
  stages: readonly PipelineStage<unknown, unknown>[],
  input: TInput,
  context: PipelineContext,
): Promise<unknown> {
  let value: unknown = input;
  for (const stage of stages) {
    value = await runStage(stage, value, context);
  }
  return value;
}
