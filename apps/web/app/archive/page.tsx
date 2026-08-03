import { headers } from 'next/headers';

import { ArchiveIndex } from '../../components/archive-index';
import { StatedFailure } from '../../components/stated-failure';
import { loadArchiveIndex } from '../../lib/archive-source';
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

      {/* The index itself, in a component so `accessibility.test.tsx` can render and audit it. It
          was inline here, which is why the archive was the one surface the axe criterion names that
          had nothing a test could reach. */}
      <ArchiveIndex days={days} />
    </div>
  );
}
