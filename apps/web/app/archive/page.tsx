import { headers } from 'next/headers';

import { StatedFailure } from '../../components/stated-failure';
import { loadArchiveIndex, mergedArchiveHref } from '../../lib/archive-source';
import { pageAccess } from '../../lib/auth/guard';

/**
 * `/archive` — every report Compass has written, by date and by team.
 *
 * ## Why this screen is a list of dates and not a search box
 *
 * The use case is one sentence long: *point a skip-level at last Tuesday's report*. That is a date and a
 * team, so the page is a reverse-chronological list of dates with each date's teams under it, and every
 * row is a permalink. No filters, no faceted search, no pagination controls — a manager of three teams
 * accumulates three rows a day, and four months of that is still a page you can scroll.
 *
 * Each date also links to its **merged** view, which is re-derived from that date's per-team rows rather
 * than stored: the merged report is a ranking over reports, and re-deriving it is what makes it unable to
 * disagree with the reports it points at.
 *
 * ## What the list says before you open anything
 *
 * The item count, and the fallback flag if the report was degraded. Both are on the row because both
 * change whether it is the report you want: a report Compass rendered from its template because narration
 * failed is a complete report, but a reader quoting a sentence from it is entitled to know that first.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Archive — Compass',
};

function ArchiveFrame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">archive</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );
}

export default async function ArchivePage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/archive', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <ArchiveFrame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No report has been lost.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </ArchiveFrame>
    );
  }

  if (!access.allowed) {
    return (
      <ArchiveFrame heading="Not yours to read">
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/account" className="tertiary-action">
            sign in
          </a>
        </StatedFailure>
      </ArchiveFrame>
    );
  }

  const days = await loadArchiveIndex(access.scoped);

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">archive</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          Every report Compass has written
        </h1>
        <p className="prose-narration mt-3">
          Each of these is a permalink to the report exactly as it was stored — the same prose, the same
          numbers, the same disclosures. Opening one does not recompute it, which is what makes it worth sending
          to somebody.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
          <a href="/merged" className="tertiary-action">
            merged report
          </a>
          <a href="/weekly" className="tertiary-action">
            weekly digest
          </a>
        </p>
      </header>

      {days.length === 0 ? (
        <p className="stated-absence mt-10 text-[17px] leading-relaxed">
          Compass has not written a report yet. The first one appears here the moment the scheduler runs, or as soon as
          somebody opens today&apos;s report on a cold container.
        </p>
      ) : (
        <ol className="mt-10 space-y-8">
          {days.map((day) => (
            <li key={day.reportDate} className="hairline pt-6 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h2 className="font-mono text-[15px] tabular-nums text-ink-strong">{day.reportDate}</h2>
                <a href={mergedArchiveHref(day.reportDate)} className="tertiary-action">
                  merged view
                </a>
              </div>

              <ul className="mt-3 space-y-2">
                {day.entries.map((entry) => (
                  <li key={entry.reportId} className="flex flex-wrap items-baseline gap-x-3">
                    <a
                      href={entry.href}
                      className="text-[15px] text-ink underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {entry.scopeLabel}
                    </a>
                    <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                      {entry.itemCount} item{entry.itemCount === 1 ? '' : 's'}
                    </span>
                    {entry.coverageStatus !== 'complete' && (
                      <span className="stated-absence text-[12px]">{entry.coverageStatus} coverage</span>
                    )}
                    {entry.fallbackRenderer && (
                      <span className="stated-absence text-[12px]">rendered from template</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
