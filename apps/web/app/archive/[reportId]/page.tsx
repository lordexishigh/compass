import { loadFreshness } from '@compass/db';
import { headers } from 'next/headers';

import { ReportDocument } from '../../../components/report-document';
import { StatedFailure } from '../../../components/stated-failure';
import { TimeTravelScrubber } from '../../../components/time-travel-scrubber';
import { loadArchivedReport, simulatedClockAvailable, timeTravelBounds } from '../../../lib/archive-source';
import { pageAccess } from '../../../lib/auth/guard';
import { buildReportView } from '../../../lib/view-model';

/**
 * `/archive/<reportId>` — one report, permalinked, rendered exactly as stored.
 *
 * ## The one property this page has to have
 *
 * It renders **the row**. `loadArchivedReport` loads and does not generate; `buildReportView` shapes the
 * page from the stored sections, items, evidence and payload; the fallback disclosure comes off
 * `reports.fallback_renderer` rather than from anything computed now. So a report opened six weeks later
 * shows the prose a manager read that morning, the numbers the thresholds of that day produced, and the
 * same disclosure about how it was rendered.
 *
 * Regenerating would be the easy mistake and a serious one: today's analysis over that day's data is a
 * different report, and a reader following a permalink has no way to tell that they are looking at one.
 * The only page in Compass allowed to generate for a past instant is the time-travel control, which says
 * so — and which, once it has written a report, sends the reader *here*, to the permalink of the row it
 * wrote.
 *
 * ## Why the whole report document, not a reduced view
 *
 * Same component as `/`. An archived report with fewer affordances would be a second, worse rendering of
 * the same data, and the Six Spine's geography is the thing a manager has learned — a past report that
 * laid itself out differently would have to be re-read rather than recognised.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Archived report — Compass',
};

export default async function ArchivedReportPage({
  params,
}: {
  readonly params: Promise<{ readonly reportId: string }>;
}) {
  const { reportId } = await params;
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/archive/[reportId]', cookieHeader });

  const frame = (heading: string, children: React.ReactNode) => (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">archive</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );

  if (access.kind === 'unavailable') {
    return frame(
      'Compass cannot reach its own records',
      <StatedFailure detail={`${access.detail} The report is not lost; this page could not read it.`}>
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

  const bundle = await loadArchivedReport(access.scoped, reportId);

  if (bundle === null) {
    // Stated in the product's voice, and deliberately not an oracle: it says nothing about whether some
    // other organization holds a report with this id.
    return frame(
      'No such report',
      <StatedFailure
        detail={
          'Compass holds no report with that id for this organization. A permalink is stable for as long as the report ' +
          'exists, so a link that stops working means the report was never written rather than that it moved.'
        }
      >
        <a href="/archive" className="tertiary-action">
          ← the archive
        </a>
      </StatedFailure>,
    );
  }

  const view = buildReportView({
    bundle,
    // The freshness of the window the report was *about*, not of today: an archived report's coverage note
    // is a fact about the day it covered.
    freshness: await loadFreshness(access.scoped, bundle.report.window),
    timeShiftNote:
      `This is the stored report for ${bundle.report.reportDate}, rendered exactly as Compass wrote it. ` +
      'Nothing on this page was recomputed.',
  });

  const bounds = timeTravelBounds(access.organizationId, bundle.report.reportDate);

  return (
    <>
      <ReportDocument view={view} />
      <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 lg:px-8">
        <p className="mt-8 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/archive" className="tertiary-action">
            ← the archive
          </a>
          <a href="/" className="tertiary-action">
            today&apos;s report
          </a>
        </p>
        {/*
          Rendered only on the simulated clock *and* only from a team report.

          The `scopeKind === 'team'` half is not cosmetic. The archive deliberately contains merged-scope
          rows, whose `scopeKey` is the merged sentinel rather than a team — so offering the scrubber here
          from a merged permalink would hand that sentinel to `regenerateForInstant`, which would call
          `ensureDailyReport` with `scope: {kind:'team', teamKey:'*'}` and persist a daily for a team that
          does not exist. A merged report is re-derived from its date's team reports, so the way to time
          travel across it is to step one of *those* and open the merged view for the new date.

          The route refuses the same request independently — it validates the team against the
          organization's known keys — so this is the affordance, not the gate.
        */}
        {bundle.report.scopeKind === 'team' && simulatedClockAvailable(access.organizationId) && (
          <TimeTravelScrubber bounds={bounds} teamKey={bundle.report.scopeKey} />
        )}
      </div>
    </>
  );
}
