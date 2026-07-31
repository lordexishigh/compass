import Link from 'next/link';

import type { ArtifactView } from '../lib/artifact-source';

/**
 * The artifact page's body.
 *
 * The other end of every evidence marker. It answers one question — "what has
 * Compass said about this thing, and on what basis" — and it answers it with the
 * source's own identifiers, so a reader can go and open the pull request or the
 * tracker item themselves and disagree.
 *
 * Both absences are stated. An artifact kind Compass has no page for still
 * resolves and says which kind it was asked for; an artifact nobody has cited
 * says exactly that, rather than rendering a blank page that reads like a bug.
 */
export function ArtifactDetail({ artifact }: { readonly artifact: ArtifactView }) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:pt-16">
      <p className="section-label">Evidence</p>
      <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
        {artifact.title}
      </h1>

      {!artifact.knownKind && (
        <p className="stated-absence mt-3">
          Compass has no detail page for artifacts of kind{' '}
          <span className="data-token not-italic">{artifact.kind}</span>, so this page shows only what the report
          recorded. The link is still here rather than dropped, because the evidence exists.
        </p>
      )}

      <dl className="mt-6 space-y-3">
        {artifact.identifiers.map((identifier) => (
          <div key={identifier.label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
            <dt className="section-label sm:w-40 sm:shrink-0">{identifier.label}</dt>
            <dd className="data-token break-all">{identifier.value}</dd>
          </div>
        ))}
        {artifact.identifiers.length === 0 && (
          <div className="flex flex-col gap-0.5">
            <dt className="section-label">Identifier</dt>
            <dd className="data-token break-all">{artifact.artifactId}</dd>
          </div>
        )}
      </dl>

      <section aria-labelledby="claims-heading" className="mt-10 hairline pt-8">
        <h2 id="claims-heading" className="section-label">
          Claims that cite this
        </h2>

        {artifact.claims.length === 0 ? (
          <p className="stated-absence mt-3 text-[17px] leading-relaxed">
            No report has cited this artifact yet. That is a statement about Compass, not about the work: nothing has
            crossed a threshold that would put it in front of a manager.
          </p>
        ) : (
          <ul className="mt-4 space-y-6">
            {artifact.claims.map((claim) => (
              <li key={`${claim.reportId}:${claim.sectionKey}:${claim.headline}`}>
                <article className="border-l border-rule-strong pl-4">
                  <p className="section-label">
                    <span className="font-mono tabular-nums">{claim.reportDate}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{claim.sectionTitle}</span>
                  </p>
                  <p className="prose-narration mt-1">{claim.headline}</p>
                  {claim.detail.length > 0 && <p className="prose-narration mt-1 text-ink-muted">{claim.detail}</p>}
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-12 text-[13px]">
        <Link
          href="/"
          className="text-ink-faint underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Back to the report
        </Link>
      </p>
    </div>
  );
}
