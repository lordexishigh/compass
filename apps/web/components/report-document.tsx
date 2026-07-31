import type { ReportView } from '../lib/view-model';

import { FreshnessPanel } from './freshness-panel';
import { ReportSectionBlock } from './report-section';
import { SixSpine } from './six-spine';

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

          <FreshnessPanel freshness={view.freshness} />
        </header>

        <div className="mt-10 space-y-10">
          {view.sections.map((section) => (
            <div key={section.key} className="hairline pt-8 first:border-t-0 first:pt-0">
              <ReportSectionBlock section={section} />
            </div>
          ))}
        </div>

        <footer className="mt-16 hairline pt-6 text-[13px] text-ink-faint">
          <p>
            Written by the deterministic template renderer (<span className="data-token">{view.rendererId}</span>),
            generated {view.generatedAtLabel} {view.timezone}. Every figure above carries a link to the artifact it
            came from.
          </p>
          <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            {/* The goal hierarchy is reachable from the report because every
                alignment verdict above resolves against it, and a manager who
                disagrees with one needs somewhere to go and say so. */}
            <a
              href="/goals"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Goal hierarchy
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
