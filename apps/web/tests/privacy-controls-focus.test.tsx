// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MinimizationControls, RetentionControls } from '../components/privacy-controls';

/**
 * The configuration screens' half of WCAG 2.4.3 and 4.1.3.
 *
 * `FeedbackActions` handles focus loss deliberately, with a ref map and a restore effect, and
 * `feedback-focus.test.ts` pins it. The configuration screens got no equivalent, and had two defects
 * that only a live DOM shows:
 *
 *  - **2.4.3.** `MinimizationControls` disabled the wrapping `<fieldset>` while a write was in flight.
 *    A disabled control cannot hold focus, so the browser dropped it to `<body>` and the next Tab
 *    restarted from the top of the page — every time a manager changed the narration mode by keyboard.
 *  - **4.1.3.** `OutcomeLine` returned `null` until there was an outcome, so its `role="status"` region
 *    was inserted *together with* its text. Screen readers announce changes inside a region they are
 *    already watching; a region that appears with its content is frequently missed, which meant the
 *    sentence explaining a retention change was silent.
 *
 * Both are asserted here against the real components, for the same reason the report's are: a focus or
 * live-region contract stated in a comment is not a contract.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  // Every control in this file posts on change. A resolved fetch keeps the transition short and the
  // assertions about *what the DOM looks like afterwards* rather than about timing.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ detail: 'Saved. The next purge applies it.' }), { status: 200 })),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `stubGlobal`. Without this the deferred `fetch` one test installs
  // leaks into the next, whose transition then never settles — which showed up as an unrelated
  // `aria-busy` assertion failing, several tests away from the cause.
  vi.unstubAllGlobals();
});

const radios = (): readonly HTMLInputElement[] => [
  ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
];

const statusRegion = (): HTMLElement | null => container.querySelector('[role="status"]');

describe('the live region exists before it has anything to say', () => {
  it('is in the DOM on first render, with no text', () => {
    act(() => {
      root.render(<MinimizationControls mode="redacted" canEdit />);
    });

    const region = statusRegion();
    // Present, so a screen reader is already watching it when the text arrives. This is the whole
    // fix: returning null here is what made the announcement unreliable.
    expect(region, container.innerHTML).not.toBeNull();
    expect(region?.textContent).toBe('');
    // And carries no state attribute while empty — an `applied` attribute on a blank paragraph would
    // colour nothing and describe nothing.
    expect(region?.hasAttribute('data-state')).toBe(false);
  });

  it('keeps the same element and only changes its text once an outcome arrives', async () => {
    act(() => {
      root.render(<MinimizationControls mode="redacted" canEdit />);
    });

    const before = statusRegion();

    await act(async () => {
      radios()[2]!.click();
    });

    const after = statusRegion();

    // The *same node*, which is what makes the change an announcement rather than an insertion.
    expect(after).toBe(before);
    expect(after?.textContent).toContain('Saved.');
    expect(after?.getAttribute('data-state')).toBe('applied');
  });

  it('does the same on the retention controls, which share the component', () => {
    act(() => {
      root.render(<RetentionControls rawEventRetentionDays={90} derivedRetentionYears={3} canEdit />);
    });

    expect(statusRegion()).not.toBeNull();
    expect(statusRegion()?.textContent).toBe('');
  });
});

describe('choosing a narration mode keeps focus inside the fieldset', () => {
  /**
   * Focus is blurred by hand here, and that is not a shortcut — it is the only way to test this.
   *
   * The browser behaviour under test is: disabling the element that has focus moves focus to `<body>`.
   * **jsdom does not implement it.** A first version of this test clicked the radio, let the write
   * settle and asserted focus had survived — and it passed against the *old* `<fieldset disabled={
   * !canEdit || pending}>` too, because jsdom left `document.activeElement` on the disabled input. A
   * regression test that passes on the bug is worse than none.
   *
   * So the blur is an explicit stand-in for what a real browser does, and the assertion is about the
   * half that is actually this component's job: **recovery**. The old code had no restore path at all,
   * so it fails this; the new code returns focus to the radio the manager chose.
   */
  it('returns focus to the radio that was chosen, not to the body', async () => {
    act(() => {
      root.render(<MinimizationControls mode="full" canEdit />);
    });

    const target = radios()[1]!;
    act(() => target.focus());
    expect(document.activeElement).toBe(target);

    // Deferred, so the in-flight window is observable rather than collapsing inside one `act`.
    let settle: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      ),
    );

    act(() => {
      target.click();
    });

    // Mid-write: the input is disabled, which in a real browser is the moment focus is lost. Doing it
    // explicitly is what makes the recovery below meaningful in jsdom.
    expect(radios()[1]!.disabled, 'the radio is not disabled mid-write, so nothing would be lost').toBe(true);

    /**
     * Focus moved away by focusing something else, not by `.blur()`.
     *
     * jsdom ignores `blur()` on a disabled element, so the first attempt at this left
     * `document.activeElement` on the radio and proved nothing. Focusing a real sibling is
     * unambiguous, and it models the browser accurately enough for the claim under test: focus is
     * somewhere other than the chosen radio, and the component has to bring it back.
     */
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    act(() => elsewhere.focus());
    expect(document.activeElement).toBe(elsewhere);

    await act(async () => {
      settle(new Response(JSON.stringify({ detail: 'Saved.' }), { status: 200 }));
    });

    // Recovered: the same radio, so an arrow-key user is where they left off rather than at the top of
    // the document. This is the assertion the old `<fieldset disabled={!canEdit || pending}>` fails —
    // it had no restore path, so focus stayed wherever it had gone.
    expect(document.activeElement).not.toBe(elsewhere);
    expect(document.activeElement).toBe(radios()[1]);

    elsewhere.remove();
  });

  it('leaves the fieldset enabled for a reader who may edit, so nothing is removed from the tab order', () => {
    act(() => {
      root.render(<MinimizationControls mode="redacted" canEdit />);
    });

    const fieldset = container.querySelector('fieldset');
    expect(fieldset?.hasAttribute('disabled')).toBe(false);
    expect(radios().every((radio) => !radio.disabled)).toBe(true);
  });

  it('still disables the whole fieldset for a reader who may not edit', () => {
    // The standing state, which is the case `<fieldset disabled>` is right for: a viewer never
    // focuses these, so nothing is taken away from anybody mid-interaction.
    act(() => {
      root.render(<MinimizationControls mode="redacted" canEdit={false} />);
    });

    expect(container.querySelector('fieldset')?.hasAttribute('disabled')).toBe(true);
  });

  it('marks the fieldset busy while the write is in flight rather than only disabling it', async () => {
    // `aria-busy` says "a change is being saved" without removing anything from the accessibility
    // tree, which is the trade the old `<fieldset disabled>` got backwards.
    act(() => {
      root.render(<MinimizationControls mode="full" canEdit />);
    });

    expect(container.querySelector('fieldset')?.getAttribute('aria-busy')).toBe('false');

    await act(async () => {
      radios()[2]!.click();
    });

    // Settled again once the write completes.
    expect(container.querySelector('fieldset')?.getAttribute('aria-busy')).toBe('false');
  });
});
