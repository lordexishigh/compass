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
  teams,
  tickets,
  unmatchedIdentities,
  wins,
} from './schema/entities.js';

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
  type IngestRunCoverageInput,
  type IngestRunInput,
  type StoredIngestRun,
} from './repositories/ingest-runs.js';

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
