import * as Sentry from '@sentry/nextjs';
import type { Instrumentation } from 'next';

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
 *
 * ## Why the consent lookup is imported dynamically, and only on Node
 *
 * Next.js compiles this file for **every** server runtime it may run in, Edge included, and the
 * Edge runtime has no `path`, `stream` or `fs`. `errorReportingConsent` reaches `@compass/db`,
 * which reaches `pg`, which reaches all three — so a static import at the top of this file is not a
 * slow edge bundle, it is `next build` failing outright with "Module not found: Can't resolve
 * 'path'". A `process.env.NEXT_RUNTIME` check alone does not help: a static import is bundled
 * whether or not the branch that uses it is reachable. The import has to be dynamic *and* guarded.
 *
 * That this was caught by `pnpm run build:web` and not by `pnpm run verify` is worth recording:
 * `verify` is lint, arch, typecheck and test, and none of the four bundles the app. Type-checking
 * this file passes cleanly, because the types are perfectly good — it is only the *bundler* that
 * knows Edge has no filesystem.
 *
 * Returning early on Edge is the honest behaviour rather than a concession. There is no database
 * connection to read consent through, so the answer would be `unset` on every call, and `unset`
 * means "do not report". Middleware is the only Edge surface Compass has, and its errors continue
 * to reach the structured log exactly as they did before.
 */
export const onRequestError: NonNullable<Instrumentation.onRequestError> = async (error, request, context) => {
  // The import sits *inside* the truthy branch, and both halves of that are load-bearing.
  //
  // Dot notation, not the bracket form the rest of this app uses for environment variables: Next
  // inlines `process.env.NEXT_RUNTIME` per compilation through webpack's DefinePlugin, so this
  // folds to `if ('edge' === 'nodejs')` in the Edge build. `process.env['NEXT_RUNTIME']` is not
  // substituted at all.
  //
  // And nested rather than an early `return`, because webpack only drops an `import()` it can prove
  // unreachable — which means the import has to be in the branch that folds away. Written as
  // `if (… !== 'nodejs') return;` followed by the import, the import sits in the function body,
  // survives the fold, gets resolved, and `next build` fails on `pg`'s `fs`/`path`/`stream`. Both
  // spellings type-check and both look equivalent; only this one builds.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { errorReportingConsent } = await import('./lib/error-reporting-consent');

    // Awaited because the non-granted arm tears a live client down: an owner who withdraws consent
    // must stop being reported on immediately, not at the next deploy.
    if (!(await initErrorReporting({ consent: await errorReportingConsent() }))) return;

    await Sentry.captureRequestError(error, request, context);
  }
};
