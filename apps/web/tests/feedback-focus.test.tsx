// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedbackActions } from '../components/feedback-actions';

/**
 * WCAG 2.4.3 for the one interactive object in the report.
 *
 * Three times in this component's life the element holding focus is removed from the DOM, and the
 * browser's answer is always the same and always wrong: focus falls to `<body>`, so a keyboard user's
 * next Tab restarts from the top of the document. A manager dismissing four risks in a row would be
 * sent back to the masthead after each one.
 *
 * The component previously carried a comment claiming Escape returned focus to the verb. It did not —
 * the handler only closed the field. This file exists because a focus contract asserted in a comment
 * is not asserted at all: every claim that comment makes is now a test below.
 *
 * ## Why `createRoot` and React's own `act` rather than a testing library
 *
 * This app has no client-interaction harness — every other suite renders with
 * `renderToStaticMarkup`, which is right for auditing markup and cannot press a key. Rather than add
 * `@testing-library/react` to the tree for one file, this drives the real component through
 * `react-dom/client` in jsdom and dispatches real events. `act` comes from `react` itself, which is
 * where React 19 exports it (`react-dom/test-utils` is removed).
 */

const OFFERS = [
  // `dismiss_risk` is in `NEEDS_REASON`, so pressing it reveals the reason field — the whole point.
  { action: 'dismiss_risk', label: 'Dismiss' },
  { action: 'snooze', label: 'Snooze' },
] as const;

const HEADLINE = '5 open reviews are waiting on one person';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const render = (): void => {
  act(() => {
    root.render(
      <FeedbackActions stableId="risk-review-queue" headline={HEADLINE} offers={[...OFFERS]} existing={null} />,
    );
  });
};

const buttonLabelled = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((candidate) =>
    (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').includes(label),
  );
  if (found === undefined) throw new Error(`no button matching "${label}" in: ${container.innerHTML}`);
  return found as HTMLButtonElement;
};

const reasonField = (): HTMLInputElement => {
  const field = container.querySelector('input.feedback-reason');
  if (field === null) throw new Error(`no reason field in: ${container.innerHTML}`);
  return field as HTMLInputElement;
};

describe('opening the reason field', () => {
  it('moves focus into the field the keypress revealed', () => {
    render();
    act(() => buttonLabelled('Dismiss').click());

    // The button that was focused no longer exists; the field is what replaced it.
    expect(document.activeElement).toBe(reasonField());
  });
});

describe('dismissing the reason field returns focus to the verb that opened it', () => {
  it('on Escape', () => {
    render();
    act(() => buttonLabelled('Dismiss').click());

    act(() => {
      reasonField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // Not `<body>`, which is where the browser puts it when the focused node is removed.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(buttonLabelled('Dismiss'));
  });

  it('on Cancel', () => {
    render();
    act(() => buttonLabelled('Dismiss').click());
    act(() => buttonLabelled('Cancel').click());

    expect(document.activeElement).toBe(buttonLabelled('Dismiss'));
  });

  it('returns focus to that verb specifically, not to the first one in the row', () => {
    // With two verbs it matters which one comes back. Keyed by action rather than by position.
    render();
    act(() => buttonLabelled('Dismiss').click());
    act(() => buttonLabelled('Cancel').click());

    expect(document.activeElement?.textContent).toBe('Dismiss');
    expect(document.activeElement).not.toBe(buttonLabelled('Snooze'));
  });

  it('clears the half-typed reason, so reopening does not resurrect it', () => {
    render();
    act(() => buttonLabelled('Dismiss').click());
    const field = reasonField();
    act(() => {
      field.value = 'not actually a risk';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => buttonLabelled('Cancel').click());
    act(() => buttonLabelled('Dismiss').click());

    expect(reasonField().value).toBe('');
  });
});

describe('submitting a verdict', () => {
  /** The outcome sentence replaces the whole row, so it is what has to receive focus. */
  const respondWith = (detail: string, ok = true): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail }), { status: ok ? 200 : 503 })),
    );
  };

  it('moves focus to the outcome sentence rather than dropping it to the body', async () => {
    respondWith('You will not see this again unless its severity rises by 100 points.');
    render();

    // `snooze` needs no reason, so one click submits.
    await act(async () => {
      buttonLabelled('Snooze').click();
    });

    const outcome = container.querySelector('p.feedback-outcome');
    expect(outcome, container.innerHTML).not.toBeNull();
    expect(document.activeElement).toBe(outcome);
  });

  it('makes the outcome focusable programmatically but not a stop on the way through the document', async () => {
    respondWith('Recorded.');
    render();
    await act(async () => {
      buttonLabelled('Snooze').click();
    });

    // A finished sentence is not a control. `-1` is what lets it receive focus without joining the
    // tab order.
    expect(container.querySelector('p.feedback-outcome')?.getAttribute('tabindex')).toBe('-1');
  });

  it('announces it, because a sighted keyboard user and a screen-reader user need the same sentence', async () => {
    respondWith('Recorded.');
    render();
    await act(async () => {
      buttonLabelled('Snooze').click();
    });

    expect(container.querySelector('p.feedback-outcome')?.getAttribute('role')).toBe('status');
  });

  it('does the same when Compass refuses, since that row is removed too', async () => {
    respondWith('Compass could not record that just now, so nothing has changed.', false);
    render();
    await act(async () => {
      buttonLabelled('Snooze').click();
    });

    const outcome = container.querySelector('p.feedback-outcome');
    expect(outcome?.getAttribute('data-state')).toBe('refused');
    expect(document.activeElement).toBe(outcome);
  });
});
