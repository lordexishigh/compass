import { scrubEvent } from '@compass/observability';
import * as Sentry from '@sentry/nextjs';

/**
 * Sentry, with the scrubber wired in before anything can leave.
 *
 * ## Why an explicit init function rather than an `instrumentation.ts` side effect
 *
 * `@sentry/nextjs` conventionally initializes from a module whose import *is* the configuration,
 * which makes the scrubbing untestable: there is no exported `beforeSend` to build an event through.
 * `sentryOptions()` returns the options object instead, `initErrorReporting()` applies it, and
 * `instrumentation.ts` calls that — so the same `beforeSend` the SDK will use is the one
 * `tests/error-reporting.test.ts` asserts against. A scrubber nobody can call is a scrubber nobody
 * has checked.
 *
 * ## No DSN is a supported state, not a degradation
 *
 * Compass runs with nothing configured — that is the zero-config promise, and `/api/health` reports
 * every capability's condition rather than assuming one. With no `SENTRY_DSN` the SDK is not
 * initialized at all, so there is no client, no transport and no background flush; errors go to the
 * structured log as they always did. `initErrorReporting` returns whether it initialized so the
 * readiness endpoint can say so.
 *
 * ## What `sendDefaultPii: false` does and does not do
 *
 * It stops Sentry *adding* personal data of its own: the client IP, the cookie header, the request
 * body. It does nothing about data already inside the exception Compass threw — an error raised
 * while reconciling a commit carries the commit in its message. So the flag is set *and* every event
 * goes through `scrubEvent`, which is the half that does the work. See `@compass/observability`.
 */

export const SENTRY_DSN_ENV_VAR = 'SENTRY_DSN';

/**
 * The options, exported so the scrubbing is testable.
 *
 * `beforeSend` and `beforeSendTransaction` share one scrubber rather than having two: a transaction
 * carries spans whose descriptions are built from the same strings an event's message is, so a
 * scrubber applied to only one of them would leak through the other.
 */
export function sentryOptions(dsn: string): Sentry.NodeOptions {
  return {
    dsn,
    // Never add PII the exception did not already contain. The scrubber handles the rest.
    sendDefaultPii: false,
    // Errors only by default. Traces are a performance feature and this task is about knowing when
    // Compass breaks; sampling them at zero keeps the payload — and the bill — to the point.
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  };
}

/**
 * Initializes Sentry when a DSN is configured. Returns whether it did.
 *
 * Idempotent: Next.js can evaluate `instrumentation.ts` more than once across the server and edge
 * runtimes, and a second `Sentry.init` would replace a live client mid-request.
 */
export function initErrorReporting(environment: Record<string, string | undefined> = process.env): boolean {
  const dsn = environment[SENTRY_DSN_ENV_VAR];
  if (dsn === undefined || dsn.length === 0) return false;
  if (Sentry.getClient() !== undefined) return true;

  Sentry.init(sentryOptions(dsn));
  return true;
}

/** Whether error reporting is configured, for `/api/health` to state rather than imply. */
export const errorReportingConfigured = (environment: Record<string, string | undefined> = process.env): boolean =>
  (environment[SENTRY_DSN_ENV_VAR] ?? '').length > 0;
