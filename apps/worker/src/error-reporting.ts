import { scrubEvent } from '@compass/observability';
import * as Sentry from '@sentry/node';

/**
 * Sentry in the worker, scrubbed by the same function the web app uses.
 *
 * ## Why the worker needs its own initialization and not the web app's
 *
 * They are two processes. The web app's `instrumentation.ts` runs in Next's server runtime and has no
 * bearing on a pg-boss job, and the worker is where the errors that matter most happen: a failed
 * ingest, a delivery that never arrived, a purge that could not complete. An error reporter that
 * covered only the request path would miss every one of them.
 *
 * ## Why the scrubber is shared and the init is not
 *
 * `scrubEvent` comes from `@compass/observability`, so the two processes cannot disagree about what
 * may leave — which is the property that matters, because a worker leaking a commit message is the
 * same leak as a web request doing it. The *options* differ only in the SDK package each runtime
 * needs (`@sentry/node` here, `@sentry/nextjs` there), and both set `sendDefaultPii: false` and both
 * hooks.
 *
 * No `SENTRY_DSN` means no initialization at all: the ordinary state of the zero-config demo, not a
 * fault. The worker logs through `@compass/observability` either way.
 */

export const SENTRY_DSN_ENV_VAR = 'SENTRY_DSN';

/** The options, exported so the scrubbing is assertable rather than merely configured. */
export function sentryOptions(dsn: string): Sentry.NodeOptions {
  return {
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  };
}

/** Initializes Sentry when a DSN is configured. Returns whether it did. Idempotent. */
export function initErrorReporting(environment: Record<string, string | undefined> = process.env): boolean {
  const dsn = environment[SENTRY_DSN_ENV_VAR];
  if (dsn === undefined || dsn.length === 0) return false;
  if (Sentry.getClient() !== undefined) return true;

  Sentry.init(sentryOptions(dsn));
  return true;
}
