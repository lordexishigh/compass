import type { FirstRunStep } from '../lib/first-run-source';

/**
 * What `/` renders when there is no organization to report on yet.
 *
 * ## Why this is not an empty report, and not an empty state either
 *
 * Compass has a firm rule that a quiet day is still six sections: a team that shipped nothing
 * yesterday gets Yesterday, Progress, Blockers, Risks, Recommendations and Wins with the
 * absences stated in prose, because "nothing happened" is a finding and a manager needs to
 * read it. `tests/cold-start.test.tsx` pins that, and this component does not weaken it.
 *
 * This is the other case, and it is genuinely different: no team and nobody, so there is no
 * subject. Six headings over an unconfigured organization would not be honest degradation —
 * it would be a *false* report, implying a quiet team where there is in fact no team. The
 * design brief's rule about stated absences applies to facts Compass tried to establish and
 * could not; it does not license asserting six of them about an org that has told Compass
 * nothing.
 *
 * So the page says which four things are missing, in the order they have to happen, and links
 * to the one screen that does them. It is still a document — one measure, prose, numbered
 * sections — and it still carries no spinner, no skeleton and no "get started" illustration.
 *
 * ## It is a link, not a redirect
 *
 * `/` never redirects. The reader lands where they meant to land and is told what is true.
 * That is the same rule that keeps a login wall off this route, and it holds here for the
 * same reason: a redirect makes the address you typed a lie.
 */
export function FirstReportGuide({
  steps,
  reportExists,
}: {
  readonly steps: readonly FirstRunStep[];
  /**
   * True when reports exist but the configuration behind them has since been emptied.
   *
   * Rare, and worth its own sentence rather than being folded into the general case: a reader
   * who was reading dailies last week and now sees this needs to know the archive is intact.
   */
  readonly reportExists: boolean;
}) {
  const outstanding = steps.filter((step) => step.state === 'todo');
  const minutes = outstanding.reduce((total, step) => total + step.minutes, 0);

  return (
    <main className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">compass</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          There is no report yet, because there is nothing to report on
        </h1>

        <p className="prose-narration mt-4">
          This organization has no team configured and nobody on it. Compass could print six empty headings and let you
          conclude your team had a quiet day — it will not: a report about an organization that has told it nothing
          would be a false one, and the whole product rests on the numbers in it being checkable.
        </p>

        <p className="prose-narration mt-3">
          Here is what is missing, in the order it has to happen. About{' '}
          <span className="font-mono tabular-nums text-ink-strong">{minutes}</span> minutes of typing in total, and none
          of it needs anybody from Compass.
        </p>
      </header>

      <ol className="mt-10 space-y-7">
        {outstanding.map((step) => (
          <li key={step.id} className="border-l border-rule-strong pl-4">
            <p className="section-label flex flex-wrap items-baseline gap-x-3">
              <span className="font-mono tabular-nums">{step.ordinal}</span>
              <span>{step.title}</span>
              <span className="font-mono tabular-nums text-ink-faint">~{step.minutes} min</span>
            </p>
            <p className="stated-absence mt-2 text-[15px] leading-relaxed">{step.summary}</p>
          </li>
        ))}
      </ol>

      {steps.some((step) => step.state === 'done') && (
        <p className="stated-absence mt-8 text-[15px] leading-relaxed">
          {steps
            .filter((step) => step.state === 'done')
            .map((step) => step.title.toLowerCase())
            .join('; ')}{' '}
          —— already done, so the path below starts from where you actually are.
        </p>
      )}

      <div className="hairline mt-10 flex flex-wrap items-center gap-x-5 gap-y-3 pt-8">
        <a href="/start" className="primary-action">
          Set this up
        </a>
        <a href="/account" className="tertiary-action">
          Account and sessions
        </a>
        <a href="/api/health" className="tertiary-action">
          system readiness
        </a>
      </div>

      {reportExists && (
        <p className="stated-absence mt-8 text-[15px] leading-relaxed">
          Reports Compass has already written are still in the archive, exactly as they were sent. The configuration
          behind them is what is empty, not the record.
        </p>
      )}
    </main>
  );
}
