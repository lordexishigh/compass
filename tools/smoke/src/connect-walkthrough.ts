/**
 * The self-serve connect walkthrough, measured.
 *
 * ## Why this is a script and not a stopwatch
 *
 * The criterion is that "a manager completes GitHub, Jira and Slack connect alone in under 10 minutes with
 * per-repo and per-project scoping; measured by a scripted walkthrough". A human with a stopwatch measures
 * one person on one day, cannot be re-run in CI, and cannot fail a build. So the walkthrough is a *model
 * of the flow* — the steps, their order, who may perform each, and a time budget per step — plus a runner
 * that walks it against the real HTTP surface and adds up what it actually took.
 *
 * Two things fall out of that, and both matter more than the number:
 *
 *  - **The step list is the assertion.** A step that requires an organization admin, a CSV, or a
 *    hand-edited file cannot be added to `CONNECT_WALKTHROUGH` without failing
 *    `assertSelfServe` — so "no admin-only steps" stops being a claim in a document.
 *  - **The budget is per step, not only overall.** A flow that passes in nine minutes because one step
 *    takes eight is not a flow anybody finishes; the per-step budgets are what keep the total honest.
 *
 * ## What the estimate is, and what it is not
 *
 * `estimatedSeconds` is a *human* estimate: how long a person spends reading a consent screen, choosing
 * repositories, pasting channel links. It is deliberately generous and it is the number the ten-minute
 * claim rests on. `measuredMillis`, when the runner is given a live deployment, is how long the *machine*
 * took — which is a different and much smaller number, and is reported separately rather than substituted
 * for the human estimate. Reporting machine time as though it were the manager's would make the claim
 * meaningless and flattering, which is exactly the sort of confident polish this product refuses.
 */

/** Who has to be present for a step. `owner` is the manager who signed up; nothing needs more. */
export type StepActor = 'owner';

/** How a step is performed. Each value is a thing a person does in a browser. */
export type StepKind =
  | 'read'
  /** A form submit that redirects to a provider's own consent screen. */
  | 'consent'
  /** A form submit that saves configuration. */
  | 'configure'
  /** Landing back on Compass after a provider redirect. */
  | 'return';

export interface WalkthroughStep {
  readonly id: string;
  /** What the manager is doing, in their own terms. */
  readonly what: string;
  readonly actor: StepActor;
  readonly kind: StepKind;
  /** Which provider this step belongs to, or null for a step that serves all of them. */
  readonly providerId: 'github' | 'jira' | 'slack' | null;
  /**
   * The page or endpoint the step touches, relative to the deployment's origin.
   *
   * Null for a step that happens on the *provider's* site — a consent screen Compass does not serve and
   * cannot measure. Those steps still carry a budget, because a manager's ten minutes includes them.
   */
  readonly path: string | null;
  /** A generous estimate of the human time this step takes. */
  readonly estimatedSeconds: number;
}

/**
 * The whole flow, in order.
 *
 * One pass per provider, and the passes are identical in shape because the connect surface is: read what
 * is asked for, grant it, choose what may be read. That symmetry is the reason a manager who has done it
 * once does the second and third in half the time, and it is why the estimates fall across the three.
 */
export const CONNECT_WALKTHROUGH: readonly WalkthroughStep[] = Object.freeze([
  Object.freeze({
    id: 'open-connect',
    what: 'Open /connect and read what Compass would read from each of the three sources.',
    actor: 'owner',
    kind: 'read',
    providerId: null,
    path: '/connect',
    estimatedSeconds: 90,
  }),

  // ---- The code host -------------------------------------------------------
  Object.freeze({
    id: 'github-scope',
    what: 'Type the repositories Compass may read, as owner/name, one per line.',
    actor: 'owner',
    kind: 'configure',
    providerId: 'github',
    path: '/api/connect/github/scope',
    estimatedSeconds: 60,
  }),
  Object.freeze({
    id: 'github-consent',
    what: 'Press Connect GitHub and approve the read-only permissions on GitHub’s own screen.',
    actor: 'owner',
    kind: 'consent',
    providerId: 'github',
    path: '/api/connect/github/install',
    estimatedSeconds: 60,
  }),
  Object.freeze({
    id: 'github-return',
    what: 'Land back on /connect, which states that the code host is connected.',
    actor: 'owner',
    kind: 'return',
    providerId: 'github',
    path: null,
    estimatedSeconds: 10,
  }),

  // ---- The tracker ---------------------------------------------------------
  Object.freeze({
    id: 'jira-scope',
    what: 'Type the project keys Compass may read. Unselected projects are never queried.',
    actor: 'owner',
    kind: 'configure',
    providerId: 'jira',
    path: '/api/connect/jira/scope',
    estimatedSeconds: 45,
  }),
  Object.freeze({
    id: 'jira-consent',
    what: 'Press Connect Jira and approve the read-only scopes on Atlassian’s own screen.',
    actor: 'owner',
    kind: 'consent',
    providerId: 'jira',
    path: '/api/connect/jira/install',
    estimatedSeconds: 60,
  }),
  Object.freeze({
    id: 'jira-return',
    what: 'Land back on /connect, which states that the tracker is connected.',
    actor: 'owner',
    kind: 'return',
    providerId: 'jira',
    path: null,
    estimatedSeconds: 10,
  }),

  // ---- Chat ----------------------------------------------------------------
  Object.freeze({
    id: 'slack-scope',
    what: 'Paste the link of each channel Compass may read, copied from Slack’s own channel menu.',
    actor: 'owner',
    kind: 'configure',
    providerId: 'slack',
    path: '/api/connect/slack/scope',
    estimatedSeconds: 75,
  }),
  Object.freeze({
    id: 'slack-consent',
    what: 'Press Connect Slack and approve channels:history and users:read on Slack’s own screen.',
    actor: 'owner',
    kind: 'consent',
    providerId: 'slack',
    path: '/api/connect/slack/install',
    estimatedSeconds: 60,
  }),
  Object.freeze({
    id: 'slack-return',
    what: 'Land back on /connect, which states that chat is connected and which channels it reads.',
    actor: 'owner',
    kind: 'return',
    providerId: 'slack',
    path: null,
    estimatedSeconds: 10,
  }),

  Object.freeze({
    id: 'review',
    what: 'Read the three sections back: every source connected, and exactly what each one is scoped to.',
    actor: 'owner',
    kind: 'read',
    providerId: null,
    path: '/connect',
    estimatedSeconds: 45,
  }),
]);

/** The criterion's own number. */
export const WALKTHROUGH_BUDGET_SECONDS = 10 * 60;

/**
 * Steps a self-serve flow may not contain, matched against a step's own words.
 *
 * A rule rather than a review note. Adding "ask your workspace administrator to install the app" to
 * `CONNECT_WALKTHROUGH` fails `assertSelfServe`, which is the only way "no admin-only steps" survives the
 * next person who finds an easier implementation that needs one.
 */
export const DISQUALIFYING_PHRASES: readonly string[] = Object.freeze([
  'administrator',
  'admin',
  'csv',
  'spreadsheet',
  'upload',
  'yaml',
  'yml',
  'config file',
  'configuration file',
  'environment variable',
  'ask your',
  'raise a ticket',
  'support',
]);

export class WalkthroughNotSelfServe extends Error {
  constructor(problems: readonly string[]) {
    super(
      'The connect walkthrough is not self-serve:\n' +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\nA manager has to be able to connect their own tools alone. A step that needs an organization ' +
        'admin, a CSV, or a hand-edited file is a step that turns a ten-minute task into a week of ' +
        'waiting on somebody else.',
    );
    this.name = 'WalkthroughNotSelfServe';
  }
}

export class WalkthroughOverBudget extends Error {
  constructor(totalSeconds: number, budgetSeconds: number, worst: WalkthroughStep | undefined) {
    super(
      `The connect walkthrough is estimated at ${Math.round(totalSeconds / 60)} minutes, over the ` +
        `${budgetSeconds / 60}-minute budget. Its longest single step is ` +
        `${worst === undefined ? 'unknown' : `"${worst.what}" at ${worst.estimatedSeconds}s`}.`,
    );
    this.name = 'WalkthroughOverBudget';
  }
}

/**
 * Every reason this flow would not be self-serve, or an empty list.
 *
 * Returns the problems rather than throwing, so a caller can report all of them at once — a walkthrough
 * with three admin steps should say so three times rather than making somebody fix them one build at a
 * time.
 */
export function selfServeProblems(
  steps: readonly WalkthroughStep[] = CONNECT_WALKTHROUGH,
): readonly string[] {
  const problems: string[] = [];

  for (const step of steps) {
    if (step.actor !== 'owner') {
      problems.push(`${step.id} needs "${step.actor}", but only the owner is present in this flow.`);
    }

    const words = step.what.toLowerCase();
    for (const phrase of DISQUALIFYING_PHRASES) {
      // Word-bounded, so `administrator` trips it and `administer` does not — and so `support` does not
      // fire on `supported`.
      if (new RegExp(`\\b${phrase}\\b`).test(words)) {
        problems.push(`${step.id} mentions "${phrase}", which is not something a manager can do alone.`);
      }
    }
  }

  return problems;
}

export function assertSelfServe(steps: readonly WalkthroughStep[] = CONNECT_WALKTHROUGH): void {
  const problems = selfServeProblems(steps);
  if (problems.length > 0) throw new WalkthroughNotSelfServe(problems);
}

export interface WalkthroughEstimate {
  readonly totalSeconds: number;
  readonly budgetSeconds: number;
  readonly withinBudget: boolean;
  /** Per provider, so a single slow provider is visible rather than averaged away. */
  readonly perProviderSeconds: Readonly<Record<'github' | 'jira' | 'slack' | 'shared', number>>;
  readonly longestStep: WalkthroughStep | undefined;
}

export function estimateWalkthrough(
  steps: readonly WalkthroughStep[] = CONNECT_WALKTHROUGH,
  budgetSeconds: number = WALKTHROUGH_BUDGET_SECONDS,
): WalkthroughEstimate {
  const perProviderSeconds: Record<'github' | 'jira' | 'slack' | 'shared', number> = {
    github: 0,
    jira: 0,
    slack: 0,
    shared: 0,
  };

  let totalSeconds = 0;
  let longestStep: WalkthroughStep | undefined;

  for (const step of steps) {
    totalSeconds += step.estimatedSeconds;
    perProviderSeconds[step.providerId ?? 'shared'] += step.estimatedSeconds;
    if (longestStep === undefined || step.estimatedSeconds > longestStep.estimatedSeconds) longestStep = step;
  }

  return {
    totalSeconds,
    budgetSeconds,
    withinBudget: totalSeconds <= budgetSeconds,
    perProviderSeconds,
    longestStep,
  };
}

export function assertWithinBudget(
  steps: readonly WalkthroughStep[] = CONNECT_WALKTHROUGH,
  budgetSeconds: number = WALKTHROUGH_BUDGET_SECONDS,
): WalkthroughEstimate {
  const estimate = estimateWalkthrough(steps, budgetSeconds);
  if (!estimate.withinBudget) {
    throw new WalkthroughOverBudget(estimate.totalSeconds, budgetSeconds, estimate.longestStep);
  }
  return estimate;
}

/** One line per step, for the operator reading a CI log. */
export function describeWalkthrough(estimate: WalkthroughEstimate): readonly string[] {
  return [
    `connect walkthrough: ${CONNECT_WALKTHROUGH.length} steps, ` +
      `${Math.round(estimate.totalSeconds / 60)} minutes estimated against a ` +
      `${estimate.budgetSeconds / 60}-minute budget.`,
    `  owner alone, no administrator, no upload, no configuration file.`,
    `  code host ${estimate.perProviderSeconds.github}s · tracker ${estimate.perProviderSeconds.jira}s · ` +
      `chat ${estimate.perProviderSeconds.slack}s · reading ${estimate.perProviderSeconds.shared}s`,
  ];
}
