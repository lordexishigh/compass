/**
 * Prose budgets — the numbers that keep a report readable, in one place.
 *
 * ## Why a budget is a constant and not a guideline
 *
 * The merged report is the two-to-three-team manager's actual daily read, and it is the one surface
 * where the product's central risk is *length*. Three teams' worth of findings concatenated is not a
 * daily; it is three dailies, and a manager who has to skim it will stop reading it inside a week.
 * So the limit is a hard number enforced in code, not an intention stated in a design document.
 *
 * ## Why the number lives here rather than in the doc
 *
 * `docs/budgets.md` explains the reasoning; this module holds the value, and
 * `tools/quality-gates/tests/budgets.test.ts` fails if the doc stops quoting the same figure. That
 * arrangement is deliberate: a number written in prose beside a number written in code is two
 * sources of truth, and the one that drifts is always the prose. The enforcer and its test both
 * import from here, so neither can pass against a stale copy.
 *
 * ## Where it is enforced
 *
 * After rendering, never on the structured payload. A word budget is a fact about the sentences a
 * manager reads, and the payload carries no sentences — it carries the items the renderer will turn
 * into some number of words. `assertWithinWordBudget` therefore runs in `@compass/renderers`, over
 * the rendered string, on every path that can produce one.
 */

/**
 * The merged cross-team report's hard ceiling: **400 words**.
 *
 * Chosen against what the read actually is. At an unhurried 200 words a minute, 400 words is two
 * minutes — the length of a coffee queue, which is where this is read. It is also about the point at
 * which a single measure stops fitting one thumb-scroll on a phone, and the merged report's whole
 * job is to be the thing a manager of three teams reads *instead of* three reports, not as well as
 * them. Anything that does not fit is not cut: it stays in the per-team report the merged item links
 * down into, and the merged prose says how many were left there.
 */
export const MERGED_REPORT_WORD_BUDGET = 400;

/**
 * What ninety seconds of reading is, in words: **450**.
 *
 * ## Two numbers about the daily, and why they are both real
 *
 * `DAILY_REPORT_WORD_BUDGET` below is **900**, and it is a *fail-closed ceiling*: the point at which
 * a narrated report is discarded in favour of the deterministic renderer. This is a different
 * quantity with a different job — the length the daily is *designed* to be, asserted over the
 * reference dataset rather than thrown at a manager at 06:00.
 *
 * Collapsing them into one number would lose something either way round. At 450 as a hard ceiling,
 * a legitimately busy day for a three-project team fails closed and the manager gets a templated
 * report for no reason. At 900 as the design target, the seeded corpus could double in length before
 * anything complained — and "the report got gradually longer" is exactly the regression nobody
 * notices in review, because no single change causes it.
 *
 * So: 900 is what Compass refuses to send. 450 is what Compass is trying to write, checked against
 * the seeded dataset on every CI run by `tools/quality-gates/tests/budgets.test.ts`.
 *
 * ## Why 450
 *
 * The read is ninety seconds — the walk from a desk to a standup, which is when this is read. At the
 * unhurried 200 words a minute the merged budget is set against, ninety seconds is 300 words; 450 is
 * that with the headroom a per-team report legitimately needs, because unlike the merged digest it
 * carries the evidence chain a manager acts on. `docs/budgets.md` states this number and the gate
 * fails if the two stop agreeing.
 */
export const DAILY_REPORT_READING_BUDGET = 450;

/**
 * The daily's fail-closed ceiling: **900 words**.
 *
 * The other half of the pair the constant above describes. 450 is what Compass is *trying* to write;
 * this is what Compass refuses to *send*. A narrated report longer than this is discarded and the
 * deterministic render goes out in its place, marked as a fallback — the same treatment a grounding
 * failure gets, for the same reason: a complete templated report beats a well-written one nobody
 * finishes.
 *
 * ## Why it is checked on the narration path and nowhere else
 *
 * Because narration is the only path that can run long. This was first tried inside `renderReport`,
 * over the templated prose, and that was wrong in a way worth recording: the seeded dataset's daily
 * renders about **1,750** words, so the check fired on the deterministic renderer — the thing that
 * *is* the fallback. There was nothing left to fall back to, and every worker suite went red at once.
 *
 * The template renderer's length is a structural fact (`MAX_SENTENCES_PER_ITEM` times a bounded item
 * count) and is left to `DAILY_REPORT_READING_BUDGET`'s assertion over the reference dataset, which
 * reports a regression to a build rather than to a manager at 06:00. A model, by contrast, is asked
 * for six sections and has no notion of a global ceiling.
 *
 * 900 is twice the reading budget: enough headroom that a genuinely busy three-project day is never
 * refused, low enough that a model which has started enumerating rather than summarising is caught.
 */
export const DAILY_REPORT_WORD_BUDGET = 900;

/**
 * The narration-fallback alert rate: **0.02**.
 *
 * The share of generated reports, over a rolling 24-hour window, that may fall back to the
 * deterministic renderer before the condition stops being noise and becomes an incident.
 *
 * That masking is the whole reason there is a number here. Fail-closed narration degrades so
 * gracefully that a total narration outage looks, from the outside, like a product that has quietly
 * decided to be templated. The rate is what turns "everything still renders" into an alert.
 *
 * A rate rather than a count, because a deployment with three teams and one with thirty should not
 * need different thresholds; and evaluated over a window rather than per report, because a single
 * fallback is an expected event that must never page anybody.
 *
 * ## Why 0.02 and not the 0.20 this constant used to hold
 *
 * 0.20 was the wrong number for an *alert*, and it was inconsistent with the plan of record.
 * `docs/PLAN.md` and the launch monitoring criteria both specify 2%; only this constant and the
 * `docs/budgets.md` section quoting it said 20%, and the criterion citing "the rate documented in
 * docs/budgets.md" was therefore citing a number the plan never agreed to.
 *
 * The old prose argued that above one report in five "the likely cause is a prompt or a grounding
 * rule that has broken for every report". That is true and it is an argument about when narration is
 * *certainly* broken, not about when to wake somebody. One report in five silently templated is
 * already a severe, days-old incident by the time it trips a 20% threshold — with three teams that
 * is a single bad report per day sitting under the alarm indefinitely. 2% is the threshold that
 * catches a systemic prompt or schema break while a single unlucky report still does not page
 * anybody, which is exactly the pair of properties the number has to have.
 */
export const NARRATION_FALLBACK_ALERT_RATE = 0.02;

/**
 * Whether a day's fallback share has crossed the alert threshold.
 *
 * Pure, and takes both counts rather than a pre-divided rate, so the zero-report case is decided here
 * instead of producing `NaN` at a call site. No reports generated is not an alert: it is a different
 * condition — the scheduler did not run — with its own signal.
 */
export function narrationFallbackAlert(input: {
  readonly reportsGenerated: number;
  readonly reportsFellBack: number;
}): { readonly rate: number; readonly alerting: boolean } {
  if (input.reportsGenerated <= 0) return { rate: 0, alerting: false };

  const rate = input.reportsFellBack / input.reportsGenerated;
  // Strictly greater, because the criterion says fallbacks must *exceed* the rate: the published
  // number is the documented ceiling, not the first failure above zero.
  return { rate, alerting: rate > NARRATION_FALLBACK_ALERT_RATE };
}

/**
 * Words in a rendered string, counted the way a reader would count them.
 *
 * Whitespace-separated tokens, with no exclusions. That is a deliberate refusal to be clever: any
 * rule that discounted numerals, section headings or mono tokens would make the enforced budget
 * larger than the budget a manager experiences, which is the only budget that matters. `01`,
 * `PLAT-742` and `#9201` are each a word on the page, so each is a word here.
 *
 * Deterministic and locale-independent — `\s+` over a trimmed string, never a word-boundary regex
 * whose behaviour varies with the unicode tables of the host.
 */
export function countWords(prose: string): number {
  const trimmed = prose.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export class WordBudgetExceededError extends Error {
  readonly budget: number;
  readonly counted: number;
  readonly detail: string;

  constructor(label: string, counted: number, budget: number) {
    const detail =
      `The ${label} rendered ${counted} words against a hard budget of ${budget}. The budget is not advisory: a ` +
      'merged report that grows without limit is three dailies rather than one, and a manager who has to skim it ' +
      'stops reading it. Items that do not fit belong in the per-team report the merged item links down into.';
    super(detail);
    this.name = 'WordBudgetExceededError';
    this.budget = budget;
    this.counted = counted;
    this.detail = detail;
  }
}

/**
 * Fails closed when rendered prose exceeds its budget.
 *
 * Throwing rather than truncating, and that is the important half. Truncating at the limit would
 * emit a report ending mid-sentence — a silently damaged document that reads as a bug in Compass —
 * whereas a thrown error is a build or a generation failure somebody fixes. The trimming decision
 * belongs upstream, where the *ranking* is known and the least useful item can be the one dropped;
 * by the time there is a string, every remaining choice is a bad one.
 */
export function assertWithinWordBudget(prose: string, budget: number, label: string): void {
  const counted = countWords(prose);
  if (counted > budget) throw new WordBudgetExceededError(label, counted, budget);
}
