/**
 * @compass/seed-connector — the MVP runtime substrate.
 *
 * Layer position: beside the port, above nothing. Only the process edge may
 * import this package: an architecture rule forbids ingest, the knowledge model,
 * analysis, the renderers and the pipeline from referring to it, so no code path
 * below the port can know a seeded provider exists.
 *
 * The package holds three things: the declarative fixtures' loader and the
 * deterministic generator that expands them, the manifest that documents what
 * the expansion produced, and the ConnectorPort implementation that serves it.
 */
export { SeedConnector } from './seed-connector.js';
export { foundationDataset, FOUNDATION_WINDOW, FOUNDATION_UNAVAILABLE_SOURCE_KEY } from './foundation-dataset.js';
export type { SeedDataset, SeedRecords, SeedSource } from './dataset.js';

export {
  FIXTURE_FILE_NAMES,
  FixtureParseError,
  loadSeedFixtures,
  type FixtureDeveloper,
  type FixtureObjective,
  type FixtureProject,
  type FixtureTeam,
  type SeedFixtures,
} from './fixtures.js';

export {
  SeedGenerationError,
  generateSeed,
  type GeneratedObjective,
  type GeneratedSeed,
} from './generator.js';

export {
  MANIFEST_TRACEABILITY_CLASSES,
  computeManifest,
  renderManifestMarkdown,
  type ManifestIdentity,
  type ManifestPathology,
  type ManifestRequirement,
  type ManifestTraceability,
  type ManifestUnmappedEmail,
  type SeedManifest,
} from './manifest.js';

export {
  INSTANT_FIELDS,
  MANIFEST_DATA_FILE_NAME,
  SeedSerializationError,
  artifactFileName,
  fromReadableRecords,
  serializeRecords,
  stableJsonText,
  toReadableRecords,
} from './serialize.js';

export {
  SEED_DIRECTORY_ENV_VAR,
  SEED_DIRECTORY_NAME,
  SEED_MANIFEST_FILE_NAME,
  SeedDirectoryNotFoundError,
  findRepositoryRoot,
  resolveSeedDirectory,
  seedFixturesDirectory,
  seedGeneratedDirectory,
  seedManifestPath,
} from './seed-paths.js';

export {
  DATASET_META_FILE_NAME,
  SeedNotGeneratedError,
  buildSeedFiles,
  loadSeedBundle,
  roundTripRecords,
  seedBundle,
  seedDataset,
  writeSeedFiles,
  type SeedBundle,
  type SeedDatasetMeta,
  type WriteSeedResult,
} from './seed-dataset.js';

export {
  SEMANTIC_MATCH_THRESHOLD,
  TICKET_KEY_PATTERN,
  TRACEABILITY_CLASSES,
  bestSemanticMatch,
  buildTraceabilityContext,
  classifyCommitTraceability,
  firstTicketKey,
  sharePercentage,
  traceabilityDistribution,
  type AlignmentTarget,
  type TraceabilityClass,
  type TraceabilityContext,
  type TraceabilityDistributionEntry,
} from './traceability.js';

export {
  resolveSeededInstant,
  type SeededInstant,
  type SeededInstantInput,
} from './report-instant.js';

export {
  DEFAULT_TEAM_KEY,
  DEFAULT_TIMEZONE,
  SEEDED_ORGANIZATION_ID,
  TEAM_KEY_ENV_VAR,
  TIMEZONE_ENV_VAR,
  resolveSeededRun,
  resolveSubstrate,
  resolveTeamKey,
  resolveTimezone,
  seededRunWindow,
  type ResolvedSubstrate,
  type SeededRun,
  type SeededRunInput,
} from './seeded-run.js';

export { EmptySelectionError, createRng, hashSeed, type Rng } from './rng.js';
export { STOPWORDS, diceSimilarity, normalizeTokens, sharedTokens, slugify, tokenSet } from './text.js';
