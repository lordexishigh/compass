import { diffItems, fieldChangesBetween, NOTHING_CHANGED_STATEMENT, type FieldChange, type ItemDiff } from '@compass/analysis';
import { formatCivilDateTime } from '@compass/clock';
import {
  findReportsForDate,
  loadReportBundle,
  type ScopedDb,
  type StoredReportBundle,
  type StoredReportItem,
} from '@compass/db';

import { describeArtifact, superscriptMarker, type EvidenceLinkView } from './view-model';

/**
 * The side-by-side diff, built from two *stored* reports.
 *
 * ## Why this reads rows rather than regenerating
 *
 * The whole point of the view is that a reviewer can check Compass did not make anything up. If the
 * page re-ran the analysis to build either column it would be showing today's beliefs about
 * yesterday, which is precisely the thing under suspicion — and a fabricated claim would be
 * regenerated identically and look confirmed. So both columns come out of `report_items`, and the
 * payload the fabrication check displays is the payload that was persisted the morning the claim was
 * made.
 *
 * ## One classifier, two shapes
 *
 * The added/removed/changed decision is `diffItems` from `@compass/analysis`, generic over anything
 * with a `stableId`. It is the same function, the same ordering and the same non-semantic allowlist
 * that `diffReports` uses on a freshly generated `StructuredReport`. A second differ for the stored
 * shape is how the engine and the page come to disagree about what changed — and on this view, a
 * disagreement is indistinguishable from the fabrication it exists to rule out.
 */

/** Fields on a stored item that are about the row, not about the claim. */
const ROW_FIELDS = new Set(['id', 'ordinal', 'reportItemId']);

/**
 * Which fields of a stored item the diff compares.
 *
 * `id` and `ordinal` are excluded for the same reason `runId` is on the determinism allowlist: they
 * are facts about the row, not about the claim. `ordinal` in particular would mark every item in a
 * reordered section as changed, which is the positional noise keying on `stableId` exists to avoid —
 * the *reordering itself* is visible in the columns, and it is not a change to the claim.
 *
 * They are excluded here rather than added to `NON_SEMANTIC_REPORT_FIELDS` because that constant is
 * the *report's* allowlist, documented in `packages/analysis/DETERMINISM.md` and shared with the
 * determinism hash; a storage-row concern has no business widening it.
 */
export const comparableItemFields = (item: StoredReportItem): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(item as unknown as Record<string, unknown>).filter(([key]) => !ROW_FIELDS.has(key)),
  );

export interface ClaimPayloadField {
  readonly field: string;
  /** Canonical JSON of the value, so a nested shape is printable without a second renderer. */
  readonly value: string;
}

/** One claim on one side of the diff, with everything the fabrication check needs. */
export interface DiffClaimView {
  readonly stableId: string;
  /** The renderer's own sentences — what the manager actually read that morning. */
  readonly prose: string;
  readonly headline: string;
  readonly changeClause: string | null;
  readonly ageDays: number;
  readonly severityScore: number;
  readonly changeTag: string;
  /** The structured payload fields backing the prose, for criterion 003. */
  readonly payloadFields: readonly ClaimPayloadField[];
  /** Every artifact behind the claim, one click from here. */
  readonly evidence: readonly EvidenceLinkView[];
}

export interface DiffRowView {
  readonly stableId: string;
  readonly status: ItemDiff['status'];
  readonly before: DiffClaimView | null;
  readonly after: DiffClaimView | null;
  readonly changedFields: readonly FieldChange[];
  /** A DOM id, so the jump-to-next-change control can move the reader to this row. */
  readonly anchorId: string;
}

export interface DiffSectionView {
  readonly key: string;
  readonly numeral: string;
  readonly title: string;
  readonly rows: readonly DiffRowView[];
  readonly addedCount: number;
  readonly removedCount: number;
  readonly changedCount: number;
  readonly hasChanges: boolean;
}

export interface DiffColumnView {
  readonly reportId: string;
  readonly reportDate: string;
  /** `30 July 2026, 06:00` — the instant the report was generated *for*. */
  readonly generatedForLabel: string;
  readonly teamLabel: string;
  readonly href: string;
}

export interface ReportDiffView {
  readonly left: DiffColumnView;
  readonly right: DiffColumnView;
  readonly sections: readonly DiffSectionView[];
  readonly addedCount: number;
  readonly removedCount: number;
  readonly changedCount: number;
  readonly unchangedCount: number;
  readonly reportFieldChanges: readonly FieldChange[];
  readonly hasChanges: boolean;
  readonly statement: string;
  /** Anchor ids of every changed row, in reading order, for the jump control. */
  readonly changeAnchors: readonly string[];
}

const canonical = (value: unknown): string => {
  // A payload can hold anything the analysis core put there; the display must never throw on it.
  try {
    return JSON.stringify(value ?? null, null, 0) ?? 'null';
  } catch {
    return '<unserialisable>';
  }
};

/**
 * The payload behind a claim, flattened to one row per top-level field.
 *
 * Top-level only, on purpose. The criterion is that a reviewer can see the fields backing the prose;
 * a fully expanded tree of forty rows buries the two that matter. Nested values print as canonical
 * JSON, which is dense but complete — and the artifact links beside them are the route to the source
 * of truth, which is where a reviewer who wants more should end up.
 */
export function payloadFields(payload: Readonly<Record<string, unknown>>): readonly ClaimPayloadField[] {
  return Object.entries(payload)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([field, value]) => ({ field, value: canonical(value) }));
}

/** Evidence refs on a stored item, as in-app artifact links. Same shape the report page uses. */
export function diffEvidenceLinks(item: StoredReportItem): readonly EvidenceLinkView[] {
  return item.evidence.map((reference, index) => ({
    marker: superscriptMarker(index + 1),
    label: reference.label,
    kind: reference.kind,
    // The one-click path to the commit SHA, pull request number or tracker key. The same route the
    // report's own evidence markers use, so the diff cannot drift from it.
    href: `/artifact/${encodeURIComponent(reference.kind)}/${encodeURIComponent(reference.artifactId)}`,
    description: describeArtifact(reference.kind, reference.label),
  }));
}

const claimView = (item: StoredReportItem): DiffClaimView => ({
  stableId: item.stableId,
  prose: item.prose,
  headline: item.headline,
  changeClause: item.changeClause,
  ageDays: item.ageDays,
  severityScore: item.severityScore,
  changeTag: item.changeTag,
  payloadFields: payloadFields(item.payload),
  evidence: diffEvidenceLinks(item),
});

/** A DOM-safe anchor. Stable ids carry `:` and `/`, which are legal in an id but awkward in a URL hash. */
export const diffAnchorId = (sectionKey: string, stableId: string): string =>
  `diff-${sectionKey}-${stableId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;

/**
 * Each column labelled in *its own* report's timezone.
 *
 * Read off the row rather than passed in: a report is dated in the zone it was generated for, and a
 * caller-supplied zone could disagree with the row — which on a view whose entire purpose is
 * verification would be a discrepancy a reviewer could not resolve.
 */
const columnView = (bundle: StoredReportBundle): DiffColumnView => ({
  reportId: bundle.report.id,
  reportDate: bundle.report.reportDate,
  generatedForLabel: formatCivilDateTime(bundle.report.reportInstant, bundle.report.timezone),
  teamLabel: bundle.report.scopeKind === 'team' ? bundle.report.scopeKey : 'every team, merged',
  href: `/archive/${encodeURIComponent(bundle.report.id)}`,
});

/**
 * Build the diff view from two stored bundles.
 *
 * `before` must be the earlier report. The caller orders them — the page does it by report date —
 * because "earlier" is a fact about the two rows and not something this function should re-derive and
 * then possibly disagree with the column headings about.
 */
export function buildReportDiffView(input: {
  readonly before: StoredReportBundle;
  readonly after: StoredReportBundle;
}): ReportDiffView {
  const { before, after } = input;
  const beforeSections = new Map(before.sections.map((section) => [section.sectionKey, section]));

  const sections: DiffSectionView[] = after.sections.map((section) => {
    const previous = beforeSections.get(section.sectionKey);

    const rows = diffItems<StoredReportItem>(
      section.sectionKey,
      previous?.items ?? [],
      section.items,
    ).map((row): DiffRowView => {
      /**
       * Re-derive the changed fields over the *comparable* field set.
       *
       * `diffItems` compares every own key, which on a stored row includes `id` and `ordinal`. Those
       * are row facts: `ordinal` alone would mark every item in a reordered section as changed. So the
       * classification's field list is recomputed here through `comparableItemFields`, and a row whose
       * only differences were row facts is corrected back to `unchanged`.
       */
      const changedFields =
        row.before === null || row.after === null
          ? []
          : fieldChangesBetween(comparableItemFields(row.before), comparableItemFields(row.after));

      const status =
        row.status === 'changed' && changedFields.length === 0 ? 'unchanged' : row.status;

      return {
        stableId: row.stableId,
        status,
        before: row.before === null ? null : claimView(row.before),
        after: row.after === null ? null : claimView(row.after),
        changedFields,
        anchorId: diffAnchorId(section.sectionKey, row.stableId),
      };
    });

    const countOf = (status: DiffRowView['status']): number =>
      rows.filter((row) => row.status === status).length;

    const addedCount = countOf('added');
    const removedCount = countOf('removed');
    const changedCount = countOf('changed');

    return {
      key: section.sectionKey,
      numeral: String(section.ordinal).padStart(2, '0'),
      title: section.title,
      rows,
      addedCount,
      removedCount,
      changedCount,
      hasChanges: addedCount + removedCount + changedCount > 0,
    };
  });

  const total = (pick: (section: DiffSectionView) => number): number =>
    sections.reduce((sum, section) => sum + pick(section), 0);

  const addedCount = total((section) => section.addedCount);
  const removedCount = total((section) => section.removedCount);
  const changedCount = total((section) => section.changedCount);

  /**
   * Report-level prose, compared apart from the items.
   *
   * The stored report row carries the masthead facts a reader sees — coverage status, the renderer
   * that wrote it, the fallback reason. A day on which every item matched but the coverage went
   * partial is not a day on which nothing changed, so these count toward `hasChanges`.
   */
  const reportFieldChanges = fieldChangesBetween(
    {
      coverageStatus: before.report.coverageStatus,
      rendererId: before.report.rendererId,
      fallbackReason: before.report.fallbackReason,
    },
    {
      coverageStatus: after.report.coverageStatus,
      rendererId: after.report.rendererId,
      fallbackReason: after.report.fallbackReason,
    },
  );

  const hasChanges = addedCount + removedCount + changedCount > 0 || reportFieldChanges.length > 0;

  return {
    left: columnView(before),
    right: columnView(after),
    sections,
    addedCount,
    removedCount,
    changedCount,
    unchangedCount: total((section) => section.rows.filter((row) => row.status === 'unchanged').length),
    reportFieldChanges,
    hasChanges,
    statement: hasChanges
      ? describeDiff(addedCount, removedCount, changedCount, reportFieldChanges.length)
      : NOTHING_CHANGED_STATEMENT,
    changeAnchors: sections.flatMap((section) =>
      section.rows.filter((row) => row.status !== 'unchanged').map((row) => row.anchorId),
    ),
  };
}

/** Counts, no adjectives — the same voice `diffReports` uses for its own statement. */
function describeDiff(added: number, removed: number, changed: number, reportFields: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} item${added === 1 ? '' : 's'} appeared`);
  if (removed > 0) parts.push(`${removed} left the report`);
  if (changed > 0) parts.push(`${changed} changed`);
  if (reportFields > 0) {
    parts.push(`${reportFields} report-level figure${reportFields === 1 ? '' : 's'} moved`);
  }

  const joined =
    parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return `${joined[0]!.toUpperCase()}${joined.slice(1)}.`;
}

/**
 * The link to a diff, built in one place.
 *
 * Exported so the archive index and the page agree about the parameter names. A hand-built query
 * string in a component is how `?team=` becomes `?teamKey=` on one screen and the link quietly 404s
 * into the "choose two reports" state.
 */
export const diffHref = (input: {
  readonly teamKey: string;
  readonly from: string;
  readonly to: string;
}): string =>
  `/archive/diff?team=${encodeURIComponent(input.teamKey)}&from=${encodeURIComponent(input.from)}` +
  `&to=${encodeURIComponent(input.to)}`;

export interface DiffPair {
  readonly before: StoredReportBundle;
  readonly after: StoredReportBundle;
}

/**
 * The two reports for a team on two dates, ordered earliest first.
 *
 * Returns null when either date has no stored report for that team. Generating the missing one would
 * make the diff a comparison against a report nobody ever read, which is the opposite of what this
 * view is for.
 */
export async function loadDiffPair(
  scoped: ScopedDb,
  input: { readonly teamKey: string; readonly leftDate: string; readonly rightDate: string },
): Promise<DiffPair | null> {
  const forDate = async (reportDate: string): Promise<StoredReportBundle | null> => {
    const rows = await findReportsForDate(scoped, reportDate);
    const row = rows.find(
      (candidate) => candidate.scopeKind === 'team' && candidate.scopeKey === input.teamKey,
    );
    return row === undefined ? null : loadReportBundle(scoped, row.id);
  };

  const [first, second] = await Promise.all([forDate(input.leftDate), forDate(input.rightDate)]);
  if (first === null || second === null) return null;

  // Ordered by the report date rather than by which parameter arrived first, so a link with the dates
  // the other way round still reads left-to-right in time.
  return first.report.reportDate <= second.report.reportDate
    ? { before: first, after: second }
    : { before: second, after: first };
}
