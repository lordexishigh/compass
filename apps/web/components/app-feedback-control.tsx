'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * The one place to tell us something about Compass itself.
 *
 * ## Where it sits, and why that is the hard part
 *
 * The reading column is the product. A floating widget that overlapped the last line of the Wins
 * section would be a small feature damaging the main one, so this is a 44px-tall pill pinned to the
 * bottom-right *outside* the measure, and `body` carries a matching bottom padding
 * (`--app-feedback-reserve`) so the final line of prose can always be scrolled clear of it. On a
 * 375px phone the pill sits in the 24px of gutter to the right of the reading column and the
 * reserved space below it is the guarantee that nothing is ever covered.
 *
 * It is mounted once in the root layout rather than inside `ReportDocument`, which is what makes it
 * reachable from *both* report views — today's report and any archived permalink — plus the weekly
 * digest and the merged view, without four copies that can drift apart.
 *
 * ## Never lose what somebody typed
 *
 * The textarea's value is cleared on exactly one condition: a 2xx response. A failed request, an
 * offline browser, a message over the ceiling — all of them leave the text where it is and put the
 * reason above it, because a support box that eats a paragraph on the first failure is a box nobody
 * uses twice. The panel also does not close itself on failure for the same reason.
 *
 * ## Colour
 *
 * Teal, the design's colour for the person's own authorship, never emerald: emerald means verified
 * positive fact, and reporting a problem is not a win. The pill itself is zinc at rest so the page
 * still has exactly one saturated object in it.
 */

type Outcome = { readonly kind: 'stored' | 'refused'; readonly detail: string };

const CLOSE_LABEL = 'Close the feedback form';

export function AppFeedbackControl() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sending, setSending] = useState(false);

  const panelId = useId();
  const fieldId = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  // Focus follows the disclosure in both directions: into the field on open, back to the pill on
  // close, so the whole control is usable from the keyboard without a mouse ever being involved.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const close = (): void => {
    setOpen(false);
    opener.current?.focus();
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const typed = message.trim();
    if (typed.length === 0 || sending) return;

    setSending(true);
    setOutcome(null);

    try {
      const response = await fetch('/api/feedback/app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: typed }),
      });
      const body = (await response.json()) as { readonly detail?: string };

      if (response.ok) {
        setOutcome({ kind: 'stored', detail: body.detail ?? 'Thank you — that is stored.' });
        // The one place the text is discarded: it is safely on the server.
        setMessage('');
      } else {
        setOutcome({
          kind: 'refused',
          detail:
            body.detail ??
            'Compass could not store that just now. Nothing was lost — your message is still here, so try again in a moment.',
        });
      }
    } catch {
      // An offline browser or a dropped connection. Stated plainly, and the text stays put.
      setOutcome({
        kind: 'refused',
        detail:
          'Compass could not be reached, so nothing was sent. Your message is still here — try again when you are back online.',
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="app-feedback" data-open={open ? 'true' : 'false'}>
      {open && (
        <form
          id={panelId}
          className="app-feedback__panel"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
          }}
          aria-labelledby={`${panelId}-title`}
        >
          <div className="app-feedback__head">
            <p id={`${panelId}-title`} className="section-label">
              Tell us about Compass
            </p>
            <button type="button" className="app-feedback__close" onClick={close} aria-label={CLOSE_LABEL}>
              Close
            </button>
          </div>

          <label className="app-feedback__label" htmlFor={fieldId}>
            What is wrong, confusing, or missing? This goes to the people who maintain Compass — it never changes
            what your reports say.
          </label>
          <textarea
            id={fieldId}
            ref={field}
            className="app-feedback__field"
            rows={4}
            value={message}
            placeholder="The projected date reads as more certain than the collar underneath it."
            onChange={(event) => setMessage(event.target.value)}
          />

          {/*
            The outcome sits above the button rather than replacing the form, because the form is what
            somebody needs if the answer was a refusal — and after a success it is what they need to
            send a second thought. `role="status"` rather than `alert`: a stored message is not an
            emergency, and an assertive region would interrupt a screen reader mid-sentence.
          */}
          {outcome !== null && (
            <p className="app-feedback__outcome" data-state={outcome.kind} role="status">
              {outcome.detail}
            </p>
          )}

          <div className="app-feedback__foot">
            <button type="submit" className="primary-action" disabled={sending || message.trim().length === 0}>
              {sending ? 'Sending' : 'Send'}
            </button>
          </div>
        </form>
      )}

      <button
        type="button"
        ref={opener}
        className="app-feedback__pill"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {open ? 'Close' : 'Feedback'}
      </button>
    </div>
  );
}
