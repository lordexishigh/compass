'use client';

import { useState, type FormEvent } from 'react';

/**
 * The one form behind a mailed link.
 *
 * Accepting an invitation and setting a password after a reset are the same shape — a
 * token from the URL, a password, and for an invitation a name — so they are one
 * component with two configurations rather than two near-identical files that drift.
 *
 * The token never appears in a field a person can see or edit. It arrived in the URL and
 * it is posted from a hidden input, because a visible token invites someone to "fix" a
 * character and turns a working link into an unexplained failure.
 */

export interface TokenFormProps {
  readonly token: string;
  readonly kind: 'invite' | 'reset';
  /** Shown above the fields — who invited you, or which address is being reset. */
  readonly context: string | null;
  readonly minPasswordLength: number;
}

export function TokenForm({ token, kind, context, minPasswordLength }: TokenFormProps) {
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (password !== confirmation) {
      // Checked here rather than server-side: the server has no business receiving a
      // password twice, and this is a typing mistake, not a security decision.
      setFailed('Those two passwords are not the same. Nothing has been sent.');
      return;
    }

    setBusy(true);
    setFailed(null);

    try {
      const response = await fetch(
        kind === 'invite' ? '/api/seats/accept' : '/api/auth/password-reset/consume',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(kind === 'invite' ? { token, displayName, password } : { token, password }),
        },
      );

      const body = (await response.json()) as { readonly detail?: string };

      if (!response.ok) {
        setFailed(body.detail ?? 'That did not work, and Compass could not say why.');
        return;
      }

      window.location.assign('/');
    } catch {
      setFailed('Compass could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-10 max-w-[26rem]">
      {context !== null && <p className="prose-narration mb-7 text-[15px]">{context}</p>}

      <input type="hidden" name="token" value={token} readOnly />

      {kind === 'invite' && (
        <label className="block">
          <span className="section-label">your name</span>
          <input
            type="text"
            name="displayName"
            autoComplete="name"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="goal-input"
            placeholder="Priya Raman"
          />
          <span className="stated-absence mt-1 block text-[13px]">
            What appears beside your seat. Nothing in a report is attributed to a person, so this is for the seat list.
          </span>
        </label>
      )}

      <label className={kind === 'invite' ? 'mt-6 block' : 'block'}>
        <span className="section-label">new password</span>
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="goal-input"
        />
        <span className="stated-absence mt-1 block text-[13px]">
          At least {minPasswordLength} characters. Length is what resists guessing — a longer ordinary phrase beats a
          short cryptic one.
        </span>
      </label>

      <label className="mt-6 block">
        <span className="section-label">again</span>
        <input
          type="password"
          name="confirmation"
          autoComplete="new-password"
          required
          minLength={minPasswordLength}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className="goal-input"
        />
      </label>

      <div className="mt-7 flex items-center gap-5">
        <button type="submit" disabled={busy} className="primary-action">
          {busy ? 'Working…' : kind === 'invite' ? 'Accept and sign in' : 'Set password and sign in'}
        </button>
        <a href="/account" className="tertiary-action">
          cancel
        </a>
      </div>

      {failed !== null && (
        <p role="alert" className="prose-narration mt-8 border-l-2 border-rule-severe pl-3 text-[15px]">
          {failed}
        </p>
      )}
    </form>
  );
}
