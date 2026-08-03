'use client';

import { useState, type FormEvent } from 'react';

import { EMPTY_STATES } from '../lib/empty-states';

import { EmptyState } from './empty-state';

/**
 * Seat management: one list, one form, no table.
 *
 * The brief is emphatic that this product is a document rather than a dashboard, and a
 * seat list is the place that pull is strongest — a grid of rows with dropdowns in every
 * cell is the obvious shape and it is the wrong one here. So each seat is a paragraph:
 * the address in mono, the role and the teams stated in a sentence, and the actions as
 * text rather than icon buttons. Twelve seats read as a list of people; twelve table rows
 * read as a spreadsheet.
 *
 * Colour is rationed exactly as the brief says. Teal marks the manager's own authorship,
 * so a pending invitation — a thing this person did that has not landed yet — carries a
 * teal rule. A revoked seat carries no red: Compass does not colour-code bad news, so it
 * is set in faint ink with a strikethrough hairline instead.
 */

export interface SeatView {
  readonly membershipId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: SeatRoleName;
  readonly status: 'pending' | 'active' | 'revoked';
  readonly hasPassword: boolean;
  readonly teamKeys: readonly string[];
  readonly invitedAtLabel: string;
  readonly isYou: boolean;
}

export type SeatRoleName = 'owner' | 'manager' | 'member' | 'viewer';

export interface SeatManagerProps {
  readonly seats: readonly SeatView[];
  /** False for a manager, who reads this list but may not act on it. */
  readonly canManage: boolean;
  readonly knownTeamKeys: readonly string[];
  readonly roleCapabilities: Readonly<Record<SeatRoleName, string>>;
}

const ROLES: readonly SeatRoleName[] = ['owner', 'manager', 'member', 'viewer'];

export function SeatManager(props: SeatManagerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [stated, setStated] = useState<string | null>(null);
  const [invitationLink, setInvitationLink] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<SeatRoleName>('member');
  const [inviteTeams, setInviteTeams] = useState<readonly string[]>([]);

  async function act(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    busyKey: string,
  ): Promise<{ readonly detail?: string; readonly invitationLink?: string } | null> {
    setBusyId(busyKey);
    setFailed(null);
    setStated(null);
    setInvitationLink(null);

    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const parsed = (await response.json()) as { readonly detail?: string; readonly invitationLink?: string };

      if (!response.ok) {
        setFailed(parsed.detail ?? 'That did not work, and Compass could not say why.');
        return null;
      }
      return parsed;
    } catch {
      setFailed('Compass could not be reached. Nothing has been changed.');
      return null;
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Every action ends by re-reading the list from the server rather than patching state.
   *
   * A seat change moves rows *and* revokes sessions, so a locally-patched list would be a
   * list someone acts on again with stale facts. The one exception is an action that
   * returned an invitation link: reloading would take the link off the screen before it
   * could be copied, so that case leaves the list stale on purpose and says so.
   */
  function settle(result: { readonly detail?: string; readonly invitationLink?: string } | null): void {
    if (result === null) return;
    setStated(result.detail ?? null);

    if (result.invitationLink !== undefined) {
      setInvitationLink(result.invitationLink);
      return;
    }
    window.location.reload();
  }

  async function invite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    settle(
      await act('/api/seats', 'POST', { email: inviteEmail, role: inviteRole, teamKeys: inviteTeams }, 'invite'),
    );
    setInviteEmail('');
    setInviteTeams([]);
  }

  return (
    <div className="mt-10">
      {/*
        A seat list with nothing in it is very nearly unreachable — you are reading this screen
        through a seat — but "very nearly" is not a reason to render a bare `<ul>`. An empty
        `.map()` produces no markup at all, which is the failure mode that looks fine in review
        and looks broken to whoever hits it.
      */}
      {props.seats.length === 0 && <EmptyState copy={EMPTY_STATES.seats} />}

      <ul className="grid gap-8">
        {props.seats.map((seat) => (
          <li
            key={seat.membershipId}
            className={`border-l-2 pl-4 ${
              seat.status === 'pending'
                ? 'border-authored'
                : seat.status === 'revoked'
                  ? 'border-rule opacity-60'
                  : 'border-rule-strong'
            }`}
          >
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={`text-[15px] ${seat.status === 'revoked' ? 'text-ink-faint line-through decoration-1' : 'text-ink-strong'}`}>
                {seat.displayName === seat.email ? '—' : seat.displayName}
              </span>
              <code className="data-token">{seat.email}</code>
              {seat.isYou && (
                <span className="rounded border border-authored px-1 font-mono text-[11px] text-authored-text">
                  you
                </span>
              )}
            </p>

            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              <span className="text-ink">{seat.role}</span>
              {' — '}
              {seat.role === 'owner'
                ? 'every team, because owners are unscoped'
                : seat.teamKeys.length === 0
                  ? 'no team scoped, so no report is readable'
                  : `teams ${seat.teamKeys.join(', ')}`}
              {seat.status === 'pending' && (
                <span className="stated-absence">
                  {' '}
                  —— invited <span className="font-mono tabular-nums">{seat.invitedAtLabel}</span>, not yet accepted
                </span>
              )}
              {seat.status === 'revoked' && <span className="stated-absence"> —— removed</span>}
              {seat.status === 'active' && !seat.hasPassword && (
                <span className="stated-absence"> —— signs in by emailed link, no password set</span>
              )}
            </p>
            <p className="mt-1 text-[13px] text-ink-faint">{props.roleCapabilities[seat.role]}</p>

            {props.canManage && seat.status !== 'revoked' && (
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="flex items-baseline gap-2 text-[13px] text-ink-muted">
                  <span className="section-label">role</span>
                  <select
                    defaultValue={seat.role}
                    disabled={busyId !== null}
                    aria-label={`Role for ${seat.email}`}
                    onChange={(event) => {
                      void act(
                        `/api/seats/${encodeURIComponent(seat.membershipId)}`,
                        'PATCH',
                        { role: event.target.value },
                        seat.membershipId,
                      ).then(settle);
                    }}
                    className="goal-input !mt-0 !h-8 w-auto"
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>

                {seat.status === 'pending' && (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => {
                      void act(
                        `/api/seats/${encodeURIComponent(seat.membershipId)}/invite`,
                        'POST',
                        undefined,
                        seat.membershipId,
                      ).then(settle);
                    }}
                    className="tertiary-action"
                  >
                    resend invitation
                  </button>
                )}

                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => {
                    void act(
                      `/api/seats/${encodeURIComponent(seat.membershipId)}`,
                      'DELETE',
                      undefined,
                      seat.membershipId,
                    ).then(settle);
                  }}
                  className="tertiary-action"
                >
                  {seat.status === 'pending' ? 'revoke invitation' : 'remove seat'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {props.canManage && (
        // The anchor the empty state's primary action points at.
        <section id="invite-seat" className="mt-14 hairline pt-8">
          <h2 className="section-label">invite a seat</h2>
          <p className="prose-narration mt-2 text-[15px]">
            The invitation works once and expires in seven days. Resending it revokes the previous link, so there is
            never more than one that works.
          </p>

          <form onSubmit={invite} className="mt-6 max-w-[26rem]">
            <label className="block">
              <span className="section-label">email</span>
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                className="goal-input"
                placeholder="colleague@example.com"
              />
            </label>

            <label className="mt-5 block">
              <span className="section-label">role</span>
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as SeatRoleName)}
                className="goal-input"
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <span className="stated-absence mt-1 block text-[13px]">{props.roleCapabilities[inviteRole]}</span>
            </label>

            {inviteRole !== 'owner' && (
              <fieldset className="mt-5 border-0 p-0">
                <legend className="section-label">teams this seat may read</legend>
                {props.knownTeamKeys.length === 0 ? (
                  <p className="stated-absence mt-2 text-[13px]">
                    No team has been ingested yet, so there is nothing to scope to. Scopes can be added once there is.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                    {props.knownTeamKeys.map((team) => (
                      <label key={team} className="flex items-baseline gap-2 text-[13px] text-ink-muted">
                        <input
                          type="checkbox"
                          checked={inviteTeams.includes(team)}
                          onChange={(event) =>
                            setInviteTeams((current) =>
                              event.target.checked
                                ? [...current, team]
                                : current.filter((entry) => entry !== team),
                            )
                          }
                          className="size-3 accent-verified"
                        />
                        <code className="data-token">{team}</code>
                      </label>
                    ))}
                  </div>
                )}
                <p className="stated-absence mt-2 text-[13px]">
                  A seat with no team scoped can read no report. That is the safe direction for the mistake to fall.
                </p>
              </fieldset>
            )}

            <button type="submit" disabled={busyId !== null} className="primary-action mt-7">
              {busyId === 'invite' ? 'Sending…' : 'Send invitation'}
            </button>
          </form>
        </section>
      )}

      {stated !== null && (
        <p role="status" className="prose-narration mt-8 border-l-2 border-verified pl-3 text-[15px]">
          {stated}
        </p>
      )}

      {invitationLink !== null && (
        <div className="mt-4 border-l-2 border-authored pl-3">
          <p className="section-label">no mail transport is configured</p>
          <p className="prose-narration mt-1 text-[15px]">
            So the invitation was written to the process log rather than delivered. Send this link to them yourself —
            the list below is not refreshed while it is on screen, so the link does not vanish before you have copied it.
          </p>
          <p className="mt-2 break-all font-mono text-[13px] text-ink-strong">{invitationLink}</p>
          <button type="button" onClick={() => window.location.reload()} className="tertiary-action mt-3">
            done — refresh the seat list
          </button>
        </div>
      )}

      {failed !== null && (
        <p role="alert" className="prose-narration mt-8 border-l-2 border-rule-severe pl-3 text-[15px]">
          {failed}
        </p>
      )}
    </div>
  );
}
