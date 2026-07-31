/**
 * @compass/pipeline — the only place the layers are wired together.
 *
 * Layer position: the top of the backend stack. It resolves the instant from a
 * Clock at the edge, then threads that single instant through every stage;
 * nothing below it may construct a clock.
 */
export {
  MissingInstantError,
  assertPipelineContext,
  definePipelineStage,
  runPipeline,
  runStage,
  type PipelineContext,
  type PipelineStage,
} from './stage.js';

export {
  NON_SEMANTIC_FIELDS,
  NonSerializableValueError,
  canonicalJson,
  isSameReport,
  reportHash,
} from './canonical-json.js';
