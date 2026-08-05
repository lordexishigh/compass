/**
 * @compass/smoke — the cold-start acceptance criterion, as code.
 *
 * Layer position: none. This is a tool, not a layer; it depends on `analysis` for
 * the section order and on `pipeline` for the artifact link shape, and nothing
 * depends on it except `apps/web`'s cold-start test and CI.
 *
 * The reason it is a package rather than a shell script in a workflow file is that
 * its assertions have to be provable. `apps/web/tests/cold-start.test.tsx` renders
 * the real report page and runs `assertColdStartHtml` over the markup, so the
 * checks CI runs against a container are the same checks a green test suite has
 * already exercised against the page as built.
 */
export {
  ALIGNMENT_AFFORDANCE_ATTRIBUTE,
  ALIGNMENT_VERDICT_ATTRIBUTE,
  CHART_MARKERS,
  COLLAR_ATTRIBUTE,
  ColdStartCheckFailed,
  FALLBACK_NOTE_ATTRIBUTE,
  FALLBACK_NOTE_SENTENCE,
  NO_DEPLOY_SIGNAL_SENTENCE,
  REGRESSION_MARKERS,
  assertColdStartHtml,
  inspectReportHtml,
  sectionLandmark,
  type ReportHtmlInspection,
} from './report-html.js';

export {
  CONNECT_WALKTHROUGH,
  DISQUALIFYING_PHRASES,
  WALKTHROUGH_BUDGET_SECONDS,
  WalkthroughNotSelfServe,
  WalkthroughOverBudget,
  assertSelfServe,
  assertWithinBudget,
  describeWalkthrough,
  estimateWalkthrough,
  selfServeProblems,
  type StepActor,
  type StepKind,
  type WalkthroughEstimate,
  type WalkthroughStep,
} from './connect-walkthrough.js';

export {
  COLD_START_BUDGET_MILLIS,
  ProbeTimeout,
  probeUntilReady,
  type ProbeAttempt,
  type ProbeOptions,
  type ProbeResult,
} from './probe.js';

export {
  DEFAULT_SMOKE_URL,
  DeadSourceLinkError,
  SMOKE_BUDGET_ENV_VAR,
  SMOKE_URL_ENV_VAR,
  assertFirstSourceLinkResolves,
  parseSmokeArgs,
  runSmoke,
  type SmokeOptions,
} from './smoke-run.js';
