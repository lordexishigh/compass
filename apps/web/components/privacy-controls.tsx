'use client';

import { useEffect, useRef, useState, useTransition } from 'react';

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

/**
 * The two answers an owner may give about error reporting.
 *
 * Two, not three. `unset` is the stored state before anybody answered and `/api/privacy/settings`
 * refuses it as an input — offering it here would be offering "un-ask the question", which deletes
 * a consent record rather than withdrawing consent. Withdrawal is `denied`, and it is the second
 * option rather than an absent one so that saying no is as easy as saying yes.
 */
const ERROR_REPORTING_ANSWERS = [
  {
    value: 'granted',
    title: 'Send scrubbed reports',
    detail:
      'When Compass throws, a stack trace goes to the error tracker named on the data-processing page. Addresses, ' +
      'credentials and every piece of ingested text are removed before it leaves this process.',
  },
  {
    value: 'denied',
    title: 'Send nothing',
    detail:
      'Nothing leaves. Errors are written to this deployment’s own log and stay there, which is exactly what ' +
      'happens today while nobody has answered.',
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

/**
 * The sentence that says what a privacy change actually did.
 *
 * ## Why the region is rendered even when it is empty
 *
 * A screen reader announces changes *inside an existing* live region. It watches regions it already
 * knows about; a `role="status"` element that is inserted into the DOM together with its text is
 * frequently missed entirely, because there was no region to be watching when the text arrived.
 *
 * This returned `null` until there was an outcome, which is the shape that fails — and it failed on
 * the sentences that matter most in this file: "the next scheduled purge applies the new window",
 * "the model was shown pseudonyms". A manager changing retention with a screen reader got silence.
 *
 * So the `<p>` is always present and only its *content* changes. `data-state` moves with the text for
 * the same reason: it is what colours the line, and an `applied` attribute sitting on an empty
 * paragraph would style a blank.
 */
function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  return (
    <p
      role="status"
      // Absent while empty rather than a third "none" value: the stylesheet keys on `refused`, and a
      // state attribute on a paragraph with no text describes nothing.
      {...(outcome === null ? {} : { 'data-state': outcome.kind === 'refused' ? 'refused' : 'applied' })}
      className={outcome === null ? 'sr-only' : 'feedback-outcome mt-3'}
    >
      {outcome === null ? '' : outcome.detail}
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

  /**
   * The radios, so focus can come back to the one the manager just chose.
   *
   * Same hazard `FeedbackActions` handles with `verbRefs`: a control that is disabled while a write is
   * in flight cannot hold focus, so the browser drops it to `<body>` and the next Tab restarts from
   * the top of the document. The configuration screens had no equivalent, which meant changing the
   * narration mode with the keyboard threw the reader out of the fieldset every time.
   *
   * Moving `disabled` from the `<fieldset>` to each `<input>` alone would not have fixed it — a
   * disabled input cannot hold focus either — so the fix is the same as the report's: remember which
   * one was activated, and put focus back when the transition ends.
   */
  const radioRefs = useRef(new Map<string, HTMLInputElement>());
  const [restoreFocusTo, setRestoreFocusTo] = useState<string | null>(null);

  useEffect(() => {
    // Only once the write has finished: while `pending` the input is still disabled and `.focus()`
    // would be a no-op.
    if (pending || restoreFocusTo === null) return;
    radioRefs.current.get(restoreFocusTo)?.focus();
    setRestoreFocusTo(null);
  }, [pending, restoreFocusTo]);

  const choose = (value: string) => {
    setSelected(value);
    setRestoreFocusTo(value);
    startTransition(async () => {
      setOutcome(await send('/api/privacy/settings', 'PATCH', { llmMinimizationMode: value }));
    });
  };

  return (
    <div className="mt-5">
      {/*
        `disabled` here covers only `!canEdit`, which is a *standing* state: a viewer never focuses
        these, so nothing is taken away from anybody. The transient in-flight disable lives on the
        individual inputs below, paired with the focus restore above — a `<fieldset disabled>` that
        flickered on every write is what dropped focus to `<body>`.

        `aria-busy` says a write is in flight without removing anything from the accessibility tree.
      */}
      <fieldset disabled={!canEdit} aria-busy={pending} className="space-y-4">
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
              // The transient disable, on the input rather than the fieldset, so the effect above can
              // give focus back to this exact radio when the write finishes.
              disabled={pending}
              ref={(node) => {
                if (node === null) radioRefs.current.delete(option.value);
                else radioRefs.current.set(option.value, node);
              }}
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

/**
 * The answer to the consent notice, and the only place it can be given.
 *
 * `components/error-reporting-notice.tsx` renders a landmark at the foot of every page while the
 * stored value is `unset`, and it deliberately carries no buttons: the choice is the organization's
 * posture, `/api/privacy/settings` is owner-only, and a viewer pressing "Allow" would be deciding
 * for everybody. This is where it points. Without this control the notice was undismissable through
 * the product — the one state its own docstring promises it can leave.
 *
 * Built as a copy of `MinimizationControls` rather than as something new, down to the focus restore:
 * both are a small closed vocabulary written to the same endpoint, and a reader who has learned one
 * screen's radio group should not meet a second idiom on the same page.
 */
export function ErrorReportingControls({
  consent,
  canEdit,
}: {
  readonly consent: string;
  readonly canEdit: boolean;
}) {
  // `unset` is a real stored value and deliberately matches no radio, so nothing is preselected and
  // the group renders as the unanswered question it is. A default selection would show an answer
  // nobody gave.
  const [selected, setSelected] = useState(consent);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const radioRefs = useRef(new Map<string, HTMLInputElement>());
  const [restoreFocusTo, setRestoreFocusTo] = useState<string | null>(null);

  useEffect(() => {
    if (pending || restoreFocusTo === null) return;
    radioRefs.current.get(restoreFocusTo)?.focus();
    setRestoreFocusTo(null);
  }, [pending, restoreFocusTo]);

  const choose = (value: string) => {
    setSelected(value);
    setRestoreFocusTo(value);
    startTransition(async () => {
      setOutcome(await send('/api/privacy/settings', 'PATCH', { errorReportingConsent: value }));
    });
  };

  return (
    <div className="mt-5">
      {selected === 'unset' && (
        // Stated rather than implied. An unanswered radio group looks identical to one whose answer
        // failed to load, and "honest degradation" means the page says which it is.
        <p className="stated-absence mb-4">
          Nobody has answered yet, so Compass is sending nothing. Either answer settles it and the
          notice at the foot of the page goes away; both can be changed again here at any time.
        </p>
      )}

      <fieldset disabled={!canEdit} aria-busy={pending} className="space-y-4">
        <legend className="sr-only">Whether stack traces may leave this deployment</legend>
        {ERROR_REPORTING_ANSWERS.map((option) => (
          <div key={option.value} className="flex gap-3">
            <input
              id={`error-reporting-${option.value}`}
              type="radio"
              name="error-reporting-consent"
              value={option.value}
              checked={selected === option.value}
              disabled={pending}
              ref={(node) => {
                if (node === null) radioRefs.current.delete(option.value);
                else radioRefs.current.set(option.value, node);
              }}
              onChange={() => choose(option.value)}
              aria-describedby={`error-reporting-${option.value}-detail`}
              className="mt-1 accent-[var(--verified)]"
            />
            <span>
              <label
                htmlFor={`error-reporting-${option.value}`}
                className="block text-[14px] font-semibold text-ink-strong"
              >
                {option.title}
              </label>
              <span
                id={`error-reporting-${option.value}-detail`}
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
          Only an owner can answer this. Whatever is marked above is what Compass is doing now.
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
      {/*
        No `aria-pressed`.

        This is an *action* button, not a toggle: its label names the act it performs — "read this
        channel" / "stop reading this channel" — and that is the idiom the rest of the product uses.
        Pairing a flipping label with `aria-pressed` announced the state twice and in opposite
        senses: a screen reader read "stop reading this channel, pressed" when the channel *is* being
        read, which is exactly backwards from how a pressed toggle is understood. A toggle may change
        its name or its pressed state, never both.
      */}
      <button type="button" className="feedback-action" onClick={toggle} disabled={pending || !isPublic}>
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
      {/* An action button, not a toggle — see `ChannelToggle` for why `aria-pressed` is absent. The
          label names the act and carries the person it acts on, which is the half a screen-reader
          user needs when four of these sit in a list. */}
      <button type="button" className="feedback-action" onClick={act} disabled={pending}>
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
