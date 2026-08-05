import { NON_SEMANTIC_REPORT_FIELDS, canonicalReportJson } from './determinism.js';
import type { ReportItem, ReportSection, StructuredReport } from './structured-report.js';

/**
 * The item-level diff between two stored reports: what a reviewer means by "what changed".
 *
 * ## Why this is keyed on `stableId` and not on position
 *
 * A report's items are ordered by severity, so yesterday's third blocker is often today's first.
 * A positional diff would report every reordering as a change and every genuine change as a pair
 * of unrelated add/remove rows — which is exactly the noise that makes a diff unreadable and, worse,
 * the noise that hides a fabricated item among fifty false positives.
 *
 * `stableId` is derived from the underlying entity and its cause, never from the report or the run,
 * so the same condition on consecutive days is the *same item* with a history. That is the property
 * this whole view is built on: keying on it means the diff has exactly as many rows as there were
 * real changes.
 *
 * ## The allowlist is not this module's to invent
 *
 * `NON_SEMANTIC_REPORT_FIELDS` — `generatedAt`, `narrationTraceId`, `runId` — is the same constant
 * the determinism gate uses, documented in prose in `packages/analysis/DETERMINISM.md` with a test
 * that parses that document and fails if the two disagree. Re-declaring the list here would create a
 * second source of truth, and the two would drift the first time a field was added: the determinism
 * gate would ignore it and the diff would report it as a change on every single pair of days.
 *
 * So there is one list, and "excluded from the diff" and "excluded from the determinism hash" are
 * the same sentence. It also gives the third criterion for free — a report diffed against itself has
 * no differences, because the comparison is the byte-identical canonical form the gate already
 * guarantees is stable.
 *
 * ## Pure, like the rest of this package
 *
 * No clock, no I/O, no database. Two reports in, one diff out. The web layer loads two stored
 * bundles and maps them onto `StructuredReport`; nothing here knows a row exists.
 */

/** One field that differs, with both sides rendered as canonical JSON. */
export interface FieldChange {
  /** The field name as it appears on the item, e.g. `severityScore`, `ageDays`. */
  readonly field: string;
  /**
   * Canonical JSON of each side, or `<absent>` when the key exists on only one.
   *
   * Strings rather than the values themselves, so a consumer can print a change without having to
   * decide how to render an arbitrary nested shape — and so the comparison a reader sees is the
   * comparison that was actually made.
   */
  readonly before: string;
  readonly after: string;
}

export type ItemDiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

/**
 * The only thing the classifier needs of an item: an identity to key on.
 *
 * A structural contract rather than `ReportItem`, and for the reason `configuration.ts` gives for
 * the same move — "a narrow structural contract is cheaper than a coupling". Two shapes carry report
 * items in this repository: `ReportItem` in a freshly generated `StructuredReport`, and
 * `StoredReportItem` read back out of the database with its structured `payload` attached. Both are
 * diffed, by the same classifier, in the same order, against the same allowlist.
 *
 * The alternative — a second differ for the stored shape — is how the page and the engine come to
 * disagree about what changed, which on this view would be indistinguishable from a fabrication.
 */
export interface DiffableItem {
  readonly stableId: string;
}

export interface ItemDiff<T extends DiffableItem = ReportItem> {
  readonly stableId: string;
  readonly sectionKey: string;
  readonly status: ItemDiffStatus;
  /** The item as it stood in the earlier report. Null when added. */
  readonly before: T | null;
  /** The item as it stands in the later report. Null when removed. */
  readonly after: T | null;
  /** Empty unless `status` is `changed`. */
  readonly changedFields: readonly FieldChange[];
}

export interface SectionDiff<T extends DiffableItem = ReportItem> {
  readonly key: string;
  readonly index: number;
  readonly title: string;
  /** Every item in either report, in the reading order documented on `diffItems`. */
  readonly items: readonly ItemDiff<T>[];
  readonly addedCount: number;
  readonly removedCount: number;
  readonly changedCount: number;
  readonly unchangedCount: number;
  /** Changes to the section's own prose — its summary, or its empty statement. */
  readonly sectionFieldChanges: readonly FieldChange[];
  /** True when anything in this section differs, including its own prose. */
  readonly hasChanges: boolean;
}

/** Which report each column is. Enough for a heading; the view resolves its own labels. */
export interface DiffSide {
  readonly instant: number;
  readonly scopeKind: string;
  readonly scopeKey: string | null;
}

export interface ReportDiff<T extends DiffableItem = ReportItem> {
  readonly left: DiffSide;
  readonly right: DiffSide;
  readonly sections: readonly SectionDiff<T>[];
  readonly addedCount: number;
  readonly removedCount: number;
  readonly changedCount: number;
  readonly unchangedCount: number;
  /**
   * Report-level facts that moved: the projection, the calibration verdict, coverage.
   *
   * Included because `hasChanges` has to be *true* whenever the reader would disagree with "nothing
   * material changed". A day on which every item is identical but the projected completion date
   * moved a week is not a day on which nothing changed, and a diff that said so would be the
   * confident-polish failure this product exists to refuse.
   */
  readonly reportFieldChanges: readonly FieldChange[];
  readonly hasChanges: boolean;
  /**
   * The sentence the view prints. Stated here rather than in the component so the page, an export
   * and any future channel cannot describe the same diff three different ways.
   */
  readonly statement: string;
}

/** The sentence for a diff with nothing in it. Asserted by name in the view's test. */
export const NOTHING_CHANGED_STATEMENT =
  'Nothing material changed between these two reports. Every item carries the same stable id, the ' +
  'same evidence and the same severity, and no report-level figure moved.';

const excluded = new Set(NON_SEMANTIC_REPORT_FIELDS);

/** `<absent>` for a key on one side only — the differ has to be able to describe that. */
const describe = (value: unknown): string => (value === undefined ? '<absent>' : canonicalReportJson(value));

/**
 * Every semantic key on which two records differ.
 *
 * Walks the union of both sides' keys, so a field that appears on only one is reported rather than
 * silently skipped. The allowlist is applied here — once — which is what makes "excluded from the
 * diff" true at every level of the structure rather than only at the top.
 */
export function fieldChangesBetween(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): readonly FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !excluded.has(key))
    .sort();

  const changes: FieldChange[] = [];
  for (const key of keys) {
    const left = describe(before[key]);
    const right = describe(after[key]);
    if (left !== right) changes.push({ field: key, before: left, after: right });
  }
  return changes;
}

const asRecord = (item: DiffableItem): Readonly<Record<string, unknown>> =>
  item as unknown as Readonly<Record<string, unknown>>;

/**
 * Classify one section's items, in the reading order the diff view renders.
 *
 * Items present in the later report come first, in *that* report's order, because the right-hand
 * column is the one a reviewer reads top to bottom and it must read like the report itself. Items
 * that left the report follow, in the earlier report's order.
 *
 * Grouping removals at the end rather than interleaving them at their old position is deliberate.
 * Severity ordering changes daily, so an item's old position carries no meaning a reader could use —
 * whereas "these three left the report" is a fact worth reading as a group. Documented here because
 * it is a judgement, not an accident.
 *
 * Exported and generic so the stored-report path in `apps/web` classifies with this function rather
 * than a copy of it. See `DiffableItem`.
 */
export function diffItems<T extends DiffableItem>(
  sectionKey: string,
  before: readonly T[],
  after: readonly T[],
): readonly ItemDiff<T>[] {
  const beforeById = new Map(before.map((item) => [item.stableId, item]));
  const afterIds = new Set(after.map((item) => item.stableId));

  const present: ItemDiff<T>[] = after.map((item) => {
    const previous = beforeById.get(item.stableId);
    if (previous === undefined) {
      return { stableId: item.stableId, sectionKey, status: 'added', before: null, after: item, changedFields: [] };
    }

    const changedFields = fieldChangesBetween(asRecord(previous), asRecord(item));
    return {
      stableId: item.stableId,
      sectionKey,
      status: changedFields.length === 0 ? 'unchanged' : 'changed',
      before: previous,
      after: item,
      changedFields,
    };
  });

  const departed: ItemDiff<T>[] = before
    .filter((item) => !afterIds.has(item.stableId))
    .map((item) => ({
      stableId: item.stableId,
      sectionKey,
      status: 'removed' as const,
      before: item,
      after: null,
      changedFields: [],
    }));

  return [...present, ...departed];
}

/**
 * The section's own prose, compared apart from its items.
 *
 * `summary` and `emptyStatement` are the two fields a section carries that a reader sees; `items` is
 * diffed item-wise above and `key`/`index`/`title` are fixed by the Six Spine and cannot move. Naming
 * the three excluded fields explicitly rather than deleting them from a copy keeps the intent legible.
 */
function sectionFieldChangesBetween(before: ReportSection, after: ReportSection): readonly FieldChange[] {
  const structural = new Set(['items', 'key', 'index', 'title']);
  const pick = (section: ReportSection): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(section as unknown as Record<string, unknown>).filter(([key]) => !structural.has(key)),
    );

  return fieldChangesBetween(pick(before), pick(after));
}

const sideOf = (report: StructuredReport): DiffSide => ({
  instant: report.instant as unknown as number,
  scopeKind: report.scope.kind,
  scopeKey: report.scope.kind === 'team' ? report.scope.teamKey : null,
});

/**
 * Report-level facts, compared shallowly.
 *
 * Shallow on purpose: one row saying `projection changed` with both canonical values is what a
 * reviewer can act on, where a deep walk would produce forty rows about the same moved date. The
 * fields are named rather than derived from `Object.keys` so that adding a section or an item can
 * never accidentally show up here as a report-level change — `sections` is diffed item-wise and
 * `changeSummary` is Compass's own prose *about* the change, which would restate every diff row.
 */
function reportFieldChangesBetween(before: StructuredReport, after: StructuredReport): readonly FieldChange[] {
  const compared = ['coverage', 'findings', 'suppressed', 'timezone', 'window', 'schemaVersion'] as const;

  const pick = (report: StructuredReport): Record<string, unknown> =>
    Object.fromEntries(compared.map((key) => [key, report[key]]));

  return fieldChangesBetween(pick(before), pick(after));
}

/**
 * Diff two reports.
 *
 * `before` is the earlier report and `after` the later one; the caller orders them, because "earlier"
 * is a fact about the two instants and not something this function should re-derive and possibly
 * disagree with the page's own heading about.
 *
 * Sections are matched by key and emitted in the Six Spine's fixed order, taken from the later
 * report. The order never reorders, so a section present in one report and not the other is a schema
 * change rather than a diff — and it is reported as an empty section rather than crashing.
 */
export function diffReports(before: StructuredReport, after: StructuredReport): ReportDiff {
  const beforeSections = new Map(before.sections.map((section) => [section.key, section]));

  const sections: SectionDiff[] = after.sections.map((section) => {
    const previous = beforeSections.get(section.key);
    const items = diffItems<ReportItem>(section.key, previous?.items ?? [], section.items);
    const sectionFieldChanges = previous === undefined ? [] : sectionFieldChangesBetween(previous, section);

    const countOf = (status: ItemDiffStatus): number =>
      items.filter((item) => item.status === status).length;

    const addedCount = countOf('added');
    const removedCount = countOf('removed');
    const changedCount = countOf('changed');

    return {
      key: section.key,
      index: section.index,
      title: section.title,
      items,
      addedCount,
      removedCount,
      changedCount,
      unchangedCount: countOf('unchanged'),
      sectionFieldChanges,
      hasChanges:
        addedCount + removedCount + changedCount > 0 || sectionFieldChanges.length > 0,
    };
  });

  const total = (pick: (section: SectionDiff) => number): number =>
    sections.reduce((sum, section) => sum + pick(section), 0);

  const addedCount = total((section) => section.addedCount);
  const removedCount = total((section) => section.removedCount);
  const changedCount = total((section) => section.changedCount);
  const reportFieldChanges = reportFieldChangesBetween(before, after);

  const hasChanges =
    addedCount + removedCount + changedCount > 0 ||
    reportFieldChanges.length > 0 ||
    sections.some((section) => section.sectionFieldChanges.length > 0);

  return {
    left: sideOf(before),
    right: sideOf(after),
    sections,
    addedCount,
    removedCount,
    changedCount,
    unchangedCount: total((section) => section.unchangedCount),
    reportFieldChanges,
    hasChanges,
    statement: hasChanges ? describeDiff(addedCount, removedCount, changedCount, reportFieldChanges.length) : NOTHING_CHANGED_STATEMENT,
  };
}

/** The one-sentence summary, in the product's voice: counts, no adjectives. */
function describeDiff(added: number, removed: number, changed: number, reportFields: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} item${added === 1 ? '' : 's'} appeared`);
  if (removed > 0) parts.push(`${removed} left the report`);
  if (changed > 0) parts.push(`${changed} changed`);
  if (reportFields > 0) {
    parts.push(`${reportFields} report-level figure${reportFields === 1 ? '' : 's'} moved`);
  }

  const joined =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;

  return `${joined[0]!.toUpperCase()}${joined.slice(1)}.`;
}

/**
 * Every changed, added or removed row in reading order, for the jump-to-next-change control.
 *
 * Computed here rather than in the component so the keyboard control and the rendered markers walk
 * the same list in the same order — a "next change" that skipped a row the page had marked would be
 * worse than no control at all.
 */
export function changedItemDiffs<T extends DiffableItem>(
  diff: ReportDiff<T>,
): readonly ItemDiff<T>[] {
  return diff.sections.flatMap((section) =>
    section.items.filter((item) => item.status !== 'unchanged'),
  );
}
