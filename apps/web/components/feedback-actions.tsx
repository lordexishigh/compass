'use client';

import { useEffect, useRef, useState, useTransition } from 'react';

import type { FeedbackOfferView } from '../lib/view-model';

/**
 * One click from the report: the manager's verdict on a finding.
 *
 * ## Why this is a client component and almost nothing else is
 *
 * The report is a document, rendered on the server, and that is the whole reason it arrives as
 * prose on a phone on a train instead of as a spinner. This is the one interactive object in it, so
 * it is the one `'use client'` boundary — a leaf under each claim, not a wrapper around the page.
 *
 * ## Verbs, not buttons
 *
 * The reading column is the product. A row of filled buttons under every claim would turn a
 * document into a control panel, so these are underlined verbs in teal — the design's colour for
 * *the manager's own authorship*, never emerald, because dismissing a risk is not a win. They are
 * still real controls: a 44px target on a phone, a visible focus ring, and a disabled state while
 * the request is in flight.
 *
 * ## What is shown afterwards
 *
 * The sentence Compass returns, which always names the effect on **future reports** rather than
 * acknowledging the click — "you will not see this again unless its severity rises by 100 points",
 * not "recorded". That is the difference between feedback and a thumbs-up button, and it is why the
 * outcome replaces the actions rather than sitting beside them: the item's fate is now decided, and
 * offering a second verdict on it would invite a manager to contradict themselves.
 *
 * The claim itself settles to 60% opacity behind a strikethrough hairline over 180ms, which is the
 * undo window the design brief asks for. There is no optimistic removal: the item stays on the page
 * until the next report, because a row that vanished on click would leave the manager with no way to
 * see what they had just done.
 *
 * ## Where focus goes, which this component has to manage by hand
 *
 * Three times in this component's life the element holding focus is *removed from the DOM*, and the
 * browser's answer to that is always the same and always wrong: focus falls to `<body>`, so the
 * keyboard user's next Tab restarts from the top of the page. Each one is handled explicitly:
 *
 *  - **Pressing a verb that needs a reason** replaces the button with a text field. Focus moves into
 *    the field (`autoFocus`), which is the case the `jsx-a11y/no-autofocus` exemption below is
 *    written for.
 *  - **Escape or Cancel** removes that field. Focus returns to the verb button that opened it, via
 *    `verbRefs` — the button has re-mounted by then, so the restore runs in an effect rather than in
 *    the handler.
 *  - **Submitting** replaces the whole row with the outcome sentence. Focus moves to that sentence,
 *    which carries `tabIndex={-1}` so it can receive focus without joining the tab order. It is the
 *    only thing left that describes what just happened, and as `role="status"` it is announced too.
 *
 * WCAG 2.4.3 is the criterion, and it is worth naming what makes this non-optional rather than
 * polish: a manager dismissing four risks in a row with the keyboard would otherwise be sent back to
 * the top of the document after each one.
 */

export interface FeedbackActionsProps {
  readonly stableId: string;
  /** The claim's own words, so a screen reader hears what the verb applies to. */
  readonly headline: string;
  readonly offers: readonly FeedbackOfferView[];
  /** A verdict already on this item, from a previous day. Null when there is none. */
  readonly existing: { readonly state: string; readonly clause: string } | null;
}

type Outcome = { readonly kind: 'applied' | 'refused'; readonly detail: string };

/**
 * Actions whose whole point is the manager's own words. Nothing else asks for a reason.
 *
 * `explain_unattributed` is the clearest case of the three: the item above it is a question, and
 * this verb opens the field the answer goes in. `feedback-source.ts` refuses an empty one, so the
 * field is not merely encouraged.
 */
const NEEDS_REASON: ReadonlySet<string> = new Set([
  'dismiss_risk',
  'off_goal_flag_wrong',
  'explain_unattributed',
]);

export function FeedbackActions({ stableId, headline, offers, existing }: FeedbackActionsProps) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  /** The verb buttons, so a cancelled reason field can hand focus back to the one that opened it. */
  const verbRefs = useRef(new Map<string, HTMLButtonElement>());
  /** Set when a reason field was dismissed; cleared by the effect that restores focus. */
  const [restoreFocusTo, setRestoreFocusTo] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLParagraphElement>(null);

  /**
   * Return focus to the verb after its reason field is dismissed.
   *
   * In an effect rather than in the key handler because the button does not exist yet when Escape
   * fires — it is re-mounted by the same render that removes the field, so `verbRefs` is only
   * populated once that render has committed.
   */
  useEffect(() => {
    if (restoreFocusTo === null) return;
    verbRefs.current.get(restoreFocusTo)?.focus();
    setRestoreFocusTo(null);
  }, [restoreFocusTo]);

  /** Focus the outcome sentence, which has replaced the button that was focused. */
  useEffect(() => {
    if (outcome !== null) outcomeRef.current?.focus();
  }, [outcome]);

  /** Closes the reason field and asks for focus to go back where it came from. */
  const dismissReason = (action: string): void => {
    setReasonFor(null);
    setReason('');
    setRestoreFocusTo(action);
  };

  if (offers.length === 0 && existing === null) return null;

  const submit = (action: string, note: string | null): void => {
    startTransition(async () => {
      try {
        const response = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stableId, action, ...(note === null ? {} : { reason: note }) }),
        });
        const body = (await response.json()) as { readonly detail?: string };
        setOutcome({
          kind: response.ok ? 'applied' : 'refused',
          detail:
            body.detail ??
            (response.ok
              ? 'Recorded.'
              : 'Compass could not record that just now, so nothing has changed. Try again in a moment.'),
        });
      } catch {
        // A network failure states itself rather than leaving the verb looking pressed. Nothing was
        // recorded, and saying so is the only honest thing to show.
        setOutcome({
          kind: 'refused',
          detail: 'Compass could not be reached, so nothing has changed. Your report is unaffected.',
        });
      } finally {
        setReasonFor(null);
        setReason('');
      }
    });
  };

  if (outcome !== null) {
    return (
      <p
        ref={outcomeRef}
        className="feedback-outcome"
        data-state={outcome.kind === 'applied' ? 'applied' : 'refused'}
        role="status"
        // Focusable programmatically, never by Tab: it replaced the control that had focus, so
        // somebody has to be given it, but a finished sentence is not a stop on the way through a
        // document.
        tabIndex={-1}
      >
        {outcome.detail}
      </p>
    );
  }

  return (
    <div className="feedback-row">
      {existing !== null && (
        <span className="feedback-mark" title="Your own verdict on this item">
          {existing.clause}
        </span>
      )}

      {offers.map((offer) =>
        reasonFor === offer.action ? (
          <span key={offer.action} className="contents">
            <label className="sr-only" htmlFor={`reason-${stableId}-${offer.action}`}>
              Why — {offer.label} on {headline}
            </label>
            <input
              id={`reason-${stableId}-${offer.action}`}
              className="feedback-reason"
              value={reason}
              placeholder="Why? One line is enough."
              /*
                Focus follows the manager into the field that just appeared.

                `jsx-a11y/no-autofocus` is right about the case it is named for — autofocus on page
                load steals focus from a reader who has not asked for anything — and it stays an error
                everywhere else. This is the opposite situation: the field exists *because* the
                manager just pressed a verb, the button they pressed has been replaced by it, and
                without moving focus their next Tab starts from wherever the removed button used to
                be. That is a real focus-loss bug for a keyboard user, and WCAG 2.4.3 asks focus to
                follow newly revealed content. Escape and Cancel both hand focus back to the verb —
                see `dismissReason` and the effect that runs it, not this handler, because the
                button has not re-mounted yet at the moment the key is pressed.
              */
              // eslint-disable-next-line jsx-a11y/no-autofocus -- focus follows the manager into the field their own keypress revealed; see above
              autoFocus
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && reason.trim().length > 0) submit(offer.action, reason.trim());
                if (event.key === 'Escape') dismissReason(offer.action);
              }}
            />
            <button
              type="button"
              className="feedback-action"
              disabled={pending || reason.trim().length === 0}
              onClick={() => submit(offer.action, reason.trim())}
            >
              {offer.label}
            </button>
            <button
              type="button"
              className="feedback-action"
              disabled={pending}
              onClick={() => dismissReason(offer.action)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            key={offer.action}
            type="button"
            className="feedback-action"
            // Registered so a cancelled reason field can give focus back to this exact verb rather
            // than to the first one in the row.
            ref={(node) => {
              if (node === null) verbRefs.current.delete(offer.action);
              else verbRefs.current.set(offer.action, node);
            }}
            disabled={pending}
            // The accessible name carries the claim, because "Dismiss this risk" on its own tells a
            // screen-reader user which of four risks they are about to dismiss: none of them.
            aria-label={`${offer.label} — ${headline}`}
            onClick={() => {
              if (NEEDS_REASON.has(offer.action)) {
                setReasonFor(offer.action);
                return;
              }
              submit(offer.action, null);
            }}
          >
            {offer.label}
          </button>
        ),
      )}
    </div>
  );
}
