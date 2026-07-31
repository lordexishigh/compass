import type { Instant } from '@compass/clock';
import { asc, eq, type InferSelectModel } from 'drizzle-orm';

import { fromDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { narrationTraces } from '../schema/narration.js';
import { reportChildRowId } from '../entity-id.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * NarrationTrace persistence.
 *
 * Like the rest of `@compass/db`, this file names no type from a layer above it:
 * the shapes here are plain, and the pipeline translates. Row ids are derived from
 * `(report, section, attempt)` through the same `reportChildRowId` the sections and
 * items use, so replaying the pipeline for one instant overwrites that report's
 * traces rather than accumulating a second run's attempts beside the first.
 */

export interface NarrationTraceInput {
  readonly sectionKey: string;
  readonly narratorId: string;
  readonly model: string;
  readonly promptHash: string;
  readonly promptVersion: string;
  readonly attempt: number;
  readonly attemptCount: number;
  readonly outcome: string;
  readonly untraceableTokens: readonly string[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly proseLength: number;
  readonly detail: string;
}

export interface StoredNarrationTrace extends NarrationTraceInput {
  readonly id: string;
  readonly reportId: string;
  readonly recordedAt: Instant;
}

export function narrationTraceRowId(reportId: string, sectionKey: string, attempt: number): string {
  return reportChildRowId(reportId, 'narration-trace', sectionKey, String(attempt));
}

/**
 * Replaces a report's traces with this run's.
 *
 * The delete is unconditional rather than an upsert because a re-run can produce
 * *fewer* attempts than the run before it — a section that took three attempts on
 * Monday and one on Tuesday would otherwise keep Monday's second and third rows and
 * report an attempt count that never happened.
 */
export async function recordNarrationTraces(
  scoped: ScopedDb,
  reportId: string,
  traces: readonly NarrationTraceInput[],
  recordedAt: Instant,
): Promise<number> {
  await scoped.deleteFrom(narrationTraces, eq(narrationTraces.reportId, reportId));
  if (traces.length === 0) return 0;

  await scoped.insertInto(
    narrationTraces,
    traces.map((trace) => ({
      id: narrationTraceRowId(reportId, trace.sectionKey, trace.attempt),
      reportId,
      sectionKey: trace.sectionKey,
      narratorId: trace.narratorId,
      model: trace.model,
      promptHash: trace.promptHash,
      promptVersion: trace.promptVersion,
      attempt: trace.attempt,
      attemptCount: trace.attemptCount,
      outcome: trace.outcome,
      untraceableTokens: [...trace.untraceableTokens],
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      proseLength: trace.proseLength,
      detail: trace.detail,
      recordedAt: toDatabaseInstant(recordedAt),
    })),
  );

  return traces.length;
}

type TraceRow = InferSelectModel<typeof narrationTraces>;

const toStoredTrace = (row: TraceRow): StoredNarrationTrace => ({
  id: row.id,
  reportId: row.reportId,
  sectionKey: row.sectionKey,
  narratorId: row.narratorId,
  model: row.model,
  promptHash: row.promptHash,
  promptVersion: row.promptVersion,
  attempt: row.attempt,
  attemptCount: row.attemptCount,
  outcome: row.outcome,
  untraceableTokens: row.untraceableTokens,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  proseLength: row.proseLength,
  detail: row.detail,
  recordedAt: fromDatabaseInstant(row.recordedAt),
});

/** One report's traces, in section then attempt order — the order they happened. */
export async function listNarrationTraces(
  scoped: ScopedDb,
  reportId: string,
): Promise<readonly StoredNarrationTrace[]> {
  const rows = await scoped
    .selectFrom(narrationTraces, eq(narrationTraces.reportId, reportId))
    .orderBy(asc(narrationTraces.sectionKey), asc(narrationTraces.attempt));

  return rows.map(toStoredTrace);
}
