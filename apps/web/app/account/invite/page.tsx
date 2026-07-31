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
    </div>
  );
}
