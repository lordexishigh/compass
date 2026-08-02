import { MERGED_REPORT_WORD_BUDGET } from './budgets.js';
import { compareStable, type Instant, type TimeWindow } from './instant.js';
import { SECTION_ORDER, type SectionKey } from './sections.js';
import type { ChangeTag, ReportItem, StructuredReport } from './structured-report.js';

/**
 * The merged cross-team report: one page for a manager of two or three teams.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is **not a concatenation**. Three teams' six sections read end to end is three dailies, and the
 * manager this exists for would skim it and then stop opening it. It is also not a re-analysis: the
 * per-team reports stay the unit of record, and this module consumes their already-computed items
 * rather than re-deriving anything from the knowledge model. That matters for a reason beyond
 * tidiness — a merged report that recomputed its own findings could disagree with the per-team report
 * it links into, and then neither is trustworthy.
 *
 * What it is: a **ranked index** into the per-team reports, holding only the items that would change
 * what the manager does today, cut to a hard prose budget, with every entry carrying the per-team
 * item's own stable id so the reader can go straight to the claim and its evidence.
 *
 * ## The action-impact score
 *
 * Ranking is the whole product here, so the rule is a documented number rather than a feeling. The
 * score is one integer per item, composed so that three considerations cannot bleed into each other:
 *
 * ```
 *   score = sectionWeight × 1_000_000
 *         + changeWeight  × 1_000
 *         + min(999, severityScore)
 * ```
 *
 * - **`sectionWeight`** — what kind of thing it is, and therefore whether it is *actionable today*.
 *   A recommendation is literally "do this today"; a blocker is something stuck that needs a person;
 *   a risk is a warning; Progress, Yesterday and Wins are things a manager reads rather than acts on.
 * - **`changeWeight`** — whether it *moved*. A risk that worsened overnight changes today's
 *   conversation; the same risk unchanged for six days does not, and the per-team report is where its
 *   day counter lives.
 * - **`severityScore`** — the item's own magnitude, already computed by the analysis core and already
 *   oriented so that higher is worse.
 *
 * The multipliers are what make the bands strict: the largest possible change contribution
 * (120 × 1000 = 120,000) cannot reach one section band (1,000,000), and the largest severity
 * contribution (999) cannot reach one change band (1,000). So a worsened Win never outranks an
 * unchanged recommendation, and severity only ever discriminates *within* a section and a change tag.
 * That is a deliberate ordering of concerns, and it is the thing to argue with if the ranking ever
 * feels wrong — not the arithmetic.
 *
 * ## Determinism
 *
 * The sort key is `(score descending, stableId ascending)`. The second half is not decoration:
 * `Array.prototype.sort` is stable, so ties would otherwise resolve to *input order* — which is team
 * order — and the acceptance criterion is precisely that team order does not decide the ranking. With
 * an explicit tiebreak, the same set of per-team reports produces the same merged report whatever
 * order the teams were passed in, which `tests/merged-report.test.ts` asserts by shuffling them.
 */

/** How much each section can change what a manager does today. Higher acts sooner. */
export const SECTION_ACTION_WEIGHT: Readonly<Record<SectionKey, number>> = Object.freeze({
  recommendations: 6,
  blockers: 5,
  risks: 4,
  progress: 3,
  yesterday: 2,
  wins: 1,
});

/** How much movement since the previous report adds. Bounded well below one section band. */
export const CHANGE_ACTION_WEIGHT: Readonly<Record<ChangeTag, number>> = Object.freeze({
  worsened: 120,
  new: 100,
  improved: 20,
  resolved: 10,
  unchanged: 0,
});

/** The band multipliers. Exported so the test asserts the bands rather than re-deriving them. */
export const SECTION_BAND = 1_000_000;
export const CHANGE_BAND = 1_000;
/** Severity is capped one below the change band so it can never cross it. */
export const MAX_SEVERITY_CONTRIBUTION = CHANGE_BAND - 1;

/** The three components of one item's score, kept apart so the page can show its own arithmetic. */
export interface ActionImpact {
  readonly score: number;
  readonly sectionWeight: number;
  readonly changeWeight: number;
  readonly severityContribution: number;
}

export function actionImpact(sectionKey: SectionKey, item: ReportItem): ActionImpact {
  const sectionWeight = SECTION_ACTION_WEIGHT[sectionKey];
  const changeWeight = CHANGE_ACTION_WEIGHT[item.changeTag];
  const severityContribution = Math.min(
    MAX_SEVERITY_CONTRIBUTION,
    Math.max(0, Math.round(item.severityScore)),
  );

  return {
    score: sectionWeight * SECTION_BAND + changeWeight * CHANGE_BAND + severityContribution,
    sectionWeight,
    changeWeight,
    severityContribution,
  };
}

/** One entry in the merged report: a pointer into a per-team report, never a copy of its analysis. */
export interface MergedReportItem {
  /**
   * The per-team item's own id, carried verbatim as a foreign key.
   *
   * Never a new id minted for the merged view. A merged item *is* the per-team item seen from one
   * level up, so a second identity would break every promise built on the first: the manager's
   * dismissal, the day counter, the presence trail and the link down into the evidence all resolve by
   * this string, and two ids for one condition is how feedback stops sticking.
   */
  readonly stableId: string;
  /** Which team's report holds it — the other half of the link down. */
  readonly teamKey: string;
  readonly sectionKey: SectionKey;
  readonly headline: string;
  readonly changeTag: ChangeTag;
  /** Days since the first report that carried this id, for the merged line's own day counter. */
  readonly seenDays: number;
  readonly impact: ActionImpact;
}

/** Everything the merged report says, before a renderer turns it into sentences. */
export interface MergedReport {
  readonly schemaVersion: number;
  readonly organizationId: string;
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  /** The teams that were merged, in the order they will be listed. */
  readonly teams: readonly MergedTeamSummary[];
  /** The items that fit the budget, ranked by action impact. */
  readonly items: readonly MergedReportItem[];
  /**
   * How many ranked items did not fit, and are therefore in the per-team reports only.
   *
   * Stated rather than silently dropped. "and 6 more in the per-team reports" is an honest sentence;
   * a page that stopped at nine items and said nothing would be hiding the fact that it had chosen.
   */
  readonly omittedItemCount: number;
  readonly wordBudget: number;
  /** The one-line answer to "is anything different this morning". */
  readonly changeLine: string;
}

export interface MergedTeamSummary {
  readonly teamKey: string;
  /** That team's own report id, so the merged page can link to the whole report as well as an item. */
  readonly reportId: string | null;
  readonly itemCount: number;
  /** How many of this team's items reached the merged page. */
  readonly mergedItemCount: number;
}

export const MERGED_REPORT_SCHEMA_VERSION = 1;

/**
 * How many items the merged report may carry.
 *
 * A count rather than a live word count, and the two are reconciled deliberately. The renderer holds
 * the budget and asserts it; this cap is what makes the assertion pass by construction, sized so that
 * the fixed furniture — masthead, change line, per-team summary, the "and N more" line — plus this
 * many item lines cannot reach 400 words. `tests/merged-report.test.ts` and the renderer's own budget
 * test are what keep the two in agreement, and the renderer throws rather than truncating if they
 * ever disagree.
 */
export const MAX_MERGED_ITEMS = 9;

export interface MergeTeamReportsInput {
  readonly organizationId: string;
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  /** One per team, already generated and already the unit of record. */
  readonly teamReports: readonly MergeTeamInput[];
}

export interface MergeTeamInput {
  readonly teamKey: string;
  readonly report: StructuredReport;
  /** The persisted report's id, when it has one. Null in a pure-analysis test. */
  readonly reportId?: string | null;
}

/**
 * Ranks every team's items into one budgeted page.
 *
 * Pure and total: no clock, no database, no ordering that depends on how the input happened to be
 * built. `seenDays` is computed from each item's own `firstSeenAt` against the merged instant, so a
 * recurring item's day counter agrees with the one in its per-team report rather than restarting.
 */
export function mergeTeamReports(input: MergeTeamReportsInput): MergedReport {
  const candidates: MergedReportItem[] = [];

  for (const team of input.teamReports) {
    for (const section of team.report.sections) {
      for (const item of section.items) {
        candidates.push({
          stableId: item.stableId,
          teamKey: team.teamKey,
          sectionKey: section.key,
          headline: item.headline,
          changeTag: item.changeTag,
          seenDays: Math.max(0, Math.floor((input.instant - item.firstSeenAt) / 86_400_000)),
          impact: actionImpact(section.key, item),
        });
      }
    }
  }

  // Score descending, then id ascending, then team. The id tiebreak is what stops team order deciding
  // anything; the team is the last resort so that a condition genuinely visible to two teams still has a
  // total order rather than resolving to arrival order.
  const ranked = dedupeByCondition(
    [...candidates].sort(
      (left, right) =>
        right.impact.score - left.impact.score ||
        compareStable(left.stableId, right.stableId) ||
        compareStable(left.teamKey, right.teamKey),
    ),
  );

  const items = ranked.slice(0, MAX_MERGED_ITEMS);
  const mergedByTeam = new Map<string, number>();
  for (const item of items) mergedByTeam.set(item.teamKey, (mergedByTeam.get(item.teamKey) ?? 0) + 1);

  return {
    schemaVersion: MERGED_REPORT_SCHEMA_VERSION,
    organizationId: input.organizationId,
    instant: input.instant,
    timezone: input.timezone,
    window: input.window,
    // Teams in their own stable key order, not the order they were passed: the per-team summary is a
    // list a manager reads down, and it must not reorder itself between two mornings.
    teams: [...input.teamReports]
      .sort((left, right) => compareStable(left.teamKey, right.teamKey))
      .map((team) => ({
        teamKey: team.teamKey,
        reportId: team.reportId ?? null,
        itemCount: team.report.sections.reduce((total, section) => total + section.items.length, 0),
        mergedItemCount: mergedByTeam.get(team.teamKey) ?? 0,
      })),
    items,
    omittedItemCount: Math.max(0, ranked.length - items.length),
    wordBudget: MERGED_REPORT_WORD_BUDGET,
    changeLine: mergedChangeLine(input.teamReports, ranked),
  };
}

/**
 * The merged report's one change sentence.
 *
 * Built from the per-team change summaries rather than recomputed, so the merged page and the team
 * pages cannot disagree about whether the morning was quiet. When every team says nothing moved, the
 * merged report says so once — which on a quiet morning is the entire report, and is the whole reason
 * a manager keeps opening it.
 */
export function mergedChangeLine(
  teamReports: readonly MergeTeamInput[],
  ranked: readonly MergedReportItem[],
): string {
  const withPrior = teamReports.filter((team) => team.report.changeSummary.hasPriorReport);
  if (withPrior.length === 0) {
    return 'This is the first merged report for these teams, so everything below is stated for the first time rather than as news.';
  }

  if (withPrior.every((team) => team.report.changeSummary.nothingMaterialChanged)) {
    return 'Nothing material changed since yesterday on any of these teams.';
  }

  const moved = ranked.filter((item) => item.changeTag !== 'unchanged').length;
  const teams = new Set(ranked.filter((item) => item.changeTag !== 'unchanged').map((item) => item.teamKey));

  return (
    `${moved} item${moved === 1 ? '' : 's'} moved across ${teams.size} ` +
    `team${teams.size === 1 ? '' : 's'} since the previous report.`
  );
}

/**
 * One condition, one line — even when several teams can see it.
 *
 * A stable id is derived from the entity and the cause and deliberately *not* from the team, because a
 * ticket does not change identity when it is read from another scope. Most of the time that means one id
 * belongs to one team's report. But an entity can genuinely sit in two teams' scopes — one objective two
 * teams both serve, one repository they share — and then the same id appears in both reports, correctly.
 *
 * On a per-team page that is right: each team is told about the work in its own scope. On the merged page
 * it would be the same sentence three times, spending a 400-word budget on repetition and leaving the
 * reader to work out that the three lines are one finding. So the highest-ranked occurrence survives and
 * the rest are dropped — the input is already sorted, so "first wins" is "highest-ranked wins", and the
 * team that keeps it is the deterministic one the sort chose.
 *
 * Not deduped by `(team, id)`, which would preserve the repetition. The unit here is the *condition*.
 */
function dedupeByCondition(ranked: readonly MergedReportItem[]): readonly MergedReportItem[] {
  const seen = new Set<string>();
  const kept: MergedReportItem[] = [];

  for (const item of ranked) {
    if (seen.has(item.stableId)) continue;
    seen.add(item.stableId);
    kept.push(item);
  }

  return kept;
}

/**
 * The merged items of one section, in ranked order.
 *
 * The merged report groups by the Six Spine when it renders, because the spine's geography is the one
 * a manager already knows — but *within* a section the order stays the action-impact order rather
 * than reverting to the per-team order.
 */
export const mergedItemsInSection = (report: MergedReport, sectionKey: SectionKey): readonly MergedReportItem[] =>
  report.items.filter((item) => item.sectionKey === sectionKey);

/** The sections that reached the merged page, in Six Spine order. Never a reordering. */
export const mergedSectionKeys = (report: MergedReport): readonly SectionKey[] =>
  SECTION_ORDER.filter((key) => report.items.some((item) => item.sectionKey === key));
