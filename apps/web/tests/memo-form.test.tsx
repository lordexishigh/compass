// @vitest-environment jsdom
import { instantFromIso } from '@compass/clock';
import { REFUSAL_SENTENCE } from '@compass/memos';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { civilWindow } from '../app/api/memos/route';
import { MemoForm } from '../components/memo-form';

/**
 * The Manager Memo entry point, which is the headline differentiator and had no UI at all.
 *
 * `@compass/memos` has modelled the whole of this for a while — `extractMemo` refuses anything
 * outside the closed five-kind schema, `resolveSubject` returns candidates when it cannot tell
 * which Marcus, `submitMemo` composes them — and `/` carried no form, so none of it was reachable
 * from the product. These assertions are about the three answers a manager can get and that each
 * one is *rendered*, because a refusal the reader never sees is the same as no refusal.
 *
 * The refusal sentence is asserted against `REFUSAL_SENTENCE` rather than a literal: the component
 * prints what the route hands it, and pinning the constant is what stops a reworded package
 * sentence from leaving a stale one on the screen.
 *
 * Driven through `react-dom/client` with React's own `act`, following `feedback-focus.test.tsx` —
 * this app deliberately carries no client-interaction harness.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<MemoForm />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const textarea = (): HTMLTextAreaElement => {
  const found = container.querySelector('textarea');
  if (found === null) throw new Error('the memo form rendered no textarea');
  return found;
};

const respondWith = (status: number, body: unknown): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

/** Types a memo and submits, letting the transition and its two awaits settle. */
const submit = async (text: string): Promise<void> => {
  act(() => {
    const field = textarea();
    // React tracks the value on the DOM node, so a plain assignment is ignored on re-render.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await act(async () => {
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const status = (): string => container.querySelector('[role="status"]')?.textContent ?? '';

/**
 * A `recorded` body in the shape the route actually returns.
 *
 * Built by running the route's own `civilWindow` over `Instant`s rather than by typing the dates
 * that were wanted. The fixtures here used to be hand-written with `effectiveFrom: '2026-08-03'`
 * while the route serialised the raw `Instant`, so this suite was green against a product that
 * printed `1754179200000 → 1754438400000` — a fixture that asserts what the code ought to do
 * certifies nothing about what it does.
 *
 * `tests/memo-window.test.ts` pins `civilWindow` itself; this makes the component test depend on
 * the same function, so the two cannot drift apart into separate ideas of the shape.
 */
const recordedBody = (over: { subjectLabel: string; from: string; until: string | null }) => ({
  status: 'recorded',
  detail: `Recorded: ${over.subjectLabel}.`,
  subjectKey: 'developer:someone',
  subjectLabel: over.subjectLabel,
  assertion: { kind: 'absence', subjectKind: 'developer', counterparty: null },
  window: civilWindow(
    {
      effectiveFrom: instantFromIso(over.from),
      effectiveUntil: over.until === null ? null : instantFromIso(over.until),
      openEnded: over.until === null,
    },
    'Europe/Berlin',
  ),
});

describe('the memo form is an entry point, not a decoration', () => {
  it('puts a real form with a real input on the page', () => {
    // The gap as reported: "/ has 0 forms and 0 inputs".
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(container.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('refuses to submit an empty memo rather than posting whitespace', () => {
    const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('shows Compass its own reading of a recorded memo, not a tick', async () => {
    respondWith(201, {
      ...recordedBody({ subjectLabel: 'Priya Raman', from: '2026-08-03T00:00:00Z', until: '2026-08-06T00:00:00Z' }),
    });

    await submit('Priya is out until Thursday');

    const shown = status();
    // The typed assertion, field by field — the confirmation the criterion names.
    expect(shown).toContain('absence');
    expect(shown).toContain('Priya Raman');
    expect(shown).toContain('2026-08-03');
    expect(shown).toContain('2026-08-06');
  });

  /**
   * The window renders as a date a manager can check, never as the `Instant` behind it.
   *
   * "until Thursday" is checkable against a Thursday and not against `1754438400000`, and the
   * confirmation exists precisely so a misread memo is caught before it shapes tomorrow's report.
   */
  it('renders the in-force window as civil dates', async () => {
    respondWith(201, {
      ...recordedBody({ subjectLabel: 'Priya Raman', from: '2026-08-03T00:00:00Z', until: '2026-08-06T00:00:00Z' }),
    });

    await submit('Priya is out until Thursday');

    const inForce = [...container.querySelectorAll('.data-token')]
      .map((node) => node.textContent ?? '')
      .find((text) => text.includes('→') || text.includes('open-ended'));

    expect(inForce, 'the recorded confirmation must state the window it recorded').toBeDefined();
    // A raw `Instant` would render as a run of digits and fail this outright.
    expect(inForce).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(inForce).not.toMatch(/\d{10,}/);
  });

  /**
   * A refusal carries two sentences and `REFUSAL_SENTENCE` is the one in `message`.
   *
   * The fixture used to put it in `detail`, which is not where `ExtractionRefusal` puts it — so
   * this assertion passed while the running product rendered only the supporting clause and never
   * the sentence the feature is known by.
   */
  it("says 'I can't represent that yet' in the package's own words", async () => {
    respondWith(422, {
      status: 'refused',
      reason: 'out_of_schema',
      message: REFUSAL_SENTENCE,
      detail: 'Compass has no kind for a request about morale.',
    });

    await submit('Please make the team happier');

    const shown = status();
    expect(shown).toContain(REFUSAL_SENTENCE);
    // And the sentence naming what could not be represented, beneath it.
    expect(shown).toContain('no kind for a request about morale');
  });

  it('offers the candidate subjects rather than guessing which Marcus', async () => {
    respondWith(409, {
      status: 'needs_subject',
      detail: 'Two people match “Marcus”.',
      candidates: [
        { subjectKind: 'developer', subjectKey: 'developer:hale', label: 'Marcus Hale', reason: 'commits on platform' },
        { subjectKind: 'developer', subjectKey: 'developer:webb', label: 'Marcus Webb', reason: 'commits on checkout' },
      ],
      pending: { rawText: 'Marcus is out tomorrow', channel: 'web' },
    });

    await submit('Marcus is out tomorrow');

    const shown = status();
    expect(shown).toContain('Marcus Hale');
    expect(shown).toContain('Marcus Webb');
    // The reason each is a candidate, so the choice is informed rather than a coin toss.
    expect(shown).toContain('commits on platform');
  });

  it('re-posts only the chosen key, leaving the offer for the server to re-derive', async () => {
    respondWith(409, {
      status: 'needs_subject',
      detail: 'Two people match “Marcus”.',
      candidates: [
        { subjectKind: 'developer', subjectKey: 'developer:hale', label: 'Marcus Hale', reason: 'commits on platform' },
        { subjectKind: 'developer', subjectKey: 'developer:webb', label: 'Marcus Webb', reason: 'commits on checkout' },
      ],
      pending: { rawText: 'Marcus is out tomorrow', channel: 'web' },
    });
    await submit('Marcus is out tomorrow');

    const recorded = respondWith(201, {
      ...recordedBody({ subjectLabel: 'Marcus Hale', from: '2026-08-04T00:00:00Z', until: '2026-08-04T00:00:00Z' }),
    });

    const choice = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Marcus Hale'));
    await act(async () => choice?.click());
    await act(async () => {
      await Promise.resolve();
    });

    const sent = JSON.parse(String((recorded.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent['chosenSubjectKey']).toBe('developer:hale');

    /**
     * The alternatives must *not* travel. They are stored on the memo as the record of the offer —
     * the answer to "why Marcus Hale rather than Marcus Webb" — so taking them from the client
     * would make that field the caller's account of Compass's own question. `submitMemo` re-derives
     * the offer from the store and refuses a key that is not in it.
     */
    expect(sent['offeredCandidates']).toBeUndefined();
    expect(sent['rawText']).toBe('Marcus is out tomorrow');
  });

  it('states a failure rather than leaving the manager thinking it saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    await submit('Priya is out until Thursday');

    expect(status()).toContain('nothing has been written');
  });
});
