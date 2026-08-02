import { headers } from 'next/headers';

import { MergedDocument } from '../../../../components/merged-document';
import { StatedFailure } from '../../../../components/stated-failure';
import { archiveHref, loadMergedArchive } from '../../../../lib/archive-source';
import { pageAccess } from '../../../../lib/auth/guard';

/**
 * `/archive/merged/<date>` — the merged cross-team view of one archived date.
 *
 * Re-derived from that date's stored per-team reports rather than read from a merged row of its own, and
 * that is the design rather than a shortcut. Every fact on this page belongs to a per-team report that is
 * already stored and already permalinked; the merged view adds a ranking and a budget, both pure functions
 * of those rows. A stored merged copy would be a second copy of every headline, free to fall out of step
 * with the one it was copied from.
 *
 * It generates nothing. A date with no stored per-team reports says so — an archive that wrote to the
 * database when somebody opened last Tuesday would not be an archive.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Archived merged report — Compass',
};

export default async function ArchivedMergedPage({
  params,
}: {
  readonly params: Promise<{ readonly reportDate: string }>;
}) {
  const { reportDate } = await params;
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/archive/merged/[reportDate]', cookieHeader });

  const frame = (heading: string, children: React.ReactNode) => (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">all teams</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );

  if (access.kind === 'unavailable') {
    return frame(
      'Compass cannot reach its own records',
      <StatedFailure detail={access.detail}>
        <a href="/archive" className="tertiary-action">
          ← the archive
        </a>
      </StatedFailure>,
    );
  }

  if (!access.allowed) {
    return frame(
      'Not yours to read',
      <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
        <a href="/account" className="tertiary-action">
          sign in
        </a>
      </StatedFailure>,
    );
  }

  const view = await loadMergedArchive(access.scoped, reportDate);

  if (view === null) {
    return frame(
      'No report for that date',
      <StatedFailure
        detail={
          `Compass holds no per-team report for ${reportDate}, so there is nothing to merge. The merged view is ` +
          'derived from that date’s team reports rather than stored on its own, which is why it cannot exist without ' +
          'them — and why it can never disagree with them.'
        }
      >
        <a href="/archive" className="tertiary-action">
          ← the archive
        </a>
      </StatedFailure>,
    );
  }

  const { merged, rendered } = view;
  const reportIdByTeam = new Map(merged.teams.map((team) => [team.teamKey, team.reportId]));

  return (
    <MergedDocument
      merged={merged}
      rendered={rendered}
      itemHref={(teamKey, stableId) => {
        const reportId = reportIdByTeam.get(teamKey);
        return reportId === undefined || reportId === null
          ? '/archive'
          : `${archiveHref(reportId)}#item-${encodeURIComponent(stableId)}`;
      }}
      teamHref={(teamKey) => {
        const reportId = reportIdByTeam.get(teamKey);
        return reportId === undefined || reportId === null ? null : archiveHref(reportId);
      }}
      note={`Re-derived from the per-team reports stored for ${reportDate}. Nothing here was regenerated.`}
    />
  );
}
