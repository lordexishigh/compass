import { errorReportingConfigured } from '../lib/error-reporting';
import { errorReportingConsent } from '../lib/error-reporting-consent';

/**
 * The consent notice: one sentence saying a decision is outstanding, and where it is made.
 *
 * ## Why it is a paragraph and not a cookie banner
 *
 * Compass has no non-essential cookies to ask about — it sets two, both `HttpOnly`, both strictly
 * necessary, and `/legal/privacy` says so in as many words. What it *does* have is one piece of
 * processing that is a genuine choice: a stack trace, scrubbed, leaving the process for an error
 * tracker. So this asks about the thing that is actually optional rather than performing a consent
 * ritual about cookies that need none. A banner asking permission for something that needs none
 * teaches people the question is meaningless, and then the one real question goes unread with it.
 *
 * ## Why it does not carry the buttons
 *
 * The choice is the organization's posture, not a per-visitor preference — it lives in the same
 * `org_privacy_settings` row as the retention windows and the narration mode, and `/api/privacy/
 * settings` is owner-only for that reason. A viewer pressing "Allow" here would either be refused
 * or would silently be deciding for everybody. So the notice states the fact and links to the one
 * screen where the decision is made, beside the other privacy controls, by the person who may make
 * it. That also keeps this a Server Component: no client bundle, no hydration, nothing to trap
 * focus.
 *
 * ## Why there is no dismiss
 *
 * Because the question is answerable, and dismissing it would hide an unanswered question rather
 * than answer it — which is exactly the state a consent record must never be able to reach. It
 * disappears when the decision is made, either way: `granted` and `denied` both end it. Until then
 * the honest thing is that it is still there.
 *
 * ## When it renders at all
 *
 * Only when a DSN is configured *and* the answer is `unset`. A deployment with no error tracker has
 * nothing to consent to, and asking anyway would be a question with no consequence — the seeded
 * demonstration tenant is exactly that case and shows nothing.
 */
export async function ErrorReportingNotice() {
  if (!errorReportingConfigured()) return null;
  if ((await errorReportingConsent()) !== 'unset') return null;

  return <ErrorReportingNoticeBody />;
}

/**
 * The markup, split from the decision so it can be rendered without a database.
 *
 * `accessibility.test.tsx` audits this directly. The async wrapper above reaches for privacy
 * settings, and an axe run that needed Postgres to render one landmark would be a test nobody kept
 * green — so the half that has a DOM is a plain component and the half that has a query is four
 * lines with no markup in it.
 */
export function ErrorReportingNoticeBody() {
  return (
    <aside
      aria-labelledby="error-reporting-notice-heading"
      data-testid="error-reporting-notice"
      // The report measure, matching every other reading column in the product. A full-bleed bar
      // pinned to the viewport is the dashboard chrome the brief refuses; this sits at the end of
      // the document and is read after it, like a footnote.
      className="mx-auto w-full max-w-[46rem] px-5 pb-16 lg:px-8"
    >
      <div className="border-l-2 border-authored pl-4">
        <h2 id="error-reporting-notice-heading" className="section-label">
          a decision is outstanding
        </h2>
        <p className="prose-narration mt-2 text-[15px]">
          Compass can send a scrubbed stack trace to an error tracker when something breaks — no
          addresses, no credentials, no ingested text, and the{' '}
          <a href="/legal/privacy" className="tertiary-action">
            privacy policy
          </a>{' '}
          sets out exactly what that means. Nobody has decided yet, so it is sending nothing.
        </p>
        <p className="stated-absence mt-2 text-[13px]">
          Until an owner answers, errors are written to this deployment&apos;s own log and go
          nowhere else. The choice sits with the retention windows on{' '}
          <a href="/privacy" className="tertiary-action">
            the privacy screen
          </a>
          , and can be changed at any time.
        </p>
      </div>
    </aside>
  );
}
