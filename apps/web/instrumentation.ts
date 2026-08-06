import * as Sentry from '@sentry/nextjs';

import { initErrorReporting } from './lib/error-reporting';

/**
 * The two hooks Next.js looks for, and nothing else.
 *
 * The options and the scrubber live in `lib/error-reporting.ts` where a test can reach them; this
 * file is only the wiring that applies them. The conventional `@sentry/nextjs` shape — a
 * `sentry.server.config.ts` whose import *is* the configuration — would put the `beforeSend`
 * scrubber somewhere no test could build an event through, and an unverifiable scrubber is the one
 * thing this must not be.
 *
 * With no `SENTRY_DSN`, `register()` does nothing and `onRequestError` has no client to report to,
 * which is the ordinary state of the zero-config demo rather than a fault.
 */

/** Called once per server runtime at startup. Initializes the SDK when a DSN is configured. */
export function register(): void {
  initErrorReporting();
}

/**
 * Where errors from Server Components and route handlers actually arrive.
 *
 * Without this export the SDK was initialized, scrubbed and connected to nothing on the render path:
 * Next.js hands a request-scoped error to `onRequestError`, and an absent hook is not an error it can
 * report — it is silence. Since almost every unhandled Compass error surfaces in a Server Component
 * (`/`, `/archive/[reportId]`, `/privacy`) or a route handler, that was most of the product's
 * failures never reaching the reporter at all.
 *
 * It is Sentry's own handler rather than a wrapper, deliberately: it needs the request context Next
 * passes it, and every event it produces still goes through the `beforeSend` scrubber configured in
 * `lib/error-reporting.ts` — the scrubbing is a property of the client, not of the call site, so
 * there is nothing to re-apply here and nothing that can be forgotten.
 */
export const onRequestError = Sentry.captureRequestError;
