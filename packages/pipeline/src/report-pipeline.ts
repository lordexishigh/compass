import {
  DEFAULT_ANALYSIS_CONFIG,
  generateStructuredReport,
  type FeedbackLedger,
  type GoalHierarchy,
  type PriorReportState,
  type ReportCoverageNote,
  type ReportScope,
  type StructuredReport,
} from '@compass/analysis';
import { toEpochMillis, type Instant, type TimeWindow } from '@compass/clock';
import type { ConnectorPort, SourceCoverage } from '@compass/connector-port';
import { ScopedDb, orgScope, type CompassDatabase, type StoredReport } from '@compass/db';
import { ingestWindowIntoModel, type ModelIngestResult } from '@compass/ingest';
import {
  KnowledgeStore,
  buildKnowledgeSnapshot,
  entitiesOfKind,
  pseudonymMap,
  type KnowledgeSnapshot,
} from '@compass/knowledge-model';
import {
  narrateReport,
  type MinimizationMode,
  type NameRedaction,
  type NarrationResult,
  type NarratorPort,
} from '@compass/narrator';
import {
  logIngestCoverageGap,
  logNarrationFallback,
  logPipelineRun,
  startTimer,
  type LogSink,
} from '@compass/observability';
import { renderReport, type RenderedReport } from '@compass/renderers';
import { recordNarrationTraces } from '@compass/db';

import { loadFeedbackLedger, loadPriorReportState } from './feedback-state.js';
import { loadGoalHierarchyAt, persistObjectiveLinks, syncGoalHierarchy } from './goal-sync.js';
import { persistReport, scopeColumnsFor, type PersistedNarration, type ScopeColumns } from './persist.js';
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
  /**
   * The narrator, resolved at the process edge like the connector and the clock.
   *
   * Absent or null means no narration stage: the report is the deterministic
   * render, `fallback_renderer` stays false, and no NarrationTrace rows are
   * written. That is the documented zero-config state, not a degradation — a
   * container with no `ANTHROPIC_API_KEY` serves complete six-section reports.
   */
  readonly narrator?: NarratorPort | null;
  /**
   * How much of the organization the model may see. Defaults to `full`.
   *
   * Read from `org_privacy_settings` by the process edge and handed down, exactly as the
   * clock, the connector and the narrator are. Defaulting to `full` here rather than to
   * the stored default is deliberate: this argument is what the *caller* decided, and a
   * pipeline that silently applied a stronger posture than it was told to would make the
   * setting page a lie in the safe direction, which is still a lie.
   */
  readonly minimization?: MinimizationMode;
  /**
   * Where the three structured events this run emits are written. Defaults to the console.
   *
   * Injectable for the same reason the clock and the connector are: a test asserts on the records
   * rather than on a captured stream. It is *not* optional in the sense of "logging can be switched
   * off" — omitting it means the process console, which is what a deployment wants.
   */
  readonly logSink?: LogSink;
}

/**
 * The name-to-pseudonym map for redacted narration, read off the snapshot.
 *
 * Two details carry weight.
 *
 * **Every developer goes into `pseudonymMap`, not just the ones being redacted.** The
 * map guarantees distinctness within the set it is given, and distinctness is what makes
 * the restoring substitution unambiguous. Feeding it a subset would let a pseudonym
 * assigned to somebody in the subset collide with one already in use by somebody
 * anonymised outside it, and the failure would be a report attributing one person's work
 * to another.
 *
 * **Already-anonymised people are excluded from the result.** What appears in their
 * report lines is their stored pseudonym, not their name, so there is nothing about them
 * left to hide from the model — and re-substituting a pseudonym for a pseudonym would
 * mean the restore pass put a *pseudonym* back, which reads as a second identity for the
 * same person.
 */
export function nameRedactionsFrom(snapshot: KnowledgeSnapshot): readonly NameRedaction[] {
  const developers = entitiesOfKind(snapshot, 'developer');

  const assignments = pseudonymMap(
    developers.map((developer) => ({
      developerKey: developer.naturalKey,
      realName: typeof developer.fields['displayName'] === 'string' ? developer.fields['displayName'] : null,
    })),
  );

  const anonymised = new Set(
    developers
      .filter((developer) => typeof developer.fields['anonymizedAt'] === 'number')
      .map((developer) => developer.naturalKey),
  );

  return assignments
    .filter(
      (assignment): assignment is typeof assignment & { readonly realName: string } =>
        assignment.realName !== null &&
        assignment.realName.trim().length > 0 &&
        !anonymised.has(assignment.developerKey),
    )
    .map((assignment) => ({ realName: assignment.realName, pseudonym: assignment.pseudonym }));
}

export interface ReportPipelineResult {
  readonly report: StructuredReport;
  readonly rendered: RenderedReport;
  /**
   * The narration outcome, or null when no narrator was supplied.
   *
   * Non-null with `fallback !== null` is the fail-closed case: narration ran, the
   * grounding validator rejected it, and `stored.prose` is the template
   * renderer's. Nothing here is ever ungrounded prose.
   */
  readonly narration: NarrationResult | null;
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
  // Started before the first stage so the measured duration is the whole run, including ingest.
  const elapsed = startTimer();
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

  // ---- 4. the two pieces of history analysis is told about ------------------
  // The prior report for this scope, and the manager's feedback. Both are *values* handed to a
  // pure function rather than queries it makes: the analysis core reads no database, so
  // change-awareness and suppression have to be loaded here or they could not exist at all.
  //
  // They are loaded in one stage because they answer one question — "what has already happened
  // between Compass and this manager" — and because a report generated with one and not the
  // other would be subtly wrong in a way nothing would flag: an item suppressed by feedback but
  // compared against a prior report that still contains it would depart and come back forever.
  const historyStage = definePipelineStage<
    ScopeColumns,
    { readonly prior: PriorReportState | null; readonly feedback: FeedbackLedger }
  >('load-change-history', async (scopeColumns, inner) => ({
    prior: await loadPriorReportState(scoped, scopeColumns, inner.now),
    feedback: await loadFeedbackLedger(scoped),
  }));
  const history = record(
    'load-change-history',
    await runStage(historyStage, scopeColumnsFor(request.scope), context),
  );

  // ---- 5. analysis ---------------------------------------------------------
  // The one pure stage. It is handed the materialized snapshot, the instant and the history
  // above, and it reaches for nothing else — which is why the report it returns is reproducible
  // from those arguments alone.
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
        ...(history.prior === null ? {} : { priorReport: history.prior }),
        feedback: history.feedback,
      }),
  );
  const report = record('analyse', await runStage(analysisStage, snapshot, context));

  // ---- 5. render -----------------------------------------------------------
  const renderStage = definePipelineStage<StructuredReport, RenderedReport>('render', (input, _inner) =>
    renderReport(input),
  );
  const rendered = record('render', await runStage(renderStage, report, context));

  // ---- 6. narrate ----------------------------------------------------------
  // The one stage that leaves the process. It is *after* the render on purpose:
  // the deterministic document already exists by the time a model is asked for
  // anything, so a narration that fails, refuses, times out or fabricates costs
  // the reader nothing but plainer wording. `narrateReport` returns either
  // grounded prose or the template renderer's own sections — there is no third
  // outcome, which is what makes ungrounded prose unable to reach `persist`.
  const narrator = request.narrator ?? null;

  /**
   * Data minimization, resolved here because this is the layer that holds the roster.
   *
   * The narrator sits above the knowledge model and cannot read a Developer row, so the
   * name-to-pseudonym map has to be resolved by a caller — and this is the only caller
   * that has both the snapshot and the mode. `pseudonymMap` is the same function
   * anonymization proposes with, which is what keeps one person from being `Wren Alder`
   * on the wire and `Contributor 3` on the roster.
   *
   * `none` mode is passed straight through and `narrateReport` makes no request at all;
   * it is not short-circuited here, so there is one place that decides what each mode
   * means rather than two that have to agree.
   */
  const minimization = request.minimization ?? 'full';
  const redactions = minimization === 'redacted' ? nameRedactionsFrom(snapshot) : [];

  const narrationStage = definePipelineStage<StructuredReport, NarrationResult | null>(
    'narrate',
    async (input, _inner) =>
      // `none` still runs the stage: it returns the template sections and the stated
      // reason, which is what puts "no part of this was sent to a model" on the page.
      narrator === null && minimization !== 'none'
        ? null
        : narrateReport(input, { narrator, rendered, minimization, redactions }),
  );
  const narration = record('narrate', await runStage(narrationStage, report, context));

  // A narrator that was never configured is not a fallback: `persist` is handed
  // nothing at all, so the report row records `template` with no fallback flag.
  const persistedNarration: PersistedNarration | undefined =
    narration === null
      ? undefined
      : {
          rendererId: narration.rendererId,
          fallbackReason: narration.fallback?.reason ?? null,
          sections: narration.sections.map((section) => ({ key: section.key, prose: section.prose })),
        };

  // ---- 7. persist ----------------------------------------------------------
  const persistStage = definePipelineStage<StructuredReport, StoredReport>('persist', async (input, inner) =>
    persistReport(scoped, {
      report: input,
      rendered,
      generatedAt: inner.now,
      ingestRunId: ingest === null ? null : ingest.runId,
      narration: persistedNarration,
    }),
  );
  const stored = record('persist', await runStage(persistStage, report, context));

  // ---- 8. the narration audit trail ----------------------------------------
  // One row per attempt, written after the report for the same reason the
  // objective links are: the narrator cannot reach the database, so the layer
  // that owns persistence records what it did. Keyed by the report row, so a
  // replay of the same instant replaces its traces rather than accumulating them.
  if (narration !== null && narration.traces.length > 0) {
    const traceStage = definePipelineStage<readonly (typeof narration.traces)[number][], number>(
      'record-narration-traces',
      async (input, inner) => recordNarrationTraces(scoped, stored.id, input, inner.now),
    );
    record('record-narration-traces', await runStage(traceStage, narration.traces, context));
  }

  // ---- 9. the alignment audit trail ----------------------------------------
  // Written after the report rather than during analysis, because the analysis core
  // is pure and cannot write anything. One row per resolved subject, keyed by the
  // report instant, so a manager arguing with an OFF-GOAL flag six weeks later can
  // be shown exactly which chain, string or score produced it.
  const linkStage = definePipelineStage<StructuredReport, number>('record-objective-links', async (input, inner) =>
    persistObjectiveLinks(scoped, input.instant, input.findings.alignment, inner.now),
  );
  const objectiveLinkCount = record('record-objective-links', await runStage(linkStage, report, context));

  // ---- 10. say what happened ------------------------------------------------
  // Three of the four structured events the observability criterion names, emitted here because this
  // is the one function every generation path goes through — the worker's scheduled job, the web
  // read path's `ensureDailyReport`, time travel, the merged report and the cold start. Emitting at
  // the callers instead would mean six call sites that have to agree, and a report generated by the
  // fifth of them would be invisible.
  emitRunEvents(request, { ingest, narration, durationMillis: elapsed() });

  return { report, rendered, narration, stored, snapshot, ingest, goalHierarchy, objectiveLinkCount, stages };
}

/**
 * How many attempts were burned before the report fell back.
 *
 * Read off `traces`, and that is the whole point of this function existing. The obvious source —
 * `narration.sections[].attempts` — is **always zero on a fallback**: every fallback path in
 * `narrateReport` returns `sections: templateSections()`, which stamps `attempts: 0` on all six
 * sections, and the narrated sections carrying the real counts are discarded before the result is
 * returned. So a reduce over `sections` could only ever report that no attempt was made, which is
 * the one number this field must never carry.
 *
 * `traces` is the only place the real counts survive: one `NarrationTraceRecord` per attempt, with a
 * 1-based `attempt`. The maximum is therefore 3 for a grounding failure that exhausted
 * `NARRATION_MAX_ATTEMPTS` and 1 for a word-budget fallback where every section grounded first
 * time — which is exactly the distinction the field exists to draw.
 *
 * Scoped to the failing section when there is one, so a section that was retried earlier in the run
 * cannot inflate the count for a later section that refused on its first attempt. A word-budget
 * fallback is report-level and names no section, so it takes the maximum across the whole run.
 */
function attemptsBehind(narration: NarrationResult | null, sectionKey: string | null): number {
  const traces = narration?.traces ?? [];
  const scoped = sectionKey === null ? traces : traces.filter((trace) => trace.sectionKey === sectionKey);
  // Falls back to the whole run if the named section somehow left no trace, so the field degrades to
  // a real measurement rather than to zero.
  const counted = scoped.length > 0 ? scoped : traces;
  return counted.reduce((most, trace) => Math.max(most, trace.attempt), 0);
}

/**
 * `pipeline.run`, plus `ingest.coverage_gap` and `narration.fallback` when there is one to report.
 *
 * Every event carries the organization, the team and the instant as fields — `request.now`, the same
 * instant the report was generated for, never a wall-clock read. That is what lets a log line be
 * lined up against the report it describes, and it is why this function takes the request rather
 * than reaching for a clock it is forbidden to hold.
 *
 * Nothing here can fail the run. A logging call that threw would turn an observability concern into
 * an outage, so the whole block is best-effort: `pipeline.run` is emitted last and a sink that throws
 * is swallowed, because a report that was generated and persisted has succeeded whatever the log
 * says.
 */
function emitRunEvents(
  request: ReportPipelineRequest,
  outcome: {
    readonly ingest: ModelIngestResult | null;
    readonly narration: NarrationResult | null;
    readonly durationMillis: number;
  },
): void {
  const fields = {
    organizationId: request.organizationId,
    // `null` for a merged report, which genuinely has no team. An empty string would read as a team
    // called nothing, and the merged report is about all of them.
    teamKey: request.scope.kind === 'team' ? request.scope.teamKey : null,
    at: toEpochMillis(request.now),
  };

  try {
    /**
     * One event per source that did not cover the window, before the run event.
     *
     * Emitted from the coverage the *connector* reported rather than inferred from an empty result:
     * "the tracker returned nothing" and "the tracker was not asked" are different facts, and only
     * the connector knows which happened. `coverageNotesFrom` has already folded the per-artifact
     * rows down to the worst status per source, which is the granularity an operator acts on.
     */
    for (const note of outcome.ingest === null ? [] : coverageNotesFrom(outcome.ingest.summary.coverage)) {
      if (note.status === 'complete') continue;

      logIngestCoverageGap(
        {
          ...fields,
          detail: `\`${note.sourceKey}\` did not cover this report's window: ${note.status}.`,
        },
        // The connector's own sentence, unedited. Compass does not soften "rate limited", and the
        // reason is the field an operator groups by after the source key.
        { sourceKey: note.sourceKey, status: note.status, reason: note.detail },
        request.logSink,
      );
    }

    /**
     * A fallback, but only when narration was actually *attempted*.
     *
     * `cause: 'not-configured'` is a deployment with no `ANTHROPIC_API_KEY`, or an organization that
     * set minimization to `none`. Neither is a degradation — both are the documented zero-config
     * state — and emitting a `warn` for them every single run would train an operator to filter the
     * event out, which would hide the four causes that matter. This is the same distinction
     * `reports.fallback_renderer` draws, and for the same reason.
     */
    const fallback = outcome.narration?.fallback ?? null;
    if (fallback !== null && fallback.cause !== 'not-configured') {
      logNarrationFallback(
        { ...fields, detail: fallback.reason },
        {
          sectionKey: fallback.sectionKey,
          outcome: fallback.outcome,
          cause: fallback.cause,
          attempts: attemptsBehind(outcome.narration, fallback.sectionKey),
        },
        request.logSink,
      );
    }

    logPipelineRun(
      {
        ...fields,
        detail: `Generated a report for ${
          request.scope.kind === 'team' ? `team \`${request.scope.teamKey}\`` : 'every team, merged'
        }.`,
      },
      {
        scopeKind: request.scope.kind,
        // What actually wrote the prose a reader gets, which is the question this field is asked. A
        // run with no narrator reports `template` honestly rather than claiming a degradation.
        rendererId: outcome.narration?.rendererId ?? 'template',
        durationMillis: outcome.durationMillis,
      },
      request.logSink,
    );
  } catch {
    // See above: the report is already persisted. A broken sink is not a failed run.
  }
}
