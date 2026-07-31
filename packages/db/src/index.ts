/**
 * @compass/db — the persistence and scoped-query layer.
 *
 * Layer position: above the clock and the connector port, below the knowledge
 * model. It owns the schema, the migrations and the single chokepoint through
 * which every query is built. Nothing above it may import a database driver.
 */
export * as schema from './schema/index.js';
export {
  BELIEF_AT_COLUMN,
  FIRST_SEEN_AT_COLUMN,
  LAST_SEEN_AT_COLUMN,
  NAMED_ENTITY_REQUIRED_COLUMNS,
  NATURAL_KEY_COLUMN,
  ORGANIZATION_ID_COLUMN,
  VERSION_COLUMN,
  entityStateColumns,
  fromDatabaseInstant,
  fromNullableDatabaseInstant,
  organizationId,
  recordTimestamps,
  toDatabaseInstant,
} from './schema/columns.js';
export {
  auditLogEntries,
  ingestRuns,
  ingestSourceCoverage,
  membershipRole,
  membershipStatus,
  memberships,
  organizations,
  sessions,
  sourceConfigs,
  users,
} from './schema/tables.js';

export {
  absences,
  blockers,
  branchRefs,
  commits,
  companies,
  developers,
  feedbackEntries,
  features,
  identityLinks,
  managerMemos,
  objectives,
  projects,
  pullRequests,
  recommendations,
  releaseTags,
  repositories,
  reviews,
  risks,
  sprints,
  teamMemberships,
  teams,
  tickets,
  trackedProjects,
  trackedRepositories,
  unmatchedIdentities,
  wins,
  workingCalendars,
} from './schema/entities.js';

export { objectiveLinks, objectiveScopeLinks, objectiveVersions } from './schema/goals.js';

export { authTokenPurpose, authTokens, membershipTeamScopes } from './schema/auth.js';

export {
  appendAuditLogEntry,
  auditLogRowId,
  authTokenRowId,
  consumeAuthToken,
  ensureMembership,
  ensureUser,
  findAuditLogEntry,
  findAuthTokenByHash,
  findMembershipById,
  findMembershipByUserId,
  findSessionById,
  findSessionByTokenHash,
  findUserByEmail,
  findUserById,
  insertAuthToken,
  insertSession,
  listAuditLogEntries,
  listLiveAuthTokens,
  listSeats,
  listSessionsForUser,
  listTeamScopes,
  listUsableMemberships,
  membershipRowId,
  normalizeEmail,
  replaceTeamScopes,
  revokeAllSessionsForUser,
  revokeAuthTokens,
  revokeSession,
  sessionRowId,
  setMembershipRole,
  setMembershipStatus,
  setUserDisplayName,
  setUserPasswordHash,
  teamScopeRowId,
  touchSession,
  userRowId,
  type AuditLogInput,
  type AuditLogRow,
  type AuthTokenInput,
  type AuthTokenPurpose,
  type AuthTokenRow,
  type MembershipInput,
  type MembershipRole,
  type MembershipRow,
  type MembershipStatus,
  type SeatRow,
  type SessionInput,
  type SessionRow,
  type UserInput,
  type UserRow,
} from './repositories/auth.js';

export {
  GoalNodeExistsError,
  GoalNodeNotFoundError,
  appendGoalRevision,
  appendGoalScopeLink,
  archiveGoalNode,
  findObjectiveLinksForSubject,
  goalRevisionRowId,
  goalScopeLinkRowId,
  listObjectiveLinks,
  loadGoalNodeHistory,
  loadGoalStore,
  objectiveLinkRowId,
  recordObjectiveLinks,
  scopeLinkKey,
  syncGoalNodes,
  type GoalNodeInput,
  type GoalNodeOrigin,
  type GoalNodeRevisionRow,
  type GoalScopeLinkInput,
  type GoalScopeLinkRow,
  type GoalStoreContents,
  type GoalWriteResult,
  type ObjectiveLinkInput,
  type StoredObjectiveLink,
} from './repositories/goals.js';

export {
  REPORT_SECTION_COUNT,
  reportItemEvidence,
  reportItems,
  reportSections,
  reports,
} from './schema/reports.js';

export { narrationTraces } from './schema/narration.js';

export {
  deliveryChannel,
  deliveryLog,
  deliveryScope,
  deliveryStatus,
  shareAudience,
  shareLinkAccess,
  shareLinkAccessOutcome,
  shareLinks,
  subscriptions,
} from './schema/delivery.js';

export {
  createShareLink,
  deactivateSubscription,
  findShareLinkById,
  findShareLinkByTokenHash,
  findSubscriptionById,
  findSubscriptionByUnsubscribeHash,
  findSubscriptionForChannel,
  hasBeenSent,
  listActiveSubscriptions,
  listDeliveryAttempts,
  listShareLinkAccess,
  listShareLinksForReport,
  listSubscriptionsForUser,
  recordDeliveryAttempt,
  recordShareLinkAccess,
  revokeShareLink,
  upsertSubscription,
  type DeliveryAttemptInput,
  type DeliveryAttemptStatus,
  type DeliveryChannelName,
  type DeliveryScopeName,
  type ShareAccessOutcome,
  type ShareAudienceName,
  type ShareLinkAccessInput,
  type ShareLinkInput,
  type StoredDeliveryAttempt,
  type StoredShareLink,
  type StoredShareLinkAccess,
  type StoredSubscription,
  type SubscriptionInput,
} from './repositories/delivery.js';

export {
  listNarrationTraces,
  narrationTraceRowId,
  recordNarrationTraces,
  type NarrationTraceInput,
  type StoredNarrationTrace,
} from './repositories/narration.js';

export {
  APPEND_ONLY_TABLE_NAMES,
  corrections,
  entityVersions,
  isAppendOnlyTableName,
  sprintScopeChanges,
  ticketStatusTransitions,
  type AppendOnlyTableName,
} from './schema/history.js';

export {
  ENTITY_KINDS,
  NAMED_ENTITIES,
  UnknownEntityKindError,
  entityTableName,
  isEntityKind,
  isNamedEntityTable,
  namedEntity,
  type EntityKind,
  type NamedEntityDefinition,
  type NamedEntityTable,
} from './schema/registry.js';

export {
  COMPASS_UUID_NAMESPACE,
  correctionRowId,
  deterministicUuid,
  entityRowId,
  entityVersionRowId,
  historyRowId,
  ingestRunRowId,
  reportChildRowId,
  reportRowId,
} from './entity-id.js';

export {
  AppendOnlyTableError,
  CrossOrgWriteError,
  MissingOrgScopeError,
  UnscopedTableError,
  assertOrgScopedTable,
  isOrgScopedTable,
  orgScope,
  requireOrgScope,
  type OrgScope,
  type OrgScopedTable,
} from './scope.js';

export {
  ScopedDb,
  createScopedDb,
  type CompassDatabase,
  type ScopedInsert,
  type ScopedSelect,
} from './scoped-db.js';

export {
  MissingDatabaseUrlError,
  createDatabase,
  resolveDatabaseUrl,
  type DatabaseHandle,
} from './client.js';

export { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

export {
  insertIngestRun,
  listCoverageForRun,
  listRecentIngestRuns,
  sourceCoverageCursors,
  type IngestRunCoverageInput,
  type IngestRunInput,
  type SourceCoverageCursor,
  type StoredIngestRun,
} from './repositories/ingest-runs.js';

export {
  ReportSectionCountError,
  ReportSectionOrdinalError,
  findClaimsCitingArtifact,
  findEvidenceForArtifact,
  findLatestReport,
  findLatestReportForDate,
  findReportById,
  findReportForInstant,
  loadReportBundle,
  reportIdFor,
  saveReport,
  type CitingClaim,
  type ReportEvidenceInput,
  type ReportInput,
  type ReportItemInput,
  type ReportSectionInput,
  type StoredReport,
  type StoredReportBundle,
  type StoredReportEvidence,
  type StoredReportItem,
  type StoredReportSection,
} from './repositories/reports.js';

export {
  EMPTY_FRESHNESS,
  loadFreshness,
  type FreshnessReport,
  type SourceFreshness,
} from './repositories/freshness.js';

export {
  ensureOrganization,
  findOrganization,
  type EnsuredOrganization,
  type OrganizationInput,
  type OrganizationRow,
} from './repositories/organizations.js';

export {
  appendEntityVersion,
  appendSprintScopeChange,
  appendTicketStatusTransition,
  countEntityRows,
  findEntityRow,
  insertCorrection,
  insertEntityRow,
  listCorrections,
  listEntityRows,
  listEntityVersions,
  listSprintScopeChanges,
  listTicketStatusTransitions,
  patchEntityRow,
  tableNameOf,
  type CorrectionInput,
  type EntityRow,
  type EntityVersionInput,
  type RowValues,
  type SprintScopeChangeInput,
  type TicketStatusTransitionInput,
} from './repositories/entity-rows.js';
