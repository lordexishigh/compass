/**
 * @compass/ingest — pulls a window through the connector port and reconciles it
 * into the versioned knowledge model.
 *
 * Layer position: above the port, the persistence layer and the knowledge model;
 * below analysis. Two properties hold of everything here and both are enforced
 * rather than intended: it cannot see which provider answered, and it never reads
 * a clock — `now` is a parameter of every entry point and lint forbids
 * constructing one.
 */
export {
  ingestWindow,
  isCompleteRun,
  type IngestArtifactBatch,
  type IngestRunSummary,
  type IngestWindowRequest,
  type IngestWindowResult,
} from './ingest-window.js';

export {
  TICKET_KEY_PATTERN,
  branchRefNaturalKey,
  commitNaturalKey,
  featureNaturalKey,
  firstTicketKey,
  judgementNaturalKey,
  projectNaturalKey,
  pullRequestNaturalKey,
  releaseTagNaturalKey,
  repositoryNaturalKey,
  reviewNaturalKey,
  sprintNaturalKey,
  ticketKeysIn,
  ticketNaturalKey,
} from './naming.js';

export {
  ingestWindowIntoModel,
  type ModelIngestRequest,
  type ModelIngestResult,
  type ObservationTally,
} from './model-ingest.js';
