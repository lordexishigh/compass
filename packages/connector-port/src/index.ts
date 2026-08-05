/**
 * @compass/connector-port — the time-windowed query port every data source
 * implements.
 *
 * Layer position: directly above @compass/clock. Nothing below the port knows
 * which provider answered; the conformance kit at `@compass/connector-port/testkit`
 * is what turns that from an intention into a checked property.
 */
export {
  InstantSchema,
  TimeWindowSchema,
  SourceKindSchema,
  ArtifactKindSchema,
  ARTIFACT_KINDS,
  ARTIFACT_SCHEMAS,
  ARTIFACT_SOURCE_KIND,
  ExternalIdentitySchema,
  CommitRecordSchema,
  PullRequestRecordSchema,
  ReviewRecordSchema,
  BranchRefRecordSchema,
  ReleaseTagRecordSchema,
  WorkItemStatusCategorySchema,
  IssueRecordSchema,
  IssueTransitionRecordSchema,
  SprintRecordSchema,
  SprintScopeChangeRecordSchema,
  MessageRecordSchema,
  ConversationKindSchema,
  type ConversationKind,
  type SourceKind,
  type ArtifactKind,
  type ExternalIdentity,
  type CommitRecord,
  type PullRequestRecord,
  type ReviewRecord,
  type BranchRefRecord,
  type ReleaseTagRecord,
  type WorkItemStatusCategory,
  type IssueRecord,
  type IssueTransitionRecord,
  type SprintRecord,
  type SprintScopeChangeRecord,
  type MessageRecord,
  type ConnectorRecordEnvelope,
  type ConnectorRecordFor,
  type AnyConnectorRecord,
} from './records.js';

export {
  COVERAGE_STATUSES,
  COVERAGE_REASONS,
  CoverageStatusSchema,
  CoverageReasonSchema,
  SourceCoverageSchema,
  SourceHealthEntrySchema,
  SourceHealthReportSchema,
  completeCoverage,
  partialCoverage,
  unavailableCoverage,
  worstCoverageStatus,
  worstStatus,
  type CoverageStatus,
  type CoverageReason,
  type CoverageInput,
  type SourceCoverage,
  type SourceHealthEntry,
  type SourceHealthReport,
} from './coverage.js';

export {
  CompositeConnector,
  EmptyCompositionError,
  type CompositeConnectorConfig,
} from './composite.js';

export {
  ARTIFACT_FETCHERS,
  connectorResult,
  degradedCoverage,
  fetchArtifact,
  isFullyCovered,
  type ArtifactFetcherName,
  type ConnectorCapabilities,
  type ConnectorPort,
  type ConnectorRequest,
  type ConnectorResult,
} from './port.js';

export {
  RATE_LIMIT_STATUS,
  SERVER_ERROR_STATUSES,
  fetchHttpClient,
  isAuthFailure,
  isRateLimited,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from './http.js';

export { compareRecords, isInCanonicalOrder, recordIdentity, sortRecords } from './ordering.js';

export {
  BANNED_PHRASES,
  BANNED_TOKENS,
  findProviderVocabularyViolations,
  providerVocabularyIn,
  tokenizeFieldName,
  type ProviderVocabularyViolation,
} from './vocabulary.js';
