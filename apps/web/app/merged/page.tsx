import { headers } from 'next/headers';

import { MergedDocument } from '../../components/merged-document';
import { StatedFailure } from '../../components/stated-failure';
import { archiveHref, knownTeamKeys, loadMergedReport } from '../../lib/archive-source';
import { pageAccess } from '../../lib/auth/guard';

/**
 * `/merged` — today's merged cross-team report.
 *
 * The two-to-three-team manager's actual daily read. It runs each team's daily through the real pipeline
 * (finding the row when the scheduler already wrote it), ranks every finding by action impact, and cuts to
 * the documented 400-word budget — which the renderer asserts rather than hopes for.
 *
 * A manager of one team is sent to `/` instead, and told why. A merged report over a single team is that
 * team's report with a worse layout and a ranking that cannot rank anything, and offering it would be
 * offering a worse version of the page they wanted.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'All teams — Compass',
};

function MergedFrame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">all teams</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );
}

export default async function MergedReportPage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/merged', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <MergedFrame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No report has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </MergedFrame>
    );
  }

  if (!access.allowed) {
    return (
      <MergedFrame heading="Not yours to read">
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/account" className="tertiary-action">
            sign in
          </a>
        </StatedFailure>
      </MergedFrame>
    );
  }

  const teamKeys = await knownTeamKeys(access.scoped);

  if (teamKeys.length === 0) {
    return (
      <MergedFrame heading="No team to merge across">
        <p className="stated-absence mt-3 text-[17px] leading-relaxed">
          No team has been configured yet, so there is nothing to rank across. Configure one on the roster screen and the
          merged report appears the next time a daily is generated.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/roster" className="tertiary-action">
            the roster
          </a>
        </p>
      </MergedFrame>
    );
  }

  if (teamKeys.length === 1) {
    return (
      <MergedFrame heading="One team needs no merged report">
        <p className="prose-narration mt-3 text-[17px] leading-relaxed">
          A merged report ranks findings <em>across</em> teams, and there is one team here — so it would be{' '}
          <span className="font-mono">{teamKeys[0]}</span>&apos;s own report with a worse layout and a ranking with
          nothing to rank. Read the daily instead; it carries the evidence this page would only link to.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </p>
      </MergedFrame>
    );
  }

  const { merged, rendered, teamReports } = await loadMergedReport(access.organizationId, teamKeys);
  const reportIdByTeam = new Map(teamReports.map((entry) => [entry.teamKey, entry.bundle.report.id]));

  return (
    <MergedDocument
      merged={merged}
      rendered={rendered}
      // The link down: the team's own archived report, anchored at the item's section. The stable id is the
      // anchor because it is the id the per-team page renders its claims under.
      itemHref={(teamKey, stableId) => {
        const reportId = reportIdByTeam.get(teamKey);
        return reportId === undefined ? '/' : `${archiveHref(reportId)}#item-${encodeURIComponent(stableId)}`;
      }}
      teamHref={(teamKey) => {
        const reportId = reportIdByTeam.get(teamKey);
        return reportId === undefined ? null : archiveHref(reportId);
      }}
      note={null}
    />
  );
}
