// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimeTravelScrubber } from '../components/time-travel-scrubber';
import type { TimeTravelBounds } from '../lib/archive-source';

/**
 * What the date control says after a step it was not allowed to take.
 *
 * `date` is optimistic — it moves before the POST so the input acknowledges the press — and on
 * success nobody ever observes it, because the page navigates to the new permalink. The refused
 * path is the one that matters, and it is not an edge case: stepping *writes*, so the role matrix
 * admits owners and managers only, and `/` performs no session lookup at all. Every anonymous
 * reader of the report page therefore takes the 401 branch.
 *
 * Left un-reverted, the control ends up describing a day that is not on screen — and `date` is
 * what `atEarliest`, `atLatest` and the "already on this day" short-circuit are all computed
 * from. So the next press steps from the wrong day, one of the two bounds is disabled against the
 * wrong end of the history, and the short-circuit that exists to stop a duplicate report row for
 * one morning stops matching the morning in question.
 *
 * Driven through `react-dom/client` with React's own `act`, following `tests/feedback-focus.test.tsx`:
 * this app deliberately carries no client-interaction harness, and `react-dom/test-utils` is gone in
 * React 19.
 */

const BOUNDS: TimeTravelBounds = {
  available: true,
  earliestDate: '2026-07-27',
  latestDate: '2026-07-31',
  timezone: 'Europe/London',
  currentDate: '2026-07-31',
};

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

const render = (bounds: TimeTravelBounds = BOUNDS): void => {
  act(() => {
    root.render(<TimeTravelScrubber bounds={bounds} teamKey="platform" />);
  });
};

const dateInput = (): HTMLInputElement => {
  const input = container.querySelector('input[type="date"]');
  if (input === null) throw new Error('the scrubber rendered no date input');
  return input as HTMLInputElement;
};

const buttonLabelled = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  return found;
};

const note = (): string => container.querySelector('[role="status"]')?.textContent ?? '';

/** Presses a stepper and lets the transition and its awaited fetch settle. */
const press = async (label: string): Promise<void> => {
  await act(async () => {
    buttonLabelled(label).click();
  });
  // A second flush: the handler awaits `response.json()`, so the state update that follows it
  // lands a microtask after the click's own transition.
  await act(async () => {
    await Promise.resolve();
  });
};

describe('a refused step leaves the control on the day that is on screen', () => {
  it('reverts the date after a 401, which is what every anonymous reader gets', async () => {
    const detail = 'Sign in to read this. Reports contain the organization’s own data.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'authentication_required', detail }), { status: 401 })),
    );

    render();
    expect(dateInput().value).toBe('2026-07-31');

    await press('Step back one day');

    expect(note(), 'the reason the server gave has to reach the reader').toContain('Sign in to read this');
    expect(dateInput().value, 'the control must not describe 2026-07-30 above a report for the 31st').toBe(
      BOUNDS.currentDate,
    );
  });

  it('reverts the date when Compass cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    render();
    await press('Step back one day');

    expect(note()).toContain('could not be reached');
    expect(dateInput().value).toBe(BOUNDS.currentDate);
  });

  /**
   * The bounds are computed from `date`, so a stale `date` disables the wrong stepper. At
   * `currentDate === latestDate` the forward step is disabled and the back step is not; a revert
   * that failed to happen would swap them after one refused press.
   */
  it('leaves both steppers describing the same end of the history they started on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'no' }), { status: 403 })));

    render();
    expect(buttonLabelled('Step forward one day').disabled).toBe(true);
    expect(buttonLabelled('Step back one day').disabled).toBe(false);

    await press('Step back one day');

    expect(buttonLabelled('Step forward one day').disabled).toBe(true);
    expect(buttonLabelled('Step back one day').disabled).toBe(false);
  });

  /**
   * `href` is a response body, and `location.assign` follows an absolute URL off-site as readily
   * as it follows a path. The route only ever answers `archiveHref(reportId)`.
   */
  it('refuses to navigate anywhere but an archive permalink', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ href: 'https://elsewhere.example/steal' }), { status: 200 })),
    );
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);

    render();
    await press('Step back one day');

    expect(assign, 'an off-origin href must not become a navigation').not.toHaveBeenCalled();
    expect(note()).toContain('did not recognise');
    expect(dateInput().value).toBe(BOUNDS.currentDate);
  });
});
