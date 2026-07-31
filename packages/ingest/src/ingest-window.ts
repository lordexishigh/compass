import type { Instant, TimeWindow } from '@compass/clock';
import {
  ARTIFACT_KINDS,
  ARTIFACT_SOURCE_KIND,
  fetchArtifact,
  unavailableCoverage,
  worstCoverageStatus,
  type ArtifactKind,
  type ConnectorPort,
  type CoverageStatus,
  type SourceCoverage,
} from '@compass/connector-port';

/**
 * Pulling one half-open window through the port.
 *
 * Two rules govern this stage. First, `now` arrives as a parameter — no clock is
 * constructed here, and lint enforces it. Second, nothing here throws because a
 * source was down: a connector that misbehaves and rejects is converted into a
 * coverage record naming the source, so a degraded run still produces a complete
 * account of what was and was not read.
 */
export interface IngestWindowRequest {
  readonly organizationId: string;
  readonly window: TimeWindow;
  readonly now: Instant;
  readonly sourceKeys?: readonly string[];
}

export interface IngestArtifactBatch {
  readonly artifact: ArtifactKind;
  readonly status: CoverageStatus;
  readonly records: readonly unknown[];
  readonly coverage: readonly SourceCoverage[];
}

export interface IngestRunSummary {
  readonly connectorId: string;
  readonly organizationId: string;
  readonly window: TimeWindow;
  readonly startedAt: Instant;
  readonly status: CoverageStatus;
  readonly totalRecords: number;
  readonly artifactCounts: Readonly<Record<ArtifactKind, number>>;
  readonly coverage: readonly SourceCoverage[];
  /** Source keys that could not answer at all, deduplicated and sorted. */
  readonly unavailableSources: readonly string[];
  /** One plain sentence per degraded source, ready to show a manager. */
  readonly degradedDetails: readonly string[];
}

export interface IngestWindowResult {
  readonly summary: IngestRunSummary;
  readonly batches: readonly IngestArtifactBatch[];
}

const emptyCounts = (): Record<ArtifactKind, number> =>
  Object.fromEntries(ARTIFACT_KINDS.map((artifact) => [artifact, 0])) as Record<ArtifactKind, number>;

export async function ingestWindow(
  connector: ConnectorPort,
  request: IngestWindowRequest,
): Promise<IngestWindowResult> {
  const batches: IngestArtifactBatch[] = [];
  const artifactCounts = emptyCounts();
  const coverage: SourceCoverage[] = [];
  let totalRecords = 0;

  for (const artifact of ARTIFACT_KINDS) {
    const batch = await fetchBatch(connector, artifact, request);
    batches.push(batch);
    artifactCounts[artifact] = batch.records.length;
    totalRecords += batch.records.length;
    coverage.push(...batch.coverage);
  }

  const unavailableSources = [
    ...new Set(coverage.filter((entry) => entry.status === 'unavailable').map((entry) => entry.sourceKey)),
  ].sort();

  const degradedDetails = [
    ...new Set(coverage.filter((entry) => entry.status !== 'complete').map((entry) => entry.detail)),
  ].sort();

  return {
    batches,
    summary: {
      connectorId: connector.connectorId,
      organizationId: request.organizationId,
      window: request.window,
      startedAt: request.now,
      status: worstCoverageStatus(coverage.map((entry) => entry.status)),
      totalRecords,
      artifactCounts,
      coverage,
      unavailableSources,
      degradedDetails,
    },
  };
}

async function fetchBatch(
  connector: ConnectorPort,
  artifact: ArtifactKind,
  request: IngestWindowRequest,
): Promise<IngestArtifactBatch> {
  try {
    const result = await fetchArtifact(connector, artifact, {
      organizationId: request.organizationId,
      window: request.window,
      now: request.now,
      ...(request.sourceKeys ? { sourceKeys: request.sourceKeys } : {}),
    });
    return {
      artifact,
      status: result.status,
      records: result.records,
      coverage: result.coverage,
    };
  } catch (error) {
    // A conforming connector reports unavailability as coverage. One that
    // throws anyway must not take the whole run down with it.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      artifact,
      status: 'unavailable',
      records: [],
      coverage: [
        unavailableCoverage({
          sourceKey: connector.connectorId,
          sourceKind: ARTIFACT_SOURCE_KIND[artifact],
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          reason: 'provider_error',
          detail: `${connector.connectorId} failed while reading ${artifact}: ${reason}`,
        }),
      ],
    };
  }
}

/** True when every source answered the whole window. */
export function isCompleteRun(summary: IngestRunSummary): boolean {
  return summary.status === 'complete';
}
