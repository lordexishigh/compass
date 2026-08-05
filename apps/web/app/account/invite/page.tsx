import { PASSWORD_MIN_LENGTH } from '@compass/auth';

import { TokenForm } from '../../../components/token-form';

/**
 * `/account/invite?token=…` — accept a seat.
 *
 * The page does **not** validate the token. It renders the form and lets
 * `POST /api/seats/accept` be the one place that decides, for one reason: a page that
 * checked first would be checking a second time, and two implementations of "is this
 * token usable" is exactly how a revoked invitation ends up accepted by the half that
 * forgot to look. The endpoint spends the token in a single UPDATE and returns the
 * sentence this page's form shows.
 *
 * A missing token is the one thing decided here, because there is no form to render
 * without one.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Accept your invitation — Compass',
};

export default async function AcceptInvitePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['token'];
  const token = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-24 pt-8 lg:px-8 lg:pt-16">
      <header>
        <p className="section-label">invitation</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          Take your seat
        </h1>
      </header>

      {token.length === 0 ? (
        <p role="alert" className="prose-narration mt-8 border-l-2 border-rule-severe pl-3">
          This address carries no invitation token, so there is nothing to accept. Open the link from the message you
          were sent — the whole address, including everything after the question mark. If it has lapsed, an owner of the
          organization can send another.{' '}
          <a href="/account" className="underline decoration-rule-strong underline-offset-4 hover:decoration-verified">
            Sign in instead
          </a>
          .
        </p>
      ) : (
        <TokenForm
          token={token}
          kind="invite"
          context="Choose the name that appears beside your seat and a password. The invitation works once — after this it is spent, whether or not you use it again."
          minPasswordLength={PASSWORD_MIN_LENGTH}
        />
      )}

      {/*
        Terms and privacy at the point of agreement.

        This is the sign-up flow: accepting a seat is where an account comes into existence, so it is the
        one moment somebody is actually agreeing to something. Linking the documents only from a report
        footer would put them where existing users are and not where new ones consent.

        Phrased as what taking the seat means rather than as a checkbox. A tick-box adds a click and a
        record of a click; it does not make anybody better informed, and the honest version is a sentence
        with two links a reader can follow before they submit. Both pages are public in every tenant, so
        neither link can refuse somebody who does not yet have the account they are here to create — and
        the third link is what Compass will say about *them*, which is the more relevant document for
        somebody about to be written about.
      */}
      <p className="mt-10 hairline pt-5 text-[13px] leading-relaxed text-ink-faint">
        Taking a seat means you accept the{' '}
        <a
          href="/legal/terms"
          className="underline decoration-rule-strong underline-offset-4 hover:text-ink hover:decoration-verified"
        >
          terms of service
        </a>{' '}
        and that your work is read as described in the{' '}
        <a
          href="/legal/privacy"
          className="underline decoration-rule-strong underline-offset-4 hover:text-ink hover:decoration-verified"
        >
          privacy policy
        </a>
        . Compass does not rank individuals and produces no automated decision about you —{' '}
        <a
          href="/legal/automated-decisions"
          className="underline decoration-rule-strong underline-offset-4 hover:text-ink hover:decoration-verified"
        >
          what that means, and how to object
        </a>
        .
      </p>
    </div>
  );
}
