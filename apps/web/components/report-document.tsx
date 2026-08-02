import type { ReportView } from '../lib/view-model';

import { CalibrationCollar } from './calibration-collar';
import { FreshnessPanel } from './freshness-panel';
import { ReportSectionBlock } from './report-section';
import { SixSpine } from './six-spine';

/**
 * The attribute the cold-start inspector looks for. One per report, or none.
 *
 * Declared here and *asserted* against `@compass/smoke` in the view tests rather
 * than imported from it: `@compass/smoke` is a dev dependency of this app, so a
 * runtime import would put a test tool in the production bundle. The assertion is
 * what stops the two drifting.
 */
export const FALLBACK_NOTE_ATTRIBUTE = 'data-narration-fallback';

/**
 * The narration-fallback disclosure.
 *
 * A hairline note above the report, in 13px zinc-500 — the design brief's rule for
 * this exact case: *"narration fallback to the deterministic template renderer is
 * disclosed, not hidden"*. It is a sentence, not a warning banner, because nothing
 * is wrong with the report: every section, figure, notch and link is complete and
 * correct. Only the wording is templated, and a manager is entitled to know that
 * before they quote a sentence back to their team as Compass's own.
 *
 * `role="status"` rather than `alert`: this is a standing fact about the document,
 * not an event demanding attention, and an assertive live region would interrupt a
 * screen reader mid-heading for something that is not urgent.
 *
 * Rendered only when narration was *attempted* and fell back. A deployment with no
 * Anthropic key is templated by design and says so in the footer instead — telling
 * that reader something failed would be a fabrication of its own.
 */
function NarrationFallbackNote({ view }: { readonly view: ReportView }) {
  if (!view.fallbackRenderer) return null;

  return (
    <p
      {...{ [FALLBACK_NOTE_ATTRIBUTE]: 'true' }}
      role="status"
      className="hairline mt-4 pt-3 text-[13px] leading-relaxed text-ink-faint"
    >
      <span className="text-ink-muted">Rendered from template — narration unavailable.</span>{' '}
      Compass wrote this report with its own deterministic renderer because the narration model stated something the
      computed report did not contain, so its prose was discarded. Every figure, link and notch below is complete.
      {view.fallbackReason !== null && (
        <>
          {' '}
          <span className="stated-absence">{view.fallbackReason}</span>
        </>
      )}
    </p>
  );
}

/**
 * The whole report, from a value.
 *
 * Split out from `app/page.tsx` so the entire rendered document can be produced
 * in a test from a fixture — which is the only way "no chart, no canvas, six
 * headings in the fixed order, every claim linked" can be an assertion rather
 * than a promise. The page is then a four-line Server Component that resolves
 * the value and hands it here.
 */
export function ReportDocument({ view }: { readonly view: ReportView }) {
  const entries = view.sections.map((section) => ({
    key: section.key,
    numeral: section.numeral,
    title: section.title,
    count: section.items.length,
  }));

  return (
    <div className="mx-auto grid w-full max-w-[76rem] grid-cols-1 gap-x-16 px-5 pb-24 lg:grid-cols-[var(--spine)_minmax(0,var(--measure))_var(--gutter)] lg:px-8">
      <div className="lg:pt-16">
        <SixSpine entries={entries} initialActiveKey={view.sections[0]?.key} />
      </div>

      <main id="report" className="pt-8 lg:pt-16">
        <header>
          <p className="section-label">{view.scopeLabel}</p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
            <span className="font-mono tabular-nums">{view.reportDate}</span>
          </h1>
          <p className="mt-1 font-mono text-[13px] tabular-nums text-ink-faint">window {view.windowLabel}</p>

          {view.timeShiftNote !== null && (
            <p className="stated-absence mt-3 text-[13px]">{view.timeShiftNote}</p>
          )}

          <NarrationFallbackNote view={view} />

          <FreshnessPanel freshness={view.freshness} />

          {/*
            What moved since the previous report — the last thing in the masthead and the first
            sentence of the read. Set in the body serif rather than as a note, because on a quiet
            morning "Nothing material changed since yesterday" *is* the report: a manager who has
            that sentence in the first screenful does not scroll six sections to discover it, and a
            page that made them do so would be re-listing yesterday's three blockers in yesterday's
            voice — the failure the whole change-awareness pass exists to prevent.

            Empty means the report predates change-awareness. Rendered as nothing rather than as
            "nothing changed": those are different facts, and Compass does not state the second when
            it only knows the first.
          */}
          {view.changeLine.length > 0 && (
            <p className="prose-narration mt-6 text-[17px] text-ink-strong">{view.changeLine}</p>
          )}
        </header>

        <div className="mt-10 space-y-10">
          {view.sections.map((section) => (
            <div key={section.key} className="hairline pt-8 first:border-t-0 first:pt-0">
              <ReportSectionBlock section={section} />
            </div>
          ))}
        </div>

        {/*
          The confidence collar sits after the six sections rather than inside
          Progress, and that is deliberate on two counts. The Six Spine is fixed at
          six entries forever, so the collar must not become a seventh heading a
          reader scrolls to. And its job is to qualify the *whole* report — the
          audit's verdicts are about the data every section above was computed from
          — so it reads last, the way a footnote to the document rather than a
          paragraph inside one of its parts.
        */}
        <CalibrationCollar collar={view.collar} />

        <footer className="mt-16 hairline pt-6 text-[13px] text-ink-faint">
          <p>
            {view.narrated
              ? 'Written by the narration model, with every number, date, name and identifier checked against the ' +
                'computed report before publication'
              : 'Written by the deterministic template renderer'}{' '}
            (<span className="data-token">{view.rendererId}</span>), generated {view.generatedAtLabel} {view.timezone}.
            Every figure above carries a link to the artifact it came from.
          </p>
          <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            {/*
              The three other reads of the same data, first in the list because they are the only ones a
              manager reaches *habitually* — the rest of this footer is configuration you visit when
              something is wrong. A manager of two or three teams opens the merged report every morning
              instead of this page, and a page they cannot find from here is a page they will not find.
            */}
            <a
              href="/merged"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              All teams
            </a>
            <a
              href="/weekly"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Weekly digest
            </a>
            {/* Every past report, permalinked — how a manager points a skip-level at last Tuesday's. */}
            <a
              href="/archive"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Archive
            </a>
            {/* The goal hierarchy is reachable from the report because every
                alignment verdict above resolves against it, and a manager who
                disagrees with one needs somewhere to go and say so. */}
            <a
              href="/goals"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Goal hierarchy
            </a>
            {/* The configuration behind every aggregate above: which repositories are
                tracked, who is on the team, whose work each commit is. A manager who
                reads a wrong attribution needs somewhere to go and fix it. */}
            <a
              href="/roster"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Roster and configuration
            </a>
            {/* Reachable, never imposed. `/` gates nothing and never redirects here:
                the zero-config promise is that a manager reads a report first and
                decides about accounts afterwards. */}
            <a
              href="/account"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Account and sessions
            </a>
            <a
              href="/api/health"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              System readiness
            </a>
          </p>
        </footer>
      </main>

      {/* The evidence gutter: markers resolve to full pages, so this stays quiet. */}
      <aside aria-hidden="true" className="hidden lg:block lg:pt-16" />
    </div>
  );
}
