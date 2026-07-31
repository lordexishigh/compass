/**
 * @compass/knowledge-model — the stateful, versioned org model.
 *
 * Layer position: above the persistence layer, below ingest and analysis.
 *
 * Its job is to hold what Compass believes about an engineering organization, and
 * to hold it in a way that supports the sentences the product is for. "Still
 * blocked, day 6" needs a persisted `first_seen_at`. "Reported blocked yesterday,
 * actually merged" needs a persisted belief to contradict, and a Correction row
 * that does not erase it. Neither is derivable from a per-run summary, which is
 * why this layer is a store and not a projection.
 *
 * Three invariants, all of them tested:
 *  - a natural key identifies an entity; observing it twice is one row
 *  - a tracked field moving appends a version; nothing rewrites one
 *  - the snapshot handed upward is plain, deterministically ordered data
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

export {
  PRESENCE_TRAIL_DAYS,
  ageInDays,
  changeSince,
  elapsedDays,
  elapsedFactsFor,
  presenceSpanDays,
  presenceTrail,
  sightedWithin,
  type ChangeSinceLastReport,
  type ElapsedFact,
} from './elapsed.js';

export {
  IncompleteObservationError,
  UntrackedFieldError,
  assertCompleteFieldSet,
  canonicalFields,
  canonicalText,
  canonicalValue,
  changedFieldNames,
  fromColumnValues,
  instantField,
  toColumnValues,
  unionSorted,
  valuesEqual,
  type FieldSet,
  type FieldValue,
} from './values.js';

export {
  KnowledgeStore,
  type CorrectionObservation,
  type EntityObservation,
  type EvidenceRef,
  type ObserveOutcome,
  type ObserveResult,
  type SprintScopeObservation,
  type StoredEntity,
  type TicketTransitionObservation,
} from './store.js';

export {
  IdentityResolver,
  identityNaturalKey,
  normalizeIdentityValue,
  type ExternalActor,
  type IdentityKind,
  type IdentityResolution,
  type UnmatchedWitness,
} from './identity.js';

export {
  DuplicateIdentityLinkError,
  provisionRoster,
  type OrgRoster,
  type RosterAbsence,
  type RosterCompany,
  type RosterDeveloper,
  type RosterObjective,
  type RosterProvisionResult,
  type RosterTeam,
} from './roster.js';

export {
  CONTRADICTION_KINDS,
  believedBlocked,
  describeCorrection,
  detectBlockedButDone,
  detectBlockedButMerged,
  detectDoneButReopened,
  recordContradiction,
  type ContradictionCandidate,
  type ContradictionKind,
  type MergedWorkSignal,
} from './reconcile.js';

export {
  SNAPSHOT_ORDERING,
  buildKnowledgeSnapshot,
  describeSnapshotWindow,
  entitiesOfKind,
  entityByKey,
  snapshotJson,
  ticketsOfFeature,
  type BuildSnapshotInput,
  type KnowledgeCollections,
  type KnowledgeSnapshot,
  type SnapshotCorrection,
  type SnapshotEntity,
  type SnapshotEntityVersion,
  type SnapshotIngestRun,
  type SnapshotSprintScopeChange,
  type SnapshotTicketTransition,
} from './snapshot-builder.js';
