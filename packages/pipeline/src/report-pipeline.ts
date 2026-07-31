import {
  DEFAULT_ANALYSIS_CONFIG,
  generateStructuredReport,
  type GoalHierarchy,
  type ReportCoverageNote,
  type ReportScope,
  type StructuredReport,
} from '@compass/analysis';
import type { Instant, TimeWindow } from '@compass/clock';
import type { ConnectorPort, SourceCoverage } from '@compass/connector-port';
import { ScopedDb, orgScope, type CompassDatabase, type StoredReport } from '@compass/db';
import { ingestWindowIntoModel, type ModelIngestResult } from '@compass/ingest';
import { KnowledgeStore, buildKnowledgeSnapshot, type KnowledgeSnapshot } from '@compass/knowledge-model';
import { renderReport, type RenderedReport } from '@compass/renderers';

import { loadGoalHierarchyAt, persistObjectiveLinks, syncGoalHierarchy } from './goal-sync.js';
import { persistReport } from './persist.js';
import { definePipelineStage, runStage, type PipelineContext } from './stage.js';

/**
 * The report pipeline: one (organization, team, instant) in, one persisted report
 * out.
 *
 * This is the only function in Compass that touches every layer, and it is
 * deliberately linear:
 *
 *   ingest window -> build snapshot -> run analysis -> render prose -> persist
 *
 * Each step is a `PipelineStage`, which means each one is handed the same
 * `PipelineContext` and each one has its instant *validated* on entry. Nothing
 * below this file constructs a clock — `compass/no-clock-instantiation` fails the
 * build if it tries — and `now` is a required parameter of this function rather
 * than something it resolves for itself. That is what makes time travel a matter
 * of passing a different instant, and what makes a test's report reproducible.
 *
 * The connector is a parameter too. The pipeline cannot tell whether the provider
 * behind the port is seeded or live, and it must not be able to: the seeded
 * connector exists precisely so that this code path is the same one a GitHub
 * connector will run.
 */

export interface ReportPipelineRequest {
  readonly organizationId: string;
  readonly scope: ReportScope;
  /** The instant the report is generated *for*. Never read from a clock here. */
  readonly now: Instant;
  readonly timezone: string;
  /** The window the report is about — normally the team's previous civil day. */
  readonly window: TimeWindow;
  /**
   * The window to pull through the connector, when it differs from the report
   * window. A cold start needs the whole history behind the sprint; a nightly run
   * needs only yesterday. Defaults to the report window.
   */
  readonly ingestWindow?: TimeWindow;
  /** The IngestRun's id, supplied by the edge. One run, one row, always. */
  readonly runId: string;
  readonly connector: ConnectorPort;
  readonly database: CompassDatabase;
  /** Skip the ingest stage and analyse what is already in the model. */
  readonly skipIngest?: boolean;
  readonly maxItemsPerSection?: number;
}

export interface ReportPipelineResult {
  readonly report: StructuredReport;
  readonly rendered: RenderedReport;
  readonly stored: StoredReport;
  readonly snapshot: KnowledgeSnapshot;
  /** The goal hierarchy this report's alignment verdicts resolved against. */
  readonly goalHierarchy: GoalHierarchy;
  /** ObjectiveLinks offered to the store — one per resolved, non-orphan subject. */
  readonly objectiveLinkCount: number;
  /** Null when `skipIngest` was set. */
  readonly ingest: ModelIngestResult | null;
  /** Each stage in the order it ran, for a log line worth reading. */
  readonly stages: readonly string[];
}

/**
 * Coverage notes for the masthead, from what the connector reported.
 *
 * One note per *source*, folded from the per-artifact coverage rows by taking the
 * worst status: a manager needs to know whether to trust the tracker today, not
 * which of its six endpoints answered. The connector's own sentence is carried
 * through unedited — Compass does not soften "rate limited".
 */
export function coverageNotesFrom(coverage: readonly SourceCoverage[]): readonly ReportCoverageNote[] {
  const severity: Readonly<Record<string, number>> = { complete: 0, partial: 1, unavailable: 2 };
  const bySource = new Map<string, ReportCoverageNote>();

  for (const entry of coverage) {
    const existing = bySource.get(entry.sourceKey);
    if (existing === undefined || (severity[entry.status] ?? 2) > (severity[existing.status] ?? 0)) {
      bySource.set(entry.sourceKey, {
        sourceKey: entry.sourceKey,
        status: entry.status,
        detail: entry.detail,
      });
    }
  }

  return [...bySource.values()];
}

export async function runReportPipeline(request: ReportPipelineRequest): Promise<ReportPipelineResult> {
  const scoped = new ScopedDb(request.database, orgScope(request.organizationId));
  const store = new KnowledgeStore(scoped);

  const context: PipelineContext = {
    organizationId: request.organizationId,
    now: request.now,
    window: request.window,
    timezone: request.timezone,
  };

  const stages: string[] = [];
  const record = <T>(name: string, value: T): T => {
    stages.push(name);
    return value;
  };

  // ---- 1. ingest -----------------------------------------------------------
  const ingestStage = definePipelineStage<TimeWindow, ModelIngestResult>('ingest-window', async (window, inner) =>
    ingestWindowIntoModel(request.connector, store, {
      organizationId: inner.organizationId,
      window,
      now: inner.now,
      runId: request.runId,
    }),
  );

  const ingest =
    request.skipIngest === true
      ? null
      : record('ingest-window', await runStage(ingestStage, request.ingestWindow ?? request.window, context));

  // ---- 2. snapshot ---------------------------------------------------------
  const snapshotStage = definePipelineStage<null, KnowledgeSnapshot>('build-snapshot', async (_input, inner) =>
    buildKnowledgeSnapshot(store, {
      scope: request.scope,
      instant: inner.now,
      timezone: inner.timezone,
      window: inner.window,
    }),
  );
  const snapshot = record('build-snapshot', await runStage(snapshotStage, null, context));

  // ---- 3. the goal hierarchy -----------------------------------------------
  // Projected from the model, then read back at the report instant. Two steps
  // rather than one because the *stored* hierarchy is what a verdict is resolved
  // against: a manager's edit lives only in the store, and reading it back is what
  // makes the edit take effect on the next report. `goal-sync.ts` explains why an
  // observed sync never supersedes a declared revision.
  const goalStage = definePipelineStage<null, GoalHierarchy>('sync-goals', async (_input, inner) => {
    await syncGoalHierarchy(scoped, snapshot, inner.now);
    return loadGoalHierarchyAt(scoped, inner.now);
  });
  const goalHierarchy = record('sync-goals', await runStage(goalStage, null, context));

  // ---- 4. analysis ---------------------------------------------------------
  // The one pure stage. It is handed the materialized snapshot and the instant,
  // and it reaches for nothing else — which is why the report it returns is
  // reproducible from those two arguments alone.
  const analysisStage = definePipelineStage<KnowledgeSnapshot, StructuredReport>(
    'analyse',
    (input, inner) =>
      generateStructuredReport(input, inner.now, {
        // Asked of the connector, never inferred. Deriving a deploy from a merge
        // would be the single most damaging claim this product could make.
        deploySignalAvailable: request.connector.capabilities().deploySignal,
        coverage: ingest === null ? [] : coverageNotesFrom(ingest.summary.coverage),
        maxItemsPerSection: request.maxItemsPerSection ?? DEFAULT_ANALYSIS_CONFIG.maxItemsPerSection,
        goalHierarchy,
      }),
  );
  const report = record('analyse', await runStage(analysisStage, snapshot, context));

  // ---- 5. render -----------------------------------------------------------
  const renderStage = definePipelineStage<StructuredReport, RenderedReport>('render', (input, _inner) =>
    renderReport(input),
  );
  const rendered = record('render', await runStage(renderStage, report, context));

  // ---- 6. persist ----------------------------------------------------------
  const persistStage = definePipelineStage<StructuredReport, StoredReport>('persist', async (input, inner) =>
    persistReport(scoped, {
      report: input,
      rendered,
      generatedAt: inner.now,
      ingestRunId: ingest === null ? null : ingest.runId,
    }),
  );
  const stored = record('persist', await runStage(persistStage, report, context));

  // ---- 7. the alignment audit trail ----------------------------------------
  // Written after the report rather than during analysis, because the analysis core
  // is pure and cannot write anything. One row per resolved subject, keyed by the
  // report instant, so a manager arguing with an OFF-GOAL flag six weeks later can
  // be shown exactly which chain, string or score produced it.
  const linkStage = definePipelineStage<StructuredReport, number>('record-objective-links', async (input, inner) =>
    persistObjectiveLinks(scoped, input.instant, input.findings.alignment, inner.now),
  );
  const objectiveLinkCount = record('record-objective-links', await runStage(linkStage, report, context));

  return { report, rendered, stored, snapshot, ingest, goalHierarchy, objectiveLinkCount, stages };
}
