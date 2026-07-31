import { PASSWORD_MIN_LENGTH, TOKEN_TTL_LABEL } from '@compass/auth';

import { TokenForm } from '../../../components/token-form';

/**
 * `/account/reset?token=…` — set a new password.
 *
 * As with the invitation page, the token is not checked here: `POST
 * /api/auth/password-reset/consume` is the single place that decides, and it spends the
 * token in one UPDATE so a double submission cannot set the password twice.
 *
 * The page states the two consequences before the person commits to them — the link
 * works once, and setting a password ends every other session on the account — because
 * the second one is the sort of thing that should not be a surprise.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Set a new password — Compass',
};

export default async function ResetPasswordPage({
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
        <p className="section-label">password</p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight text-ink-strong">
          Set a new password
        </h1>
      </header>

      {token.length === 0 ? (
        <p role="alert" className="prose-narration mt-8 border-l-2 border-rule-severe pl-3">
          This address carries no reset token. Open the link from the message you were sent — the whole address,
          including everything after the question mark — or{' '}
          <a href="/account" className="underline decoration-rule-strong underline-offset-4 hover:decoration-verified">
            ask for a new one
          </a>
          . Reset links last {TOKEN_TTL_LABEL.password_reset}.
        </p>
      ) : (
        <TokenForm
          token={token}
          kind="reset"
          context={`This link works once and lasts ${TOKEN_TTL_LABEL.password_reset} from when it was sent. Setting a password also ends every other session on this account — if you are here because you think somebody else has your password, that is the point.`}
          minPasswordLength={PASSWORD_MIN_LENGTH}
        />
      )}
    </div>
  );
}
