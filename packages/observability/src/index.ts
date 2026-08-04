/**
 * @compass/observability — structured logging and the error-reporter scrubber.
 *
 * Layer position: the bottom, beside `@compass/clock`. It depends on nothing, which is what lets
 * every layer above it emit a log line without inverting the dependency graph — and it is why `now`
 * is a parameter on every emitter rather than something this package reads.
 *
 * Two things live here and they share one list:
 *
 *  - **`log.ts`** — the closed set of structured events, each carrying organization, team and
 *    instant as *fields*. A log is a table, not prose.
 *  - **`scrub.ts`** — what an error reporter is allowed to be shown. Email addresses, credentials
 *    and raw ingested text are removed before an event leaves the process, and the raw-text field
 *    list is held to the narrator's by a test, so teaching the report payload about a new raw-text
 *    field is a build failure until the scrubber is taught too.
 *
 * The scrubber is shared with the logger deliberately: an interpolated error message is the
 * commonest way a token reaches a log line, so `detail` and every string extra go through the same
 * `scrubText` a Sentry event does.
 */
export {
  CREDENTIAL_HEADERS,
  RAW_TEXT_FIELD_NAMES,
  REDACTED,
  leaksIn,
  scrubEvent,
  scrubText,
  type ScrubbableEvent,
} from './scrub.js';

export {
  LEVEL_FOR_EVENT,
  LOG_EVENTS,
  RecordingSink,
  consoleSink,
  createConsoleSink,
  emit,
  logDeliveryFailure,
  logIngestCoverageGap,
  logNarrationFallback,
  logPipelineRun,
  logReadinessUnavailable,
  logRecord,
  startTimer,
  type ConsoleLike,
  type ElapsedMillis,
  type PerformanceLike,
  type LogEvent,
  type LogExtras,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from './log.js';
