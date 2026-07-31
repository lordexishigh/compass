/**
 * @compass/db — the persistence and scoped-query layer.
 *
 * Layer position: above the clock and the connector port, below the knowledge
 * model. It owns the schema, the migrations and the single chokepoint through
 * which every query is built. Nothing above it may import a database driver.
 */
export * as schema from './schema/index.js';
export {
  ORGANIZATION_ID_COLUMN,
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
