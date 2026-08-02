import { compareStable, wholeDaysBetween, type Instant } from './instant.js';
import type { SectionKey } from './sections.js';
import type { ChangeTag, ReportChangeSummary, ReportItem, ReportSection } from './structured-report.js';

/**
 * Change-awareness: what moved since the previous report, and the plain statement that
 * nothing did.
 *
 * ## The failure this module exists to prevent
 *
 * A daily that re-lists the same three blockers every morning as though they were news is
 * worthless within a week — it is one of the two documented ways this product dies. Stable
 * item ids (`identity.ts`) make continuity *possible*; this module is what makes it
 * *visible*. Every item is compared against its own prior self and carries exactly one tag,
 * the items that moved are led with, and a morning on which nothing moved says so in one
 * sentence instead of re-printing yesterday's page in yesterday's voice.
 *
 * ## The five tags, and how each is decided
 *
 * - **`resolved`** — the item is a completion. A Yesterday line and a Win are finished by
 *   construction, so their producer has already said `resolved` and the comparison leaves
 *   that alone. An intrinsic verdict is never overwritten by an arithmetic one.
 * - **`new`** — no item with this id appeared in the prior report. On the very first report
 *   for a scope, that is every item, and the summary says so rather than implying that
 *   twelve things happened overnight.
 * - **`worsened`** / **`improved`** — the id appeared before and its `severityScore` has
 *   risen / fallen.
 * - **`unchanged`** — the id appeared before at the same score. It renders with its age in
 *   whole days from `firstSeenAt`, which is what turns "this blocker again" into "day 6 of
 *   this blocker".
 *
 * ## Why one number, and why higher is always worse
 *
 * The comparison needs a single ordered quantity per item or it cannot say which direction
 * an item moved. So every producer family maps onto one integer, `severityScore`, and the
 * direction is fixed for all of them: **higher is worse**. A sprint at 62% therefore scores
 * `38`, not `62` — the alternative is a per-family direction flag that every consumer has
 * to honour and one of them eventually will not, at which point the page reports an
 * improving sprint as worsening. `generate.ts` documents the mapping family by family.
 *
 * ## `firstSeenAt` is when Compass first *reported* the item, not when the condition began
 *
 * The two are different facts and the product states both. `ageDays` is the condition's own
 * age, read from the knowledge model's persisted history — a ticket stalled for six days
 * before Compass was installed was stalled for six days. `firstSeenAt` is the first report
 * that carried this item id, which is what "unchanged since Compass first reported it" is
 * counted from and what a manager's sense of "you keep telling me this" is actually about.
 */

/** Every tag an item can carry, in the order the summary lists them. */
export const CHANGE_TAGS: readonly ChangeTag[] = Object.freeze([
  'new',
  'worsened',
  'improved',
  'resolved',
  'unchanged',
]);

/**
 * The tags that count as movement.
 *
 * `unchanged` is the only tag that is not movement, which is the whole definition of
 * "nothing material changed": every item present carries `unchanged`, and nothing that was
 * present yesterday has departed.
 */
export const MOVED_CHANGE_TAGS: readonly ChangeTag[] = Object.freeze([
  'new',
  'worsened',
  'improved',
  'resolved',
]);

export const isChangeTag = (value: string): value is ChangeTag =>
  (CHANGE_TAGS as readonly string[]).includes(value);

/** The sentence a morning with no movement gets. Stated, never implied by an empty page. */
export const NOTHING_MATERIAL_CHANGED_STATEMENT = 'Nothing material changed since yesterday.';

/** The sentence the first report for a scope gets, so "all new" is not read as a surge. */
export const FIRST_REPORT_STATEMENT =
  'This is the first report Compass has generated for this scope, so everything below is stated for the first time rather than as news.';

/**
 * One item as the prior report left it — the only thing the comparison needs.
 *
 * Deliberately three fields rather than a whole `ReportItem`. The prior report is loaded
 * from persisted rows and the comparison must not be able to reach for its headline, its
 * prose or its evidence: an item's *text* changing is not an item changing, and a
 * comparison that could see the text would eventually be tempted to diff it.
 */
export interface PriorItemState {
  readonly stableId: string;
  /** Carried forward, so an item that persists for a week ages rather than resetting. */
  readonly firstSeenAt: Instant;
  readonly severityScore: number;
}

/** The previous report for one subscription's scope, reduced to what the tagging needs. */
export interface PriorReportState {
  /** The instant that report was generated *for*. */
  readonly instant: Instant;
  readonly items: readonly PriorItemState[];
}

/** Whole days from the first report that carried this item to the report being built. */
export const itemPresenceDays = (item: ReportItem, instant: Instant): number =>
  Math.max(0, wholeDaysBetween(item.firstSeenAt, instant));

/**
 * The clause an item's tag becomes when the item has nothing more specific to say.
 *
 * A run-in clause in the product's voice, never a badge. `unchanged` is the interesting
 * one: it is the sentence that stops the same finding reading as news on day six.
 */
export function changeClauseFor(tag: ChangeTag, presenceDays: number): string | null {
  switch (tag) {
    case 'unchanged':
      return presenceDays <= 0
        ? 'unchanged since the previous report'
        : 'unchanged since Compass first reported it';
    case 'worsened':
      return 'worse than it was in the previous report';
    case 'improved':
      return 'better than it was in the previous report';
    case 'new':
      return null;
    case 'resolved':
      return null;
  }
}

/**
 * One item, tagged against its own prior self.
 *
 * Pure and total: no clock, no lookup beyond the map it is handed. A `resolved` tag already
 * on the item is intrinsic — a completion — and survives untouched.
 */
export function tagItemChange(
  item: ReportItem,
  prior: PriorItemState | undefined,
  instant: Instant,
): ReportItem {
  if (item.changeTag === 'resolved') {
    // A completion. `firstSeenAt` still comes from the prior report when there is one, so a
    // Win that stays in the window for three days does not claim to be three days old.
    return { ...item, firstSeenAt: prior?.firstSeenAt ?? item.firstSeenAt };
  }

  if (prior === undefined) {
    return { ...item, changeTag: 'new', firstSeenAt: instant };
  }

  const tag: ChangeTag =
    item.severityScore > prior.severityScore
      ? 'worsened'
      : item.severityScore < prior.severityScore
        ? 'improved'
        : 'unchanged';

  const firstSeenAt = prior.firstSeenAt;
  const presenceDays = Math.max(0, wholeDaysBetween(firstSeenAt, instant));
  const clause = item.changeClause ?? changeClauseFor(tag, presenceDays);

  return {
    ...item,
    changeTag: tag,
    firstSeenAt,
    ...(clause === null ? {} : { changeClause: clause }),
  };
}

/**
 * Movement first, then the section's own order.
 *
 * A **stable** partition: within the moved group and within the unchanged group the
 * producer's ordering — severity for risks, age for blockers — is preserved exactly. That
 * matters twice over. It keeps the section's documented order meaningful, and it makes this
 * pass a no-op on the first report for a scope, where every item is `new` and therefore
 * every item has moved.
 */
export function movedFirst(items: readonly ReportItem[]): readonly ReportItem[] {
  const moved = items.filter((item) => item.changeTag !== 'unchanged');
  const still = items.filter((item) => item.changeTag === 'unchanged');
  return [...moved, ...still];
}

const emptyCounts = (): Record<ChangeTag, number> => ({
  new: 0,
  unchanged: 0,
  worsened: 0,
  improved: 0,
  resolved: 0,
});

/** "2 are new, 1 worsened and 3 are unchanged" — the counts, in the fixed tag order. */
function describeCounts(counts: Readonly<Record<ChangeTag, number>>, departed: number): string {
  const parts: string[] = [];
  const noun = (count: number): string => `${count} item${count === 1 ? '' : 's'}`;

  if (counts.new > 0) parts.push(`${noun(counts.new)} appeared`);
  if (counts.worsened > 0) parts.push(`${noun(counts.worsened)} worsened`);
  if (counts.improved > 0) parts.push(`${noun(counts.improved)} improved`);
  if (counts.resolved > 0) parts.push(`${noun(counts.resolved)} completed`);
  if (departed > 0) parts.push(`${noun(departed)} stopped holding`);
  if (counts.unchanged > 0) parts.push(`${noun(counts.unchanged)} carried over unchanged`);

  if (parts.length === 0) return NOTHING_MATERIAL_CHANGED_STATEMENT;
  const listed = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
  return `Since the previous report ${listed}.`;
}

export interface ChangeAwarenessResult {
  readonly sections: readonly ReportSection[];
  readonly summary: ReportChangeSummary;
}

/**
 * Tags every item in every section, leads with what moved, and summarises the morning.
 *
 * Runs once, over the assembled sections, rather than inside each of the six producers.
 * Five producers each deciding their own tag is how the change tag came to mean five
 * different things — a blocker's `new` meant "detected today", a recommendation's meant
 * "always", and a risk's came from a trend computed against a window rather than against
 * the previous report. One pass, one definition.
 */
export function applyChangeAwareness(
  sections: readonly ReportSection[],
  prior: PriorReportState | null,
  instant: Instant,
): ChangeAwarenessResult {
  const priorById = new Map((prior?.items ?? []).map((item) => [item.stableId, item]));
  const counts = emptyCounts();
  const present = new Set<string>();

  const tagged = sections.map((section) => {
    const items = section.items.map((item) => {
      const next = tagItemChange(item, prior === null ? undefined : priorById.get(item.stableId), instant);
      counts[next.changeTag] += 1;
      present.add(next.stableId);
      return next;
    });
    return { ...section, items: movedFirst(items) };
  });

  const departedStableIds = [...priorById.keys()]
    .filter((stableId) => !present.has(stableId))
    .sort(compareStable);

  const movedCount = MOVED_CHANGE_TAGS.reduce((total, tag) => total + counts[tag], 0);
  const nothingMaterialChanged = prior !== null && movedCount === 0 && departedStableIds.length === 0;

  const statement =
    prior === null
      ? FIRST_REPORT_STATEMENT
      : nothingMaterialChanged
        ? NOTHING_MATERIAL_CHANGED_STATEMENT
        : describeCounts(counts, departedStableIds.length);

  return {
    sections: tagged,
    summary: {
      hasPriorReport: prior !== null,
      priorInstant: prior?.instant ?? null,
      nothingMaterialChanged,
      statement,
      counts,
      departedStableIds,
    },
  };
}

/**
 * The prior state a report leaves behind, for tomorrow's comparison.
 *
 * Built from the report itself rather than from its persisted rows, so the pipeline can
 * hand yesterday's structured payload straight back in and a test can chain ten simulated
 * days with no database at all.
 */
export function priorStateOf(report: {
  readonly instant: Instant;
  readonly sections: readonly ReportSection[];
}): PriorReportState {
  const items: PriorItemState[] = [];
  for (const section of report.sections) {
    for (const item of section.items) {
      items.push({
        stableId: item.stableId,
        firstSeenAt: item.firstSeenAt,
        severityScore: item.severityScore,
      });
    }
  }
  return { instant: report.instant, items: items.sort((left, right) => compareStable(left.stableId, right.stableId)) };
}

/**
 * The sections a change tag is *actionable* in.
 *
 * Feedback exists for findings a manager can dispute or act on. A Yesterday completion and a
 * Win are statements of fact about work that already happened — there is nothing to dismiss,
 * snooze or reject — and offering a button under them would invite a manager to argue with
 * their own team's merge history.
 */
export const ACTIONABLE_SECTION_KEYS: readonly SectionKey[] = Object.freeze([
  'blockers',
  'risks',
  'recommendations',
]);

export const isActionableSection = (key: SectionKey): boolean => ACTIONABLE_SECTION_KEYS.includes(key);
