import {
  DEMO_OWNER_EMAIL,
  DEMO_OWNER_PASSWORD,
  ROLE_CAPABILITIES,
  SESSION_ABSOLUTE_TTL_DAYS,
  SESSION_IDLE_TTL_DAYS,
  ownerCredentialsAreDefault,
  sessionDeadline,
} from '@compass/auth';
import { listSessionsForUser } from '@compass/db';
import { headers } from 'next/headers';

import { AccountPanel, type AccountSessionView } from '../../components/account-panel';
import { SignInPanel } from '../../components/sign-in-panel';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess } from '../../lib/auth/guard';

/**
 * `/account` — sign in, or see the seat you already have.
 *
 * Not `/login`. That is not squeamishness about the word: `apps/web/tests/cold-start.test.tsx`
 * asserts that no `app/login`, `app/signin`, `app/setup` or `app/onboarding` directory
 * exists, because a route with one of those names is the shape of a gate on the way to
 * the report, and Compass's zero-config promise is that there is no such gate. This
 * screen is somewhere you *choose* to go, reachable from the report footer, and `/` never
 * redirects to it.
 *
 * A Server Component. Both halves are client islands because both hold field state, and
 * neither is on the report path.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Account — Compass',
};

export default async function AccountPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawProblem = params['problem'];
  const problem = Array.isArray(rawProblem) ? (rawProblem[0] ?? null) : (rawProblem ?? null);

  const cookieHeader = (await headers()).get('cookie');

  /**
   * Resolving who you are needs the database, and this screen has to answer even when it
   * cannot be reached — it is where somebody goes *because* something is wrong. So the
   * failure is caught and stated, rather than becoming the framework's error page.
   */
  let access: Awaited<ReturnType<typeof pageAccess>> | null = null;
  let unavailable: string | null = null;
  try {
    access = await pageAccess({ route: '/account', cookieHeader });
  } catch (error) {
    unavailable = error instanceof Error ? error.message : 'The account store could not be reached.';
  }

  if (access === null) {
    return (
      <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
        <header>
          <p className="section-label">account</p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
            Compass cannot reach its own records
          </h1>
        </header>
        <StatedFailure
          detail={`${unavailable} Nobody has been signed in or out, and nothing has been changed. Sign-in reads the same database the report does, so this is the same condition the report would report.`}
        >
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </div>
    );
  }

  const identity = access.identity;
  const sessions = identity === null ? [] : await sessionViews(access, identity.user.id, identity.session.id);

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">account</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          {identity === null ? 'Who is reading this report' : 'Your seat'}
        </h1>
        <p className="prose-narration mt-3">
          {identity === null
            ? 'Reports carry an organisation’s own data, so a seat decides which teams you can read. The demonstration report on the front page needs no seat at all.'
            : 'What Compass knows about you, which teams your seat can read, and every device it is signed in on.'}
        </p>
        <p className="mt-4 text-[13px]">
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </p>
      </header>

      {identity === null ? (
        <SignInPanel
          problem={problem}
          demoCredentials={
            ownerCredentialsAreDefault()
              ? { email: DEMO_OWNER_EMAIL, password: DEMO_OWNER_PASSWORD }
              : null
          }
        />
      ) : (
        <AccountPanel
          email={identity.user.email}
          displayName={identity.user.displayName}
          role={identity.membership.role}
          roleCapabilities={ROLE_CAPABILITIES[identity.membership.role]}
          teamKeys={identity.teamScopes}
          unscoped={identity.membership.role === 'owner'}
          hasPassword={identity.user.passwordHash !== null}
          canManageSeats={identity.membership.role === 'owner' || identity.membership.role === 'manager'}
          absoluteTtlDays={SESSION_ABSOLUTE_TTL_DAYS}
          idleTtlDays={SESSION_IDLE_TTL_DAYS}
          sessions={sessions}
        />
      )}
    </div>
  );
}

/**
 * The session list, formatted on the server.
 *
 * Dates are rendered here rather than in the client island for the reason the report
 * does the same: a component that formats a date needs a locale and a zone, and doing
 * it on the client makes the first paint disagree with the second.
 */
async function sessionViews(
  access: Awaited<ReturnType<typeof pageAccess>>,
  userId: string,
  currentSessionId: string,
): Promise<readonly AccountSessionView[]> {
  const sessions = await listSessionsForUser(access.scoped, userId);
  const label = (millis: number): string =>
    new Date(millis).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

  return sessions.map((session) => ({
    id: session.id,
    current: session.id === currentSessionId,
    issuedAtLabel: label(session.issuedAt),
    lastUsedAtLabel: label(session.lastUsedAt),
    endsAtLabel: label(sessionDeadline(session)),
    revokedReason: session.revokedReason,
    rotatedFrom: session.rotatedFromSessionId !== null,
  }));
}
