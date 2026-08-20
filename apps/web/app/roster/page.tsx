import { headers } from 'next/headers';

import { RosterScreen } from '../../components/roster-screen';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';
import { UNAVAILABLE_SENTENCE } from '../../lib/auth/http';
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
 * exactly as `/` and `/settings/members` do.
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
 * `MembersFrame` on `/settings/members`.
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
  try {
    roster = await readRoster(access.scoped, access.now);
  } catch (error) {
    /*
      Logged, never rendered — the same split `guard()`, `pageAccess()` and `failure()` make.

      A driver or connection error's `message` carries host, port, user and sometimes the
      database name, which is why `UNAVAILABLE_SENTENCE` exists and why `http.ts` says so next
      to it. This branch used to render `error.message`, and that was survivable only while the
      matrix gated this route to owner and manager. It no longer does: on the demonstration
      tenant an anonymous reader reaches this line, so the driver's words would go to a stranger.

      Rendering the same constant `pageAccess` hands back as `access.detail` also makes the two
      failure branches on this page say one thing rather than two.
    */
    console.error(
      `[compass] /roster could not read the configuration: ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }

  if (roster === null) {
    return (
      <Frame heading="The configuration could not be read">
        <StatedFailure detail={`${UNAVAILABLE_SENTENCE} Nothing has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  /*
    Who may change this, as opposed to read it.

    The matrix admits `public` here on the demonstration tenant, so being past the refusal above
    no longer implies a seat that can write. Owner and manager are exactly the principals the five
    `/api/roster/*` write rows name, so a control offered to anybody else would be a control its
    own endpoint refuses — which is the failure `RosterScreen`'s `canEdit` exists to prevent.

    Derived from the principal, the way `/me` and `/weekly` derive theirs. An inactive seat cannot
    reach this line at all: `authorize` refuses `seat_not_active` before it allows the route.
  */
  const canEdit = access.principal === 'owner' || access.principal === 'manager';

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
          {!canEdit && (
            // Stated in the prose voice, in the reading column, as a fact about this reader —
            // never a greyed-out page or a banner. The document is the point; the controls are not.
            <p className="stated-absence mt-3 text-[15px]">
              You are reading this without a seat, so it is the configuration as it stands and nothing here can be
              changed. Every figure the report cites resolves against exactly these teams, links and absences.
            </p>
          )}
          <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
            <a href="/" className="tertiary-action">
              ← today&apos;s report
            </a>
            <a href="/goals" className="tertiary-action">
              goal hierarchy
            </a>
            {canEdit ? (
              <a href="/settings/members" className="tertiary-action">
                seats
              </a>
            ) : (
              /*
                The way out for a reader with no seat.

                Named here rather than left to the report's footer: `apps/web/tests/demo-credentials.test.tsx`
                holds every publicly-readable page to offering a route to the credentials, and a
                reader who came to this screen to check an attribution they believe is wrong is
                exactly the one who then needs to sign in and correct it.
              */
              <a href="/account" className="tertiary-action">
                sign in to change any of this
              </a>
            )}
          </p>
        </>
      }
    >
      <RosterScreen roster={roster} canEdit={canEdit} />
    </Frame>
  );
}
