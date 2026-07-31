import type { Instant, TimeWindow } from '@compass/clock';
import { z } from 'zod';

import { ArtifactKindSchema, InstantSchema, SourceKindSchema, TimeWindowSchema } from './records.js';
import type { ArtifactKind, SourceKind } from './records.js';

/**
 * Coverage is how a source says "I could not answer that", and it is a required
 * part of every result rather than an optional extra.
 *
 * A connector must not throw when a source is unavailable: a thrown error tells
 * the caller nothing about which source failed or how much of the window is
 * missing, and an empty array with no coverage record is indistinguishable from
 * a genuinely quiet day. Report generation has to be able to say "Slack has
 * been stale for 6 hours, Blockers may be incomplete" — that sentence is built
 * from these records.
 */

export const COVERAGE_STATUSES = ['complete', 'partial', 'unavailable'] as const;
export const CoverageStatusSchema = z.enum(COVERAGE_STATUSES);
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const COVERAGE_REASONS = [
  'ok',
  'not_configured',
  'authentication_failed',
  'permission_denied',
  'rate_limited',
  'unreachable',
  'capability_absent',
  'window_truncated',
  'provider_error',
] as const;
export const CoverageReasonSchema = z.enum(COVERAGE_REASONS);
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export const SourceCoverageSchema = z.strictObject({
  sourceKey: z.string().min(1),
  sourceKind: SourceKindSchema,
  artifact: ArtifactKindSchema,
  status: CoverageStatusSchema,
  reason: CoverageReasonSchema,
  /** Plain-language, shown to a manager as-is. Names the source. */
  detail: z.string().min(1),
  requestedWindow: TimeWindowSchema,
  /** The part of the requested window actually observed; null when nothing was. */
  coveredWindow: TimeWindowSchema.nullable(),
  recordCount: z.number().int().nonnegative(),
  observedAt: InstantSchema,
});
export type SourceCoverage = z.infer<typeof SourceCoverageSchema>;

/** Worst status wins: one unavailable source degrades the whole answer. */
export function worstCoverageStatus(statuses: readonly CoverageStatus[]): CoverageStatus {
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('partial')) return 'partial';
  return 'complete';
}

export function worstStatus(coverages: readonly SourceCoverage[]): CoverageStatus {
  return worstCoverageStatus(coverages.map((coverage) => coverage.status));
}

export interface CoverageInput {
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly artifact: ArtifactKind;
  readonly requestedWindow: TimeWindow;
  readonly observedAt: Instant;
  readonly recordCount: number;
}

/** A source that answered the whole window. */
export function completeCoverage(input: CoverageInput): SourceCoverage {
  return {
    sourceKey: input.sourceKey,
    sourceKind: input.sourceKind,
    artifact: input.artifact,
    status: 'complete',
    reason: 'ok',
    detail: `${input.sourceKey} answered the full window (${input.recordCount} record${
      input.recordCount === 1 ? '' : 's'
    }).`,
    requestedWindow: input.requestedWindow,
    coveredWindow: input.requestedWindow,
    recordCount: input.recordCount,
    observedAt: input.observedAt,
  };
}

/** A source that could not answer at all. Records must be empty alongside this. */
export function unavailableCoverage(
  input: Omit<CoverageInput, 'recordCount'> & { readonly reason: CoverageReason; readonly detail: string },
): SourceCoverage {
  return {
    sourceKey: input.sourceKey,
    sourceKind: input.sourceKind,
    artifact: input.artifact,
    status: 'unavailable',
    reason: input.reason,
    detail: input.detail,
    requestedWindow: input.requestedWindow,
    coveredWindow: null,
    recordCount: 0,
    observedAt: input.observedAt,
  };
}

/** A source that answered part of the window — rate limits, pagination cut-offs. */
export function partialCoverage(
  input: CoverageInput & {
    readonly reason: CoverageReason;
    readonly detail: string;
    readonly coveredWindow: TimeWindow;
  },
): SourceCoverage {
  return {
    sourceKey: input.sourceKey,
    sourceKind: input.sourceKind,
    artifact: input.artifact,
    status: 'partial',
    reason: input.reason,
    detail: input.detail,
    requestedWindow: input.requestedWindow,
    coveredWindow: input.coveredWindow,
    recordCount: input.recordCount,
    observedAt: input.observedAt,
  };
}

export const SourceHealthEntrySchema = z.strictObject({
  sourceKey: z.string().min(1),
  sourceKind: SourceKindSchema,
  status: CoverageStatusSchema,
  reason: CoverageReasonSchema,
  detail: z.string().min(1),
  /** When this source last produced anything, or null if it never has. */
  lastObservedAt: InstantSchema.nullable(),
});
export type SourceHealthEntry = z.infer<typeof SourceHealthEntrySchema>;

export const SourceHealthReportSchema = z.strictObject({
  connectorId: z.string().min(1),
  window: TimeWindowSchema,
  observedAt: InstantSchema,
  overall: CoverageStatusSchema,
  sources: z.array(SourceHealthEntrySchema),
});
export type SourceHealthReport = z.infer<typeof SourceHealthReportSchema>;
