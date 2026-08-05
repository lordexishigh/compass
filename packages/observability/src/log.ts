import { scrubText } from './scrub.js';

/**
 * Structured logging: one line per event, fields rather than sentences.
 *
 * ## Why fields and not an interpolated string
 *
 * `[compass] ingest degraded for 0a1b… : primary-code unavailable` is readable by one person once.
 * It is not queryable, so "which organizations had a coverage gap this week" cannot be asked, and
 * the organization id is glued to prose that a later edit will reword. Every emitter here takes the
 * organization, the team where there is one, and the instant as *fields*, so the log is a table.
 *
 * ## The four events the criterion names
 *
 * `pipeline.run`, `narration.fallback`, `ingest.coverage_gap` and `delivery.failure`. They are a
 * closed union rather than a free string, so a fifth event is a compile error until it is declared
 * here — which is what stops the log growing a vocabulary nobody has written a query for.
 *
 * ## Why `now` is a parameter
 *
 * Because everything in Compass is. This package is not on the clock-guarded list only because it
 * is new; the rule is the same, and an emitter that read `Date.now()` would make the tests below
 * assert against wall-clock time. The *log* timestamp is the instant the caller was working at,
 * which is the one that lines up with the report it produced.
 */

/** The closed set of structured events. A fifth is a compile error until it is declared. */
export const LOG_EVENTS = [
  /** One pipeline run finished: which scope, how long, which renderer answered. */
  'pipeline.run',
  /**
   * A generation attempt failed and produced no report.
   *
   * Distinct from `pipeline.run`, which is only emitted once a report has been persisted. A run that
   * throws never reaches that emitter, so without this event the *failure* case was the one condition
   * the log could not describe — it existed only as an interpolated sentence in the worker's stderr,
   * which cannot be grouped by organization or counted over a window.
   */
  'pipeline.failure',
  /** Narration was attempted and the template renderer answered instead. */
  'narration.fallback',
  /** A source did not cover the window it was asked for. */
  'ingest.coverage_gap',
  /** A scheduled delivery did not arrive. */
  'delivery.failure',
  /** Compass could not read its own records while answering a request. */
  'readiness.unavailable',
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];

export type LogLevel = 'info' | 'warn' | 'error';

/** Which level each event is emitted at, so the choice is one table rather than per call site. */
export const LEVEL_FOR_EVENT: Readonly<Record<LogEvent, LogLevel>> = {
  'pipeline.run': 'info',
  // A report that does not exist is the product failing to appear, not a degradation of it.
  'pipeline.failure': 'error',
  // A fallback is a *degradation*, not a failure: the reader still gets six complete sections.
  'narration.fallback': 'warn',
  'ingest.coverage_gap': 'warn',
  'delivery.failure': 'error',
  'readiness.unavailable': 'error',
};

/**
 * The fields every event carries.
 *
 * `organizationId` is required because Compass is multi-tenant and a log line that does not say
 * whose it is cannot answer any question worth asking. `teamKey` is nullable and the nullability is
 * meaningful: a merged report and an organization-wide ingest genuinely have no team, and `null`
 * says so where an empty string would read as a team called nothing.
 */
export interface LogFields {
  readonly organizationId: string;
  readonly teamKey: string | null;
  /** Epoch milliseconds — the caller's own instant, never a clock read in here. */
  readonly at: number;
  /** One sentence for a human reading the stream. Never the place a field belongs. */
  readonly detail: string;
}

/** Anything else, flattened onto the line. Values are scrubbed like every other string. */
export type LogExtras = Readonly<Record<string, string | number | boolean | null>>;

export interface LogRecord extends LogFields {
  readonly event: LogEvent;
  readonly level: LogLevel;
  /** ISO-8601, derived from `at` so the line is readable without a converter. */
  readonly timestamp: string;
  readonly extras: LogExtras;
}

/** Where a record goes. `console` in production; an array in a test. */
export interface LogSink {
  write(record: LogRecord): void;
}

/**
 * The three console methods this package uses, declared structurally.
 *
 * Resolved off `globalThis` rather than by widening this package's `types` to `["node"]`. The
 * `types: []` in its tsconfig is the thing that keeps it dependency-free — the same choice
 * `packages/clock` makes — and one `console.info` is not a reason to give that up. A structural
 * interface plus one cast is the whole cost, and it has a second benefit: `ConsoleLike` is exactly
 * what a test needs to pass in place of the real console.
 */
export interface ConsoleLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * One JSON object per line, on the console method matching the level.
 *
 * JSON rather than logfmt because every hosted log product parses it without configuration, and the
 * alternative — a bespoke format — would need a parser nobody has written.
 */
export function createConsoleSink(target: ConsoleLike): LogSink {
  return {
    write(record: LogRecord): void {
      const line = JSON.stringify(record);
      if (record.level === 'error') target.error(line);
      else if (record.level === 'warn') target.warn(line);
      else target.info(line);
    },
  };
}

/**
 * The default sink, bound to the host's console.
 *
 * `globalThis` is in the ES2023 lib, so this needs no `@types/node`. The cast is narrow and
 * deliberate: every runtime Compass targets has these three methods, and a host without them would
 * fail loudly on the first log line rather than silently.
 */
export const consoleSink: LogSink = createConsoleSink(
  (globalThis as unknown as { console: ConsoleLike }).console,
);

/**
 * An elapsed-milliseconds measurement, for a log line and nothing else.
 *
 * ## Why this is allowed to exist here, when `packages/pipeline` may not measure its own duration
 *
 * The clock rules — `compass/no-system-clock`, the textual scan, and the one sanctioned
 * `Date.now()` in `SystemClock` — exist so that a *report* is a pure function of `(snapshot,
 * instant)`. `performance.now()` is banned in the guarded layers for that reason, and the ban is
 * right: a stage that timed itself and put the number in a finding would make the determinism gate
 * meaningless.
 *
 * "How long did this run take" is not that kind of fact. It never enters a report, a section, an
 * item or a content hash — it goes on one log line, which nothing reads back. So the measurement
 * lives in this package, which is not clock-guarded and is the one layer whose whole job is to
 * describe a run rather than to compute one. `packages/pipeline` calls `startTimer()` and never
 * names a time source, which keeps its own gate honest instead of routing around it.
 *
 * **Monotonic, not wall-clock.** `performance.now()` cannot go backwards, so an NTP correction
 * mid-run yields a slow report rather than a negative duration. It also cannot be turned into an
 * instant, which is the property that makes it unusable for anything but a duration — the type
 * system enforces the intent, since the only thing this returns is an elapsed number.
 */
export interface PerformanceLike {
  now(): number;
}

export type ElapsedMillis = () => number;

export function startTimer(): ElapsedMillis {
  // Resolved off `globalThis` for the same reason `consoleSink` is: this package keeps `types: []`,
  // and one duration measurement is not a reason to take on `@types/node`.
  const timer = (globalThis as unknown as { performance?: PerformanceLike }).performance;
  if (timer === undefined) {
    // No monotonic source: report zero rather than throwing. A log line is never worth failing a
    // pipeline run for, and `durationMillis: 0` is visibly wrong in a way a fabricated number is not.
    return () => 0;
  }
  const startedAt = timer.now();
  return () => Math.round(timer.now() - startedAt);
}

/**
 * Builds a record without writing it.
 *
 * Separate from `emit` so a test can assert the *shape* without capturing a stream, and so the
 * scrubbing is provably applied to the same object that gets written.
 */
export function logRecord(event: LogEvent, fields: LogFields, extras: LogExtras = {}): LogRecord {
  const scrubbedExtras: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(extras)) {
    scrubbedExtras[key] = typeof value === 'string' ? scrubText(value) : value;
  }

  return {
    event,
    level: LEVEL_FOR_EVENT[event],
    organizationId: fields.organizationId,
    teamKey: fields.teamKey,
    at: fields.at,
    timestamp: new Date(fields.at).toISOString(),
    // Scrubbed for the same reason a Sentry event is: an error message interpolated into a detail
    // sentence is the commonest way a token reaches a log line.
    detail: scrubText(fields.detail),
    extras: scrubbedExtras,
  };
}

/** Builds the record and writes it. The function every emitter below is a thin wrapper over. */
export function emit(
  event: LogEvent,
  fields: LogFields,
  extras: LogExtras = {},
  sink: LogSink = consoleSink,
): LogRecord {
  const record = logRecord(event, fields, extras);
  sink.write(record);
  return record;
}

/**
 * A sink that keeps what it was given. The testkit, in the same file as the thing it fakes because
 * it is six lines and a separate entry point would be more ceremony than substance.
 */
export class RecordingSink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }

  /** The most recent record for one event, for a test that just triggered it. */
  last(event: LogEvent): LogRecord | null {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record !== undefined && record.event === event) return record;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// The four named emitters, plus the readiness one
// ---------------------------------------------------------------------------

export const logPipelineRun = (
  fields: LogFields,
  extras: { readonly scopeKind: string; readonly rendererId: string; readonly durationMillis: number },
  sink?: LogSink,
): LogRecord => emit('pipeline.run', fields, extras, sink);

/**
 * A generation attempt that produced no report.
 *
 * `attempt` and `retryLimit` are both fields because the pair is what says whether this is a transient
 * blip pg-boss will retry or the last attempt — an alert on the final failure is a different page from
 * one on the first, and a string like "attempt 3 of 5" cannot be filtered on.
 *
 * `reason` is the thrown error's own message, scrubbed like every other string here.
 */
export const logPipelineFailure = (
  fields: LogFields,
  extras: {
    readonly scopeKind: string;
    readonly reason: string;
    readonly attempt: number;
    readonly retryLimit: number;
  },
  sink?: LogSink,
): LogRecord => emit('pipeline.failure', fields, extras, sink);

/**
 * `cause` is what makes the fallback *rate* alert actionable.
 *
 * `outcome` is the reader-facing disposition and is coarse by design — a grounding rejection and a
 * report over the word ceiling are both `rejected`. That is right for the note a manager reads and
 * useless for the person paged at 2am: a broken prompt and prose that got too long need different
 * people and different fixes. `@compass/narrator`'s `NarrationFallbackCause` is the closed union, so
 * this field's vocabulary cannot drift from the thing producing it.
 */
export const logNarrationFallback = (
  fields: LogFields,
  extras: {
    readonly sectionKey: string | null;
    readonly outcome: string;
    readonly attempts: number;
    readonly cause?: string;
  },
  sink?: LogSink,
): LogRecord => emit('narration.fallback', fields, extras, sink);

export const logIngestCoverageGap = (
  fields: LogFields,
  extras: { readonly sourceKey: string; readonly status: string; readonly reason: string },
  sink?: LogSink,
): LogRecord => emit('ingest.coverage_gap', fields, extras, sink);

export const logDeliveryFailure = (
  fields: LogFields,
  extras: { readonly channel: string; readonly attempt: number; readonly status: string },
  sink?: LogSink,
): LogRecord => emit('delivery.failure', fields, extras, sink);

/**
 * Compass could not reach its own records. The one the web edge emits.
 *
 * `cause` is the underlying error's own message, and it is a field rather than something spliced into
 * `detail` for the reason every field here is one: "which driver error is this" is a question worth
 * grouping by. It is scrubbed like every other string, so the host, port and user a connection error
 * names do not survive into the line.
 */
export const logReadinessUnavailable = (
  fields: LogFields,
  extras: { readonly surface: string; readonly cause?: string },
  sink?: LogSink,
): LogRecord => emit('readiness.unavailable', fields, extras, sink);
