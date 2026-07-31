/**
 * @compass/knowledge-model — the stateful, versioned org model.
 *
 * Layer position: above the persistence layer, below ingest and analysis. Its
 * one job at the analysis boundary is `sealSnapshot`: a plain, deterministically
 * ordered, fully materialized structure with no database handle in sight.
 */
export {
  compareNumbers,
  compareStable,
  isSortedByStableKey,
  sortByCompositeKey,
  sortByStableKey,
} from './ordering.js';

export {
  SnapshotSerializationError,
  isSealed,
  sealSnapshot,
  type SnapshotEnvelope,
} from './snapshot.js';
