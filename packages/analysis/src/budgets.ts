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
