/**
 * @compass/analysis — the pure deterministic core.
 *
 * This is the layer the product argues from. Everything a manager could dispute
 * — what finished, what is stuck, how far along the sprint is, when it will land,
 * what to do about it — is decided here, and nowhere else.
 *
 * Its purity is structural, not aspirational. `package.json` declares no
 * dependencies at all, not even @compass/clock, so an import of a database, an
 * HTTP client or a clock is a resolution failure rather than a code-review
 * discussion. `tools/quality-gates/tests/analysis-purity.test.ts` scans every
 * module and names the offending file and import if one appears, ESLint bans
 * `Math.random`, `process` and `fetch` in this tree, and every exported analysis
 * function takes the instant it should reason about as an explicit parameter.
 *
 * The determinism that buys is what makes the rest of the product possible: time
 * travel re-runs the same path for a past instant and lands on the same report,
 * golden fixtures mean something, and a manager who reloads the page sees the
 * same numbers.
 */
export {
  MILLIS_PER_DAY,
  MILLIS_PER_HOUR,
  MILLIS_PER_MINUTE,
  MILLIS_PER_SECOND,
  addDays,
  basisPoints,
  compareInstants,
  compareNumbers,
  compareStable,
  dayOfWeek,
  earliest,
  isWeekendDay,
  latest,
  meanOf,
  medianOf,
  pearsonBasisPoints,
  percent,
  percentileOf,
  priorWindow,
  scaled,
  trailingDays,
  utcCivilDate,
  utcDayIndex,
  wholeDaysBetween,
  windowContains,
  windowDays,
  workingDaysBetween,
  type Instant,
  type TimeWindow,
} from './instant.js';

export {
  THRESHOLDS,
  THRESHOLD_IDS,
  thresholdRef,
  type Threshold,
  type ThresholdId,
  type ThresholdRef,
} from './thresholds.js';

export { SECTIONS, SECTION_ORDER, sectionDefinition, type SectionDefinition, type SectionKey } from './sections.js';

export {
  BLOCKED_STATUS_PATTERN,
  DONE_STATUS_CATEGORY,
  TODO_STATUS_CATEGORY,
  booleanField,
  developerName,
  entitiesOfKind,
  entityByKey,
  indexOfKind,
  instantField,
  isDone,
  isInFlight,
  looksBlocked,
  numberField,
  projectInScope,
  repositoryInScope,
  resolveScope,
  reviewsByPullRequest,
  scopedCommits,
  scopedPullRequests,
  scopedReleaseTags,
  scopedSprints,
  scopedTickets,
  textField,
  textListField,
  transitionsByTicket,
  type AnalysisCollections,
  type AnalysisCorrection,
  type AnalysisElapsedFact,
  type AnalysisEntity,
  type AnalysisEntityVersion,
  type AnalysisIngestRun,
  type AnalysisScope,
  type AnalysisSnapshot,
  type AnalysisSprintScopeChange,
  type AnalysisTicketTransition,
  type FieldValue,
  type ResolvedScope,
} from './snapshot.js';

export {
  commitEvidence,
  orderedEvidence,
  pullRequestEvidence,
  pullRequestLabel,
  releaseEvidence,
  sprintEvidence,
  ticketEvidence,
  type EvidenceRef,
} from './evidence.js';

export {
  LADDER_RUNGS,
  NO_DEPLOY_SIGNAL_STATEMENT,
  RUNG_LABELS,
  assessLadder,
  indexArtifactsByTicket,
  rungAtOrAbove,
  rungIndex,
  type HighestRung,
  type LadderInput,
  type LadderNotch,
  type LadderOptions,
  type LadderResult,
  type LadderRungId,
  type WorkUnitArtifacts,
} from './ladder.js';

export {
  CYCLE_TIME_TRAILING_DAYS,
  VELOCITY_TRAILING_SPRINTS,
  assessKanbanFlow,
  assessProgress,
  assessVelocity,
  completedSprints,
  currentSprint,
  noProgressSignal,
  type CompletionBasis,
  type KanbanFlow,
  type ProgressAssessment,
  type ReconciliationRow,
  type ScopeLine,
  type SprintCompletion,
  type VelocityAssessment,
  type VelocitySample,
  type VelocityTrend,
} from './progress.js';

export {
  QUALIFYING_YESTERDAY_EVENTS,
  YESTERDAY_DEDUP_KEY,
  YESTERDAY_ORDER_KEY,
  detectYesterdayItems,
  yesterdayHeadline,
  type YesterdayEvent,
  type YesterdayEventKind,
  type YesterdayItem,
  type YesterdayOptions,
} from './yesterday.js';

export {
  BLOCKER_SIGNALS,
  blockerIsResolved,
  blockerTicket,
  detectBlockers,
  type BlockerSignal,
  type DetectedBlocker,
} from './blockers.js';

export {
  aggregateReviewQueue,
  changesRequestedCycles,
  isOpenPullRequest,
  latestReview,
  type ReviewQueue,
  type ReviewQueueEntry,
  type ReviewerLoad,
} from './review-queue.js';

export {
  WORKLOAD_BASIS,
  absentDeveloperKeys,
  assessWorkload,
  leastLoadedDeveloper,
  type DeveloperLoad,
  type WorkloadDistribution,
} from './workload.js';

export {
  RISK_CAUSES,
  detectRisks,
  severityFor,
  statusCategoryAt,
  trendFor,
  type DetectedRisk,
  type RiskCause,
  type RiskInputs,
  type RiskSeverity,
  type RiskTrend,
} from './risks.js';

export {
  WIN_MINIMUM_RUNG,
  detectWins,
  type DetectedWin,
  type WinQualifier,
} from './wins.js';

export {
  DEBT_TRAILING_DAYS,
  REWORK_CYCLE_COUNT,
  TECH_DEBT_LABELS,
  assessTechnicalDebt,
  isTechDebt,
  netTechnicalDebtChange,
  type DebtAgeSignal,
  type DebtCountSignal,
  type DebtGrowth,
  type DebtNetChange,
  type DebtNetChangeSignal,
  type DebtPerSprintPoint,
  type DebtReworkSignal,
  type TechnicalDebtSignal,
} from './technical-debt.js';

export {
  ELAPSED_FACT_KINDS,
  ELAPSED_FACT_MINIMUM_DAYS,
  changeSinceYesterday,
  computeElapsedFacts,
  countWord,
  factSubjectResolved,
  type ChangeSinceYesterday,
  type ElapsedFactKind,
  type ElapsedFactStatement,
} from './elapsed.js';

export {
  CALIBRATION_VERDICTS,
  assessCalibration,
  projectCompletion,
  resolvedInsideWindow,
  type CalibrationVerdict,
  type CalibrationVerdictName,
  type ConfidenceLevel,
  type ProjectedCompletion,
  type ProjectionInput,
  type ProjectionMethod,
  type ProjectionReasoning,
} from './projection.js';

export {
  MAX_RECOMMENDATIONS,
  RECOMMENDATION_SOURCES,
  REPORT_READER,
  RecommendationShapeError,
  assertRecommendationWellFormed,
  generateRecommendations,
  type Recommendation,
  type RecommendationActor,
  type RecommendationInputs,
  type RecommendationObject,
  type RecommendationSource,
} from './recommendations.js';

export {
  BANNED_OUTPUT_FIELD_PATTERNS,
  IndividualRankingError,
  assertNoIndividualRanking,
  findIndividualRankingViolations,
  type RankingViolation,
} from './ranking-guard.js';

export {
  NON_SEMANTIC_REPORT_FIELDS,
  NonSerializableReportValueError,
  canonicalReportJson,
  firstCanonicalDifference,
  reportsAreIdentical,
  type CanonicalDifference,
} from './determinism.js';

export {
  REPORT_SCHEMA_VERSION,
  SectionOrderError,
  assertSixSectionsInOrder,
  createEmptyStructuredReport,
  emptyFindings,
  sectionCounts,
  sectionOf,
  type AnalysisFindings,
  type ChangeTag,
  type EmptyReportInput,
  type ReportCoverageNote,
  type ReportItem,
  type ReportScope,
  type ReportSection,
  type StructuredReport,
} from './structured-report.js';

export {
  DEFAULT_ANALYSIS_CONFIG,
  generateStructuredReport,
  insideReportWindow,
  type AnalysisConfig,
} from './generate.js';
