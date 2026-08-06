import * as Sentry from '@sentry/nextjs';
import type { Instrumentation } from 'next';

import { initErrorReporting } from './lib/error-reporting';
import { errorReportingConsent } from './lib/error-reporting-consent';

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

/**
 * Called once per server runtime at startup — and deliberately initializes nothing.
 *
 * This used to call `initErrorReporting()` unconditionally, which made error reporting a property
 * of the deployment rather than a choice the organization made: the only way to stop stack traces
 * leaving was for whoever ran the servers to delete `SENTRY_DSN`, and that is not the same person
 * as the controller whose data it is.
 *
 * The hook cannot make the decision itself. `register()` runs at process boot, before any request
 * — there is no organization in scope and no stored choice to read, so gating *here* is not
 * something that can be written. What it can do is not start the client, so that nothing is
 * reporting until a code path that does know has said so; `onRequestError` below is that path.
 *
 * The export stays, rather than being deleted, because its absence and its emptiness say different
 * things to the next reader: Next.js looks for this name, and a file without it reads as an
 * oversight rather than as a decision.
 */
export function register(): void {
  // Intentionally empty. See above: consent is not knowable at boot.
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
 * It delegates to Sentry's own handler rather than reimplementing it: that handler needs the
 * request context Next passes it, and every event it produces goes through the `beforeSend`
 * scrubber configured in `lib/error-reporting.ts` — the scrubbing is a property of the client, not
 * of the call site, so there is nothing to re-apply here and nothing that can be forgotten.
 *
 * ## The consent gate lives here because this is the first place it can
 *
 * A request has an organization; boot does not. So this reads the organization's stored choice and
 * starts the client only once that choice is `granted` — the deferral `register()` cannot perform.
 * Until then the handler returns without capturing, and the error still reaches the structured log
 * exactly as it did before, so nothing is lost while the question is unanswered.
 *
 * Reading a setting on the error path has to be failure-tolerant, and is: `errorReportingConsent`
 * answers `unset` if the database cannot be reached. An outage that takes out Postgres is precisely
 * when errors are flying, and "the consent lookup threw inside the error handler" would turn one
 * fault into two.
 */
export const onRequestError: NonNullable<Instrumentation.onRequestError> = async (error, request, context) => {
  if (!initErrorReporting({ consent: await errorReportingConsent() })) return;

  await Sentry.captureRequestError(error, request, context);
};
