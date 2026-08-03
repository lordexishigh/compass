'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';

import { EMPTY_STATES } from '../lib/empty-states';
import type { RosterScreenView } from '../lib/roster-source';

import { EmptyState } from './empty-state';

/**
 * The configuration screen: six sections of prose and lists, one measure.
 *
 * The pull here is towards a dashboard — tabs, tables, a grid of cards per resource — and
 * the design brief refuses it: *"It is a document, not a dashboard. If something can be a
 * sentence, it is a sentence."* So each section reads as a paragraph about one thing, with
 * its controls as text beneath it. Twelve repositories read as a list of repositories;
 * twelve table rows read as a spreadsheet, and a spreadsheet is what a manager already has
 * and does not want.
 *
 * Colour is rationed exactly as the brief says. Emerald marks verified positive fact — an
 * identifier that resolves to a person, a tracked repository. Teal marks the manager's own
 * authorship — a membership they wrote, an absence they recorded, a merge they made.
 * Archived, unattributed and removed carry **no** red: they are set in faint ink with a
 * hairline, because Compass never colour-codes bad news.
 *
 * Every action states its consequence before and after. "6 commits and 2 pull requests will
 * be attributed to Priya Raman" is the whole reason a merge is reversible in practice: the
 * manager sees what it did, so they can tell whether it was right.
 */

type Kind = 'email' | 'account' | 'handle';

const WEEKDAY_NAMES: readonly string[] = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const KIND_LABEL: Readonly<Record<Kind, string>> = {
  email: 'git email',
  account: 'tracker account',
  handle: 'chat handle',
};

const dateOf = (millis: number): string => new Date(millis).toISOString().slice(0, 10);

const DAY_MILLIS = 86_400_000;

/**
 * The civil date a manager picked in "until", as the instant that ends the absence.
 *
 * An absence covers `[startAt, endAt)` — half-open, like every other span in the product —
 * so the instant that makes the picked day *covered* is midnight at the start of the day
 * **after** it. Submitting midnight of the picked day itself was the bug: "out from 3 Aug
 * until 7 Aug" produced an absence ending at 7 Aug 00:00, which covers no instant on the
 * 7th, so the 7th's report still named the person in stalled-work findings — while the
 * roster displayed the same record as `2026-08-03 → 2026-08-07` and read inclusive.
 *
 * The conversion belongs here, at the form boundary, and not in `absenceCoversInstant`:
 * half-open is correct, tested, and shared with every other span. What was wrong was
 * translating a human's inclusive "until" into it.
 */
const inclusiveEndInstant = (civilDate: string): string =>
  new Date(new Date(`${civilDate}T00:00:00Z`).getTime() + DAY_MILLIS).toISOString();

/**
 * The last day an absence actually covers, for display.
 *
 * The stored bound is exclusive, so rendering it raw would show the first day the person is
 * *back* as though they were still out. One millisecond earlier is the last covered instant,
 * and its civil date is the day a manager means when they say "until".
 */
const lastCoveredDay = (endAt: number): string => dateOf(endAt - 1);

/** A section of the document. Never a card: a hairline and a heading. */
function Section({
  numeral,
  title,
  lead,
  anchor,
  children,
}: {
  readonly numeral: string;
  readonly title: string;
  readonly lead: string;
  /**
   * An id, so another section's empty state can send the reader here.
   *
   * The absence form and the identifier form both live *inside* a person's row in section 04,
   * which is why sections 05 and 06 have somewhere to point when they are empty: the action
   * that fills them is up there, against a person.
   */
  readonly anchor?: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={anchor} className="hairline mt-12 pt-8">
      <p className="section-label">
        <span className="font-mono tabular-nums">{numeral}</span> {title}
      </p>
      <p className="prose-narration mt-3 text-[15px]">{lead}</p>
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** The count a claim carries, in mono, inline — never a badge. */
const Count = ({ value, unit }: { readonly value: number; readonly unit: string }) => (
  <span className="text-ink-muted">
    <span className="font-mono tabular-nums text-ink-strong">{value}</span> {value === 1 ? unit : `${unit}s`}
  </span>
);

export function RosterScreen({ roster }: { readonly roster: RosterScreenView }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [stated, setStated] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** The merge whose undo is still one click away. Cleared on the next action. */
  const [undoable, setUndoable] = useState<{ readonly auditId: string; readonly label: string } | null>(null);

  async function act(
    path: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body: unknown,
    key: string,
  ): Promise<{ readonly detail?: string; readonly mergeAuditId?: string } | null> {
    setBusy(key);
    setStated(null);
    setFailed(null);

    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = (await response.json()) as { readonly detail?: string; readonly mergeAuditId?: string };

      if (!response.ok) {
        setFailed(parsed.detail ?? 'That did not work, and Compass could not say why.');
        return null;
      }
      return parsed;
    } catch {
      setFailed('Compass could not be reached. Nothing has been changed.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Every action ends by re-reading from the server — and by saying what it did.
   *
   * `router.refresh()` and not `window.location.reload()`. The reload unloaded the document
   * in the same tick as `setStated`, so the sentence was set and thrown away: a manager never
   * saw "6 artifacts (6 commits, 0 pull requests) now attribute to this person", which is the
   * entire reason the identities route computes that count. `router.refresh()` re-runs the
   * Server Component and keeps client state, so the fresh roster and the outcome sentence
   * arrive together.
   *
   * A locally-patched list is still not an option: the facts on this screen include artifact
   * counts a write has just changed, and acting twice on stale ones is how a manager
   * re-points an identifier they have already moved.
   */
  function settle(result: { readonly detail?: string; readonly mergeAuditId?: string } | null, undo?: string): void {
    if (result === null) return;
    setStated(result.detail ?? null);

    // A merge leaves its undo on screen. That survives the refresh now, so the row can
    // update to "merged" while the offer to reverse it stays where the manager is reading.
    if (result.mergeAuditId !== undefined && undo !== undefined) {
      setUndoable({ auditId: result.mergeAuditId, label: undo });
    }
    router.refresh();
  }

  return (
    <div>
      {/* ------------------------------------------------------------------ */}
      <Section
        numeral="01"
        title="teams"
        lead="A team owns a project, and the project's repositories are the ones its report is about. Removing somebody sets their membership inactive rather than deleting it — last Tuesday's report credited them with that day's work, and the row is the evidence."
      >
        {roster.teams.length === 0 ? (
          <EmptyState copy={EMPTY_STATES.rosterTeams} />
        ) : (
          <ul className="grid gap-8">
            {roster.teams.map((team) => (
              <li key={team.key} className="border-l-2 border-rule-strong pl-4">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[15px] text-ink-strong">{team.name}</span>
                  <code className="data-token">{team.key}</code>
                  <span className="text-[13px] text-ink-muted">{team.methodology}</span>
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                  {team.projectKey === null ? (
                    <span className="stated-absence">no project named, so its scope is inferred</span>
                  ) : (
                    <>
                      project <code className="data-token">{team.projectKey}</code>
                    </>
                  )}
                  {' — '}
                  <Count value={team.members.filter((member) => member.active).length} unit="member" />
                </p>

                <ul className="mt-3 grid gap-1">
                  {team.members.map((member) => (
                    <li key={member.developerKey} className="text-[13px] leading-relaxed">
                      <span className={member.active ? 'text-ink' : 'text-ink-faint line-through decoration-1'}>
                        {member.displayName}
                      </span>
                      {member.membershipRole === 'lead' && <span className="text-ink-muted"> — lead</span>}
                      {member.impliedByDeveloperRow && (
                        <span className="stated-absence"> —— on the team through their own record, not a membership</span>
                      )}
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          void act(
                            '/api/roster/teams',
                            'PATCH',
                            { teamKey: team.key, developerKey: member.developerKey, active: !member.active },
                            `member:${team.key}:${member.developerKey}`,
                          ).then((result) => settle(result));
                        }}
                        className="tertiary-action ml-3"
                      >
                        {member.active ? 'remove' : 'add back'}
                      </button>
                    </li>
                  ))}
                </ul>

                <AddMemberForm
                  teamKey={team.key}
                  developers={roster.developers}
                  taken={new Set(team.members.filter((member) => member.active).map((member) => member.developerKey))}
                  busy={busy !== null}
                  onSubmit={(developerKey, membershipRole) =>
                    act(
                      '/api/roster/teams',
                      'PATCH',
                      { teamKey: team.key, developerKey, membershipRole, active: true },
                      `add:${team.key}`,
                    ).then((result) => settle(result))
                  }
                />

                <CalendarForm
                  team={team}
                  busy={busy !== null}
                  onSubmit={(workingWeekdays, holidays, timezone) =>
                    act(
                      '/api/roster/teams',
                      'PUT',
                      { teamKey: team.key, workingWeekdays, holidays, timezone },
                      `calendar:${team.key}`,
                    ).then((result) => settle(result))
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        numeral="02"
        title="tracked repositories"
        lead="Archiving a repository excludes it from future ingest windows and changes nothing that already exists. Every commit, every pull request and every report that cited them stays exactly as it is."
      >
        <TrackedList
          rows={roster.repositories}
          kind="repository"
          emptyStatement="No repository has been ingested yet."
          busy={busy !== null}
          onToggle={(key, tracked) =>
            act('/api/roster/sources', 'PATCH', { kind: 'repository', key, tracked }, `repo:${key}`).then((result) =>
              settle(result),
            )
          }
        />
      </Section>

      <Section
        numeral="03"
        title="tracked projects"
        lead="The same decision for a project. A project's tickets and sprints stop arriving; the ones already here remain."
      >
        <TrackedList
          rows={roster.projects}
          kind="project"
          emptyStatement="No project has been ingested yet."
          busy={busy !== null}
          onToggle={(key, tracked) =>
            act('/api/roster/sources', 'PATCH', { kind: 'project', key, tracked }, `project:${key}`).then((result) =>
              settle(result),
            )
          }
        />
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        numeral="04"
        anchor="roster-identities"
        title="identity roster"
        lead="One person, several identifiers: every git email they commit under, one tracker account, one chat handle. An artifact is attributed to somebody if and only if a declared link matches the identifier exactly — never a similar name. Removing a link deletes nothing; its artifacts revert to unattributed."
      >
        {roster.developers.length === 0 ? (
          <EmptyState copy={EMPTY_STATES.rosterPeople} />
        ) : (
          <ul className="grid gap-8">
            {roster.developers.map((developer) => (
              <li key={developer.key} className="border-l-2 border-rule-strong pl-4">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`text-[15px] ${developer.active ? 'text-ink-strong' : 'text-ink-faint'}`}>
                    {developer.displayName}
                  </span>
                  <code className="data-token">{developer.key}</code>
                  {developer.teamKey !== null && (
                    <span className="text-[13px] text-ink-muted">{developer.teamKey}</span>
                  )}
                  {!developer.active && <span className="stated-absence text-[13px]">—— inactive</span>}
                </p>

                {developer.identities.length === 0 ? (
                  <p className="stated-absence mt-2 text-[13px]">
                    No identifier is linked, so nothing is attributed to them.
                  </p>
                ) : (
                  <ul className="mt-2 grid gap-1">
                    {developer.identities.map((identity) => (
                      <li key={identity.identityKey} className="text-[13px] leading-relaxed">
                        <span className="text-ink-faint">{KIND_LABEL[identity.kind]}</span>{' '}
                        {/* Emerald marks verified positive fact: this identifier resolves. */}
                        <code className="data-token border-b border-verified pb-[1px]">{identity.value}</code>{' '}
                        <span className="text-ink-muted">
                          attributes <Count value={identity.attributes.totalCount} unit="artifact" />
                        </span>
                        {identity.origin === 'merged' && (
                          <span className="ml-2 rounded border border-authored px-1 font-mono text-[11px] text-authored-text">
                            merged
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            void act(
                              '/api/roster/identities',
                              'DELETE',
                              { kind: identity.kind, value: identity.value },
                              `unlink:${identity.identityKey}`,
                            ).then((result) => settle(result));
                          }}
                          className="tertiary-action ml-3"
                        >
                          unlink
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <AddIdentityForm
                  developerKey={developer.key}
                  busy={busy !== null}
                  onSubmit={(kind, value) =>
                    act(
                      '/api/roster/identities',
                      'POST',
                      { kind, value, developerKey: developer.key },
                      `link:${developer.key}`,
                    ).then((result) => settle(result))
                  }
                />

                <AbsenceForm
                  developerKey={developer.key}
                  absences={developer.absences}
                  busy={busy !== null}
                  onSubmit={(kind, startAt, endAt, note) =>
                    act(
                      '/api/roster/absences',
                      'POST',
                      { developerKey: developer.key, kind, startAt, endAt, note, source: 'manual' },
                      `absence:${developer.key}`,
                    ).then((result) => settle(result))
                  }
                  /*
                    No `endAt`. The route defaults it to the instant it resolved at the
                    request edge, so a skewed browser clock cannot decide the end of a
                    record that governs report suppression.
                  */
                  onEnd={(absenceKey) =>
                    act('/api/roster/absences', 'PATCH', { absenceKey }, `end:${absenceKey}`).then((result) =>
                      settle(result),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        numeral="05"
        title="unmatched identities"
        lead="Identifiers no link covers. The work is not dropped and not guessed at — the report asks about it rather than attributing it. Merging one is reversible: the merge records what it changed, so undo restores the prior attribution exactly."
      >
        {roster.unmatched.length === 0 ? (
          <EmptyState copy={EMPTY_STATES.rosterUnmatched} />
        ) : (
          <ul className="grid gap-6">
            {roster.unmatched.map((row) => (
              <li
                key={row.identityKey}
                className={`border-l-2 pl-4 ${row.resolved ? 'border-authored opacity-70' : 'border-rule-strong'}`}
              >
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <code className="data-token">{row.value}</code>
                  <span className="text-[13px] text-ink-faint">{KIND_LABEL[row.kind]}</span>
                  {row.displayName !== null && (
                    <span className="text-[13px] text-ink-muted">
                      calls itself &ldquo;{row.displayName}&rdquo;
                    </span>
                  )}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                  <Count value={row.occurrenceCount} unit="sighting" />
                  {row.attributes.totalCount > 0 && (
                    <>
                      {', '}
                      <Count value={row.attributes.commitCount} unit="commit" />
                      {' and '}
                      <Count value={row.attributes.pullRequestCount} unit="pull request" />
                      {' at stake'}
                    </>
                  )}
                  {row.artifactKinds.length > 0 && <> — seen in {row.artifactKinds.join(', ')}</>}
                </p>

                {/*
                  The sample artifact *link* the criterion asks for.

                  Anchors, not mono text: "go and look at it" is the whole point, and a
                  reader cannot follow a string. Same treatment as the report's evidence
                  markers, and the same `artifactHref` builds both paths, so the queue
                  cannot invent a shape the artifact route does not serve.
                */}
                {row.sampleLinks.length > 0 ? (
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-faint">
                    <span className="sr-only">Sample artifacts: </span>
                    <span aria-hidden="true">for example </span>
                    {row.sampleLinks.map((sample, index) => (
                      <span key={sample.href}>
                        {index > 0 && <span aria-hidden="true"> · </span>}
                        <Link
                          href={sample.href}
                          className="data-token underline decoration-rule-strong underline-offset-4 transition-colors duration-150 hover:decoration-verified focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {sample.label}
                          <span className="sr-only"> — an artifact this identifier accounts for</span>
                        </Link>
                      </span>
                    ))}
                  </p>
                ) : (
                  row.sampleWitnessRefs.length > 0 && (
                    // Seen, but in nothing Compass has an artifact page for — a chat message,
                    // say. Stated as the source record it is rather than dressed as a link
                    // that would land nowhere.
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
                      seen in <span className="font-mono">{row.sampleWitnessRefs.join('  ·  ')}</span> — no commit or
                      pull request carries this identifier yet
                    </p>
                  )
                )}

                {row.resolved ? (
                  <p className="mt-2 text-[13px] text-ink-muted">
                    Merged into <code className="data-token">{row.resolvedDeveloperKey}</code>.
                  </p>
                ) : (
                  <MergeForm
                    identityKey={row.identityKey}
                    developers={roster.developers}
                    busy={busy !== null}
                    onSubmit={(body) =>
                      act('/api/roster/merges', 'POST', { identityKey: row.identityKey, ...body }, `merge:${row.identityKey}`).then(
                        (result) => settle(result, row.value),
                      )
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        numeral="06"
        title="absences"
        lead="While an absence covers the report instant, stalled-work findings naming that person are withheld and the report states why, with a link back to the record. The elapsed count itself is never shortened — that number is one a manager can check on the board."
      >
        {roster.absences.length === 0 ? (
          <EmptyState copy={EMPTY_STATES.rosterAbsences} />
        ) : (
          <ul className="grid gap-2">
            {roster.absences.map((absence) => (
              <li
                key={absence.naturalKey}
                className={`border-l-2 pl-3 text-[13px] leading-relaxed ${
                  absence.activeNow ? 'border-authored' : 'border-rule text-ink-faint'
                }`}
              >
                <code className="data-token">{absence.developerKey}</code>{' '}
                <span className="text-ink-muted">{absence.kind.replace(/_/g, ' ')}</span>{' '}
                {/* The last day covered, not the exclusive bound — so the range reads the way
                    the manager typed it and the way suppression actually behaves. */}
                <span className="font-mono tabular-nums">
                  {dateOf(absence.startAt)} → {lastCoveredDay(absence.endAt)}
                </span>
                <span className="text-ink-faint"> — {absence.source === 'memo' ? 'from a manager memo' : 'recorded in the roster'}</span>
                {absence.sourceRef !== null && <code className="data-token ml-1">{absence.sourceRef}</code>}
                {absence.note !== null && <span className="stated-absence"> —— {absence.note}</span>}
                {absence.activeNow && (
                  <span className="ml-2 rounded border border-authored px-1 font-mono text-[11px] text-authored-text">
                    in force
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Outcomes, in the reading column. Never a toast. */}
      {stated !== null && (
        <p role="status" className="prose-narration mt-10 border-l-2 border-verified pl-3 text-[15px]">
          {stated}
        </p>
      )}

      {undoable !== null && (
        <div className="mt-4 border-l-2 border-authored pl-3">
          <p className="section-label">one click away</p>
          <p className="prose-narration mt-1 text-[15px]">
            If <code className="data-token">{undoable.label}</code> was the wrong person, undo restores the prior
            attribution exactly — the merge recorded what it changed, and both acts stay in the audit log.
          </p>
          <p className="mt-3 flex flex-wrap gap-x-5 text-[13px]">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                void act(
                  '/api/roster/merges',
                  'DELETE',
                  { mergeAuditId: undoable.auditId },
                  `undo:${undoable.auditId}`,
                ).then((result) => {
                  setUndoable(null);
                  settle(result);
                });
              }}
              className="tertiary-action"
            >
              undo that merge
            </button>
            <button
              type="button"
              onClick={() => {
                setUndoable(null);
                router.refresh();
              }}
              className="tertiary-action"
            >
              keep it — refresh the roster
            </button>
          </p>
        </div>
      )}

      {failed !== null && (
        <p role="alert" className="prose-narration mt-10 border-l-2 border-rule-severe pl-3 text-[15px]">
          {failed}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

function TrackedList({
  rows,
  kind,
  emptyStatement,
  busy,
  onToggle,
}: {
  readonly rows: RosterScreenView['repositories'];
  readonly kind: 'repository' | 'project';
  readonly emptyStatement: string;
  readonly busy: boolean;
  readonly onToggle: (key: string, tracked: boolean) => void;
}) {
  if (rows.length === 0) return <p className="stated-absence text-[15px]">{emptyStatement}</p>;

  return (
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li
          key={row.key}
          className={`flex flex-wrap items-baseline gap-x-3 border-l-2 pl-3 text-[13px] leading-relaxed ${
            row.tracked ? 'border-verified' : 'border-rule text-ink-faint'
          }`}
        >
          <code className="data-token">{row.key}</code>
          {row.parentKey !== null && <span className="text-ink-faint">{row.parentKey}</span>}
          {row.tracked ? (
            <span className="text-ink-muted">tracked</span>
          ) : (
            <span className="stated-absence">
              archived{row.archivedAt === null ? '' : ` ${dateOf(row.archivedAt)}`} — excluded from future ingest, every
              prior row kept
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onToggle(row.key, !row.tracked)}
            className="tertiary-action"
          >
            {row.tracked ? `archive this ${kind}` : 'track it again'}
          </button>
        </li>
      ))}
    </ul>
  );
}

function AddMemberForm({
  teamKey,
  developers,
  taken,
  busy,
  onSubmit,
}: {
  readonly teamKey: string;
  readonly developers: RosterScreenView['developers'];
  readonly taken: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onSubmit: (developerKey: string, membershipRole: 'member' | 'lead') => void;
}) {
  const available = developers.filter((developer) => !taken.has(developer.key));
  const [developerKey, setDeveloperKey] = useState('');
  const [membershipRole, setMembershipRole] = useState<'member' | 'lead'>('member');

  if (available.length === 0) {
    return <p className="stated-absence mt-3 text-[13px]">Everybody configured is already on this team.</p>;
  }

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (developerKey.length === 0) return;
        onSubmit(developerKey, membershipRole);
      }}
      className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2"
    >
      <label className="block">
        <span className="section-label">add to {teamKey}</span>
        <select
          value={developerKey}
          onChange={(event) => setDeveloperKey(event.target.value)}
          className="goal-input !h-8 w-auto"
          aria-label={`Person to add to ${teamKey}`}
        >
          <option value="">choose somebody</option>
          {available.map((developer) => (
            <option key={developer.key} value={developer.key}>
              {developer.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="section-label">as</span>
        <select
          value={membershipRole}
          onChange={(event) => setMembershipRole(event.target.value === 'lead' ? 'lead' : 'member')}
          className="goal-input !h-8 w-auto"
          aria-label="Membership role"
        >
          <option value="member">member</option>
          <option value="lead">lead</option>
        </select>
      </label>
      <button type="submit" disabled={busy || developerKey.length === 0} className="primary-action !h-8">
        Add
      </button>
    </form>
  );
}

function CalendarForm({
  team,
  busy,
  onSubmit,
}: {
  readonly team: RosterScreenView['teams'][number];
  readonly busy: boolean;
  readonly onSubmit: (workingWeekdays: readonly number[], holidays: readonly string[], timezone: string) => void;
}) {
  const configured = team.calendar;
  const [weekdays, setWeekdays] = useState<readonly number[]>(configured?.workingWeekdays ?? [1, 2, 3, 4, 5]);
  const [holidays, setHolidays] = useState((configured?.holidays ?? []).join(', '));
  const [timezone, setTimezone] = useState(configured?.timezone ?? team.timezone);

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit(
          weekdays,
          holidays
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
          timezone,
        );
      }}
      className="mt-5"
    >
      <p className="section-label">working calendar</p>
      {configured === null && (
        <p className="stated-absence mt-1 text-[13px]">
          Not configured, so working days are counted Monday to Friday, UTC.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        {[1, 2, 3, 4, 5, 6, 7].map((day) => (
          <label key={day} className="flex items-baseline gap-2 text-[13px] text-ink-muted">
            <input
              type="checkbox"
              checked={weekdays.includes(day)}
              onChange={(event) =>
                setWeekdays((current) =>
                  event.target.checked
                    ? [...current, day].sort((left, right) => left - right)
                    : current.filter((entry) => entry !== day),
                )
              }
              className="size-3 accent-verified"
            />
            {WEEKDAY_NAMES[day]}
          </label>
        ))}
      </div>

      <label className="mt-3 block max-w-[26rem]">
        <span className="section-label">holidays</span>
        <input
          type="text"
          value={holidays}
          onChange={(event) => setHolidays(event.target.value)}
          className="goal-input"
          placeholder="2026-08-31, 2026-12-25"
          aria-label={`Holidays for ${team.key}`}
        />
        <span className="stated-absence mt-1 block text-[13px]">
          Comma-separated <code className="data-token">YYYY-MM-DD</code> dates. These do not count as working days,
          however they fall.
        </span>
      </label>

      <label className="mt-3 block max-w-[16rem]">
        <span className="section-label">zone</span>
        <input
          type="text"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          className="goal-input"
          aria-label={`Timezone for ${team.key}`}
        />
      </label>

      <button type="submit" disabled={busy || weekdays.length === 0} className="primary-action mt-4 !h-8">
        Save calendar
      </button>
      {weekdays.length === 0 && (
        <span className="stated-absence ml-3 text-[13px]">
          At least one working day — with none, no threshold could ever be crossed.
        </span>
      )}
    </form>
  );
}

function AddIdentityForm({
  developerKey,
  busy,
  onSubmit,
}: {
  readonly developerKey: string;
  readonly busy: boolean;
  readonly onSubmit: (kind: Kind, value: string) => void;
}) {
  const [kind, setKind] = useState<Kind>('email');
  const [value, setValue] = useState('');

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (value.trim().length === 0) return;
        onSubmit(kind, value.trim());
        setValue('');
      }}
      className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2"
    >
      <label className="block">
        <span className="section-label">link</span>
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as Kind)}
          className="goal-input !h-8 w-auto"
          aria-label={`Identifier kind for ${developerKey}`}
        >
          <option value="email">git email</option>
          <option value="account">tracker account</option>
          <option value="handle">chat handle</option>
        </select>
      </label>
      <label className="block max-w-[20rem] flex-1">
        <span className="section-label">identifier</span>
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="goal-input"
          placeholder={kind === 'email' ? 'priya@acme.example' : 'the source’s own id'}
          aria-label={`Identifier value for ${developerKey}`}
        />
      </label>
      <button type="submit" disabled={busy || value.trim().length === 0} className="primary-action !h-8">
        Link
      </button>
    </form>
  );
}

function AbsenceForm({
  developerKey,
  absences,
  busy,
  onSubmit,
  onEnd,
}: {
  readonly developerKey: string;
  readonly absences: RosterScreenView['developers'][number]['absences'];
  readonly busy: boolean;
  readonly onSubmit: (kind: string, startAt: string, endAt: string, note: string | null) => void;
  /** Ends it now. The instant is the server's, so this takes no date. */
  readonly onEnd: (absenceKey: string) => void;
}) {
  const [kind, setKind] = useState('leave');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [note, setNote] = useState('');

  return (
    <div className="mt-4">
      {absences.length > 0 && (
        <ul className="mb-2 grid gap-1">
          {absences.map((absence) => (
            <li key={absence.naturalKey} className="text-[13px] leading-relaxed text-ink-muted">
              {absence.kind.replace(/_/g, ' ')}{' '}
              <span className="font-mono tabular-nums">
                {dateOf(absence.startAt)} → {lastCoveredDay(absence.endAt)}
              </span>
              {absence.activeNow && (
                <>
                  {' '}
                  <span className="rounded border border-authored px-1 font-mono text-[11px] text-authored-text">
                    in force
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onEnd(absence.naturalKey)}
                    className="tertiary-action ml-2"
                  >
                    end it now
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (startAt.length === 0 || endAt.length === 0 || endAt < startAt) return;
          onSubmit(
            kind,
            new Date(`${startAt}T00:00:00Z`).toISOString(),
            // Inclusive of the day picked: the absence ends at the start of the next day.
            inclusiveEndInstant(endAt),
            note.trim().length === 0 ? null : note.trim(),
          );
        }}
        className="flex flex-wrap items-end gap-x-4 gap-y-2"
      >
        <label className="block">
          <span className="section-label">mark out</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="goal-input !h-8 w-auto"
            aria-label={`Absence kind for ${developerKey}`}
          >
            <option value="leave">leave</option>
            <option value="holiday">holiday</option>
            <option value="on_call">on call</option>
            <option value="inactive">inactive</option>
          </select>
        </label>
        <label className="block">
          <span className="section-label">from</span>
          <input
            type="date"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
            className="goal-input !h-8 w-auto"
            aria-label={`Absence start for ${developerKey}`}
          />
        </label>
        <label className="block">
          <span className="section-label">until (inclusive)</span>
          <input
            type="date"
            value={endAt}
            // Can't end before it starts, and the same day is a legitimate one-day absence.
            min={startAt.length > 0 ? startAt : undefined}
            onChange={(event) => setEndAt(event.target.value)}
            className="goal-input !h-8 w-auto"
            aria-label={`Absence end for ${developerKey}, inclusive of this day`}
          />
        </label>
        <label className="block max-w-[16rem] flex-1">
          <span className="section-label">note</span>
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="goal-input"
            aria-label={`Absence note for ${developerKey}`}
          />
        </label>
        <button
          type="submit"
          disabled={busy || startAt.length === 0 || endAt.length === 0 || endAt < startAt}
          className="primary-action !h-8"
        >
          Record
        </button>
        {endAt.length > 0 && startAt.length > 0 && endAt < startAt && (
          <span className="stated-absence text-[13px]">
            An absence has to end on or after the day it starts.
          </span>
        )}
      </form>
    </div>
  );
}

function MergeForm({
  identityKey,
  developers,
  busy,
  onSubmit,
}: {
  readonly identityKey: string;
  readonly developers: RosterScreenView['developers'];
  readonly busy: boolean;
  readonly onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [developerKey, setDeveloperKey] = useState('');
  const [newKey, setNewKey] = useState('');
  const [displayName, setDisplayName] = useState('');

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (mode === 'existing') {
          if (developerKey.length === 0) return;
          onSubmit({ developerKey });
          return;
        }
        if (newKey.trim().length === 0 || displayName.trim().length === 0) return;
        onSubmit({ developerKey: newKey.trim(), createDeveloper: true, displayName: displayName.trim() });
      }}
      className="mt-3"
    >
      <fieldset className="border-0 p-0">
        <legend className="section-label">merge into</legend>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
          {(['existing', 'new'] as const).map((option) => (
            <label
              key={option}
              className={`flex cursor-pointer items-baseline gap-2 text-[13px] transition-colors duration-150 hover:text-ink-strong ${
                mode === option ? 'text-ink-strong' : 'text-ink-muted'
              }`}
            >
              <input
                type="radio"
                name={`merge-mode-${identityKey}`}
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
                className="size-3 accent-verified"
              />
              {option === 'existing' ? 'somebody already here' : 'a new person'}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        {mode === 'existing' ? (
          <label className="block">
            <span className="section-label">person</span>
            <select
              value={developerKey}
              onChange={(event) => setDeveloperKey(event.target.value)}
              className="goal-input !h-8 w-auto"
              aria-label={`Person to merge ${identityKey} into`}
            >
              <option value="">choose somebody</option>
              {developers.map((developer) => (
                <option key={developer.key} value={developer.key}>
                  {developer.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="block max-w-[12rem]">
              <span className="section-label">key</span>
              <input
                type="text"
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
                className="goal-input"
                placeholder="priya-raman"
                aria-label="New person key"
              />
            </label>
            <label className="block max-w-[16rem]">
              <span className="section-label">name</span>
              <input
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="goal-input"
                placeholder="Priya Raman"
                aria-label="New person display name"
              />
            </label>
          </>
        )}
        <button type="submit" disabled={busy} className="primary-action !h-8">
          Merge
        </button>
      </div>

      {mode === 'new' && (
        <p className="stated-absence mt-2 text-[13px]">
          Compass will not derive a name from an email address — that guess is what the unmatched queue exists to refuse.
        </p>
      )}
    </form>
  );
}
