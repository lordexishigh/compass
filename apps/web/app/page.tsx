import { FirstReportGuide } from '../components/first-report-guide';
import { MemoForm } from '../components/memo-form';
import { ReportDocument } from '../components/report-document';
import { TeamSwitcher } from '../components/team-switcher';
import { TimeTravelScrubber } from '../components/time-travel-scrubber';
import { loadHomeView } from '../lib/report-source';

/**
 * `/` — today's report.
 *
 * A Server Component with no `'use client'` anywhere above it: the report is
 * assembled on the server and arrives as HTML, which is why a manager on a phone
 * on a train reads prose rather than a spinner.
 *
 * No login wall, no connector wizard, no redirect. If nobody has generated today's
 * report yet — the normal case on a cold container — the read path generates it,
 * which is the whole of the zero-config promise.
 *
 * There is exactly one other thing this route can render, and it is not an empty
 * state. An organization with no team and nobody on it has no *subject* for a
 * report, and six empty headings over it would assert a quiet team where there is
 * none. That case names what is missing and links to `/start`. A quiet day is
 * unaffected: it still renders six sections with the absences stated, which is what
 * `tests/cold-start.test.tsx` holds this route to.
 */
export const dynamic = 'force-dynamic';

export default async function ReportPage() {
  const home = await loadHomeView();

  if (home.kind === 'unprovisioned') {
    return <FirstReportGuide steps={home.steps} reportExists={home.reportExists} />;
  }

  return (
    <>
      <ReportDocument view={home.view} />
      {/*
        The date control, on the report page — which is where the blueprint puts it, and it matters
        that it is *here* rather than only on a permalink.

        It was built and mounted only on `/archive/[reportId]`, which made the product circular: the
        control that generates a day was reachable only from the archive, and the archive listed one
        day because nothing had generated another. A reader who lands on `/` — every reader, since
        `/` is the whole zero-config promise — met a report frozen on one date with no way to move.
        Mounting it here is what breaks the circle: step from today's report and the archive fills
        with the days you stepped through.

        Rendered after the document rather than inside it, deliberately. `ReportDocument` is shared
        by `/`, the permalink, the merged view and the weekly digest; putting the scrubber inside it
        would render two of them on the permalink page, which already mounts its own. Same wrapper
        measure as that page, so time travel is the same object in the same place on both.
      */}
      {/*
        The three controls that act on the document, grouped after it: which team, which day, and
        the one way a manager writes back. They share a wrapper because they answer one question
        between them — *is this the report I meant to be reading, and is anything in it wrong?* —
        and because splitting them would put two hairlines where the design wants one column.

        After the report rather than before it for the same reason the feedback pill is: the reader
        came for the prose. A switcher above the masthead would make them choose a team before they
        had read the one Compass chose for them.
      */}
      <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 lg:px-8">
        <TeamSwitcher teams={home.teams} />
        {home.timeTravel !== null && (
          <TimeTravelScrubber bounds={home.timeTravel.bounds} teamKey={home.timeTravel.teamKey} />
        )}
        <MemoForm />
      </div>
    </>
  );
}
