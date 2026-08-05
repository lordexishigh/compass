'use client';

import { useState, type FormEvent } from 'react';

/**
 * Sign in — three ways, one column, no chrome.
 *
 * The design brief says this is a document, not a dashboard, and that holds here: this
 * is a page of prose with three fields in it, set in the report's own measure and
 * typography, not a centred card on a tinted background. A manager arriving at 8:45am
 * should recognise it as the same product as the report.
 *
 * The three routes are one panel rather than three screens because they are one
 * decision — *how would you like to prove who you are* — and splitting it into
 * "forgot password?" hyperlinks that navigate away loses the address the person has
 * already typed.
 *
 * A client island, because it holds field state and posts. The report path stays
 * entirely server-rendered; nothing here is imported by it.
 */

type Mode = 'password' | 'link' | 'reset';

const MODES: readonly { readonly mode: Mode; readonly label: string; readonly hint: string }[] = [
  { mode: 'password', label: 'Password', hint: 'Email and password.' },
  { mode: 'link', label: 'Emailed link', hint: 'A single-use link, good for 15 minutes.' },
  { mode: 'reset', label: 'Forgotten it', hint: 'A single-use reset link, good for 1 hour.' },
];

const ENDPOINT: Readonly<Record<Mode, string>> = {
  password: '/api/auth/login',
  link: '/api/auth/magic-link',
  reset: '/api/auth/password-reset',
};

export interface SignInPanelProps {
  /** A sentence from a rejected link, carried here by the redirect. */
  readonly problem?: string | null;
  /**
   * The providers this deployment can offer, from `ssoButtons()`.
   *
   * Empty on a deployment with no client credentials, and the panel then shows nothing at all rather
   * than a disabled button — an offer that cannot be accepted is worse than no offer.
   */
  readonly ssoProviders?: readonly {
    readonly provider: string;
    readonly name: string;
    readonly startPath: string;
    readonly scopes: readonly string[];
    readonly reads: string;
  }[];
  /**
   * A half-finished sign-in that already proved a first factor and now owes a code.
   *
   * Arrives two ways: from this panel's own password post, and in the query string after a Google,
   * GitHub or SAML round-trip whose account has 2FA on. Both land in the same state, which is the point
   * — there is one code prompt in the product rather than one per sign-in method.
   */
  readonly pendingChallenge?: string | null;
  /**
   * The owner address, when this deployment configured none and one was generated for it.
   *
   * The address and not the password, because the password is not knowable here: the worker
   * mints it on the boot that creates the seat, stores an Argon2id digest of it, and prints it
   * once. This panel says where to find it rather than showing it.
   */
  readonly generatedOwnerEmail?: string | null;
  /**
   * The owner environment is half-configured, so no owner seat exists to sign in to.
   *
   * Its own prop rather than reusing `problem`, which is what a *rejected attempt* says. This
   * is true before anybody types anything, and it is the reason every attempt will fail — so
   * it is stated up front rather than after the fact.
   */
  readonly configurationProblem?: string | null;
}

export function SignInPanel({
  problem = null,
  generatedOwnerEmail = null,
  configurationProblem = null,
  ssoProviders = [],
  pendingChallenge = null,
}: SignInPanelProps) {
  const [mode, setMode] = useState<Mode>('password');
  /**
   * The signed challenge, once a first factor has been proved.
   *
   * ## The bug this state exists to fix
   *
   * `POST /api/auth/login` answers **200** with `{signedIn: false, secondFactorRequired: true, challenge}`
   * when the account has 2FA on — a deliberate design, so that a correct password mints no session. This
   * panel used to read any `response.ok` as success and navigate straight to `/`, where there was no
   * session: the reader was bounced back to this screen with nothing said, and there was **no way to
   * complete a two-factor sign-in through the product at all.** The enforcement worked; the way through
   * it did not exist.
   */
  const [challenge, setChallenge] = useState<string | null>(pendingChallenge);
  const [code, setCode] = useState('');
  // Deliberately empty rather than pre-filled with the demonstration address: a form that
  // arrives half-completed makes a reader wonder what else it has assumed. The button
  // under the demonstration note fills both fields when that is what they want.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [stated, setStated] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(problem);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStated(null);
    setFailed(null);

    try {
      const response = await fetch(ENDPOINT[mode], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `same-origin` is the default, and it is stated rather than assumed because a
        // session cookie is the whole point of the request.
        credentials: 'same-origin',
        body: JSON.stringify(mode === 'password' ? { email, password } : { email }),
      });

      const body = (await response.json()) as { readonly detail?: string };

      if (!response.ok) {
        setFailed(body.detail ?? 'That did not work, and Compass could not say why. Try again.');
        return;
      }

      if (mode === 'password') {
        /**
         * A 200 does not mean a session. See the note on `challenge` above.
         *
         * When 2FA is active the login route deliberately mints nothing and hands back a signed
         * challenge, so the only correct reading of this response is to look at `signedIn`.
         */
        const answered = body as {
          readonly signedIn?: boolean;
          readonly secondFactorRequired?: boolean;
          readonly challenge?: string;
          readonly detail?: string;
        };

        if (answered.secondFactorRequired === true && typeof answered.challenge === 'string') {
          setChallenge(answered.challenge);
          setStated(
            answered.detail ??
              'Enter the six-digit code from your authenticator app. A recovery code works instead if you ' +
                'cannot reach it.',
          );
          return;
        }

        // A full navigation rather than a client-side push: the report is a Server
        // Component and has to be rendered with the new cookie attached.
        window.location.assign('/');
        return;
      }

      setStated(body.detail ?? 'Check your inbox.');
    } catch {
      setFailed('Compass could not be reached. The report page will say whether the server is up.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * The second step: a TOTP code, or a recovery code, against the challenge.
   *
   * One handler for both, because `/api/auth/2fa/challenge` accepts either at one address — it is the
   * same question ("prove you are still you") and only the credential differs. A separate form for
   * recovery codes would double the surface for one decision.
   */
  async function submitCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (challenge === null) return;

    setBusy(true);
    setStated(null);
    setFailed(null);

    try {
      const response = await fetch('/api/auth/2fa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ challenge, code }),
      });

      const body = (await response.json()) as { readonly detail?: string };

      if (!response.ok) {
        setFailed(body.detail ?? 'That code was not accepted. Codes work once each.');
        /**
         * An expired challenge sends the reader back to the first step rather than leaving them typing
         * codes at a ticket that can no longer be satisfied. A wrong code keeps the prompt, because the
         * next code from their app will work.
         */
        if (response.status === 401 && (body.detail ?? '').includes('expired')) {
          setChallenge(null);
          setCode('');
        }
        return;
      }

      window.location.assign('/');
    } catch {
      setFailed('Compass could not be reached. The report page will say whether the server is up.');
    } finally {
      setBusy(false);
    }
  }

  const active = MODES.find((entry) => entry.mode === mode);

  /**
   * The code step replaces the whole panel rather than appearing beneath it.
   *
   * A first factor has already been proved, so offering the three sign-in methods again would invite
   * somebody to start over and lose the challenge they are holding — and would put two live forms on one
   * screen, of which only one can succeed.
   */
  if (challenge !== null) {
    return (
      <div className="mt-10">
        <p className="section-label">one more step</p>
        <p className="prose-narration mt-3 max-w-[34rem] text-[15px]">
          Your password was right. This account has two-factor authentication on, so it takes a code as
          well — which is the point of having it.
        </p>

        <form onSubmit={submitCode} className="mt-7 max-w-[26rem]">
          <label className="block" htmlFor="second-factor-code">
            <span className="section-label">code</span>
          </label>
          <input
            id="second-factor-code"
            name="code"
            type="text"
            required
            /*
              `one-time-code` is what lets a phone offer the code from its own notification, and
              `inputMode` brings up a numeric keypad without rejecting a recovery code's letters.

              Deliberately *not* `autoFocus`: `jsx-a11y/no-autofocus` refuses it, and the rule is right
              here — this input appears after a page transition, and moving focus into it without the
              reader asking is exactly the jump that loses a screen-reader user their place. The heading
              above it says what to do.
            */
            autoComplete="one-time-code"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="goal-input font-mono tracking-[0.2em]"
            placeholder="123456"
            aria-describedby="code-hint"
          />
          <p id="code-hint" className="stated-absence mt-2 text-[13px]">
            Six digits from your authenticator app. One of your recovery codes works instead, and is then
            spent.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-5">
            <button type="submit" disabled={busy || code.trim().length === 0} className="primary-action">
              {busy ? 'Checking…' : 'Finish signing in'}
            </button>
            <button
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setPassword('');
                setStated(null);
                setFailed(null);
              }}
              className="tertiary-action"
            >
              start again
            </button>
          </div>
        </form>

        {stated !== null && (
          <p role="status" className="prose-narration mt-8 border-l-2 border-verified pl-3 text-[15px]">
            {stated}
          </p>
        )}
        {failed !== null && (
          <p role="alert" className="prose-narration mt-8 border-l-2 border-rule-severe pl-3 text-[15px]">
            {failed}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-10">
      {/* The three ways, as a radio group: they are one exclusive choice, and a
          keyboard reader should hear it as one. */}
      <fieldset className="border-0 p-0">
        <legend className="section-label">how would you like to sign in</legend>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          {MODES.map((entry) => (
            <label
              key={entry.mode}
              // Driven from state rather than from a `has-checked:` variant: the selected
              // one is already known here, and a variant that silently failed to compile
              // would leave the choice invisible with no error anywhere to find.
              className={`flex cursor-pointer items-baseline gap-2 text-[13px] transition-colors duration-150 hover:text-ink-strong ${
                mode === entry.mode ? 'text-ink-strong' : 'text-ink-muted'
              }`}
            >
              <input
                type="radio"
                name="sign-in-mode"
                value={entry.mode}
                checked={mode === entry.mode}
                onChange={() => {
                  setMode(entry.mode);
                  setStated(null);
                  setFailed(null);
                }}
                className="size-3 accent-verified"
              />
              {entry.label}
            </label>
          ))}
        </div>
        {active !== undefined && <p className="stated-absence mt-2 text-[13px]">{active.hint}</p>}
      </fieldset>

      <form onSubmit={submit} className="mt-6 max-w-[26rem]">
        <label className="block">
          <span className="section-label">email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="goal-input"
            placeholder="you@example.com"
          />
        </label>

        {mode === 'password' && (
          <label className="mt-5 block">
            <span className="section-label">password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="goal-input"
            />
          </label>
        )}

        <div className="mt-7 flex items-center gap-5">
          <button type="submit" disabled={busy} className="primary-action">
            {busy
              ? 'Working…'
              : mode === 'password'
                ? 'Sign in'
                : mode === 'link'
                  ? 'Email me a link'
                  : 'Email me a reset link'}
          </button>
          <a href="/" className="tertiary-action">
            read the demonstration report instead
          </a>
        </div>
      </form>

      {/* ------------------------------------------------------------------
          Single sign-on. Plain links, below the form, with the scopes stated.
          ------------------------------------------------------------------ */}
      {ssoProviders.length > 0 && (
        <div className="mt-10 hairline pt-6">
          <p className="section-label">or sign in with</p>

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
            {ssoProviders.map((entry) => (
              /**
               * An anchor, not a button with a fetch.
               *
               * The round-trip is a top-level navigation to the provider and back, so a link is the
               * honest control for it — and it means single sign-on keeps working if this island's
               * JavaScript never loads, which is the one sign-in method that can make that claim.
               */
              <a key={entry.provider} href={entry.startPath} className="primary-action">
                Continue with {entry.name}
              </a>
            ))}
          </div>

          {/*
            The scope list, verbatim, before consent.
            Rendered from `SSO_PROVIDER_DEFINITIONS` rather than written here, so the sentence a reader
            approves and the request Compass actually sends cannot drift apart — the same rule the
            GitHub connect screen keeps.
          */}
          <ul className="mt-4">
            {ssoProviders.map((entry) => (
              <li key={entry.provider} className="mt-2 text-[13px] leading-relaxed text-ink-muted">
                <span className="text-ink-strong">{entry.name}</span> is asked for{' '}
                {entry.scopes.map((scope, index) => (
                  <span key={scope}>
                    {index > 0 && ', '}
                    <code className="data-token">{scope}</code>
                  </span>
                ))}{' '}
                — {entry.reads}
              </li>
            ))}
          </ul>

          <p className="stated-absence mt-4 text-[13px] leading-relaxed">
            Compass links a provider to an existing seat only when the provider confirms the email
            address belongs to you. It never creates a seat: those are invited.
          </p>
        </div>
      )}

      {/* Both outcomes are sentences in the reading column, never a toast and never a
          coloured box: Compass does not colour-code bad news. */}
      {stated !== null && (
        <p role="status" className="prose-narration mt-8 border-l-2 border-verified pl-3 text-[15px]">
          {stated}
        </p>
      )}
      {failed !== null && (
        <p role="alert" className="prose-narration mt-8 border-l-2 border-rule-severe pl-3 text-[15px]">
          {failed}
        </p>
      )}

      {/* Stated as a fact about the deployment, in the reading column, carried by a hairline
          and by zinc rather than by colour: this is not bad news to be flagged, it is the
          reason the form above cannot work, and a reader is entitled to it before they try.
          `role="status"` and not `alert` — nothing was attempted yet. */}
      {configurationProblem !== null && (
        <div role="status" className="mt-12 hairline pt-6">
          <p className="section-label">this deployment has no owner seat</p>
          <p className="prose-narration mt-2 text-[15px]">
            {configurationProblem}{' '}
            <span className="stated-absence">
              Until then the boot script refuses to provision an owner, so no address here can sign in — including the
              demonstration one, which is deliberately not offered while the environment says something else was
              intended. /api/health reports this ahead of every other check.
            </span>
          </p>
        </div>
      )}

      {generatedOwnerEmail !== null && (
        <div className="mt-12 hairline pt-6">
          <p className="section-label">this deployment configured no owner</p>
          <p className="prose-narration mt-2 text-[15px]">
            The owner seat is <code className="data-token">{generatedOwnerEmail}</code>, and its password was generated
            when Compass first booted rather than being written into this source. Compass printed it once, in the boot
            log, and wrote it to <code className="data-token">.nous/demo_account.json</code> — this page cannot show it
            to you, because the database holds only a hash of it.{' '}
            <span className="stated-absence">
              Set COMPASS_OWNER_EMAIL and COMPASS_OWNER_PASSWORD to choose your own before this deployment holds real
              data — /api/health says the same thing until you do.
            </span>
          </p>
          {/* The address is safe to fill and saves a reader retyping it; the password is the
              half they have to fetch, and a button that filled only one field and silently
              left the other would read as broken. */}
          <button
            type="button"
            onClick={() => {
              setMode('password');
              setEmail(generatedOwnerEmail);
              setStated(null);
              setFailed(null);
            }}
            className="tertiary-action mt-3"
          >
            fill in that address
          </button>
        </div>
      )}
    </div>
  );
}
