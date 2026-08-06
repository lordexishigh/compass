import { headers } from 'next/headers';

import { RosterScreen } from '../../components/roster-screen';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';
import { readRoster } from '../../lib/roster-source';

/**
 * `/roster` — the configuration every aggregate in the product is computed from.
 *
 * Team scoping decides which work appears in which report, and a wrong identity merge
 * corrupts attribution in every downstream report until somebody un-merges it. So this
 * screen is not a settings page tucked behind a gear icon: it is where a manager goes when
 * a report says something they know is wrong, and it has to be legible enough that they can
 * see *why* it said it.
 *
 * Set in the report's own typography rather than a settings idiom, for that reason. Six
 * sections of prose and lists, one measure, read top to bottom — the same shape as the
 * document it configures.
 *
 * A Server Component that reads the store directly and hands a value to one client island,
 * exactly as `/` and `/seats` do.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Roster — Compass',
};

/**
 * The one wrapper every outcome of this route renders in — the three refusals and the screen
 * itself.
 *
 * `lede` sits inside the `<header>` alongside the heading, because on the success path the
 * standfirst and the cross-links are part of the masthead. `children` sits outside it: the
 * body of a refusal is a `role="alert"`, and an alert nested inside a banner reads oddly to a
 * screen reader — the heading is the landmark, the sentence is the content. Same reasoning as
 * `SeatsFrame` on `/seats`.
 */
function Frame({
  heading,
  lede,
  children,
}: {
  readonly heading: string;
  readonly lede?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[52rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">roster</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
        {lede}
      </header>
      {children}
    </div>
  );
}

export default async function RosterPage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/roster', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <Frame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No configuration has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  if (!access.allowed) {
    return (
      <Frame heading="Not yours to change">
        {/* The same sentence `/api/roster` answers with, from the same matrix — so the
            screen and the endpoint cannot disagree about who may read this. */}
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/account" className="tertiary-action">
            sign in
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  let roster: Awaited<ReturnType<typeof readRoster>> | null = null;
  let unreadable: string | null = null;
  try {
    roster = await readRoster(access.scoped, access.now);
  } catch (error) {
    unreadable = error instanceof Error ? error.message : 'The configuration could not be read.';
  }

  if (roster === null) {
    return (
      <Frame heading="The configuration could not be read">
        <StatedFailure detail={`${unreadable} Nothing has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  return (
    <Frame
      heading="What the reports are computed from"
      lede={
        <>
          <p className="prose-narration mt-3">
            Teams decide which work appears in which report. Identity links decide whose work it is. A working calendar
            decides what &ldquo;three working days&rdquo; means. Every change here is an append: the previous version
            stays on disk, so a report generated for a past instant still resolves the configuration that was in force
            then.
          </p>
          <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
            <a href="/" className="tertiary-action">
              ← today&apos;s report
            </a>
            <a href="/goals" className="tertiary-action">
              goal hierarchy
            </a>
            <a href="/settings/members" className="tertiary-action">
              seats
            </a>
          </p>
        </>
      }
    >
      <RosterScreen roster={roster} />
    </Frame>
  );
}
