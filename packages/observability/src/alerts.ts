import { LEVEL_FOR_EVENT, type LogEvent, type LogRecord } from './log.js';

/**
 * Alert rules over the structured log.
 *
 * ## Why the rules live here and not in a hosted query
 *
 * A threshold written in a monitoring vendor's UI is a threshold nobody can review, test, or diff. The
 * four conditions the launch criteria name are properties of Compass, not of whoever is hosting the
 * logs this month, so they are evaluated by a pure function over `LogRecord`s and asserted in
 * `tests/alerts.test.ts`. Exporting the same rules is what lets a hosted alert be *generated* from
 * them rather than re-typed beside them.
 *
 * ## Pure, and time is a parameter
 *
 * `evaluate` takes `now` and the records. It reads no clock — the same rule the whole repository
 * follows, and the reason a rolling-window assertion can be written at all: a test picks the window
 * boundary instead of waiting a day for it.
 *
 * ## What an alert is allowed to say
 *
 * Every alert names the affected organizations. That is the criterion's own wording for the fallback
 * rule and it is the right shape for all four: "narration is degrading" is not actionable, "narration
 * is degrading for these two organizations" is. Team and instant travel too where the event carries
 * them, so the page says who, where and when without a second query.
 */

/** The closed set of alert rules. A fifth is a compile error until it is declared. */
export const ALERT_RULES = [
  /** Narration fell back for more than the published share of a window's reports. */
  'narration.fallback_rate',
  /** A generation attempt produced no report. */
  'pipeline.generation_failure',
  /** A scheduled delivery did not arrive. */
  'delivery.failure',
  /** A configured source did not cover the window it was asked for. */
  'ingest.coverage_gap',
] as const;

export type AlertRule = (typeof ALERT_RULES)[number];

/**
 * `warning` pages nobody and shows on a dashboard; `critical` is worth an interruption.
 *
 * Deliberately coarser than the log's three levels. A log level describes one line; a severity
 * describes what a human should do about a *condition*, and collapsing an hour of `error` lines into
 * one critical alert is the whole job of this module.
 */
export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  readonly rule: AlertRule;
  readonly severity: AlertSeverity;
  /** One sentence, in the product's voice, that names the condition and its size. */
  readonly summary: string;
  /** Every organization the window's evidence implicates, sorted, deduplicated. */
  readonly organizationIds: readonly string[];
  /** Teams where the events carried one. Empty for organization-wide conditions. */
  readonly teamKeys: readonly string[];
  /** The newest instant among the events that triggered this alert. Epoch millis. */
  readonly at: number;
  /** How many events in the window matched. */
  readonly count: number;
}

/** 24 hours in milliseconds. The rolling window the fallback-rate criterion names. */
export const ROLLING_WINDOW_MILLIS = 24 * 60 * 60 * 1000;

export interface AlertInput {
  /** Every record to consider. Filtered to the window by `evaluateAlerts`, not by the caller. */
  readonly records: readonly LogRecord[];
  /** The evaluation instant, in epoch millis. Never read from a clock in here. */
  readonly now: number;
  /** Overridable so a test can narrow the window; defaults to the documented 24 hours. */
  readonly windowMillis?: number;
  /**
   * The share of a window's reports that may fall back before this alerts.
   *
   * Injected rather than imported so this package keeps depending on nothing —
   * `@compass/analysis` owns `NARRATION_FALLBACK_ALERT_RATE` and is a *higher* layer, so importing it
   * here would invert the graph. The caller passes the published constant, and
   * `tests/alerts.test.ts` asserts the two agree.
   */
  readonly fallbackRate: number;
}

const uniqueSorted = (values: readonly (string | null)[]): readonly string[] =>
  [...new Set(values.filter((value): value is string => value !== null && value.length > 0))].sort();

/**
 * The newest instant among the events, or the fallback when there are none.
 *
 * Seeded with the first record rather than with `now`, which is the whole point: every event is in the
 * past, so seeding the reduce with `now` made `Math.max` return `now` every time and the alert claimed
 * to have happened at evaluation time. An alert that timestamps itself instead of its evidence cannot
 * be correlated with the report it is about.
 */
const newestAt = (records: readonly LogRecord[], fallback: number): number =>
  records.length === 0
    ? fallback
    : records.reduce((latest, record) => Math.max(latest, record.at), records[0]!.at);

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * The records inside the rolling window, for one event.
 *
 * Half-open on the older edge and inclusive of `now`: a record stamped exactly `now - window` has
 * aged out, and one stamped exactly `now` has just happened. Records from the future are kept rather
 * than dropped — a clock skew between two processes is not a reason to stop alerting, and silently
 * discarding the newest evidence is the worst possible response to it.
 */
const inWindow = (input: AlertInput, event: LogEvent): readonly LogRecord[] => {
  const windowMillis = input.windowMillis ?? ROLLING_WINDOW_MILLIS;
  const from = input.now - windowMillis;
  return input.records.filter((record) => record.event === event && record.at > from);
};

/**
 * The narration-fallback rate rule.
 *
 * The denominator is `pipeline.run` — reports actually generated in the window — and the numerator is
 * `narration.fallback`. Both come from the same emitter in `packages/pipeline`, so they cannot
 * disagree about what a report is.
 *
 * A window with no runs is **not** an alert. That is the same reasoning
 * `narrationFallbackAlert` encodes for the zero case: no reports generated is a different condition
 * (the scheduler did not run) with its own rule, and `0/0` folded into this one would page whoever is
 * on call about narration when narration was never reached.
 */
function fallbackRateAlert(input: AlertInput): Alert | null {
  const runs = inWindow(input, 'pipeline.run');
  const fallbacks = inWindow(input, 'narration.fallback');

  if (runs.length === 0 || fallbacks.length === 0) return null;

  const rate = fallbacks.length / runs.length;
  // Strictly greater, matching `narrationFallbackAlert`: the published rate is the ceiling.
  if (rate <= input.fallbackRate) return null;

  const organizationIds = uniqueSorted(fallbacks.map((record) => record.organizationId));
  const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`;

  return {
    rule: 'narration.fallback_rate',
    severity: 'critical',
    summary:
      `Narration fell back for ${fallbacks.length} of ${plural(runs.length, 'report')} in the last ` +
      `${Math.round((input.windowMillis ?? ROLLING_WINDOW_MILLIS) / 3_600_000)}h — ${percentage(rate)} against a ` +
      `published ceiling of ${percentage(input.fallbackRate)}. ` +
      // The masking this number exists for, restated where somebody woken at 2am will read it.
      'Every report still rendered, so this is invisible in the product: check the prompt, the payload ' +
      `schema and the grounding rules. Affected: ${organizationIds.join(', ')}.`,
    organizationIds,
    teamKeys: uniqueSorted(fallbacks.map((record) => record.teamKey)),
    at: newestAt(fallbacks, input.now),
    count: fallbacks.length,
  };
}

/**
 * One alert per condition rather than one per event.
 *
 * A rule that emitted an alert per failing delivery would page somebody twelve times for one Resend
 * outage. The events are collapsed into a single alert that carries the count and every organization
 * implicated, which is the difference between a monitor and a pager that gets muted.
 */
function countAlert(
  input: AlertInput,
  event: LogEvent,
  rule: AlertRule,
  describe: (records: readonly LogRecord[], organizationIds: readonly string[]) => string,
): Alert | null {
  const records = inWindow(input, event);
  if (records.length === 0) return null;

  const organizationIds = uniqueSorted(records.map((record) => record.organizationId));

  return {
    rule,
    // Severity follows the log's own level table rather than a second opinion declared here, so an
    // event reclassified in `log.ts` cannot keep a stale severity in this module.
    severity: LEVEL_FOR_EVENT[event] === 'error' ? 'critical' : 'warning',
    summary: describe(records, organizationIds),
    organizationIds,
    teamKeys: uniqueSorted(records.map((record) => record.teamKey)),
    at: newestAt(records, input.now),
    count: records.length,
  };
}

/**
 * Every alert firing at `now`, most severe first.
 *
 * Returns an empty array for a healthy window — an explicit "nothing is wrong" rather than a null, so
 * a caller renders a list either way and no branch is needed for the ordinary case.
 */
export function evaluateAlerts(input: AlertInput): readonly Alert[] {
  const alerts = [
    fallbackRateAlert(input),
    countAlert(input, 'pipeline.failure', 'pipeline.generation_failure', (records, organizationIds) => {
      const finalAttempts = records.filter(
        (record) => Number(record.extras['attempt']) >= Number(record.extras['retryLimit']),
      ).length;

      return (
        `${plural(records.length, 'report generation')} failed. ` +
        // The distinction that decides whether this needs anybody tonight: pg-boss retries, so a
        // first-attempt failure often heals itself and an exhausted one never will.
        (finalAttempts > 0
          ? `${finalAttempts} exhausted every retry, so those reports do not exist and will not appear on their own. `
          : 'All of them have retries remaining. ') +
        `Affected: ${organizationIds.join(', ')}.`
      );
    }),
    countAlert(input, 'delivery.failure', 'delivery.failure', (records, organizationIds) => {
      const channels = uniqueSorted(records.map((record) => String(record.extras['channel'] ?? '')));
      return (
        `${plural(records.length, 'scheduled delivery', 'scheduled deliveries')} failed ` +
        `${channels.length > 0 ? `over ${channels.join(' and ')}` : 'to send'}. ` +
        'The report is still readable in Compass; what failed is the copy that goes to the reader. ' +
        `Affected: ${organizationIds.join(', ')}.`
      );
    }),
    countAlert(input, 'ingest.coverage_gap', 'ingest.coverage_gap', (records, organizationIds) => {
      const sources = uniqueSorted(records.map((record) => String(record.extras['sourceKey'] ?? '')));
      return (
        `${plural(sources.length, 'configured source')} did not cover the window ` +
        `(${sources.join(', ')}) across ${plural(records.length, 'run')}. ` +
        // Stated so the person reading knows the product is already telling the truth about this and
        // the alert is the operational half, not the user-facing one.
        'Those reports state their own incompleteness in the freshness panel, so no reader has been ' +
        `misled — but the data is still missing. Affected: ${organizationIds.join(', ')}.`
      );
    }),
  ].filter((alert): alert is Alert => alert !== null);

  // Critical before warning, then newest first, so the top of the list is what to look at.
  const rank: Readonly<Record<AlertSeverity, number>> = { critical: 0, warning: 1 };
  return [...alerts].sort((left, right) =>
    rank[left.severity] !== rank[right.severity] ? rank[left.severity] - rank[right.severity] : right.at - left.at,
  );
}
