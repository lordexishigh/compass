import { headers } from 'next/headers';

import { StatedFailure } from '../../components/stated-failure';
import { knownTeamKeys, loadWeeklyDigest } from '../../lib/archive-source';
import { defaultTeamKey, pageAccess } from '../../lib/auth/guard';

/**
 * `/weekly` — the weekly digest.
 *
 * ## Six topics, prose only
 *
 * Velocity trend, workload distribution, review bottlenecks, technical debt growth, upcoming risks and
 * suggested priorities — in that fixed order, every week, whether or not there is history behind each one.
 * A topic Compass cannot compute is rendered as the sentence saying what it is waiting for, not omitted
 * and not zeroed: a digest that silently dropped its undefined topics would read as a complete picture of
 * a week Compass does not have the history for.
 *
 * There is no chart here and nothing that could become one. Anything a sparkline would have shown is
 * either in the sentence or is a number the reader could not have acted on. Each topic also names the
 * analysis function that produced it, in mono at the foot of its paragraph — so a manager who disputes a
 * sentence can find the code that wrote it rather than filing a bug against "the dashboard".
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Weekly digest — Compass',
};

function WeeklyFrame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">weekly</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );
}

export default async function WeeklyDigestPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly team?: string }>;
}) {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/weekly', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <WeeklyFrame heading="Compass cannot reach its own records">
        <StatedFailure detail={access.detail}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </WeeklyFrame>
    );
  }

  if (!access.allowed) {
    return (
      <WeeklyFrame heading="Not yours to read">
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/account" className="tertiary-action">
            sign in
          </a>
        </StatedFailure>
      </WeeklyFrame>
    );
  }

  const known = await knownTeamKeys(access.scoped);

  /**
   * The teams this reader may see a digest for — existence *and* scope.
   *
   * Existence alone was not enough: a manager scoped to `platform` could read `checkout`'s weekly digest by
   * editing the query string, which is precisely the cross-team read `/api/reports/[teamKey]` refuses. A
   * seat with no scopes at all is unscoped by the matrix's own rule (`teamScopeAllows` treats an empty scope
   * list as "whatever this principal can see"), and an owner is team-unscoped, so both see every team.
   */
  const scopes = access.identity?.teamScopes ?? [];
  const unscoped = access.principal === 'owner' || scopes.length === 0;
  const teamKeys = unscoped ? known : known.filter((key) => scopes.includes(key));

  const requested = (await searchParams).team;
  // A requested team has to be one this reader may see. Falls back to their own first team, then the
  // deployment's default — never to a team they are not scoped to.
  const teamKey =
    requested !== undefined && teamKeys.includes(requested)
      ? requested
      : (teamKeys[0] ?? defaultTeamKey());

  if (teamKeys.length === 0) {
    // Two different absences, and a reader is owed the right one: nothing configured is somebody else's job
    // to fix on the roster, whereas a seat scoped to no existing team is a seat an owner needs to widen.
    return (
      <WeeklyFrame heading="No team to report on">
        <p className="stated-absence mt-3 text-[17px] leading-relaxed">
          {known.length === 0
            ? 'No team has been configured yet, so there is no week to summarise. Configure one on the roster screen.'
            : 'Your seat is not scoped to any of this organization’s teams, so there is no week to summarise for you. An owner can add a team to your seat.'}
        </p>
      </WeeklyFrame>
    );
  }

  const { digest, rendered } = await loadWeeklyDigest(access.organizationId, teamKey);

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">weekly · {teamKey}</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          Week ending <span className="font-mono tabular-nums">{rendered.weekEnding}</span>
        </h1>
        <p className="prose-narration mt-6 text-[17px] text-ink-strong">{rendered.summary}</p>

        {teamKeys.length > 1 && (
          <p className="mt-4 flex flex-wrap gap-x-4 text-[13px]">
            {teamKeys.map((key) => (
              <a
                key={key}
                href={`/weekly?team=${encodeURIComponent(key)}`}
                aria-current={key === teamKey ? 'page' : undefined}
                className={
                  key === teamKey
                    ? 'font-mono text-[13px] text-ink-strong underline decoration-verified underline-offset-4'
                    : 'tertiary-action font-mono'
                }
              >
                {key}
              </a>
            ))}
          </p>
        )}
      </header>

      <div className="mt-10 space-y-8">
        {rendered.topics.map((topic, position) => (
          <section
            key={topic.key}
            aria-labelledby={`topic-${topic.key}`}
            className="hairline pt-6 first:border-t-0 first:pt-0"
          >
            <h2 id={`topic-${topic.key}`} className="section-label flex items-baseline gap-2">
              <span className="font-mono tabular-nums">{String(position + 1).padStart(2, '0')}</span>
              <span>{topic.title}</span>
            </h2>

            {/*
              An undefined topic is set in the stated-absence voice — serif italic zinc — because it is a
              refusal to state a figure, not a finding. A stated one is body prose. The difference is
              typographic rather than a badge, which is the same rule the daily follows for "no deploy
              signal available".
            */}
            <p className={topic.state === 'undefined' ? 'stated-absence mt-3 text-[17px] leading-relaxed' : 'prose-narration mt-3'}>
              {topic.prose}
            </p>

            <p className="mt-2 font-mono text-[11px] text-ink-faint">
              computed by {topic.producer}
              {topic.state === 'undefined' ? ' · no figure stated' : ''}
            </p>
          </section>
        ))}
      </div>

      <footer className="hairline mt-10 pt-6">
        {digest.undefinedTopicKeys.length > 0 && (
          <p className="stated-absence text-[13px]">
            {digest.undefinedTopicKeys.length} of the {rendered.topics.length} topics have no figure yet. Each one above
            says what it is waiting for.
          </p>
        )}
        <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
          <a href="/merged" className="tertiary-action">
            merged report
          </a>
          <a href="/archive" className="tertiary-action">
            the archive
          </a>
        </p>
      </footer>
    </div>
  );
}
