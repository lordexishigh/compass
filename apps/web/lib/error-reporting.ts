import type { ErrorReportingConsent } from '@compass/db';
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
 * Compass runs with nothing configured — that is the zero-config promise. With no `SENTRY_DSN` the
 * SDK is not initialized at all, so there is no client, no transport and no background flush;
 * errors go to the structured log as they always did.
 *
 * `initErrorReporting` returns whether it initialized, and the caller is `onRequestError`: a false
 * answer means "there is nothing to capture through", so it returns instead of calling Sentry. That
 * is the whole of the contract.
 *
 * It is worth saying what the return value is *not* for, because this sentence used to claim it.
 * `/api/health` does not call this function and reports no error-reporting capability — its checks
 * are database, seats, mail, slack, clock, connector and seed-dataset. The claim was harmless while
 * this function was synchronous and became a trap when it became `async`: a reader following the
 * docstring to a readiness endpoint would have gone looking for an un-awaited call that reported a
 * Promise as truthy. There is no such call site. A surface that does want the answer without
 * starting anything should read `errorReportingConfigured()` or `errorReportingActive()`, which are
 * exported for that and take no arguments.
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
 * Initializes Sentry when a DSN is configured **and** the organization has agreed. Returns whether
 * it did.
 *
 * Idempotent: Next.js can evaluate `instrumentation.ts` more than once across the server and edge
 * runtimes, and a second `Sentry.init` would replace a live client mid-request.
 *
 * ## Why consent is a parameter and not something this reads
 *
 * Because of where this is called from. `register()` in `instrumentation.ts` runs once at process
 * boot, before any request exists — there is no organization in scope and no stored choice to read,
 * so a version of this function that went and looked would have nothing to look at. The decision
 * therefore arrives from the caller that *does* have a request, and this function stays a pure
 * function of (environment, consent) that a test can drive through all six combinations.
 *
 * ## Why the SDK is not initialized while consent is `unset`
 *
 * An initialized client is not inert. It installs global handlers, captures unhandled rejections
 * and can flush on exit, so "initialize now, decide later" would mean events leaving the process
 * during the window before anybody answered. Deferring the `init` itself is the only version of
 * this gate that is true at every instant rather than usually.
 *
 * ## Withdrawal takes effect now, not at the next restart
 *
 * The same fact makes the reverse true, and it is the arm that was missing. A client started under
 * `granted` keeps its global handlers after the owner changes their mind, so gating only the
 * *capture* path would have left an unhandled rejection still reaching the tracker — consent
 * withdrawn in the database and not in the process. So a non-granted pass with a live client tears
 * it down. `Sentry.close()` flushes what is already queued before detaching, which is the right
 * order: those events were captured while consent stood.
 */
export async function initErrorReporting(
  input: {
    readonly consent: ErrorReportingConsent;
    readonly environment?: Record<string, string | undefined>;
  } = { consent: 'unset' },
): Promise<boolean> {
  const environment = input.environment ?? process.env;
  const dsn = environment[SENTRY_DSN_ENV_VAR];
  if (dsn === undefined || dsn.length === 0) return false;

  // `denied` and `unset` behave identically here and mean different things elsewhere: the notice
  // shows for one and not the other. See `ERROR_REPORTING_CONSENTS`.
  if (input.consent !== 'granted') {
    await stopErrorReporting();
    return false;
  }

  if (Sentry.getClient() !== undefined) return true;

  Sentry.init(sentryOptions(dsn));
  return true;
}

/**
 * Detaches the SDK, flushing anything already captured. Safe to call when nothing is running.
 *
 * Exported so a test can assert the teardown directly and so a caller with its own reason to stop
 * — a shutdown hook, a test's `afterEach` — does not have to fake a consent value to get it.
 *
 * ## `close()` alone does not do it
 *
 * `Sentry.close()` flushes the queue and shuts the transport down, but it leaves the client bound
 * to the scopes — `getClient()` keeps returning it, and code that asks "is reporting on" is told
 * yes. That is not a cosmetic difference for a consent gate: the whole claim is that withdrawal
 * takes effect now, and a half-detached client is a claim that reads true and behaves otherwise.
 * The first version of this function shipped exactly that, and the test below caught it.
 *
 * So the client is unbound from all three scopes afterwards. All three, because `getClient()`
 * resolves current → isolation → global, and clearing only the one `init` happened to write would
 * leave the lookup finding it one level up.
 */
export async function stopErrorReporting(): Promise<void> {
  if (Sentry.getClient() === undefined) return;

  // Flush first, detach second. Anything already captured was captured while consent stood, and
  // dropping it would lose a real error rather than protect anybody.
  await Sentry.close();

  Sentry.getCurrentScope().setClient(undefined);
  Sentry.getIsolationScope().setClient(undefined);
  Sentry.getGlobalScope().setClient(undefined);
}

/**
 * Whether error reporting is *configured* — a DSN exists — regardless of consent.
 *
 * Kept distinct from "is reporting happening", which `/api/health` also needs to say, because an
 * operator debugging a silent reporter has to be able to tell "no DSN" from "nobody has agreed
 * yet". Two different problems with two different fixes, and one boolean could not name either.
 */
export const errorReportingConfigured = (environment: Record<string, string | undefined> = process.env): boolean =>
  (environment[SENTRY_DSN_ENV_VAR] ?? '').length > 0;

/** Whether the SDK is live right now. False until an organization has agreed and a DSN is set. */
export const errorReportingActive = (): boolean => Sentry.getClient() !== undefined;
