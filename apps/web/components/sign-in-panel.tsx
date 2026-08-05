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
  /** Shown when the deployment is still on the published demonstration owner. */
  readonly demoCredentials?: { readonly email: string; readonly password: string } | null;
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
  demoCredentials = null,
  configurationProblem = null,
}: SignInPanelProps) {
  const [mode, setMode] = useState<Mode>('password');
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

  const active = MODES.find((entry) => entry.mode === mode);

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

      {demoCredentials !== null && (
        <div className="mt-12 hairline pt-6">
          <p className="section-label">this deployment is a demonstration</p>
          <p className="prose-narration mt-2 text-[15px]">
            The owner seat is the published demonstration one, so you can sign in and try seat management without
            setting anything up. Its password is{' '}
            <code className="data-token">{demoCredentials.password}</code> and its address is{' '}
            <code className="data-token">{demoCredentials.email}</code>.{' '}
            <span className="stated-absence">
              Set COMPASS_OWNER_EMAIL and COMPASS_OWNER_PASSWORD before this deployment holds real data — /api/health
              says the same thing until you do.
            </span>
          </p>
          <button
            type="button"
            onClick={() => {
              setMode('password');
              setEmail(demoCredentials.email);
              setPassword(demoCredentials.password);
              setStated(null);
              setFailed(null);
            }}
            className="tertiary-action mt-3"
          >
            fill the form with them
          </button>
        </div>
      )}
    </div>
  );
}
