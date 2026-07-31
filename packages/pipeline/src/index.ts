/**
 * @compass/pipeline — the only place the layers are wired together.
 *
 * Layer position: the top of the backend stack. It resolves nothing for itself:
 * the instant comes from a Clock at the process edge, the connector is handed in,
 * and the database handle is a parameter. Everything below it is told the time.
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

export {
  SCOPE_KEY_FOR_MERGED,
  coverageStatusOf,
  evidenceColumns,
  persistReport,
  reportRows,
  scopeColumns,
  type PersistReportInput,
} from './persist.js';

export {
  coverageNotesFrom,
  runReportPipeline,
  type ReportPipelineRequest,
  type ReportPipelineResult,
} from './report-pipeline.js';

export {
  ReportUnavailableError,
  defaultReportWindow,
  ensureDailyReport,
  loadFreshnessFor,
  loadLatestReport,
  scopeColumnsFor,
  type EnsuredReport,
  type EnsureReportRequest,
  type ScopeColumns,
} from './ensure-report.js';

export { ARTIFACT_ROUTE_KINDS, artifactHref, isArtifactRouteKind, type ArtifactRouteKind } from './artifact-route.js';
