import { SECTIONS, sectionCounts } from '@compass/analysis';

import { FreshnessLine } from '../components/freshness-line';
import { ReportSectionBlock } from '../components/report-section';
import { SeededHistoryNote } from '../components/seeded-history-note';
import { SixSpine } from '../components/six-spine';
import { describeWindow, loadFoundationView } from '../lib/foundation-report';

/**
 * `/` — the report view.
 *
 * There is no login wall and no empty state: the page renders the six fixed
 * sections and states, in the product's own voice, exactly what it does and does
 * not yet know. The freshness line is real — it comes from the connector port's
 * source-health report for the team's previous civil day.
 */
export const dynamic = 'force-dynamic';

export default async function ReportPage() {
  const view = await loadFoundationView();
  const counts = new Map(sectionCounts(view.report).map((entry) => [entry.key, entry.count]));

  const entries = SECTIONS.map((section) => ({
    key: section.key,
    numeral: section.numeral,
    title: section.title,
    count: counts.get(section.key) ?? 0,
  }));

  return (
    <div className="mx-auto grid w-full max-w-[76rem] grid-cols-1 gap-x-16 px-5 pb-24 lg:grid-cols-[var(--spine)_minmax(0,var(--measure))_var(--gutter)] lg:px-8">
      <div className="lg:pt-16">
        <SixSpine entries={entries} initialActiveKey="yesterday" />
      </div>

      <main id="report" className="pt-8 lg:pt-16">
        <header>
          <p className="section-label">
            {view.report.scope.kind === 'team' ? view.report.scope.teamKey : 'all teams'}
          </p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
            <span className="font-mono tabular-nums">{view.reportDate}</span>
          </h1>
          <FreshnessLine
            notes={view.report.coverage}
            observedAt={view.observedAt}
            windowLabel={describeWindow(view.window, view.timezone)}
          />
        </header>

        <div className="mt-10 hairline pt-8">
          <p className="prose-narration">
            Compass has no report for you yet. What it does have is the substrate: the <strong>Clock port</strong>, the
            time-windowed <strong>connector port</strong>, and behind it a seeded organization of{' '}
            <span className="font-mono tabular-nums">{view.recordCount.toLocaleString('en-GB')}</span> artifacts —
            commits, pull requests, reviews, tickets, sprints and conversation. The sources above answered through that
            port, not from a fixture read at render time.
          </p>
          <SeededHistoryNote
            datasetWindow={view.datasetWindow}
            coversWindow={view.datasetCoversWindow}
            timezone={view.timezone}
          />
          <p className="prose-narration mt-4">
            The six sections below are the ones you will read every morning, in this order, forever. They are empty
            because the analysis core that fills them is the next piece of work, and Compass would rather say so than
            show you a number it cannot stand behind.
          </p>
        </div>

        <div className="mt-10 space-y-10">
          {view.report.sections.map((section, position) => (
            <div key={section.key} className="hairline pt-8 first:border-t-0 first:pt-0">
              <ReportSectionBlock section={section} numeral={SECTIONS[position]?.numeral ?? '00'} />
            </div>
          ))}
        </div>

        <footer className="mt-16 hairline pt-6 text-[13px] text-ink-faint">
          <p>
            Rendered from the deterministic template — narration is not wired up yet, and Compass says so rather than
            hiding it.
          </p>
          <p className="mt-2">
            <a
              href="/api/health"
              className="underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-verified"
            >
              System readiness
            </a>
          </p>
        </footer>
      </main>

      {/* The evidence gutter: empty by default, filled when a claim is expanded. */}
      <aside aria-hidden="true" className="hidden lg:block lg:pt-16" />
    </div>
  );
}
