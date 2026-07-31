import { ROLE_CAPABILITIES, readSeats, seatReadiness } from '@compass/auth';
import { listEntityRows, teams } from '@compass/db';
import { headers } from 'next/headers';

import { SeatManager, type SeatView } from '../../components/seat-manager';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';

/**
 * `/seats` — who can read this organization's reports.
 *
 * Owner and manager, and the difference between them is visible rather than hidden: a
 * manager gets the same list with no controls, and a sentence saying so. Showing a
 * manager an empty screen would make them think the feature was broken; showing them the
 * controls and refusing the click would be worse.
 *
 * Access comes from `pageAccess`, which asks the same `ROLE_MATRIX` the endpoints ask. A
 * screen that rendered data its API refuses is the leak the matrix exists to prevent, so
 * the page and `/api/seats` cannot disagree by construction.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Seats — Compass',
};

/**
 * The frame the two refusal outcomes share.
 *
 * `heading` is inside the `<header>` and `children` deliberately outside it: the body of a
 * refusal is a `role="alert"`, and an alert nested inside a banner reads oddly to a screen
 * reader — the heading is the landmark, the sentence is the content.
 */
function SeatsFrame({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">seats</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">{heading}</h1>
      </header>
      {children}
    </div>
  );
}

export default async function SeatsPage() {
  const cookieHeader = (await headers()).get('cookie');

  // Deciding whether you may read this needs the database. `pageAccess` returns an
  // `unavailable` arm rather than throwing, so an owner arriving during an outage gets a
  // sentence instead of the framework's error page.
  const access = await pageAccess({ route: '/seats', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <SeatsFrame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} No seat has been changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </SeatsFrame>
    );
  }

  if (!access.allowed) {
    return (
      <SeatsFrame heading="Not yours to read">
        {/* Stated in the product's voice, in the reading column. Never an illustrated
            error page, and never a redirect that loses where the person was going —
            `access.reason` comes from the same matrix the endpoints answer with, so the
            sentence here and the 403 body are the same sentence. */}
        <StatedFailure detail={access.reason ?? 'Your role does not permit this.'}>
          <a href="/account" className="tertiary-action">
            sign in
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </SeatsFrame>
    );
  }

  const seats = await readSeats(access.scoped);
  const readiness = await seatReadiness(access.scoped);
  const canManage = access.principal === 'owner';

  // The teams a scope can name are the teams that have actually been ingested, so the
  // form cannot offer a key that will never match a report.
  const teamRows = await listEntityRows(access.scoped, teams);
  const knownTeamKeys = teamRows.map((row) => row.naturalKey).sort();

  const views: readonly SeatView[] = seats.map((seat) => ({
    membershipId: seat.id,
    email: seat.email,
    displayName: seat.displayName,
    role: seat.role,
    status: seat.status,
    hasPassword: seat.hasPassword,
    teamKeys: seat.teamKeys,
    invitedAtLabel: new Date(seat.createdAt).toISOString().slice(0, 10),
    isYou: seat.userId === access.identity?.user.id,
  }));

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">seats</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          Who can read these reports
        </h1>
        <p className="prose-narration mt-3">
          A seat is a role and a set of teams. The role decides what someone can do; the teams decide which reports they
          can read at all. Owners are unscoped, because an owner locked out of their own organization would have no way
          back in.
        </p>
        <p className="mt-3 text-[13px] text-ink-muted">
          <span className="font-mono tabular-nums">{readiness.owners}</span> owner
          {readiness.owners === 1 ? '' : 's'},{' '}
          <span className="font-mono tabular-nums">{readiness.activeSeats}</span> active seat
          {readiness.activeSeats === 1 ? '' : 's'},{' '}
          <span className="font-mono tabular-nums">{readiness.pendingInvitations}</span> pending invitation
          {readiness.pendingInvitations === 1 ? '' : 's'}.
        </p>
        {!canManage && (
          <p className="stated-absence mt-3 text-[13px]">
            You are a manager, so this list is read-only. Changing a role, inviting someone or removing a seat is an
            owner&apos;s act — every one of them is written to the audit log with who did it.
          </p>
        )}
        <p className="mt-4 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
          <a href="/account" className="tertiary-action">
            your seat
          </a>
        </p>
      </header>

      <SeatManager
        seats={views}
        canManage={canManage}
        knownTeamKeys={knownTeamKeys}
        roleCapabilities={ROLE_CAPABILITIES}
      />
    </div>
  );
}
