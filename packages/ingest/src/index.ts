/**
 * @compass/ingest — pulls a window through the connector port.
 *
 * Layer position: above the port and the persistence layer, below analysis. It
 * cannot see which provider answered, and it never reads a clock: `now` is a
 * parameter of every entry point.
 */
export {
  ingestWindow,
  isCompleteRun,
  type IngestArtifactBatch,
  type IngestRunSummary,
  type IngestWindowRequest,
  type IngestWindowResult,
} from './ingest-window.js';
