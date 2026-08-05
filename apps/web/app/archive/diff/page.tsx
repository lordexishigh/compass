import { headers } from 'next/headers';

import { ReportDiffDocument } from '../../../components/report-diff';
import { StatedFailure } from '../../../components/stated-failure';
import { loadArchiveIndex } from '../../../lib/archive-source';
import { pageAccess } from '../../../lib/auth/guard';
import { buildReportDiffView, loadDiffPair } from '../../../lib/diff-source';

/**
 * `/archive/diff?team=platform&from=2026-07-29&to=2026-07-30` — two mornings, side by side.
 *
 * ## The journey this exists for
 *
 * "Show me you did not make this up." A reviewer opens two consecutive reports, sees exactly which
 * items appeared, left or changed, expands any claim to the structured payload it was computed from,
 * and clicks through to the commit, pull request or ticket behind it. Every step is on this page or
 * one click from it.
 *
 * ## Both columns are reads, never regenerations
 *
 * `loadDiffPair` reads two stored rows and returns null if either is missing. It deliberately does not
 * generate the absent one: a diff against a report nobody ever read would prove nothing about what
 * Compass actually said, which is the only question this page is asked. A missing date is stated.
 *
 * ## Why the parameters are a team and two dates
 *
 * Not two report ids. A reviewer sent this link is thinking "Tuesday and Wednesday for the platform
 * team", and report ids are derived from `(organization, scope, instant)` — opaque, and impossible to
 * type. Dates are the vocabulary the archive index already uses, so a link built by hand works.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'What changed — Compass',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function DiffFrame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">what changed</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );
}

export default async function ReportDiffPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/archive/diff', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <DiffFrame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No report has been lost.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
          <a href="/archive" className="tertiary-action">
            ← the archive
          </a>
        </StatedFailure>
      </DiffFrame>
    );
  }

  if (!access.allowed) {
    return (
      <DiffFrame heading="Not yours to read">
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/account" className="tertiary-action">
            sign in
          </a>
        </StatedFailure>
      </DiffFrame>
    );
  }

  const params = await searchParams;
  const single = (key: string): string | null => {
    const value = params[key];
    const text = Array.isArray(value) ? value[0] : value;
    return text === undefined || text.length === 0 ? null : text;
  };

  const teamKey = single('team');
  const from = single('from');
  const to = single('to');

  /**
   * A missing or malformed parameter is a stated fact with a way forward, not a 400.
   *
   * The page is reachable from a hand-typed URL and from a link somebody pasted into Slack, so the
   * common failure is a truncated one. It names what it needs and offers the archive, which is where
   * the valid dates are listed.
   */
  if (teamKey === null || from === null || to === null || !DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
    const days = await loadArchiveIndex(access.scoped, 14);

    return (
      <DiffFrame heading="Choose two reports to compare">
        <p className="prose-narration mt-3">
          This page compares two stored reports for one team. It needs a team and two dates —
          <code className="ml-1 font-mono text-[13px]">?team=platform&amp;from=2026-07-29&amp;to=2026-07-30</code>.
          Nothing is regenerated: both columns are read from what Compass wrote on those mornings.
        </p>

        {days.length === 0 ? (
          <p className="stated-absence mt-6 text-[14px]">
            Compass has not written a report yet, so there is nothing to compare. The archive fills up
            from the first morning the pipeline runs.
          </p>
        ) : (
          <>
            <p className="section-label mt-8">the most recent reports</p>
            <ul className="mt-2 space-y-1">
              {days.flatMap((day) =>
                day.entries
                  .filter((entry) => entry.scopeKind === 'team')
                  .map((entry) => (
                    <li key={entry.reportId} className="font-mono text-[13px] tabular-nums text-ink-muted">
                      <span className="data-token">{entry.reportDate}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{entry.scopeLabel}</span>
                    </li>
                  )),
              )}
            </ul>
          </>
        )}

        <p className="mt-6 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/archive" className="tertiary-action">
            ← the archive
          </a>
        </p>
      </DiffFrame>
    );
  }

  const pair = await loadDiffPair(access.scoped, { teamKey, leftDate: from, rightDate: to });

  if (pair === null) {
    return (
      <DiffFrame heading="One of those reports does not exist">
        <p className="prose-narration mt-3">
          Compass has no stored report for <span className="data-token">{teamKey}</span> on both{' '}
          <span className="data-token">{from}</span> and <span className="data-token">{to}</span>. It will not
          generate the missing one to fill this page: a diff against a report nobody read would prove
          nothing about what Compass actually said.
        </p>
        <p className="mt-6 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/archive" className="tertiary-action">
            ← the archive, which lists every date that does exist
          </a>
        </p>
      </DiffFrame>
    );
  }

  return <ReportDiffDocument diff={buildReportDiffView(pair)} />;
}
