/**
 * The closed feedback vocabulary, and the two numbers that govern it.
 *
 * ## Why this is its own module
 *
 * A leaf. It imports nothing, and that is the whole reason it exists: the report contract in
 * `structured-report.ts` has to name a feedback action — a suppressed item records which verdict
 * removed it — while `feedback.ts` has to name `ReportItem` and `ReportSection`. Those two facts
 * together are a cycle, and `.dependency-cruiser.cjs` refuses cycles even where TypeScript would
 * erase them. Splitting the *vocabulary* out breaks it honestly rather than by exemption: the
 * closed set of verdicts is a smaller idea than either the report or the suppression pass, and both
 * of them depend on it.
 *
 * ## The two numbers
 *
 * `MATERIAL_WORSENING_DELTA` and `DEFAULT_SNOOZE_DAYS` live here rather than beside the logic that
 * applies them, for the same reason: `docs/DESIGN.md` states them, the corrections screen prints
 * them and the analysis core enforces them, and a constant three layers can see is a constant that
 * cannot be changed in one place only.
 */

export const FEEDBACK_ACTIONS = [
  'dismiss_risk',
  'off_goal_flag_wrong',
  'accept_recommendation',
  'reject_recommendation',
  'blocker_already_resolved',
  'explain_unattributed',
  'snooze',
] as const;

export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

export const isFeedbackAction = (value: string): value is FeedbackAction =>
  (FEEDBACK_ACTIONS as readonly string[]).includes(value);

/**
 * Actions that state a fact rather than schedule one — they never expire on their own.
 *
 * Named as a list so the corrections screen can say "these are permanent" without re-deriving the
 * rule from six switch arms.
 */
export const TERMINAL_FEEDBACK_ACTIONS: readonly FeedbackAction[] = Object.freeze([
  'reject_recommendation',
  'off_goal_flag_wrong',
  // An answer does not expire, but it also does not travel: the unattributed question is keyed on
  // the commits it is about, so "permanent" here means "for these commits". A different set next
  // week is a different cause and asks again. See `unattributedRefId` in `alignment.ts`.
  'explain_unattributed',
]);

/**
 * The documented material-worsening threshold: **100 severity points**.
 *
 * A dismissed risk stays dismissed indefinitely. It returns only when its severity score has risen
 * by at least this much since the moment of dismissal, and when it returns it carries a sentence
 * naming what worsened and by how much.
 *
 * A risk's severity score is `band + excess`, where the band is `low 100 / medium 200 / high 300`
 * and the excess is how far past its own threshold the measurement sits, as a percentage capped at
 * 99 (`riskSeverityScore` in `risks.ts`). So 100 points is exactly **one whole severity band**, or
 * an equivalent doubling of the measurement against the threshold that made it a risk at all.
 *
 * That is the smallest change a manager could not reasonably have anticipated when they dismissed
 * it: a review queue one day over T5 that is now two days over is the same finding, and telling
 * them again would be the nagging this rule exists to prevent; a queue that has gone from medium to
 * high is a different fact about their sprint.
 *
 * `docs/DESIGN.md` states the same number, and `tests/feedback.test.ts` imports this constant
 * rather than restating it, so the threshold cannot be changed in one place only.
 */
export const MATERIAL_WORSENING_DELTA = 100;

/** The default snooze, in days. What the one-click "Snooze" button means. */
export const DEFAULT_SNOOZE_DAYS = 7;

/**
 * The cause kind of the off-goal flag.
 *
 * `alignment.ts` calls the finding `off_goal`, the acceptance criteria call it "the off-goal flag",
 * and the manager's verdict on it is `off_goal_flag_wrong`. One term throughout, and the cause kind
 * it matches is the one `alignment.ts` actually emits — a mismatch here would make a correction
 * silently suppress nothing.
 */
export const OFF_GOAL_CAUSE_KIND = 'off_goal';

/** The cause kind of the unattributed-work question. Not a verdict, so not correctable. */
export const UNATTRIBUTED_CAUSE_KIND = 'unattributed';
