import {
  SUBPROCESSORS,
  SUBPROCESSOR_NOTICE_DAYS,
  TRUST_CONTACT,
} from '@compass/trust';

/**
 * `/trust/subprocessors` — every company that receives any part of your data.
 *
 * ## Why it is a table and not prose
 *
 * This is the one page in Compass where a table is the right object. A reader here is doing a specific
 * comparison — which company, what data, which region — across six rows, and prose forces them to hold
 * five facts in their head to answer a question a table answers by scanning a column. The document
 * posture still applies to everything around it.
 *
 * ## The subscribe control is a real obligation, not a newsletter
 *
 * Compass commits to {SUBPROCESSOR_NOTICE_DAYS} days' advance notice before this list changes, which is
 * a promise that needs somebody to notify. The form posts to a route that stores the address and mails a
 * confirmation; the worker's notice job compares a digest of this module against the last one it
 * announced and mails the difference. Both halves are tested — the list and the promise cannot drift,
 * because the job reads the same array this page renders.
 *
 * ## Not prerendered, and the reason is the CSP rather than the content
 *
 * This declared `force-static`, which the content justifies and the security policy forbids: a nonce
 * is minted per response, so HTML built at build time carries none, and `'strict-dynamic'` then
 * refuses every script on the page. See the root layout, which reads `headers()` to make the whole app
 * render per request; a `force-static` here would override that and put this page back to loading with
 * its JavaScript blocked.
 */

export const metadata = {
  title: 'Data processing and subprocessors — Compass',
};

export default function SubprocessorsPage() {
  return (
    <main id="subprocessors" className="mx-auto max-w-[76ch] px-4 py-10">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">
          Data processing and subprocessors
        </h1>
        <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink">
          Every company that receives any part of your data, what category each one gets, and where it is
          processed. Compass gives {SUBPROCESSOR_NOTICE_DAYS} days&apos; advance notice before this list
          changes, and you can subscribe to that notice below without having an account.
        </p>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink-faint">
          Most of these are optional. A self-hosted deployment with no language-model key sends nothing to
          one; with no mail key, nothing is emailed. The <em>optional</em> column says which, because
          &ldquo;we may share with providers&rdquo; is the disclosure this page exists to refuse.
        </p>
      </header>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]">
          <caption className="sr-only">
            Compass subprocessors, the data category each receives, its processing region, and whether it
            is optional.
          </caption>
          <thead>
            <tr className="border-b border-rule-strong">
              {['Subprocessor', 'What for', 'Data it receives', 'Region', 'Optional'].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="py-2 pr-4 align-bottom font-mono text-[11px] uppercase tracking-wide text-ink-faint"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SUBPROCESSORS.map((entry) => (
              <tr
                key={entry.id}
                data-testid="subprocessor-row"
                data-subprocessor={entry.id}
                className="border-b border-rule align-top"
              >
                <th scope="row" className="py-3 pr-4 text-[14px] font-medium text-ink-strong">
                  {entry.name}
                </th>
                <td className="py-3 pr-4 leading-relaxed text-ink">{entry.purpose}</td>
                <td data-testid="subprocessor-category" className="py-3 pr-4 leading-relaxed text-ink">
                  {entry.dataCategory}
                </td>
                <td
                  data-testid="subprocessor-region"
                  className="py-3 pr-4 font-mono text-[12px] leading-relaxed text-ink"
                >
                  {entry.region}
                </td>
                <td className="py-3 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                  {entry.optional ? 'optional' : 'required'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        The subscribe control.
        A real `<form method="post">` with no client JavaScript, like every other control on the public
        surfaces. The route answers a 303 back to this page with an outcome, so somebody who submits it
        lands on a page that states what happened rather than on a JSON document.
      */}
      <section aria-labelledby="notice-heading" className="mt-10 border-t border-rule pt-6">
        <h2 id="notice-heading" className="text-[15px] font-medium text-ink-strong">
          Get {SUBPROCESSOR_NOTICE_DAYS} days&apos; notice before this list changes
        </h2>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">
          Compass will email you at least {SUBPROCESSOR_NOTICE_DAYS} days before adding a subprocessor,
          removing one, or changing what any of them receives. You will get one confirmation email now and
          nothing else until the list actually changes — this is not a newsletter and there is nothing
          else to send.
        </p>

        <form
          action="/api/trust/subprocessor-notices"
          method="post"
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="notice-email" className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
              Email address
            </label>
            <input
              id="notice-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@your-company.com"
              className="goal-input w-[28ch] max-w-full"
            />
          </div>
          <button type="submit" className="primary-action" data-testid="notice-subscribe">
            Subscribe to change notices
          </button>
        </form>

        <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-ink-faint">
          Your address is used for this one purpose and nothing else. Every notice carries a one-click
          unsubscribe, and you can unsubscribe before any notice is ever sent.
        </p>
      </section>

      <section aria-labelledby="more-heading" className="mt-10 border-t border-rule pt-6">
        <h2 id="more-heading" className="text-[15px] font-medium text-ink-strong">
          Documents and requests
        </h2>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">
          The impact assessment and the Article 22 position are published in full. The software bill of
          materials, a countersigned data processing agreement and security questionnaires are available
          at <span className="data-token">{TRUST_CONTACT}</span>.
        </p>
      </section>

      <p className="mt-8 flex flex-wrap gap-4 text-[13px] leading-relaxed text-ink-faint">
        <a href="/legal/dpia" className="tertiary-action">
          Impact assessment
        </a>
        <a href="/legal/automated-decisions" className="tertiary-action">
          Article 22 statement
        </a>
        <a href="/legal" className="tertiary-action">
          All documents
        </a>
        <a href="/account" className="tertiary-action">
          Sign in
        </a>
        <a href="/" className="tertiary-action">
          Read today&apos;s report
        </a>
      </p>
    </main>
  );
}
