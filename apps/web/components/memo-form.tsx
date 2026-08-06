'use client';

import { useState, useTransition } from 'react';

/**
 * The Manager Memo entry point: one sentence in, a typed assertion back.
 *
 * ## Why the confirmation shows Compass's *reading*, not a tick
 *
 * A memo changes what tomorrow's report says about a named human — it suppresses a stalled-work
 * finding, moves a deadline, records a dependency. The manager is entitled to see the assertion
 * Compass extracted before it does that, in the schema's own words, because the failure this
 * catches is not a rejected memo but an *accepted* one that was understood differently. "Priya is
 * out until Thursday" read as an open-ended absence is a memo that looks like it worked.
 *
 * So the recorded state renders the kind, the subject and the window as fields, not as a
 * paragraph. It is the same information the row holds, which is what makes it checkable.
 *
 * ## Three answers that are not failures
 *
 * The refusal — *"I can't represent that yet"* — is the product's most characteristic sentence and
 * comes from `REFUSAL_SENTENCE` in `@compass/memos` by way of the route, never from this file. A
 * memo outside the closed five-kind schema is declined in plain words rather than stored as
 * something nothing downstream can honour. It arrives as `message`, with `detail` naming what
 * could not be represented; both are rendered, because for a while only the second was and the
 * sentence the feature is known by never reached the screen.
 *
 * The candidate picker is the second: Compass understood the assertion and cannot tell which
 * Marcus it is about, so it asks rather than guessing. Choosing re-posts the same text with
 * `chosenSubjectKey` and nothing else — `submitMemo` re-derives the offer from the store and
 * refuses a key that is not in it, so the alternatives recorded on the memo are Compass's own
 * rather than the client's account of them.
 *
 * Every rule behind those three lives in `@compass/memos` — the threshold, the refusal, the
 * candidate list. This component renders outcomes and decides nothing, which is what stops the web
 * form and the inbound email path from disagreeing about what Compass will represent.
 */

interface SubjectCandidateView {
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly label: string;
  readonly reason: string;
}

interface AssertionView {
  readonly kind?: string;
  readonly subjectKind?: string;
  readonly counterparty?: string | null;
}

interface WindowView {
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string | null;
  readonly openEnded?: boolean;
}

type Outcome =
  | {
      readonly status: 'recorded';
      readonly detail: string;
      readonly subjectLabel: string;
      readonly assertion?: AssertionView;
      readonly window?: WindowView;
    }
  | { readonly status: 'needs_subject'; readonly detail: string; readonly candidates: readonly SubjectCandidateView[] }
  /**
   * A refusal carries two sentences, and the headline one is `message`.
   *
   * `ExtractionRefusal` declares `message` — always `REFUSAL_SENTENCE`, the product's own *"I
   * can't represent that yet"* — and `detail`, one sentence naming what could not be represented.
   * This branch used to render `detail` alone, so the sentence the feature is *known by* never
   * reached the screen while a supporting clause did. The package's own comment on `detail` says
   * "shown beneath the refusal", which is exactly the arrangement below.
   */
  | { readonly status: 'refused'; readonly message?: string; readonly detail?: string }
  | { readonly status: 'subject_unknown'; readonly detail: string }
  | { readonly status: 'error'; readonly detail: string };

/** A labelled field of the extracted assertion. Mono, because it is a stored value. */
function AssertionField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="section-label">{label}</span>
      <span className="data-token">{value}</span>
    </div>
  );
}

export function MemoForm() {
  const [text, setText] = useState('');
  /**
   * The sentence that was actually asked about, frozen at submit.
   *
   * `choose` re-posts the memo text with the chosen key, and reading it live off the textarea
   * meant a manager who tidied their wording after the "which Marcus?" question would send the
   * chosen key against a *different* sentence. `submitMemo` re-derives the offer from the store,
   * so the outcome was another `needs_subject` rather than a mis-bound memo — a dead end rather
   * than a wrong answer, but a confusing one: the question was about the sentence they had sent,
   * and the answer silently was not.
   */
  const [asked, setAsked] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  const send = (body: Record<string, unknown>): void => {
    startTransition(async () => {
      try {
        const response = await fetch('/api/memos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = (await response.json()) as Record<string, unknown>;

        // The route answers 201/409/422 with the outcome union in the body, and any other status
        // with `{ error, detail }`. Reading `status` first keeps the two apart without a table of
        // status codes here — the outcome is the contract, the code is how HTTP spells it.
        if (typeof payload['status'] === 'string') {
          setOutcome(payload as unknown as Outcome);
          return;
        }

        setOutcome({
          status: 'error',
          detail:
            typeof payload['detail'] === 'string'
              ? payload['detail']
              : 'Compass could not record that memo, and nothing has been written.',
        });
      } catch {
        setOutcome({ status: 'error', detail: 'Compass could not be reached, so nothing has been written.' });
      }
    });
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const asking = text.trim();
    if (asking.length === 0) return;
    setOutcome(null);
    setAsked(asking);
    send({ rawText: asking });
  };

  /**
   * Finishing a memo Compass understood but could not attribute.
   *
   * Only the key travels. The alternatives it was chosen between are deliberately *not* echoed
   * back: `submitMemo` re-derives the offer from the store and refuses a key that is not in it, so
   * sending them would be handing the server the client's account of the server's own question —
   * and that account is what ends up on the row as "why Marcus Hale rather than Marcus Webb".
   *
   * The channel does not travel either. It is `web` by virtue of being this form, and the route
   * pins it rather than reading it, so sending one would be payload the server is right to ignore.
   */
  const choose = (candidate: SubjectCandidateView): void => {
    // `asked`, not `text`: the answer belongs to the sentence the question was about.
    send({ rawText: asked, chosenSubjectKey: candidate.subjectKey });
  };

  return (
    <section aria-labelledby="memo-heading" className="hairline mt-8 pt-6">
      <h2 id="memo-heading" className="section-label">
        manager memo
      </h2>
      <p className="prose-narration mt-2 text-[15px] text-ink-muted">
        Tell Compass something it cannot see — somebody is away, a deadline moved, a team is blocked on another team.
        One sentence. It is read into a typed assertion you can check before tomorrow&apos;s report honours it.{' '}
        {/*
          Said before the submit rather than after it, in the same words and for the same reason as
          the time-travel control directly above.

          A memo *writes to the org model* — it can suppress a named person's findings for a week —
          so the role matrix admits owners and managers and nobody else. `/` performs no session
          lookup at all (the zero-config promise is that the first request passes no gate, and
          `tests/cold-start.test.tsx` asserts the route contains no `cookies(`), so this component
          cannot know who is reading and cannot hide itself from a reader without a seat.

          The alternative is a manager typing a sentence, pressing the button and meeting the
          matrix's denial — having already done the work. `tests/demo-credentials.test.tsx` holds
          every unauthenticated surface to being one hop from the published credentials; this is
          that hop, and it is also the sentence that stops the trip being wasted.
        */}
        Recording one writes to the org model, so it needs a seat —{' '}
        <a href="/account" className="tertiary-action">
          the demonstration credentials are on /account
        </a>
        .
      </p>

      <form onSubmit={submit} className="mt-4">
        <label htmlFor="memo-text" className="section-label">
          the memo
        </label>
        <textarea
          id="memo-text"
          name="rawText"
          className="feedback-reason"
          rows={2}
          value={text}
          disabled={pending}
          onChange={(event) => setText(event.target.value)}
          placeholder="Priya is out until Thursday"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="submit" className="primary-action" disabled={pending || text.trim().length === 0}>
            {pending ? 'reading…' : 'Record this memo'}
          </button>
          <span className="font-mono text-[11px] tabular-nums text-ink-faint">writes to the org model</span>
        </div>
      </form>

      {/*
        `role="status"` rather than `alert` throughout: an outcome is the answer to something the
        manager just did, not an emergency interrupting them.
      */}
      {outcome !== null && (
        <div role="status" className="mt-5">
          {outcome.status === 'recorded' && (
            <div className="border-l-2 border-authored pl-4">
              <p className="section-label text-authored-text">recorded — this is how Compass read it</p>
              <div className="mt-2 space-y-1">
                {outcome.assertion?.kind !== undefined && <AssertionField label="kind" value={outcome.assertion.kind} />}
                <AssertionField label="about" value={outcome.subjectLabel} />
                {outcome.window?.effectiveFrom !== undefined && (
                  <AssertionField
                    label="in force"
                    value={
                      outcome.window.openEnded === true || outcome.window.effectiveUntil === null
                        ? `${outcome.window.effectiveFrom} — open-ended`
                        : `${outcome.window.effectiveFrom} → ${outcome.window.effectiveUntil}`
                    }
                  />
                )}
                {outcome.assertion?.counterparty != null && (
                  <AssertionField label="counterparty" value={outcome.assertion.counterparty} />
                )}
              </div>
              <p className="prose-narration mt-3 text-[15px]">{outcome.detail}</p>
            </div>
          )}

          {outcome.status === 'needs_subject' && (
            <div className="border-l-2 border-rule-strong pl-4">
              <p className="section-label">who did you mean?</p>
              <p className="prose-narration mt-2 text-[15px]">{outcome.detail}</p>
              <ul className="mt-3 space-y-2">
                {outcome.candidates.map((candidate) => (
                  <li key={candidate.subjectKey}>
                    <button
                      type="button"
                      className="tertiary-action"
                      disabled={pending}
                      onClick={() => choose(candidate)}
                    >
                      {candidate.label}
                    </button>{' '}
                    <span className="stated-absence text-[13px]">{candidate.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {outcome.status === 'refused' && (
            // Both sentences, in the order the package intends them: `REFUSAL_SENTENCE` first,
            // then what it was about. Set in the stated-absence voice — the same serif italic a
            // missing deploy signal gets, because it is the same kind of sentence: a thing Compass
            // will not pretend to know.
            <div className="border-l-2 border-rule-strong pl-4">
              {outcome.message !== undefined && (
                <p className="stated-absence text-[15px]">{outcome.message}</p>
              )}
              {outcome.detail !== undefined && (
                <p className="stated-absence mt-1 text-[13px]">{outcome.detail}</p>
              )}
            </div>
          )}

          {(outcome.status === 'subject_unknown' || outcome.status === 'error') && (
            <p className="stated-absence border-l-2 border-rule-strong pl-4 text-[15px]">{outcome.detail}</p>
          )}
        </div>
      )}
    </section>
  );
}
