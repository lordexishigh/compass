import { formatCivilDate, toIso } from '@compass/clock';
import { headers } from 'next/headers';

import { GoalQuickEntry, TeamQuickSetup } from '../../components/first-report-path';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';
import { firstRunMinutes, outstandingSteps, readFirstRunReadiness } from '../../lib/first-run-source';
import { requestedRun } from '../../lib/report-source';

/**
 * `/start` — the path from a new organization to its first report.
 *
 * ## Why this is a page of prose with four forms in it, and not a wizard
 *
 * A wizard is a sequence that owns the reader: it decides what they see next, hides what they
 * have not reached, and cannot be left half way without losing its place. That is the wrong
 * shape for this, for a reason particular to Compass: **the steps are not really sequential.**
 * A manager who already has a Jira project needs step 02 and nothing else; somebody
 * evaluating the product wants to skip all four and read the seeded report. So the whole path
 * is one page, every step is visible whether or not it is done, and each one states what is
 * *currently true* rather than whether the reader has visited it. Leaving and coming back
 * costs nothing, because the page is a view of the configuration rather than a position in a
 * flow.
 *
 * It is also, deliberately, not on the way to anything. Nothing redirects here. `/` renders
 * the report; if there is genuinely no organization to report on, it explains that and offers
 * this page as a link. That ordering is the zero-config promise: the demonstration tenant
 * never sees this screen at all, because all four steps are already done for it.
 *
 * ## The numbers on the page
 *
 * Each step carries its minutes, and the header sums them. That claim is the product's answer
 * to "how long is this going to take me", and a setup path that will not say is one a manager
 * puts off. `tests/first-run.test.tsx` holds the sum under ten.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'First report — Compass',
};

function StartFrame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">first report</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );
}

export default async function StartPage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/start', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <StartFrame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No configuration has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </StartFrame>
    );
  }

  if (!access.allowed) {
    return (
      <StartFrame heading="Setting this up needs a seat">
        <StatedFailure
          detail={
            access.reason ??
            'Every step here writes configuration a report is computed from, so it is owner and manager only.'
          }
        >
          <a href="/account" className="tertiary-action">
            sign in
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </StartFrame>
    );
  }

  const readiness = await readFirstRunReadiness({
    scoped: access.scoped,
    organizationId: access.organizationId,
    now: access.now,
  });
  const outstanding = outstandingSteps(readiness);
  // The zone this deployment serves, from the same resolver the report edge uses — so the
  // "what quarter is it" default and the report's own idea of "yesterday" cannot disagree.
  const timezone = requestedRun().timezone;
  const today = formatCivilDate(access.now, timezone);

  const stepById = new Map(readiness.steps.map((step) => [step.id, step]));

  /** The heading for each step, with its state and budget in mono beside it. */
  const StepHeading = ({ id }: { readonly id: 'source' | 'team' | 'goals' | 'roster' }) => {
    const step = stepById.get(id);
    if (step === undefined) return null;

    return (
      <>
        <p className="section-label flex flex-wrap items-baseline gap-x-3">
          <span className="font-mono tabular-nums">{step.ordinal}</span>
          <span>{step.title}</span>
          <span className="font-mono tabular-nums text-ink-faint">~{step.minutes} min</span>
          {step.state === 'done' && (
            <span className="inline-flex items-baseline gap-1 font-mono text-[11px] normal-case text-verified-text">
              <span aria-hidden="true">▍</span>done
            </span>
          )}
        </p>
        <p className={step.state === 'done' ? 'prose-narration mt-3 text-[15px]' : 'stated-absence mt-3 text-[15px] leading-relaxed'}>
          {step.summary}
        </p>
      </>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">first report</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          {readiness.ready ? 'Everything a report needs is in place' : 'Four steps to your first report'}
        </h1>

        <p className="prose-narration mt-3">
          {readiness.ready
            ? 'Every step below is done, so Compass has a team to report on, a chain to measure work against and people ' +
              'to attribute it to. The daily is generated on the team’s own schedule; opening it now generates today’s ' +
              'if nobody has yet.'
            : `About ${firstRunMinutes(readiness)} minutes of typing, in this order, and none of it needs anybody from ` +
              'Compass. Each step says what is true right now rather than whether you have been here before, so you can ' +
              'stop after any of them and come back.'}
        </p>

        {readiness.demonstration && (
          <p className="stated-absence mt-4 text-[15px] leading-relaxed">
            This is the seeded demonstration organization, so all four steps were done for you at boot — the dataset, the
            teams, the goal chain and twelve people with their identifiers. What follows is what a real organization
            would do, and every form on it works against this tenant too.
          </p>
        )}

        <p className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
          <a href="/roster" className="tertiary-action">
            full configuration
          </a>
          <a href="/goals" className="tertiary-action">
            goal hierarchy
          </a>
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      <section id="source" className="hairline mt-12 pt-8">
        <StepHeading id="source" />

        <p className="prose-narration mt-4 text-[15px]">
          Compass reads through one connector interface, and nothing above it can tell which provider answered. That is
          why there are two honest ways to start and neither is a lesser one:
        </p>

        <ul className="mt-5 space-y-5">
          <li className="border-l border-rule-strong pl-4">
            <p className="text-[15px] text-ink-strong">Read the seeded dataset</p>
            <p className="prose-narration mt-1 text-[15px]">
              A declared, checked-in dataset of three projects, twelve developers and five sprints, with real
              pathologies in it — a review bottleneck, a slipping release, a ticket reported blocked that had already
              merged. It is loaded automatically on first boot, so this step is already done if you have a report.
            </p>
            <p className="mt-2 text-[13px]">
              <a href="/" className="tertiary-action">
                read the seeded report →
              </a>
            </p>
          </li>
          <li className="border-l border-rule-strong pl-4">
            <p className="text-[15px] text-ink-strong">Name your own repositories and projects</p>
            <p className="prose-narration mt-1 text-[15px]">
              The GitHub and Jira connectors are configuration rather than code — they implement the same port the
              seeded provider does. Once a source has been read once, its repositories and projects appear on the
              configuration screen, where tracking one is a single decision per source.
            </p>
            <p className="stated-absence mt-2 text-[13px] leading-relaxed">
              Until a live connector is configured, Compass says so on <span className="font-mono not-italic">/api/health</span>{' '}
              rather than showing an empty board and letting you conclude your team did nothing.
            </p>
            <p className="mt-2 text-[13px]">
              <a href="/roster" className="tertiary-action">
                tracked sources →
              </a>
            </p>
          </li>
        </ul>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section id="team" className="hairline mt-12 pt-8">
        <StepHeading id="team" />

        <p className="prose-narration mt-4 text-[15px]">
          A team is what a daily report is <em>about</em>: it carries the board, the cadence and the working week every
          threshold in the product is measured in. Compass will not infer one from who commits together — that would put
          somebody else&apos;s merge in this team&apos;s Yesterday, and it would be wrong quietly.
        </p>

        <TeamQuickSetup defaultTimezone={timezone} />
      </section>

      {/* ------------------------------------------------------------------ */}
      <section id="goals" className="hairline mt-12 pt-8">
        <StepHeading id="goals" />

        <p className="prose-narration mt-4 text-[15px]">
          This is the one thing no connector can report, and the one that makes the difference between a status summary
          and a report that can say <em>this work does not serve the current objective</em>. Two lines are enough to
          start: what the company is trying to do, and what this sprint is for.
        </p>

        <GoalQuickEntry today={today} effectiveFrom={toIso(access.now)} />
      </section>

      {/* ------------------------------------------------------------------ */}
      <section id="roster" className="hairline mt-12 pt-8">
        <StepHeading id="roster" />

        <p className="prose-narration mt-4 text-[15px]">
          One person commits under several git addresses, files under one tracker account and talks under one chat
          handle. Compass attributes an artifact only when a declared identifier matches exactly — never a similar name
          — so unclaimed identifiers collect in a queue rather than being guessed at, and the report asks about the work
          instead of crediting the wrong person.
        </p>

        {readiness.unmatchedCount > 0 ? (
          <p className="prose-narration mt-4 text-[15px]">
            <span className="font-mono tabular-nums text-ink-strong">{readiness.unmatchedCount}</span> identifier
            {readiness.unmatchedCount === 1 ? ' is' : 's are'} waiting to be claimed. Merging one is reversible: the
            merge records exactly what it changed, so undoing it restores the prior attribution rather than guessing at
            it.
          </p>
        ) : (
          <p className="stated-absence mt-4 text-[15px] leading-relaxed">
            Nothing is waiting to be claimed. The queue fills as soon as a source is read and an address appears that no
            configured person holds.
          </p>
        )}

        <p className="mt-5">
          <a href="/roster#roster-identities" className="primary-action">
            Open the identity roster
          </a>
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="hairline mt-12 pt-8">
        <p className="section-label">then</p>
        {readiness.ready ? (
          <>
            <p className="prose-narration mt-3">
              Nothing is outstanding. Compass generates each team&apos;s daily on that team&apos;s own schedule and
              keeps every one of them permalinked, so the next thing worth doing is reading today&apos;s and telling it
              where it is wrong — a dismissed risk stays dismissed, and it says why if it ever comes back.
            </p>
            <p className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
              <a href="/" className="primary-action">
                Read the report
              </a>
              <a href="/archive" className="tertiary-action">
                the archive
              </a>
              <a href="/seats" className="tertiary-action">
                invite a colleague
              </a>
            </p>
          </>
        ) : (
          <>
            <p className="prose-narration mt-3">
              {outstanding.length === 1
                ? 'One step is outstanding:'
                : `${outstanding.length} steps are outstanding:`}{' '}
              {outstanding.map((step) => step.title.toLowerCase()).join('; ')}. A report generated before they are done
              is not wrong, but it will state what it could not resolve rather than resolving it.
            </p>
            <p className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
              <a href={`#${outstanding[0]?.id ?? 'source'}`} className="primary-action">
                {`Continue with ${outstanding[0]?.ordinal ?? '01'}`}
              </a>
              <a href="/" className="tertiary-action">
                read the report anyway
              </a>
            </p>
          </>
        )}
      </section>
    </div>
  );
}
