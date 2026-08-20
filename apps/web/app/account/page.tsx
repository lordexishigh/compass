import {
  DEMO_OWNER_EMAIL,
  ROLE_CAPABILITIES,
  SESSION_ABSOLUTE_TTL_DAYS,
  SESSION_IDLE_TTL_DAYS,
  ownerConfigurationProblem,
  ownerCredentialsAreDefault,
  sessionDeadline,
  sessionRejection,
} from '@compass/auth';
import { listSessionsForUser } from '@compass/db';
import { headers } from 'next/headers';

import { AccountPanel, type AccountSessionView } from '../../components/account-panel';
import { DeliverySchedule } from '../../components/delivery-schedule';
import { SignInPanel } from '../../components/sign-in-panel';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess, type PageAccessResolved } from '../../lib/auth/guard';
import { deliveryOutcomeStatement, loadDeliveryView } from '../../lib/delivery-source';
import {
  buildLinkedIdentities,
  samlRefusalStatement,
  ssoButtons,
  ssoOutcomeStatement,
} from '../../lib/sso-source';

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
  const single = (key: string): string | null => {
    const raw = params[key];
    return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  };

  const problem = single('problem');

  /**
   * The outcome of a single-sign-on or SAML round-trip, as a sentence.
   *
   * Looked up from a slug rather than read out of the query string. `lib/sso-source.ts` records the
   * reason at length: a `detail` parameter this page printed would let anybody hand somebody a Compass
   * URL that displays arbitrary text in Compass's own typography, on Compass's own domain.
   */
  const ssoStated = ssoOutcomeStatement(single('sso')) ?? samlRefusalStatement(single('saml'));

  /**
   * A half-finished sign-in that owes a code, handed back by an SSO or SAML callback.
   *
   * Carried in the URL, which is acceptable rather than merely convenient: it is a five-minute signed
   * ticket that authorises exactly one act — presenting a code for one user — and it is worthless
   * without the code, whose own replay rejection is durable in the database.
   */
  const pendingChallenge = single('challenge');

  const cookieHeader = (await headers()).get('cookie');

  /**
   * Resolving who you are needs the database, and this screen has to answer even when it
   * cannot be reached — it is where somebody goes *because* something is wrong.
   *
   * `pageAccess` never throws; it returns an `unavailable` arm instead, so the failure is
   * a value this page has to handle rather than an exception it might forget to catch.
   */
  const access = await pageAccess({ route: '/account', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
        <header>
          <p className="section-label">account</p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
            Compass cannot reach its own records
          </h1>
        </header>
        <StatedFailure
          detail={`${access.detail} Nobody has been signed in or out. Sign-in reads the same database the report does, so this is the same condition the report would report.`}
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
        /**
         * The address, never the password — because this process does not have it.
         *
         * There used to be a published owner-password constant to print here. Removing it from
         * shipped source removed the only way the *web* process could know an unconfigured
         * deployment's password: it is minted by the worker on the boot that creates the seat,
         * hashed into the database with Argon2id, and printed once. The web app cannot read it
         * back, and it should not be able to.
         *
         * So the panel now states where to find it instead of showing it — which is the more
         * honest rendering anyway, and the one the design brief asks for: a stated fact in the
         * product's voice rather than a credential on a page anybody can open.
         *
         * A half-configured environment is still mutually exclusive with this: `bootstrapOwner`
         * refuses to provision on it, so there is no seat at any address, and naming one would
         * let a reader conclude the product is broken rather than the deployment misconfigured.
         */
        <SignInPanel
          // A refused round-trip is a rejected sign-in attempt, so it is stated where every other
          // rejection is — in the panel, rather than in a second notice above it.
          problem={problem ?? ssoStated}
          configurationProblem={ownerConfigurationProblem()}
          generatedOwnerEmail={
            ownerConfigurationProblem() === null && ownerCredentialsAreDefault() ? DEMO_OWNER_EMAIL : null
          }
          ssoProviders={ssoButtons()}
          pendingChallenge={pendingChallenge}
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

      {/*
        The manager's own daily: when it arrives, where, and how to stop it.

        Here rather than on `/` because it is a fact about *you* rather than about the report, and
        this is the screen the report footer already sends people to for those. Above single
        sign-on because switching the daily on is the thing a new manager came to do — the whole
        product is one report a day, and until this is set they have to remember to come and read
        it.
      */}
      {identity !== null && (
        <DeliverySchedule
          view={await loadDeliveryView({
            scoped: access.scoped,
            userId: identity.user.id,
            teamKeys: identity.teamScopes,
            accountEmail: identity.user.email,
          })}
          stated={deliveryOutcomeStatement(single('delivery'))}
        />
      )}

      {/*
        Linked sign-in providers, for a seat that already has one.
        Below the panel rather than inside it, because it is a fact about the account rather than a way
        of getting into it — and because a signed-in reader is here to audit, not to sign in.
      */}
      {identity !== null && (
        <LinkedIdentitiesPanel
          identities={await buildLinkedIdentities({ scoped: access.scoped, userId: identity.user.id })}
          hasPassword={identity.user.passwordHash !== null}
          stated={ssoStated}
        />
      )}
    </div>
  );
}

/**
 * Which providers this account can sign in with, and the way to add or remove one.
 *
 * ## Why unlinking asks for the password here
 *
 * The route requires it, and this form has to say so rather than surprise somebody with a 403. The
 * reason is the one the route records: for an account whose only credential is the provider link,
 * unlinking is a lockout — so a stolen session must not be able to remove somebody's way back in.
 *
 * An account with no password at all is told that plainly and offered the reset form, because there is
 * no credential to re-authenticate with and a disabled button with no explanation is the worst of the
 * available options.
 */
function LinkedIdentitiesPanel({
  identities,
  hasPassword,
  stated,
}: {
  readonly identities: readonly Awaited<ReturnType<typeof buildLinkedIdentities>>[number][];
  readonly hasPassword: boolean;
  readonly stated: string | null;
}) {
  return (
    <section aria-labelledby="linked-identities" className="mt-12 hairline pt-6">
      <h2 id="linked-identities" className="section-label">
        single sign-on
      </h2>
      <p className="prose-narration mt-3 text-[15px]">
        A linked provider is an additional way into this account, not a replacement for your password.
        Linking and unlinking are both on your account&apos;s record.
      </p>

      {stated !== null && (
        <p role="status" className="prose-narration mt-5 border-l-2 border-verified pl-3 text-[15px]">
          {stated}
        </p>
      )}

      <ul className="mt-5">
        {identities.map((entry) => (
          <li key={entry.provider} className="hairline-top py-4 first:border-t-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-ink-strong">{entry.name}</span>
              <span className="stated-absence text-[13px]">
                {entry.linked
                  ? entry.lastSignInAt === null
                    ? `linked as ${entry.email ?? 'an address it did not state'}, never used to sign in`
                    : `linked as ${entry.email ?? 'an address it did not state'}, last used ${new Date(
                        entry.lastSignInAt,
                      )
                        .toISOString()
                        .slice(0, 10)}`
                  : 'not linked'}
              </span>
            </div>

            {entry.unavailableReason !== null ? (
              <p className="stated-absence mt-2 text-[13px] leading-relaxed">{entry.unavailableReason}</p>
            ) : entry.linked ? (
              <form method="post" action="/api/auth/sso/unlink" className="mt-3">
                <input type="hidden" name="provider" value={entry.provider} />
                <label className="block" htmlFor={`unlink-${entry.provider}`}>
                  <span className="section-label">your password, to unlink</span>
                </label>
                <input
                  id={`unlink-${entry.provider}`}
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="goal-input max-w-[20rem]"
                  disabled={!hasPassword}
                  aria-describedby={hasPassword ? undefined : `unlink-hint-${entry.provider}`}
                />
                {!hasPassword && (
                  <p id={`unlink-hint-${entry.provider}`} className="stated-absence mt-2 text-[13px]">
                    This account has no password, so there is nothing to re-authenticate with — and
                    unlinking would lock you out.{' '}
                    <a href="/account/reset" className="tertiary-action">
                      set one first
                    </a>
                    .
                  </p>
                )}
                <button type="submit" disabled={!hasPassword} className="tertiary-action mt-3">
                  unlink {entry.name}
                </button>
              </form>
            ) : (
              <p className="mt-3">
                {/* A link, not a fetch: the round-trip is a top-level navigation to the provider. */}
                <a href={entry.startPath} className="tertiary-action">
                  link {entry.name} to this account →
                </a>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The session list, formatted on the server.
 *
 * Dates are rendered here rather than in the client island for the reason the report does
 * the same: a component that formats a date needs a locale and a zone, and doing it on
 * the client makes the first paint disagree with the second.
 *
 * `live` is decided here too, and for a sharper reason. Whether a session would still be
 * honoured is a comparison against *this request's* instant and against `sessionDeadline`,
 * which is where the 30-day and 14-day rules meet. The client cannot make that comparison
 * — it has no injected clock and no business holding one — and a client that guessed from
 * "nothing revoked it" would count an expired session as live, so "sign out everywhere
 * (N live)" would name a number that included sessions which ended themselves days ago.
 */
async function sessionViews(
  access: PageAccessResolved,
  userId: string,
  currentSessionId: string,
): Promise<readonly AccountSessionView[]> {
  const sessions = await listSessionsForUser(access.scoped, userId);
  const label = (millis: number): string =>
    new Date(millis).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

  return sessions.map((session) => {
    const rejection = sessionRejection(session, access.now);

    return {
      id: session.id,
      current: session.id === currentSessionId,
      issuedAtLabel: label(session.issuedAt),
      lastUsedAtLabel: label(session.lastUsedAt),
      endsAtLabel: label(sessionDeadline(session)),
      revokedReason: session.revokedReason,
      rotatedFrom: session.rotatedFromSessionId !== null,
      live: rejection === null,
      // The two deadlines are told apart on purpose: "you have not used Compass in two
      // weeks" and "this session was opened a month ago" are different facts about the
      // world, and a person auditing their own devices is entitled to which one it was.
      endedBecause:
        rejection === 'expired'
          ? `${SESSION_ABSOLUTE_TTL_DAYS} days after it began`
          : rejection === 'idle'
            ? `${SESSION_IDLE_TTL_DAYS} days without use`
            : null,
    };
  });
}
