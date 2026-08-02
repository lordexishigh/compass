import {
  SECTIONS,
  assertSixSectionsInOrder,
  type EvidenceRef,
  type ReportItem,
  type ReportScope,
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
  /**
   * The narration outcome, when narration ran.
   *
   * Absent means "this build had no narration stage", which is how the MVP's tests
   * and any caller that only wants the deterministic render keep working unchanged.
   * Present-and-fallback is a *different* fact from absent, and the report row
   * distinguishes them: see `reports.fallbackRenderer`.
   */
  readonly narration?: PersistedNarration;
}

/** What the pipeline learned from narrating, reduced to what a row holds. */
export interface PersistedNarration {
  /** `narrated`, or the template renderer's id on a fallback. */
  readonly rendererId: string;
  /** Null when narration succeeded. */
  readonly fallbackReason: string | null;
  /** One entry per section, in the fixed order. Overrides the rendered prose. */
  readonly sections: readonly { readonly key: string; readonly prose: string }[];
}

export type ScopeColumns = { readonly scopeKind: string; readonly scopeKey: string };

/**
 * `team` / `platform`, or `merged` / `*`. Never a nullable key.
 *
 * Declared here rather than beside the report-reading path, because three callers now need it
 * *before* a report exists: the prior-report lookup, the idempotency check and the row write. A
 * second spelling of the same mapping is how a lookup ends up scoped to `merged` / `null` and
 * quietly finds no prior report ever again.
 */
export function scopeColumnsFor(scope: ReportScope): ScopeColumns {
  return scope.kind === 'team'
    ? { scopeKind: 'team', scopeKey: scope.teamKey }
    : { scopeKind: 'merged', scopeKey: SCOPE_KEY_FOR_MERGED };
}

export const scopeColumns = (report: StructuredReport): ScopeColumns => scopeColumnsFor(report.scope);

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
    // The three coordinates as typed columns, not only inside the payload: a feedback click
    // arrives with an item id and the handler has to turn it into the cause a verdict is
    // recorded against. Reading that out of a jsonb blob works until the payload shape moves.
    causeEntityRef: item.cause.entityRef,
    causeKind: item.cause.causeKind,
    causeDiscriminator: item.cause.causeDiscriminator,
    headline: item.headline,
    detail: item.detail,
    prose,
    changeTag: item.changeTag,
    ageDays: item.ageDays,
    firstSeenAt: item.firstSeenAt,
    severityScore: item.severityScore,
    signalOnsetAt: item.signalOnsetAt,
    feedbackState: item.feedback?.state ?? null,
    changeClause: item.changeClause ?? null,
    ladder: item.ladder === undefined ? null : (JSON.parse(canonicalJson(item.ladder)) as Record<string, unknown>),
    payload: JSON.parse(canonicalJson(item)) as Record<string, unknown>,
    evidence: item.evidence.map(evidenceColumns),
  };
}

function sectionRow(
  section: ReportSection,
  rendered: RenderedSection | undefined,
  ordinal: number,
  narratedProse: string | undefined,
): ReportSectionInput {
  // Joined by stable id rather than by position: the renderer emits one claim
  // per item today, but a paragraph that is not an item would silently shift
  // every claim's prose onto its neighbour if this indexed by position.
  const proseByClaim = new Map((rendered?.claims ?? []).map((claim) => [claim.stableId, claim.prose]));

  return {
    sectionKey: section.key,
    ordinal,
    title: section.title,
    // One column, one meaning: the prose a manager actually read for this
    // section. Narrated when narration was grounded, the template renderer's
    // otherwise. The per-claim `prose` below stays the deterministic renderer's
    // either way — narration may reorder and merge items, so a claim's own
    // validated sentences are the only text that can still be attributed to it.
    prose: narratedProse ?? rendered?.prose ?? '',
    payload: JSON.parse(canonicalJson(section)) as Record<string, unknown>,
    emptyStatement: section.emptyStatement,
    summary: section.summary ?? null,
    items: section.items.map((item) => itemRow(item, proseByClaim.get(item.stableId) ?? '')),
  };
}

/**
 * The whole-report prose, with narrated sections substituted in.
 *
 * `rendered.text` is the deterministic document — masthead, freshness line, the
 * `01`–`06` numerals — and narration only ever replaces section bodies. So the
 * furniture is kept and the bodies are swapped, rather than the narrator being
 * asked to reproduce a masthead it was never shown.
 */
function documentProse(rendered: RenderedReport, narration: PersistedNarration | undefined): string {
  if (narration === undefined) return rendered.text;
  const proseByKey = new Map(narration.sections.map((section) => [section.key, section.prose]));

  const body = rendered.sections.flatMap((section) => [
    `${section.numeral} ${section.title.toUpperCase()}`,
    '',
    proseByKey.get(section.key) ?? section.prose,
    '',
  ]);

  return `${[rendered.masthead, '', rendered.freshness, '', ...body].join('\n').trimEnd()}\n`;
}

/** The row shape for one report, section ordinals derived from `SECTIONS`. */
export function reportRows(input: PersistReportInput): ReportInput {
  const { report, rendered, narration } = input;
  assertSixSectionsInOrder(report);

  const renderedByKey = new Map(rendered.sections.map((section) => [section.key, section]));
  const narratedByKey = new Map((narration?.sections ?? []).map((section) => [section.key, section.prose]));
  const fallbackReason = narration?.fallbackReason ?? null;

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
    prose: documentProse(rendered, narration),
    // Never narrated. Narration replaces *section bodies*; the change line is a computed fact about
    // the report as a whole, and a model asked to reword "nothing material changed since yesterday"
    // could only make it less true.
    changeLine: rendered.changeLine,
    rendererId: narration?.rendererId ?? rendered.rendererId,
    // True only when narration was *attempted* and did not survive grounding.
    // A build with no narrator at all reports `false` with a null reason: nothing
    // degraded there, and an operator alerting on this number must not be woken by
    // a deployment that was never configured to narrate.
    fallbackRenderer: narration !== undefined && fallbackReason !== null,
    fallbackReason,
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
      return sectionRow(section, renderedByKey.get(section.key), definition.index, narratedByKey.get(section.key));
    }),
  };
}

/** Writes one report and its six sections. Replaces an earlier run's rows. */
export async function persistReport(scoped: ScopedDb, input: PersistReportInput): Promise<StoredReport> {
  return saveReport(scoped, reportRows(input));
}
