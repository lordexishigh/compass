import type { Instant, TimeWindow } from '@compass/clock';
import { and, asc, desc, eq, lt, type InferSelectModel } from 'drizzle-orm';

import { fromDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
import { narrationTraces } from '../schema/narration.js';
import {
  REPORT_SECTION_COUNT,
  reportItemEvidence,
  reportItems,
  reportSections,
  reports,
} from '../schema/reports.js';
import { reportChildRowId, reportRowId } from '../entity-id.js';
import type { ScopedDb } from '../scoped-db.js';

/**
 * Report persistence.
 *
 * The shapes here are deliberately plain. `@compass/db` sits *below*
 * `@compass/analysis` in the layer order, so it cannot name `StructuredReport`
 * and must not try to; the pipeline is the layer that holds both and does the
 * translation. What this file owns is the storage contract: six sections with an
 * explicit ordinal, a verbatim payload beside every rendered string, and
 * evidence identifiers kept apart as typed columns.
 */

export class ReportSectionCountError extends Error {
  constructor(count: number) {
    super(
      `A report is persisted with exactly ${REPORT_SECTION_COUNT} sections; this one carried ${count}. ` +
        'The Six Spine is a product guarantee, not a shape the caller gets to choose.',
    );
    this.name = 'ReportSectionCountError';
  }
}

export class ReportSectionOrdinalError extends Error {
  constructor(found: readonly number[]) {
    super(
      `Report sections must carry ordinals 1..${REPORT_SECTION_COUNT} exactly once each; found [${found.join(', ')}].`,
    );
    this.name = 'ReportSectionOrdinalError';
  }
}

export interface ReportEvidenceInput {
  readonly kind: string;
  readonly label: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly commitSha: string | null;
  readonly pullRequestNumber: number | null;
  readonly issueKey: string | null;
  readonly artifactKind: string;
  readonly artifactId: string;
}

export interface ReportItemInput {
  readonly stableId: string;
  /** The coordinates `stableId` was derived from — what a feedback row is keyed on. */
  readonly causeEntityRef: string;
  readonly causeKind: string;
  readonly causeDiscriminator: string;
  readonly headline: string;
  readonly detail: string;
  /** This claim's own rendered sentences. Never reconstructed from the section. */
  readonly prose: string;
  readonly changeTag: string;
  readonly ageDays: number;
  /** The first report that carried this id. Read back by tomorrow's comparison. */
  readonly firstSeenAt: Instant;
  /** The ordered quantity tomorrow compares against. Higher is worse. */
  readonly severityScore: number;
  readonly signalOnsetAt: Instant;
  /** `accepted` | `resurfaced` | null. */
  readonly feedbackState: string | null;
  readonly changeClause: string | null;
  readonly ladder: Record<string, unknown> | null;
  readonly payload: Record<string, unknown>;
  readonly evidence: readonly ReportEvidenceInput[];
}

export interface ReportSectionInput {
  readonly sectionKey: string;
  readonly ordinal: number;
  readonly title: string;
  readonly prose: string;
  readonly payload: Record<string, unknown>;
  readonly emptyStatement: string;
  readonly summary: string | null;
  readonly items: readonly ReportItemInput[];
}

export interface ReportInput {
  readonly scopeKind: string;
  readonly scopeKey: string;
  readonly schemaVersion: number;
  readonly reportInstant: Instant;
  readonly reportDate: string;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly contentHash: string;
  readonly payloadJson: string;
  readonly payload: Record<string, unknown>;
  readonly prose: string;
  /** The change line as rendered. Empty for a report written before change-awareness. */
  readonly changeLine: string;
  readonly rendererId: string;
  /** True only when narration was attempted and the template renderer answered. */
  readonly fallbackRenderer: boolean;
  /** Null exactly when `fallbackRenderer` is false. */
  readonly fallbackReason: string | null;
  readonly coverageStatus: string;
  readonly ingestRunId: string | null;
  /** Passed in by the edge. This layer never reads a clock. */
  readonly generatedAt: Instant;
  readonly sections: readonly ReportSectionInput[];
}

export interface StoredReport {
  readonly id: string;
  readonly organizationId: string;
  readonly scopeKind: string;
  readonly scopeKey: string;
  readonly schemaVersion: number;
  readonly reportInstant: Instant;
  readonly reportDate: string;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly contentHash: string;
  readonly payloadJson: string;
  readonly payload: Record<string, unknown>;
  readonly prose: string;
  /** The change line as rendered. Empty for a report written before change-awareness. */
  readonly changeLine: string;
  readonly rendererId: string;
  readonly fallbackRenderer: boolean;
  readonly fallbackReason: string | null;
  readonly coverageStatus: string;
  readonly ingestRunId: string | null;
  readonly generatedAt: Instant;
}

export interface StoredReportSection {
  readonly id: string;
  readonly sectionKey: string;
  readonly ordinal: number;
  readonly title: string;
  readonly prose: string;
  readonly payload: Record<string, unknown>;
  readonly itemCount: number;
  readonly emptyStatement: string;
  readonly summary: string | null;
  readonly items: readonly StoredReportItem[];
}

export interface StoredReportItem {
  readonly id: string;
  readonly ordinal: number;
  readonly stableId: string;
  readonly causeEntityRef: string;
  readonly causeKind: string;
  readonly causeDiscriminator: string;
  readonly headline: string;
  readonly detail: string;
  readonly prose: string;
  readonly changeTag: string;
  readonly ageDays: number;
  readonly firstSeenAt: Instant;
  readonly severityScore: number;
  readonly signalOnsetAt: Instant;
  readonly feedbackState: string | null;
  readonly changeClause: string | null;
  readonly ladder: Record<string, unknown> | null;
  readonly payload: Record<string, unknown>;
  readonly evidence: readonly StoredReportEvidence[];
}

export interface StoredReportEvidence extends ReportEvidenceInput {
  readonly id: string;
  readonly reportItemId: string;
  readonly ordinal: number;
}

/** A whole report, sections in ordinal order, items in ordinal order. */
export interface StoredReportBundle {
  readonly report: StoredReport;
  readonly sections: readonly StoredReportSection[];
}

/** The id a report for this (organization, scope, instant) will always have. */
export function reportIdFor(
  organizationId: string,
  scopeKind: string,
  scopeKey: string,
  reportInstant: Instant,
): string {
  return reportRowId(organizationId, scopeKind, scopeKey, reportInstant as unknown as number);
}

function assertSixOrderedSections(sections: readonly ReportSectionInput[]): void {
  if (sections.length !== REPORT_SECTION_COUNT) throw new ReportSectionCountError(sections.length);

  const ordinals = sections.map((section) => section.ordinal);
  const expected = Array.from({ length: REPORT_SECTION_COUNT }, (_, index) => index + 1);
  if (ordinals.join(',') !== expected.join(',')) throw new ReportSectionOrdinalError(ordinals);
}

/**
 * Writes a report, replacing any earlier write for the same instant.
 *
 * Re-running the pipeline for a `(organization, team, instant)` it has already
 * covered is a normal thing to do — a backfill arrived, a Correction landed — and
 * it must produce one row, not two. Every id is derived from the report id and
 * the child's own key, so a replay overwrites rather than accumulating; the
 * delete pass ahead of it removes children a shorter re-run no longer produces.
 */
export async function saveReport(scoped: ScopedDb, input: ReportInput): Promise<StoredReport> {
  assertSixOrderedSections(input.sections);

  const reportId = reportIdFor(scoped.organizationId, input.scopeKind, input.scopeKey, input.reportInstant);
  await deleteReportChildren(scoped, reportId);
  await scoped.deleteFrom(reports, eq(reports.id, reportId));

  await scoped.insertInto(reports, {
    id: reportId,
    scopeKind: input.scopeKind,
    scopeKey: input.scopeKey,
    schemaVersion: input.schemaVersion,
    reportInstant: toDatabaseInstant(input.reportInstant),
    reportDate: input.reportDate,
    timezone: input.timezone,
    windowStart: toDatabaseInstant(input.window.start),
    windowEnd: toDatabaseInstant(input.window.end),
    contentHash: input.contentHash,
    payloadJson: input.payloadJson,
    payload: input.payload,
    prose: input.prose,
    changeLine: input.changeLine,
    rendererId: input.rendererId,
    fallbackRenderer: input.fallbackRenderer,
    // Normalised rather than trusted: a reason with no flag would render a
    // disclosure the report row says did not happen, and a flag with no reason
    // would render a disclosure with nothing in it.
    fallbackReason: input.fallbackRenderer ? input.fallbackReason : null,
    coverageStatus: input.coverageStatus,
    ingestRunId: input.ingestRunId,
    generatedAt: toDatabaseInstant(input.generatedAt),
  });

  for (const section of input.sections) {
    const sectionId = reportChildRowId(reportId, 'section', section.sectionKey);
    await scoped.insertInto(reportSections, {
      id: sectionId,
      reportId,
      sectionKey: section.sectionKey,
      ordinal: section.ordinal,
      title: section.title,
      prose: section.prose,
      payload: section.payload,
      itemCount: section.items.length,
      emptyStatement: section.emptyStatement,
      summary: section.summary,
    });

    for (const [index, item] of section.items.entries()) {
      const itemId = reportChildRowId(reportId, 'item', section.sectionKey, item.stableId);
      await scoped.insertInto(reportItems, {
        id: itemId,
        reportId,
        reportSectionId: sectionId,
        ordinal: index + 1,
        stableId: item.stableId,
        causeEntityRef: item.causeEntityRef,
        causeKind: item.causeKind,
        causeDiscriminator: item.causeDiscriminator,
        headline: item.headline,
        detail: item.detail,
        prose: item.prose,
        changeTag: item.changeTag,
        ageDays: item.ageDays,
        firstSeenAt: toDatabaseInstant(item.firstSeenAt),
        severityScore: item.severityScore,
        signalOnsetAt: toDatabaseInstant(item.signalOnsetAt),
        feedbackState: item.feedbackState,
        changeClause: item.changeClause,
        ladder: item.ladder,
        hasLadder: item.ladder !== null,
        payload: item.payload,
      });

      if (item.evidence.length === 0) continue;
      await scoped.insertInto(
        reportItemEvidence,
        item.evidence.map((evidence, evidenceIndex) => ({
          id: reportChildRowId(reportId, 'evidence', section.sectionKey, item.stableId, String(evidenceIndex)),
          reportId,
          reportItemId: itemId,
          ordinal: evidenceIndex + 1,
          kind: evidence.kind,
          label: evidence.label,
          sourceKey: evidence.sourceKey,
          sourceRecordId: evidence.sourceRecordId,
          commitSha: evidence.commitSha,
          pullRequestNumber: evidence.pullRequestNumber,
          issueKey: evidence.issueKey,
          artifactKind: evidence.artifactKind,
          artifactId: evidence.artifactId,
        })),
      );
    }
  }

  const stored = await findReportById(scoped, reportId);
  if (stored === null) {
    throw new Error(`Report ${reportId} was written but could not be read back.`);
  }
  return stored;
}

/**
 * Children first: the foreign keys point downward, so the deletes go upward.
 *
 * `narration_traces` belongs here even though the pipeline writes it in a later
 * stage. It references `reports.id`, so a replay that deleted the report row without
 * clearing the traces first hit a foreign-key violation — and because a replay is the
 * *normal* path (a cold start re-runs the day it has no report for, a backfill
 * re-runs a past instant), that broke every second run with narration enabled. One
 * function owns the report's cascade; a table added to the schema without being added
 * here is the bug this comment exists to prevent recurring.
 */
async function deleteReportChildren(scoped: ScopedDb, reportId: string): Promise<void> {
  await scoped.deleteFrom(narrationTraces, eq(narrationTraces.reportId, reportId));
  await scoped.deleteFrom(reportItemEvidence, eq(reportItemEvidence.reportId, reportId));
  await scoped.deleteFrom(reportItems, eq(reportItems.reportId, reportId));
  await scoped.deleteFrom(reportSections, eq(reportSections.reportId, reportId));
}

type ReportRow = InferSelectModel<typeof reports>;

const toStoredReport = (row: ReportRow): StoredReport => ({
  id: row.id,
  organizationId: row.organizationId,
  scopeKind: row.scopeKind,
  scopeKey: row.scopeKey,
  schemaVersion: row.schemaVersion,
  reportInstant: fromDatabaseInstant(row.reportInstant),
  reportDate: row.reportDate,
  timezone: row.timezone,
  window: { start: fromDatabaseInstant(row.windowStart), end: fromDatabaseInstant(row.windowEnd) },
  contentHash: row.contentHash,
  payloadJson: row.payloadJson,
  payload: row.payload,
  prose: row.prose,
  changeLine: row.changeLine,
  rendererId: row.rendererId,
  fallbackRenderer: row.fallbackRenderer,
  fallbackReason: row.fallbackReason,
  coverageStatus: row.coverageStatus,
  ingestRunId: row.ingestRunId,
  generatedAt: fromDatabaseInstant(row.generatedAt),
});

export async function findReportById(scoped: ScopedDb, reportId: string): Promise<StoredReport | null> {
  const [row] = await scoped.selectFrom(reports, eq(reports.id, reportId)).limit(1);
  return row === undefined ? null : toStoredReport(row);
}

/** The report for one exact instant — the time-travel and idempotency lookup. */
export async function findReportForInstant(
  scoped: ScopedDb,
  scope: { readonly scopeKind: string; readonly scopeKey: string },
  reportInstant: Instant,
): Promise<StoredReport | null> {
  return findReportById(scoped, reportIdFor(scoped.organizationId, scope.scopeKind, scope.scopeKey, reportInstant));
}

/**
 * The most recent report for a civil date — what `/` renders.
 *
 * Keyed on the date rather than the instant because a manager asks for "today's
 * report", not for the report generated at 06:12:04.117.
 */
export async function findLatestReportForDate(
  scoped: ScopedDb,
  scope: { readonly scopeKind: string; readonly scopeKey: string },
  reportDate: string,
): Promise<StoredReport | null> {
  const [row] = await scoped
    .selectFrom(
      reports,
      and(
        eq(reports.scopeKind, scope.scopeKind),
        eq(reports.scopeKey, scope.scopeKey),
        eq(reports.reportDate, reportDate),
      ),
    )
    .orderBy(desc(reports.reportInstant))
    .limit(1);
  return row === undefined ? null : toStoredReport(row);
}

/** The newest report of any date, for a scope. */
export async function findLatestReport(
  scoped: ScopedDb,
  scope: { readonly scopeKind: string; readonly scopeKey: string },
): Promise<StoredReport | null> {
  const [row] = await scoped
    .selectFrom(reports, and(eq(reports.scopeKind, scope.scopeKind), eq(reports.scopeKey, scope.scopeKey)))
    .orderBy(desc(reports.reportInstant))
    .limit(1);
  return row === undefined ? null : toStoredReport(row);
}

/**
 * A whole report, read back in the order it must be displayed.
 *
 * Ordering is by the explicit `ordinal` column at every level. Nothing here
 * relies on the order rows came back in, which is a property PostgreSQL has
 * never promised and which would fail intermittently rather than loudly.
 */
export async function loadReportBundle(scoped: ScopedDb, reportId: string): Promise<StoredReportBundle | null> {
  const report = await findReportById(scoped, reportId);
  if (report === null) return null;

  const sectionRows = await scoped
    .selectFrom(reportSections, eq(reportSections.reportId, reportId))
    .orderBy(asc(reportSections.ordinal));
  const itemRows = await scoped
    .selectFrom(reportItems, eq(reportItems.reportId, reportId))
    .orderBy(asc(reportItems.reportSectionId), asc(reportItems.ordinal));
  const evidenceRows = await scoped
    .selectFrom(reportItemEvidence, eq(reportItemEvidence.reportId, reportId))
    .orderBy(asc(reportItemEvidence.reportItemId), asc(reportItemEvidence.ordinal));

  const evidenceByItem = new Map<string, StoredReportEvidence[]>();
  for (const row of evidenceRows) {
    const bucket = evidenceByItem.get(row.reportItemId) ?? [];
    bucket.push({
      id: row.id,
      reportItemId: row.reportItemId,
      ordinal: row.ordinal,
      kind: row.kind,
      label: row.label,
      sourceKey: row.sourceKey,
      sourceRecordId: row.sourceRecordId,
      commitSha: row.commitSha,
      pullRequestNumber: row.pullRequestNumber,
      issueKey: row.issueKey,
      artifactKind: row.artifactKind,
      artifactId: row.artifactId,
    });
    evidenceByItem.set(row.reportItemId, bucket);
  }

  const itemsBySection = new Map<string, StoredReportItem[]>();
  for (const row of itemRows) {
    const bucket = itemsBySection.get(row.reportSectionId) ?? [];
    bucket.push({
      id: row.id,
      ordinal: row.ordinal,
      stableId: row.stableId,
      causeEntityRef: row.causeEntityRef,
      causeKind: row.causeKind,
      causeDiscriminator: row.causeDiscriminator,
      headline: row.headline,
      detail: row.detail,
      prose: row.prose,
      changeTag: row.changeTag,
      ageDays: row.ageDays,
      firstSeenAt: fromDatabaseInstant(row.firstSeenAt),
      severityScore: row.severityScore,
      signalOnsetAt: fromDatabaseInstant(row.signalOnsetAt),
      feedbackState: row.feedbackState,
      changeClause: row.changeClause,
      ladder: row.ladder,
      payload: row.payload,
      evidence: evidenceByItem.get(row.id) ?? [],
    });
    itemsBySection.set(row.reportSectionId, bucket);
  }

  return {
    report,
    sections: sectionRows.map((row) => ({
      id: row.id,
      sectionKey: row.sectionKey,
      ordinal: row.ordinal,
      title: row.title,
      prose: row.prose,
      payload: row.payload,
      itemCount: row.itemCount,
      emptyStatement: row.emptyStatement,
      summary: row.summary,
      items: itemsBySection.get(row.id) ?? [],
    })),
  };
}

/** One row in the archive index: enough to list a report without loading its sections. */
export interface ReportArchiveEntry {
  readonly id: string;
  readonly scopeKind: string;
  readonly scopeKey: string;
  readonly reportDate: string;
  readonly reportInstant: Instant;
  readonly timezone: string;
  readonly rendererId: string;
  /** Carried into the index so the list can mark a degraded report before it is opened. */
  readonly fallbackRenderer: boolean;
  readonly coverageStatus: string;
  readonly generatedAt: Instant;
  readonly itemCount: number;
}

/**
 * Every stored report, newest first — the archive index.
 *
 * Ordered by `(report_instant desc, scope_kind, scope_key)`: the date is what a manager navigates by
 * ("last Tuesday's"), and the scope columns are the tiebreak so several teams on one date list in a
 * fixed order rather than in whatever order the rows came back. Nothing here relies on physical row
 * order, which PostgreSQL has never promised and which would make the archive reshuffle itself between
 * two loads.
 *
 * The item count is summed from `report_sections.item_count` rather than by counting `report_items`,
 * because the section rows already hold it — a report with six zero-item sections is a real report and
 * has to appear in the index, and a join against items would have to be an outer one to include it.
 */
export async function listReportArchive(
  scoped: ScopedDb,
  options: { readonly limit?: number; readonly scopeKind?: string; readonly scopeKey?: string } = {},
): Promise<readonly ReportArchiveEntry[]> {
  const predicates = [
    ...(options.scopeKind === undefined ? [] : [eq(reports.scopeKind, options.scopeKind)]),
    ...(options.scopeKey === undefined ? [] : [eq(reports.scopeKey, options.scopeKey)]),
  ];

  const rows = await scoped
    .selectFrom(reports, predicates.length === 0 ? undefined : and(...predicates))
    .orderBy(desc(reports.reportInstant), asc(reports.scopeKind), asc(reports.scopeKey))
    .limit(options.limit ?? 200);

  const entries: ReportArchiveEntry[] = [];
  for (const row of rows) {
    const sections = await scoped.selectFrom(reportSections, eq(reportSections.reportId, row.id));
    entries.push({
      id: row.id,
      scopeKind: row.scopeKind,
      scopeKey: row.scopeKey,
      reportDate: row.reportDate,
      reportInstant: fromDatabaseInstant(row.reportInstant),
      timezone: row.timezone,
      rendererId: row.rendererId,
      fallbackRenderer: row.fallbackRenderer,
      coverageStatus: row.coverageStatus,
      generatedAt: fromDatabaseInstant(row.generatedAt),
      itemCount: sections.reduce((total, section) => total + section.itemCount, 0),
    });
  }

  return entries;
}

/**
 * Every report for one civil date, across every scope — what the merged archive view re-merges.
 *
 * Keyed on the date rather than the instant, because a manager asks for "last Tuesday" and the merged
 * view has to gather the same day's teams however far apart their generation instants happened to fall.
 */
export async function findReportsForDate(
  scoped: ScopedDb,
  reportDate: string,
): Promise<readonly StoredReport[]> {
  const rows = await scoped
    .selectFrom(reports, eq(reports.reportDate, reportDate))
    .orderBy(asc(reports.scopeKind), asc(reports.scopeKey));
  return rows.map(toStoredReport);
}

/**
 * One item's state as a prior report left it — three fields and nothing else.
 *
 * Deliberately not `StoredReportItem`. The change comparison must not be able to reach for a
 * prior item's headline or prose: an item's *text* changing is not the item changing, and a
 * comparison that could see the text would eventually be tempted to diff it.
 */
export interface PriorReportItemState {
  readonly stableId: string;
  readonly firstSeenAt: Instant;
  readonly severityScore: number;
}

export interface PriorReportSnapshot {
  readonly reportId: string;
  readonly reportInstant: Instant;
  readonly items: readonly PriorReportItemState[];
}

/**
 * The most recent report for a scope *strictly before* an instant, reduced to what the change
 * comparison needs.
 *
 * `<` and not `<=`, which is the whole correctness of it. A replay regenerates the report for an
 * instant it has already covered — a backfill arrived, a Correction landed, a cold start re-ran
 * today — and a `<=` lookup would find *that same report* and compare it against itself. Every
 * item would come back `unchanged` with the age it already had, and the second generation of any
 * day would silently lose a morning's movement.
 */
export async function findPriorReportState(
  scoped: ScopedDb,
  scope: { readonly scopeKind: string; readonly scopeKey: string },
  before: Instant,
): Promise<PriorReportSnapshot | null> {
  const [row] = await scoped
    .selectFrom(
      reports,
      and(
        eq(reports.scopeKind, scope.scopeKind),
        eq(reports.scopeKey, scope.scopeKey),
        lt(reports.reportInstant, toDatabaseInstant(before)),
      ),
    )
    .orderBy(desc(reports.reportInstant))
    .limit(1);

  if (row === undefined) return null;

  const itemRows = await scoped
    .selectFrom(reportItems, eq(reportItems.reportId, row.id))
    .orderBy(asc(reportItems.stableId));

  return {
    reportId: row.id,
    reportInstant: fromDatabaseInstant(row.reportInstant),
    items: itemRows.map((item) => ({
      stableId: item.stableId,
      firstSeenAt: fromDatabaseInstant(item.firstSeenAt),
      severityScore: item.severityScore,
    })),
  };
}

/** One item as it was persisted, found by its stable id — what a feedback click resolves. */
export interface ReportItemLocator {
  readonly reportId: string;
  readonly sectionKey: string;
  readonly stableId: string;
  readonly causeEntityRef: string;
  readonly causeKind: string;
  readonly causeDiscriminator: string;
  readonly headline: string;
  readonly severityScore: number;
}

/**
 * The newest occurrence of one item id in this organization's reports.
 *
 * A feedback click supplies an item id and nothing else, and the handler needs the coordinates a
 * verdict is keyed on plus the severity score that becomes a dismissal's baseline. Newest first,
 * because the manager is acting on the report in front of them, and the same condition measured
 * three days ago is not the number their dismissal is about.
 */
export async function findReportItemByStableId(
  scoped: ScopedDb,
  stableId: string,
): Promise<ReportItemLocator | null> {
  const rows = await scoped.selectFrom(reportItems, eq(reportItems.stableId, stableId));
  if (rows.length === 0) return null;

  const reportInstants = new Map<string, number>();
  for (const reportId of new Set(rows.map((row) => row.reportId))) {
    const [report] = await scoped.selectFrom(reports, eq(reports.id, reportId)).limit(1);
    if (report !== undefined) reportInstants.set(reportId, report.reportInstant.getTime());
  }

  const newest = [...rows].sort(
    (left, right) =>
      (reportInstants.get(right.reportId) ?? 0) - (reportInstants.get(left.reportId) ?? 0) ||
      compareText(left.id, right.id),
  )[0];
  if (newest === undefined) return null;

  const [section] = await scoped
    .selectFrom(reportSections, eq(reportSections.id, newest.reportSectionId))
    .limit(1);

  return {
    reportId: newest.reportId,
    sectionKey: section?.sectionKey ?? '',
    stableId: newest.stableId,
    causeEntityRef: newest.causeEntityRef,
    causeKind: newest.causeKind,
    causeDiscriminator: newest.causeDiscriminator,
    headline: newest.headline,
    severityScore: newest.severityScore,
  };
}

/**
 * Every claim that cited one artifact — what the artifact detail page shows.
 *
 * Keyed on `(artifact_kind, artifact_id)` rather than on the label, because two
 * repositories can both have a `#42` and a manager following a link has to land
 * on theirs.
 */
export async function findEvidenceForArtifact(
  scoped: ScopedDb,
  artifactKind: string,
  artifactId: string,
): Promise<readonly StoredReportEvidence[]> {
  const rows = await scoped
    .selectFrom(
      reportItemEvidence,
      and(eq(reportItemEvidence.artifactKind, artifactKind), eq(reportItemEvidence.artifactId, artifactId)),
    )
    .orderBy(asc(reportItemEvidence.reportItemId), asc(reportItemEvidence.ordinal));

  return rows.map((row) => ({
    id: row.id,
    reportItemId: row.reportItemId,
    ordinal: row.ordinal,
    kind: row.kind,
    label: row.label,
    sourceKey: row.sourceKey,
    sourceRecordId: row.sourceRecordId,
    commitSha: row.commitSha,
    pullRequestNumber: row.pullRequestNumber,
    issueKey: row.issueKey,
    artifactKind: row.artifactKind,
    artifactId: row.artifactId,
  }));
}

/** The claims that cited an artifact, with the section each one sits in. */
export interface CitingClaim {
  readonly reportId: string;
  readonly reportDate: string;
  readonly sectionKey: string;
  readonly sectionTitle: string;
  /** 1–6, so the caller can group by the Six Spine without a second lookup. */
  readonly sectionOrdinal: number;
  readonly stableId: string;
  readonly headline: string;
  readonly detail: string;
  readonly evidenceLabel: string;
}

/**
 * Every claim that cited one artifact, newest report first.
 *
 * The order is the answer to the question the artifact page asks: "what has
 * Compass said about this pull request, most recently first". Ordering by row id
 * instead would put an arbitrary day at the top and make the same page look
 * different depending on which report happened to be written first — the report
 * date is the only ordering a reader can predict. Within one day the Six Spine's
 * own ordinal decides, so a claim's position on the artifact page matches its
 * position in the report it came from.
 */
export async function findClaimsCitingArtifact(
  scoped: ScopedDb,
  artifactKind: string,
  artifactId: string,
): Promise<readonly CitingClaim[]> {
  const evidence = await findEvidenceForArtifact(scoped, artifactKind, artifactId);
  if (evidence.length === 0) return [];

  const claims: CitingClaim[] = [];
  const seen = new Set<string>();

  for (const reference of evidence) {
    if (seen.has(reference.reportItemId)) continue;
    seen.add(reference.reportItemId);

    const [item] = await scoped.selectFrom(reportItems, eq(reportItems.id, reference.reportItemId)).limit(1);
    if (item === undefined) continue;
    const [section] = await scoped
      .selectFrom(reportSections, eq(reportSections.id, item.reportSectionId))
      .limit(1);
    const [report] = await scoped.selectFrom(reports, eq(reports.id, item.reportId)).limit(1);

    claims.push({
      reportId: item.reportId,
      reportDate: report?.reportDate ?? '',
      sectionKey: section?.sectionKey ?? '',
      sectionTitle: section?.title ?? '',
      sectionOrdinal: section?.ordinal ?? 0,
      stableId: item.stableId,
      headline: item.headline,
      detail: item.detail,
      evidenceLabel: reference.label,
    });
  }

  return claims.sort(
    (left, right) =>
      compareText(right.reportDate, left.reportDate) ||
      left.sectionOrdinal - right.sectionOrdinal ||
      compareText(left.stableId, right.stableId),
  );
}

/** Code-unit comparison. Never `localeCompare`: the order must not vary by host. */
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Re-exported so callers do not have to reach into the schema module. */
export { REPORT_SECTION_COUNT };
