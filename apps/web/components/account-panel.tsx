'use client';

import { useState } from 'react';

/**
 * The signed-in half of `/account`: who you are, what you may do, and the two ways out.
 *
 * The session list is the reason this exists rather than a bare sign-out button. "Sign
 * out all devices" is a decision, and a person can only make it if they can see how many
 * devices there are and when each was last used. A button with no list is a button
 * pressed hopefully.
 *
 * Revoked sessions stay in the list, greyed and with their reason, because *why* a
 * session ended is the interesting part — `role_change` beside a session that ended
 * yesterday is the audit trail a person can read about themselves.
 */

export interface AccountSessionView {
  readonly id: string;
  readonly current: boolean;
  readonly issuedAtLabel: string;
  readonly lastUsedAtLabel: string;
  readonly endsAtLabel: string;
  readonly revokedReason: string | null;
  readonly rotatedFrom: boolean;
  /**
   * Whether this session would still be honoured.
   *
   * Computed on the server, because it is a comparison against the request's own instant
   * and against `sessionDeadline` — the one place the 30-day and 14-day rules meet. A
   * client deriving it from `revokedReason === null` would count a session that has simply
   * *expired* as live, and "sign out everywhere (4 live)" would then offer to end sessions
   * that ended themselves days ago.
   */
  readonly live: boolean;
  /** Why it is no longer usable, when nothing revoked it. `null` for a live session. */
  readonly endedBecause: string | null;
}

export interface AccountPanelProps {
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly roleCapabilities: string;
  readonly teamKeys: readonly string[];
  readonly unscoped: boolean;
  readonly hasPassword: boolean;
  readonly canManageSeats: boolean;
  readonly sessions: readonly AccountSessionView[];
  readonly absoluteTtlDays: number;
  readonly idleTtlDays: number;
}

export function AccountPanel(props: AccountPanelProps) {
  const [busy, setBusy] = useState<'none' | 'out' | 'everywhere'>('none');
  const [failed, setFailed] = useState<string | null>(null);

  async function post(path: string, method: 'POST' | 'DELETE', which: 'out' | 'everywhere'): Promise<void> {
    setBusy(which);
    setFailed(null);
    try {
      const response = await fetch(path, { method, credentials: 'same-origin' });
      if (!response.ok) {
        const body = (await response.json()) as { readonly detail?: string };
        setFailed(body.detail ?? 'That did not work, and Compass could not say why.');
        return;
      }
      // A full navigation: the cookie has changed, and every Server Component above has
      // to be re-rendered without it.
      window.location.assign('/account');
    } catch {
      setFailed('Compass could not be reached.');
    } finally {
      setBusy('none');
    }
  }

  const live = props.sessions.filter((session) => session.live);

  return (
    <div className="mt-10">
      <dl className="grid gap-4">
        <Row term="signed in as">
          <span className="text-ink-strong">{props.displayName}</span>{' '}
          <code className="data-token">{props.email}</code>
        </Row>
        <Row term="role">
          {/* Teal marks the manager's own authorship; a role is a fact about them, so it
              is set in ink and weight rather than in colour. */}
          <span className="text-ink-strong">{props.role}</span>
          <span className="mt-1 block text-ink-muted">{props.roleCapabilities}</span>
        </Row>
        <Row term="teams">
          {props.unscoped ? (
            <span>
              every team.{' '}
              <span className="stated-absence">
                Owners are unscoped by design — an owner locked out of their own organization would have no way back
                in.
              </span>
            </span>
          ) : props.teamKeys.length === 0 ? (
            <span className="stated-absence">
              no team is scoped to this seat, so there is no report to show you. An owner can add one.
            </span>
          ) : (
            <span className="flex flex-wrap gap-x-2">
              {props.teamKeys.map((team) => (
                <code key={team} className="data-token">
                  {team}
                </code>
              ))}
            </span>
          )}
        </Row>
        <Row term="password">
          {props.hasPassword ? (
            <span>set</span>
          ) : (
            <span className="stated-absence">
              none — this account signs in by emailed link. Ask for a reset link to set one.
            </span>
          )}
        </Row>
      </dl>

      <section className="mt-12 hairline pt-6">
        <h2 className="section-label">sessions</h2>
        <p className="prose-narration mt-2 text-[15px]">
          A session ends {props.absoluteTtlDays} days after it begins however often it is used, and after{' '}
          {props.idleTtlDays} days without use. Whichever comes first.
        </p>

        <ul className="mt-5 grid gap-3">
          {props.sessions.map((session) => (
            <li
              key={session.id}
              className={`grid gap-1 text-[13px] leading-relaxed ${session.live ? 'text-ink' : 'text-ink-faint'}`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono tabular-nums">{session.issuedAtLabel}</span>
                {session.current && (
                  <span className="rounded border border-verified px-1 font-mono text-[11px] text-verified-text">
                    this device
                  </span>
                )}
                {session.rotatedFrom && (
                  <span className="stated-absence">—— issued by a rotation, replacing an earlier one</span>
                )}
              </span>
              <span className="text-ink-muted">
                {session.live ? (
                  <>
                    last used <span className="font-mono tabular-nums">{session.lastUsedAtLabel}</span>, ends{' '}
                    <span className="font-mono tabular-nums">{session.endsAtLabel}</span>
                  </>
                ) : session.revokedReason !== null ? (
                  <>
                    ended — <span className="font-mono">{session.revokedReason.replace(/_/g, ' ')}</span>
                  </>
                ) : (
                  <>
                    ended <span className="font-mono tabular-nums">{session.endsAtLabel}</span>
                    {session.endedBecause !== null && <> — {session.endedBecause}</>}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-7 flex flex-wrap items-center gap-5">
          <button
            type="button"
            disabled={busy !== 'none'}
            onClick={() => void post('/api/auth/logout', 'POST', 'out')}
            className="primary-action"
          >
            {busy === 'out' ? 'Signing out…' : 'Sign out'}
          </button>
          <button
            type="button"
            disabled={busy !== 'none' || live.length === 0}
            onClick={() => void post('/api/auth/sessions', 'DELETE', 'everywhere')}
            className="tertiary-action"
          >
            {busy === 'everywhere'
              ? 'Ending every session…'
              : `sign out everywhere (${live.length} live)`}
          </button>
          {props.canManageSeats && (
            <a href="/seats" className="tertiary-action">
              manage seats
            </a>
          )}
        </div>

        {failed !== null && (
          <p role="alert" className="prose-narration mt-6 border-l-2 border-rule-severe pl-3 text-[15px]">
            {failed}
          </p>
        )}
      </section>
    </div>
  );
}

function Row({ term, children }: { readonly term: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      <dt className="section-label sm:pt-[3px]">{term}</dt>
      <dd className="text-[15px] leading-relaxed text-ink">{children}</dd>
    </div>
  );
}
