import { mergedArchiveHref, type ArchiveDayView } from '../lib/archive-source';
import { EMPTY_STATES } from '../lib/empty-states';

import { EmptyState } from './empty-state';

/**
 * The archive index: every report Compass has written, by date, each one a permalink.
 *
 * ## Why this is a component and not inline JSX in the page
 *
 * It was inline, and the consequence was that the archive was the one surface the accessibility
 * criterion names which had no axe assertion — there was nothing a test could render. The report
 * view, the evidence panel and the configuration screens are all components and all audited; this
 * closes the fourth. A surface that cannot be rendered in isolation cannot be audited in isolation,
 * which makes "audited" a property of the file layout rather than of anybody's diligence.
 *
 * The page keeps the masthead and the cross-links, because those are about *navigation* and differ
 * per screen. What moved here is the part with the structure worth auditing: nested lists, a heading
 * per date, and a link per report.
 *
 * ## The nesting is deliberate
 *
 * An ordered list of dates, each containing an unordered list of that date's reports. The dates are
 * ordered — newest first is the whole point of an archive — and the reports within one date are not,
 * because two teams' Tuesday reports have no sequence between them. axe checks list structure, so
 * getting this wrong is a violation rather than a matter of taste.
 */
export function ArchiveIndex({ days }: { readonly days: readonly ArchiveDayView[] }) {
  if (days.length === 0) {
    return (
      <div className="mt-10">
        <EmptyState copy={EMPTY_STATES.archive} />
      </div>
    );
  }

  return (
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
                {/*
                  Degradation is stated, never a grey box and never omitted. A reader deciding
                  whether to forward last Tuesday's report needs to know it was written from partial
                  coverage before they send it, not after somebody asks.
                */}
                {entry.coverageStatus !== 'complete' && (
                  <span className="stated-absence text-[12px]">{entry.coverageStatus} coverage</span>
                )}
                {entry.fallbackRenderer && <span className="stated-absence text-[12px]">rendered from template</span>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
