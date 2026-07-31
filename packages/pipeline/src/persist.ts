import {
  SECTIONS,
  assertSixSectionsInOrder,
  type EvidenceRef,
  type ReportItem,
  type ReportSection,
  type StructuredReport,
} from '@compass/analysis';
import { formatCivilDate, type Instant } from '@compass/clock';
import {
  saveReport,
  type ReportEvidenceInput,
  type ReportInput,
  type ReportItemInput,
  type ReportSectionInput,
  type ScopedDb,
  type StoredReport,
} from '@compass/db';
import type { RenderedReport, RenderedSection } from '@compass/renderers';

import { canonicalJson, reportHash } from './canonical-json.js';

/**
 * The translation between the structured report and its rows.
 *
 * This is the only place the two shapes meet. `@compass/analysis` cannot name a
 * database table and `@compass/db` cannot name `StructuredReport` — they sit on
 * opposite sides of the layer order — so the mapping has to live in the one
 * package that depends on both, and it has to be explicit rather than a
 * `JSON.parse(JSON.stringify(...))` that would silently drop a field.
 *
 * Two properties are load-bearing.
 *
 * **The payload is stored verbatim.** `payload_json` is the canonical
 * serialisation of the section — sorted keys, no incidental whitespace, nothing
 * excluded — so reading the row back and re-serialising it produces the same
 * bytes. Only the *hash* excludes the documented non-semantic fields; the stored
 * payload excludes nothing, because a manager arguing with a report six weeks
 * later needs the thing that was computed, not a summary of it.
 *
 * **Ordinals come from the section definition.** `SECTIONS` in the analysis
 * package is the single declaration of the Six Spine, and the row ordinals, the
 * rendered prose order and the web view's headings are all derived from it.
 */

export const SCOPE_KEY_FOR_MERGED = '*';

export interface PersistReportInput {
  readonly report: StructuredReport;
  readonly rendered: RenderedReport;
  /** Passed in by the edge. This layer never reads a clock. */
  readonly generatedAt: Instant;
  readonly ingestRunId: string | null;
}

/** `team` / `platform`, or `merged` / `*`. Never a nullable key. */
export function scopeColumns(report: StructuredReport): { scopeKind: string; scopeKey: string } {
  return report.scope.kind === 'team'
    ? { scopeKind: 'team', scopeKey: report.scope.teamKey }
    : { scopeKind: 'merged', scopeKey: SCOPE_KEY_FOR_MERGED };
}

/**
 * The worst coverage status across the sources, or `unavailable` when nothing was
 * ingested at all.
 *
 * `unavailable` rather than `complete` is the honest default for an empty
 * coverage list: no source having reported is not the same as every source
 * having succeeded, and a report row that claimed otherwise would make the web
 * view present an unverified page as a finished one.
 */
export function coverageStatusOf(report: StructuredReport): 'complete' | 'partial' | 'unavailable' {
  if (report.coverage.length === 0) return 'unavailable';
  if (report.coverage.some((note) => note.status === 'unavailable')) return 'partial';
  if (report.coverage.some((note) => note.status === 'partial')) return 'partial';
  return 'complete';
}

/**
 * The in-app route one piece of evidence resolves to.
 *
 * `artifactKind` and `artifactId` together are what the artifact detail page
 * looks up, and the id has to survive a URL, so it is the source's own natural
 * key rather than a label. Where the evidence names a commit, a pull request or a
 * tracker item, that identifier is *also* written to its own typed column, so a
 * link can be built without parsing anything.
 */
export function evidenceColumns(reference: EvidenceRef): ReportEvidenceInput {
  const commitSha = reference.kind === 'commit' ? lastSegment(reference.sourceRecordId) : null;
  const pullRequestNumber = reference.kind === 'pull_request' ? numberInLabel(reference.label) : null;
  const issueKey = reference.kind === 'issue' ? reference.label : null;

  return {
    kind: reference.kind,
    label: reference.label,
    sourceKey: reference.sourceKey,
    sourceRecordId: reference.sourceRecordId,
    commitSha,
    pullRequestNumber,
    issueKey,
    artifactKind: reference.kind,
    artifactId: reference.sourceRecordId,
  };
}

/** `checkout-web:7a8b9c0d…` -> `7a8b9c0d…`. A commit natural key names its repo. */
const lastSegment = (naturalKey: string): string => {
  const separator = naturalKey.lastIndexOf(':');
  return separator === -1 ? naturalKey : naturalKey.slice(separator + 1);
};

/** `#9201` -> 9201. Null when the forge did not give the PR a display number. */
const numberInLabel = (label: string): number | null => {
  const digits = /^#(\d+)$/.exec(label);
  return digits === null ? null : Number.parseInt(digits[1] ?? '', 10);
};

function itemRow(item: ReportItem, prose: string): ReportItemInput {
  return {
    stableId: item.stableId,
    headline: item.headline,
    detail: item.detail,
    prose,
    changeTag: item.changeTag,
    ageDays: item.ageDays,
    changeClause: item.changeClause ?? null,
    ladder: item.ladder === undefined ? null : (JSON.parse(canonicalJson(item.ladder)) as Record<string, unknown>),
    payload: JSON.parse(canonicalJson(item)) as Record<string, unknown>,
    evidence: item.evidence.map(evidenceColumns),
  };
}

function sectionRow(section: ReportSection, rendered: RenderedSection | undefined, ordinal: number): ReportSectionInput {
  // Joined by stable id rather than by position: the renderer emits one claim
  // per item today, but a paragraph that is not an item would silently shift
  // every claim's prose onto its neighbour if this indexed by position.
  const proseByClaim = new Map((rendered?.claims ?? []).map((claim) => [claim.stableId, claim.prose]));

  return {
    sectionKey: section.key,
    ordinal,
    title: section.title,
    prose: rendered?.prose ?? '',
    payload: JSON.parse(canonicalJson(section)) as Record<string, unknown>,
    emptyStatement: section.emptyStatement,
    summary: section.summary ?? null,
    items: section.items.map((item) => itemRow(item, proseByClaim.get(item.stableId) ?? '')),
  };
}

/** The row shape for one report, section ordinals derived from `SECTIONS`. */
export function reportRows(input: PersistReportInput): ReportInput {
  const { report, rendered } = input;
  assertSixSectionsInOrder(report);

  const renderedByKey = new Map(rendered.sections.map((section) => [section.key, section]));

  return {
    ...scopeColumns(report),
    schemaVersion: report.schemaVersion,
    reportInstant: report.instant,
    reportDate: formatCivilDate(report.instant, report.timezone),
    timezone: report.timezone,
    window: report.window,
    contentHash: reportHash(report),
    payloadJson: canonicalJson(report),
    payload: JSON.parse(canonicalJson(report)) as Record<string, unknown>,
    prose: rendered.text,
    rendererId: rendered.rendererId,
    coverageStatus: coverageStatusOf(report),
    ingestRunId: input.ingestRunId,
    generatedAt: input.generatedAt,
    sections: SECTIONS.map((definition, position) => {
      const section = report.sections[position];
      if (section === undefined || section.key !== definition.key) {
        throw new Error(
          `Section ${position + 1} must be \`${definition.key}\`; the section-order assertion should have caught this.`,
        );
      }
      return sectionRow(section, renderedByKey.get(section.key), definition.index);
    }),
  };
}

/** Writes one report and its six sections. Replaces an earlier run's rows. */
export async function persistReport(scoped: ScopedDb, input: PersistReportInput): Promise<StoredReport> {
  return saveReport(scoped, reportRows(input));
}
