import type { PolicyDocument } from '@compass/trust';

/**
 * A published policy, set as a document.
 *
 * Same posture as the report: one reading column, one measure, prose top to bottom. A legal page is the
 * surface most likely to be turned into a wall of nested bullets in a grey box, and the reason not to is
 * the same reason the report refuses it — somebody has to actually read this, on a phone, while deciding
 * whether to trust the product.
 *
 * ## The two pieces of markup that are not decoration
 *
 * `**bold**` inside a paragraph is honoured, because two of these documents draw a distinction that only
 * works if the two terms are emphasised — "**account data**" against "**work data**" in the privacy
 * policy. It is a deliberate, closed piece of formatting rather than a markdown renderer: the content is
 * a typed module written by us, not user input, so a full parser would be a dependency and an injection
 * surface bought for one asterisk pair.
 *
 * Backtick spans are the second, and they were a defect before they were a feature. The no-ranking
 * stance cites `assertNoIndividualRanking` and `packages/analysis/src/ranking-guard.ts`, and the privacy
 * policy names the two cookies it sets — all written in the backtick idiom the rest of this codebase
 * uses, and all rendering on the published page as literal backtick characters, because only asterisks
 * were understood. A reader saw `` `compass_session` `` with the punctuation showing.
 *
 * They are set in mono for the same reason the report sets a SHA in mono: the brief rations that
 * treatment to receipts — identifiers a reader might copy, search for, or check against something else —
 * and a cookie name, a file path and a function name are exactly that. Same `.data-token` class the
 * report uses, so there is one mono treatment in the product rather than a second one here.
 */

/**
 * Splits on `**…**` and `` `…` `` and marks up the odd segments. Nothing else in the string is markup.
 *
 * Emphasis is applied first and code inside each resulting run second, so `**a `b`**` is bold with a
 * mono span inside it rather than one of the two winning. An unpaired delimiter leaves its text alone:
 * `split` yields an even final segment, which falls through as the plain string it was.
 */
function withCode(text: string, keyPrefix: string): readonly React.ReactNode[] {
  return text.split('`').map((segment, index) =>
    index % 2 === 1 ? (
      <code key={`${keyPrefix}-c${index}`} className="data-token">
        {segment}
      </code>
    ) : (
      segment
    ),
  );
}

function withEmphasis(text: string): readonly React.ReactNode[] {
  return text.split('**').map((segment, index) =>
    index % 2 === 1 ? (
      <strong key={index} className="font-medium text-ink-strong">
        {withCode(segment, `b${index}`)}
      </strong>
    ) : (
      <span key={index}>{withCode(segment, `p${index}`)}</span>
    ),
  );
}

export function PolicyBody({ document }: { readonly document: PolicyDocument }) {
  return (
    <>
      {document.sections.map((section) => (
        <section
          key={section.heading}
          aria-labelledby={`section-${section.heading.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}
          data-testid="policy-section"
          className="mt-8 border-t border-rule pt-6 first:mt-6 first:border-t-0 first:pt-0"
        >
          <h2
            id={`section-${section.heading.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}
            className="text-[15px] font-medium text-ink-strong"
          >
            {section.heading}
          </h2>

          {section.paragraphs.map((paragraph, index) => (
            <p key={index} className="mt-3 max-w-prose text-[14px] leading-relaxed text-ink">
              {withEmphasis(paragraph)}
            </p>
          ))}

          {section.bullets !== undefined && (
            <ul className="mt-3 space-y-2">
              {section.bullets.map((bullet) => (
                <li
                  key={bullet}
                  data-testid="policy-bullet"
                  className="max-w-prose border-l-2 border-rule-strong pl-3 text-[14px] leading-relaxed text-ink"
                >
                  {withEmphasis(bullet)}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}

/**
 * The whole page for one policy, including the masthead and the footer links.
 *
 * The footer is not decoration either: `/legal/*` is readable with no session, so a reader who arrives
 * here from a search engine must be able to reach both the sign-in and the other documents. The
 * publicly-readable-page test enforces that a way back exists.
 */
export function PolicyPage({ document }: { readonly document: PolicyDocument }) {
  return (
    <main id={document.slug} className="mx-auto max-w-[68ch] px-4 py-10">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">{document.title}</h1>
        <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink">{document.lede}</p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
          {/*
            The date the *content* changed, from the module. Not "today": a policy page whose date moves
            on every deploy is a page whose date means nothing, and it is the commonest way one of these
            documents quietly lies.
          */}
          last updated <span className="data-token">{document.lastUpdated}</span>
        </p>
      </header>

      <PolicyBody document={document} />

      <nav aria-label="Other documents" className="mt-10 border-t border-rule pt-6">
        <p className="flex flex-wrap gap-4 text-[13px] leading-relaxed text-ink-faint">
          <a href="/legal" className="tertiary-action">
            All documents
          </a>
          <a href="/trust/subprocessors" className="tertiary-action">
            Data processing
          </a>
          <a href="/account" className="tertiary-action">
            Sign in
          </a>
          <a href="/" className="tertiary-action">
            Read today&apos;s report
          </a>
        </p>
      </nav>
    </main>
  );
}
