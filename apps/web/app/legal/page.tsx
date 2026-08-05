import { POLICY_DOCUMENTS, SUBPROCESSOR_NOTICE_DAYS, TRUST_CONTACT } from '@compass/trust';

/**
 * `/legal` — the index, so the documents are findable rather than only linkable.
 *
 * Each entry shows its own lede rather than a bare title, because "Automated decisions and GDPR Article
 * 22" tells a reader nothing about whether it is the page they want and the first sentence tells them
 * immediately.
 *
 * ## Not prerendered, though every byte on it is a constant
 *
 * This said `force-static`, which is what the content deserves and what the CSP cannot allow. The
 * policy is nonce-based and a nonce exists only per response, so a page whose HTML was built before
 * any request carries none — and `'strict-dynamic'` then blocks every script on it. Prerendered, this
 * page loaded with about twenty CSP refusals in the console and no hydration at all. The root layout
 * reads `headers()` for exactly this reason and a `force-static` here would override it, so the
 * declaration is gone rather than moved. The cost is a per-request render of a typed module, which is
 * arithmetic on a constant; the alternative was a public trust document with its JavaScript dead.
 */

export const metadata = {
  title: 'Legal and trust — Compass',
};

export default function LegalIndexPage() {
  return (
    <main id="legal" className="mx-auto max-w-[68ch] px-4 py-10">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">Legal and trust</h1>
        <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink">
          Every document Compass publishes about what it does with data, in one place and readable with no
          account. The two that buyers ask for first are the Article 22 statement and the impact
          assessment; both are complete rather than templated.
        </p>
      </header>

      <ul className="mt-8 space-y-5">
        {POLICY_DOCUMENTS.map((document) => (
          <li
            key={document.slug}
            data-testid="legal-index-entry"
            data-slug={document.slug}
            className="rounded-[12px] border border-rule-strong p-4"
          >
            <h2 className="text-[15px] font-medium text-ink-strong">
              <a href={`/legal/${document.slug}`} className="underline decoration-rule-strong">
                {document.title}
              </a>
            </h2>
            <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">{document.lede}</p>
            <p className="mt-2 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
              last updated <span className="data-token">{document.lastUpdated}</span>
            </p>
          </li>
        ))}

        <li
          data-testid="legal-index-entry"
          data-slug="subprocessors"
          className="rounded-[12px] border border-rule-strong p-4"
        >
          <h2 className="text-[15px] font-medium text-ink-strong">
            <a href="/trust/subprocessors" className="underline decoration-rule-strong">
              Data processing and subprocessors
            </a>
          </h2>
          <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">
            Every company that receives any part of your data, what category each one gets, and where it
            is processed — with {SUBPROCESSOR_NOTICE_DAYS} days&apos; notice before the list changes.
          </p>
        </li>
      </ul>

      <section aria-labelledby="ask-heading" className="mt-10 border-t border-rule pt-6">
        <h2 id="ask-heading" className="text-[15px] font-medium text-ink-strong">
          Asking for something not published here
        </h2>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">
          The software bill of materials, a countersigned data processing agreement and security
          questionnaires are available on request at{' '}
          <span className="data-token">{TRUST_CONTACT}</span>. The SBOM is generated on every CI run and
          retained as a build artifact; the retrieval process is documented in{' '}
          <span className="data-token">docs/SBOM.md</span>.
        </p>
      </section>

      <p className="mt-8 flex flex-wrap gap-4 text-[13px] leading-relaxed text-ink-faint">
        <a href="/pricing" className="tertiary-action">
          Pricing
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
