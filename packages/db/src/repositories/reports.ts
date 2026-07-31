import type { Instant, TimeWindow } from '@compass/clock';
import { and, asc, desc, eq, type InferSelectModel } from 'drizzle-orm';

import { fromDatabaseInstant, toDatabaseInstant } from '../schema/columns.js';
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
  readonly headline: string;
  readonly detail: string;
  /** This claim's own rendered sentences. Never reconstructed from the section. */
  readonly prose: string;
  readonly changeTag: string;
  readonly ageDays: number;
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
  readonly rendererId: string;
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
  readonly rendererId: string;
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
  readonly headline: string;
  readonly detail: string;
  readonly prose: string;
  readonly changeTag: string;
  readonly ageDays: number;
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
    rendererId: input.rendererId,
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
        headline: item.headline,
        detail: item.detail,
        prose: item.prose,
        changeTag: item.changeTag,
        ageDays: item.ageDays,
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

/** Children first: the foreign keys point downward, so the deletes go upward. */
async function deleteReportChildren(scoped: ScopedDb, reportId: string): Promise<void> {
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
  rendererId: row.rendererId,
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
      headline: row.headline,
      detail: row.detail,
      prose: row.prose,
      changeTag: row.changeTag,
      ageDays: row.ageDays,
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
