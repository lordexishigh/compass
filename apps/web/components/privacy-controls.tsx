'use client';

import { useState, useTransition } from 'react';

/**
 * The three writes on `/privacy`, as one small client island.
 *
 * Everything else on that page is a Server Component reading the store. Only the controls
 * are interactive, and they are grouped here rather than scattered so there is one place
 * that knows how a privacy write reports itself: an outcome sentence in the product's voice,
 * printed under the control that caused it, never a toast that disappears before it is read.
 *
 * ## Why the outcome is prose and not a green tick
 *
 * These are the writes with the largest consequences in the product — shortening a retention
 * window, withdrawing somebody's name, turning off narration. A tick says "it worked"; what a
 * manager actually needs to know is *what will now happen*, which is a sentence. The routes
 * return that sentence, and this prints it verbatim rather than paraphrasing.
 */

const RAW_CHOICES = [30, 90, 180, 365] as const;
const DERIVED_CHOICES = [
  { value: '1', label: '1 year' },
  { value: '3', label: '3 years' },
  { value: '7', label: '7 years' },
  { value: 'indefinite', label: 'indefinitely' },
] as const;

const MODES = [
  {
    value: 'full',
    title: 'Full text',
    detail:
      'The computed report goes to the model as written, names included. Raw text — commit messages, ticket ' +
      'comments, chat — never travels in any mode.',
  },
  {
    value: 'redacted',
    title: 'Redacted',
    detail:
      'Every name is replaced by a stable pseudonym on the way out and substituted back on this machine ' +
      'afterwards. The page a manager reads is identical; the provider never learns who works here.',
  },
  {
    value: 'none',
    title: 'No model at all',
    detail:
      'Zero requests. Every report is written by Compass’s own template renderer, states that it was, and passes ' +
      'the same grounding validator.',
  },
] as const;

interface Outcome {
  readonly kind: 'ok' | 'refused';
  readonly detail: string;
}

async function send(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { detail?: string };
    return {
      kind: response.ok ? 'ok' : 'refused',
      detail:
        payload.detail ??
        (response.ok
          ? 'Saved.'
          : 'Compass refused the change and did not say why, which is itself a fault. Nothing was changed.'),
    };
  } catch {
    return {
      kind: 'refused',
      // A network failure is not a refusal by the product, and the sentence says so: the
      // difference between "you may not" and "we could not ask" is what decides whether a
      // manager retries or goes looking for who to complain to.
      detail: 'The request never reached Compass, so nothing was changed. Check the connection and try again.',
    };
  }
}

function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  if (outcome === null) return null;
  return (
    <p
      role="status"
      data-state={outcome.kind === 'refused' ? 'refused' : 'applied'}
      className="feedback-outcome mt-3"
    >
      {outcome.detail}
    </p>
  );
}

export function RetentionControls({
  rawEventRetentionDays,
  derivedRetentionYears,
  canEdit,
}: {
  readonly rawEventRetentionDays: number;
  readonly derivedRetentionYears: number | null;
  readonly canEdit: boolean;
}) {
  const [raw, setRaw] = useState(String(rawEventRetentionDays));
  const [derived, setDerived] = useState(derivedRetentionYears === null ? 'indefinite' : String(derivedRetentionYears));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      setOutcome(
        await send('/api/privacy/settings', 'PATCH', {
          rawEventRetentionDays: Number(raw),
          derivedRetentionYears: derived === 'indefinite' ? null : Number(derived),
        }),
      );
    });
  };

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <label className="block">
          <span className="section-label">chat messages</span>
          <select
            className="goal-input mt-1 block w-44"
            value={raw}
            disabled={!canEdit || pending}
            onChange={(event) => setRaw(event.target.value)}
          >
            {RAW_CHOICES.map((choice) => (
              <option key={choice} value={String(choice)}>
                {choice} days
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="section-label">reports and derived data</span>
          <select
            className="goal-input mt-1 block w-44"
            value={derived}
            disabled={!canEdit || pending}
            onChange={(event) => setDerived(event.target.value)}
          >
            {DERIVED_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        {canEdit ? (
          <button type="button" className="primary-action" onClick={save} disabled={pending}>
            {pending ? 'saving…' : 'save windows'}
          </button>
        ) : null}
      </div>

      {canEdit ? null : (
        <p className="stated-absence mt-4">
          Only an owner can change a retention window. What is set is shown above, and the next purge will apply it.
        </p>
      )}

      <OutcomeLine outcome={outcome} />
    </div>
  );
}

export function MinimizationControls({
  mode,
  canEdit,
}: {
  readonly mode: string;
  readonly canEdit: boolean;
}) {
  const [selected, setSelected] = useState(mode);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const choose = (value: string) => {
    setSelected(value);
    startTransition(async () => {
      setOutcome(await send('/api/privacy/settings', 'PATCH', { llmMinimizationMode: value }));
    });
  };

  return (
    <div className="mt-5">
      <fieldset disabled={!canEdit || pending} className="space-y-4">
        <legend className="sr-only">How much a language model is shown</legend>
        {/* `id`/`htmlFor` rather than a wrapping label: the mode's title and its explanation are
            two blocks, and a label whose text is nested inside them is one a screen reader — and
            `jsx-a11y` — cannot find. The explanation is tied on with `aria-describedby`, so it is
            announced after the name rather than as part of it. */}
        {MODES.map((option) => (
          <div key={option.value} className="flex gap-3">
            <input
              id={`llm-mode-${option.value}`}
              type="radio"
              name="llm-minimization-mode"
              value={option.value}
              checked={selected === option.value}
              onChange={() => choose(option.value)}
              aria-describedby={`llm-mode-${option.value}-detail`}
              className="mt-1 accent-[var(--verified)]"
            />
            <span>
              <label
                htmlFor={`llm-mode-${option.value}`}
                className="block text-[14px] font-semibold text-ink-strong"
              >
                {option.title}
              </label>
              <span
                id={`llm-mode-${option.value}-detail`}
                className="mt-0.5 block text-[13px] leading-relaxed text-ink-muted"
              >
                {option.detail}
              </span>
            </span>
          </div>
        ))}
      </fieldset>

      {canEdit ? null : (
        <p className="stated-absence mt-4">
          Only an owner can change this. The mode in force is marked above and applies to every report Compass writes.
        </p>
      )}

      <OutcomeLine outcome={outcome} />
    </div>
  );
}

export function ChannelToggle({
  conversationKey,
  conversationName,
  conversationKind,
  enabled,
}: {
  readonly conversationKey: string;
  readonly conversationName: string;
  readonly conversationKind: string;
  readonly enabled: boolean;
}) {
  const [isOn, setIsOn] = useState(enabled);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const isPublic = conversationKind === 'public_channel';

  const toggle = () => {
    const next = !isOn;
    startTransition(async () => {
      const result = await send('/api/privacy/channels', 'PATCH', {
        conversationKey,
        conversationName,
        conversationKind,
        enabled: next,
      });
      // Only move the switch if Compass agreed. A control that flips optimistically and then
      // silently reverts is how somebody comes to believe a channel is off when it is on.
      if (result.kind === 'ok') setIsOn(next);
      setOutcome(result);
    });
  };

  return (
    <div>
      <button
        type="button"
        className="feedback-action"
        onClick={toggle}
        disabled={pending || !isPublic}
        aria-pressed={isOn}
      >
        {pending ? 'saving…' : isOn ? 'stop reading this channel' : 'read this channel'}
      </button>
      {isPublic ? null : (
        <p className="stated-absence mt-2">
          Compass does not read {conversationKind.replace(/_/g, ' ')}s. Not as a setting — at all.
        </p>
      )}
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

export function AnonymizeControl({
  developerKey,
  displayName,
  anonymized,
}: {
  readonly developerKey: string;
  readonly displayName: string;
  readonly anonymized: boolean;
}) {
  const [isAnonymous, setIsAnonymous] = useState(anonymized);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const act = () => {
    startTransition(async () => {
      const result = isAnonymous
        ? await send('/api/privacy/anonymize', 'DELETE', { developerKey })
        : await send('/api/privacy/anonymize', 'POST', { developerKey, reason: 'departed' });
      if (result.kind === 'ok') setIsAnonymous(!isAnonymous);
      setOutcome(result);
    });
  };

  return (
    <div>
      <button type="button" className="feedback-action" onClick={act} disabled={pending} aria-pressed={isAnonymous}>
        {pending
          ? 'saving…'
          : isAnonymous
            ? `restore ${displayName}’s name`
            : `withdraw ${displayName}’s name`}
      </button>
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

export function DeletionControls({
  canDeleteOrganization,
  /**
   * Whether to offer the whole-organization export.
   *
   * `/api/privacy/export` is owner-only, so offering the link to a member would be a button
   * that answers 403 — which reads as the product being broken rather than as the permission
   * it is. When it is not offered, the alternative is stated instead: this page is itself the
   * record of what Compass holds about the reader, which is the thing they were actually
   * asking for. Defaults to true so `/privacy`, whose only readers are owners and managers,
   * needs no extra argument.
   */
  canExport = true,
}: {
  readonly canDeleteOrganization: boolean;
  readonly canExport?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const request = (subjectKind: 'account' | 'organization') => {
    startTransition(async () => {
      setOutcome(await send('/api/privacy/deletion', 'POST', { subjectKind }));
      setConfirmed(false);
    });
  };

  return (
    <div className="mt-5">
      {canExport ? (
        <p className="mt-2 flex flex-wrap gap-x-5 text-[13px]">
          <a href="/api/privacy/export" className="tertiary-action">
            download everything Compass holds
          </a>
        </p>
      ) : (
        <p className="stated-absence mt-2">
          The machine-readable export of the whole organization is an owner&apos;s to download. Everything Compass
          holds about <em>you</em> is on this page, and the email it sends when you ask to delete carries the same
          link an owner would use.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button type="button" className="feedback-action" onClick={() => request('account')} disabled={pending}>
          delete my account
        </button>

        {canDeleteOrganization ? (
          <>
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="accent-[var(--verified)]"
              />
              {/* The confirmation is a checkbox rather than a typed organization name because
                  the seven-day grace period is the real safety mechanism. A typing ritual in
                  front of a reversible act is theatre; the undo link is the substance. */}
              I understand this schedules deletion of the whole organization
            </label>
            <button
              type="button"
              className="feedback-action"
              onClick={() => request('organization')}
              disabled={pending || !confirmed}
            >
              delete this organization
            </button>
          </>
        ) : null}
      </div>

      <OutcomeLine outcome={outcome} />
    </div>
  );
}
