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
  canonicalPrettyJson,
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
  type PersistedNarration,
  type PersistReportInput,
} from './persist.js';

export {
  feedbackRecordFrom,
  loadFeedbackLedger,
  loadPriorReportState,
} from './feedback-state.js';

export {
  goalNodeInputsFromSnapshot,
  loadGoalHierarchyAt,
  objectiveLinkInputsFrom,
  persistObjectiveLinks,
  syncGoalHierarchy,
} from './goal-sync.js';

export {
  coverageNotesFrom,
  nameRedactionsFrom,
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

export {
  DEFAULT_GENERATION_LOCAL_TIME,
  GENERATION_LOCAL_TIME_ENV_VAR,
  reportInstantForDate,
  resolveGenerationLocalTime,
} from './generation-time.js';

export {
  MergedReportUnavailableError,
  ensureMergedReport,
  ensureWeeklyDigest,
  mergeStoredReports,
  structuredReportFrom,
  type EnsureMergedReportRequest,
  type EnsureWeeklyDigestRequest,
  type EnsuredMergedReport,
  type EnsuredTeamReport,
  type EnsuredWeeklyDigest,
} from './merged-report.js';

export { ARTIFACT_ROUTE_KINDS, artifactHref, isArtifactRouteKind, type ArtifactRouteKind } from './artifact-route.js';
