import { readPrivacySettings, type ErrorReportingConsent } from '@compass/db';

import { requestOrganizationId, scopedFor } from './auth/guard';

/**
 * The organization's answer to "may stack traces leave this process", read from the same row
 * `/privacy` writes.
 *
 * ## Why this is its own module rather than a function in `error-reporting.ts`
 *
 * `error-reporting.ts` is a pure function of (environment, consent) and a test drives it through
 * every combination without a database. Putting the lookup in it would drag `@compass/db` into
 * that module and make the scrubbing tests need a Postgres. The split keeps the decision testable
 * and the lookup replaceable.
 *
 * ## Failure is `unset`, never a throw and never `granted`
 *
 * Two callers, and both make this the only safe answer.
 *
 * `onRequestError` calls it *inside the error handler*. A database that is down is exactly when
 * errors are flying, and a consent lookup that threw there would turn one fault into two — the
 * original error lost behind a second one raised while trying to report it. So the read is wrapped
 * and a failure answers `unset`.
 *
 * And the direction of the fallback matters as much as its existence. `unset` means the reporter
 * stays quiet, which is the outcome that cannot do harm: a fallback of `granted` would send an
 * organization's stack traces on the strength of a read that failed, which is inventing a consent
 * out of an outage.
 */
export async function errorReportingConsent(): Promise<ErrorReportingConsent> {
  try {
    const settings = await readPrivacySettings(scopedFor(requestOrganizationId()));
    return settings?.errorReportingConsent ?? 'unset';
  } catch {
    // Deliberately silent. This runs on the error path; logging here would be a second line of
    // noise about the failure the caller is already handling, and `/api/health` is where the
    // database's condition is stated.
    return 'unset';
  }
}
