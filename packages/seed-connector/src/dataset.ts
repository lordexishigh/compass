import type { ArtifactKind, ConnectorRecordFor, CoverageReason, SourceKind } from '@compass/connector-port';

/**
 * A source as the seed declares it, including whether it is pretending to be
 * down. Degradation has to be exercisable without credentials, so "Jira is
 * rate-limited" is a fixture state rather than a production-only surprise.
 */
export interface SeedSource {
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly availability:
    | { readonly status: 'available' }
    | { readonly status: 'unavailable'; readonly reason: CoverageReason; readonly detail: string };
}

export type SeedRecords = { readonly [TKind in ArtifactKind]: readonly ConnectorRecordFor<TKind>[] };

export interface SeedDataset {
  readonly datasetId: string;
  readonly sources: readonly SeedSource[];
  readonly records: SeedRecords;
  /** No CI/CD connector exists, so R5 of the Completion Ladder is never inferable. */
  readonly deploySignal: boolean;
}
