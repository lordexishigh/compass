import type { MergedReport } from '@compass/analysis';
import type { RenderedMergedReport } from '@compass/renderers';

/**
 * The merged cross-team report.
 *
 * ## One measure, ranked, with the receipts one tap down
 *
 * The page is the same reading column as the daily and it keeps the Six Spine's numerals, because that
 * geography is the thing a manager has already learned. What it does *not* do is repeat each team's six
 * sections: every line is one ranked finding, and the link at the end of it goes to that finding in the
 * team's own report, where its evidence, its notches and its day counter live.
 *
 * ## Where the word budget shows
 *
 * At the foot, in mono, as a fact rather than a boast: `312 / 400 words`. It is there because the budget
 * is a promise the product makes to the reader — this will always be about two minutes — and a promise
 * you can check is worth more than one you are told about. The omitted-count line above it is the other
 * half: it names what the ranking left in the per-team reports rather than letting the page imply that
 * nine findings were all there were.
 *
 * A Server Component with no interactive part. The links are links.
 */

export interface MergedDocumentProps {
  readonly merged: MergedReport;
  readonly rendered: RenderedMergedReport;
  /** `(teamKey, stableId) → href` — the link down into the per-team claim. */
  readonly itemHref: (teamKey: string, stableId: string) => string;
  /** `teamKey → href` of that team's whole report. */
  readonly teamHref: (teamKey: string) => string | null;
  /** Stated above the report when this page is showing a day other than today. */
  readonly note?: string | null;
}

export function MergedDocument({ merged, rendered, itemHref, teamHref, note }: MergedDocumentProps) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">all teams</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          <span className="font-mono tabular-nums">{rendered.reportDate}</span>
        </h1>

        {note !== null && note !== undefined && note.length > 0 && (
          <p className="stated-absence mt-3 text-[13px]">{note}</p>
        )}

        {/* The change line, in the body serif and above everything: on a quiet morning it is the report. */}
        <p className="prose-narration mt-6 text-[17px] text-ink-strong">{rendered.changeLine}</p>

        <ul className="mt-4 space-y-1">
          {merged.teams.map((team) => {
            const href = teamHref(team.teamKey);
            return (
              <li key={team.teamKey} className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink-muted">
                {href === null ? (
                  <span className="text-ink">{team.teamKey}</span>
                ) : (
                  <a
                    href={href}
                    className="text-ink underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    {team.teamKey}
                  </a>
                )}
                <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                  {team.mergedItemCount} of {team.itemCount} here
                </span>
              </li>
            );
          })}
        </ul>
      </header>

      {rendered.sections.length === 0 ? (
        <p className="stated-absence mt-10 text-[17px] leading-relaxed">
          No finding on any of these teams crossed a threshold worth your morning.
        </p>
      ) : (
        <div className="mt-10 space-y-8">
          {rendered.sections.map((section) => (
            <section
              key={section.key}
              aria-labelledby={`merged-${section.key}`}
              className="hairline pt-6 first:border-t-0 first:pt-0"
            >
              <h2 id={`merged-${section.key}`} className="section-label flex items-baseline gap-2">
                <span className="font-mono tabular-nums">{section.numeral}</span>
                <span>{section.title}</span>
              </h2>

              <ul className="mt-4 space-y-4">
                {section.lines.map((line) => (
                  <li key={line.stableId} className="border-l border-rule-strong pl-4">
                    <p className="prose-narration">{line.prose}</p>
                    {/*
                      The link down, by the per-team item's own stable id. This is the whole difference
                      between a merged report and a summary: the reader can reach the claim itself, with
                      its evidence chain and its notches, in one tap.
                    */}
                    <p className="mt-1 text-[13px]">
                      <a
                        href={itemHref(line.teamKey, line.stableId)}
                        className="tertiary-action"
                        aria-label={`Open this finding in the ${line.teamKey} report`}
                      >
                        in the {line.teamKey} report
                      </a>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <footer className="hairline mt-10 pt-6">
        {rendered.omittedLine.length > 0 && (
          <p className="prose-narration text-[15px] text-ink-muted">{rendered.omittedLine}</p>
        )}
        {/*
          The budget, checkable. A promise a reader can verify is worth more than one they are told about,
          and this is the number `docs/budgets.md` documents and the renderer enforces.
        */}
        <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
          {rendered.wordCount} / {rendered.wordBudget} words
        </p>
        <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
          <a href="/archive" className="tertiary-action">
            the archive
          </a>
          <a href="/weekly" className="tertiary-action">
            weekly digest
          </a>
        </p>
      </footer>
    </div>
  );
}
