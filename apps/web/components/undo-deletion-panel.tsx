'use client';

import { useState, useTransition } from 'react';

/**
 * The one control on `/account/deletion`.
 *
 * ## Why the token is never displayed
 *
 * It sits in a hidden field and in the URL the reader already has. Printing it on the page
 * would put a live capability into a screenshot, a shoulder-surfer's view, and every
 * screen-sharing session the reader happens to be in when they open their mail.
 *
 * ## Why the four outcomes read differently
 *
 * The endpoint distinguishes restored, already-settled, expired and unknown, and each gets its
 * own sentence. The one that matters most is *expired*: telling somebody who was two hours
 * late that their link was "invalid" would be a lie of omission at the worst possible moment.
 * The button disappears once the answer is terminal, because a button that no longer does
 * anything invites a second click and a second disappointment.
 */
interface Outcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly terminal: boolean;
}

export function UndoDeletionPanel({ token }: { readonly token: string }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();

  if (token.length === 0) {
    return (
      <p className="stated-absence">
        This address carries no undo token, so there is nothing for Compass to cancel. Open the link in the email it
        sent you — the token is part of that link and exists nowhere else, including in Compass&apos;s own records,
        which store only a digest of it.
      </p>
    );
  }

  const submit = () => {
    startTransition(async () => {
      try {
        const response = await fetch('/api/privacy/deletion/undo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const payload = (await response.json()) as { detail?: string };
        setOutcome({
          ok: response.ok,
          detail: payload.detail ?? 'Compass answered without a sentence, which is itself a fault.',
          // 410 and 404 are terminal: nothing about clicking again would change them.
          terminal: response.ok || response.status === 410 || response.status === 404,
        });
      } catch {
        setOutcome({
          ok: false,
          detail: 'The request never reached Compass, so nothing has changed. Check the connection and try again.',
          terminal: false,
        });
      }
    });
  };

  return (
    <div>
      {outcome === null || !outcome.terminal ? (
        <button type="button" className="primary-action" onClick={submit} disabled={pending}>
          {pending ? 'cancelling…' : 'cancel the deletion'}
        </button>
      ) : null}

      {outcome === null ? null : (
        <p
          role="status"
          data-state={outcome.ok ? 'applied' : 'refused'}
          className="feedback-outcome mt-4"
        >
          {outcome.detail}
        </p>
      )}
    </div>
  );
}
