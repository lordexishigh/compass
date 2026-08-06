'use client';

import { useState, useTransition } from 'react';

import type { TimeTravelBounds } from '../lib/archive-source';

/**
 * The time-travel control: step `now` a day at a time, or jump to any date in the seeded history.
 *
 * ## Why it is a stepper and a date field, not a slider
 *
 * The gesture a manager actually wants is "what did this look like on Tuesday" — a named day, not a
 * position along a continuum. A slider makes every day equidistant and none of them nameable, and on a
 * phone it makes all of them mis-tappable. So: two 44px steppers for the day-by-day walk that shows
 * continuity, and a native date input for the jump. The date input is deliberately native — it brings
 * the platform's own calendar, its keyboard handling and its locale for free, and a hand-built calendar
 * popover would be a worse one in every respect.
 *
 * ## Why the regeneration is a POST and the page then reloads
 *
 * Stepping is a *write*: a day nobody has generated runs the whole pipeline and persists a report. That
 * cannot be a link. Once the row exists the answer is a URL — the permalink of that day's report — so the
 * control posts, learns the permalink, and navigates to it. The reader ends up somewhere they can bookmark
 * and send to a skip-level, which is the archive's whole purpose.
 *
 * ## Absent, not disabled, outside simulated-clock mode
 *
 * On a live organization this renders nothing at all. A disabled control is an invitation to ask why it is
 * disabled; the honest arrangement is that a feature which cannot apply is not shown. The server refuses
 * the POST regardless — this is the affordance, not the gate.
 */

export interface TimeTravelScrubberProps {
  readonly bounds: TimeTravelBounds;
  readonly teamKey: string;
}

/** `2026-07-24` plus or minus whole days, without a Date round-trip that could shift the zone. */
function shiftDate(date: string, days: number): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (parsed === null) return date;
  const [, year, month, day] = parsed;
  const shifted = new Date(
    Date.UTC(Number.parseInt(year!, 10), Number.parseInt(month!, 10) - 1, Number.parseInt(day!, 10) + days),
  );
  return shifted.toISOString().slice(0, 10);
}

export function TimeTravelScrubber({ bounds, teamKey }: TimeTravelScrubberProps) {
  const [date, setDate] = useState(bounds.currentDate);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!bounds.available) return null;

  const travel = (target: string): void => {
    if (target < bounds.earliestDate || target > bounds.latestDate) {
      setNote(`The seeded history runs from ${bounds.earliestDate} to ${bounds.latestDate}.`);
      return;
    }

    /**
     * Travelling to the day already on screen is not a journey, and posting it is not harmless.
     *
     * A report row's id is `(organization, scope, instant)` — `reportRowId` in `packages/db` hashes
     * the instant in *milliseconds*, not the civil date. Time travel generates at the scheduler's
     * canonical instant for a date (06:00 local), while `/` generates at the run's own `now`. Those
     * are two different instants on one civil date, so posting the date already being shown mints a
     * second row for that morning and the archive then lists the day twice with different content.
     *
     * The wider mismatch is not this component's to fix — it is a question about which instant `/`
     * reports for — but the one path from here into it closes with an equality check. A reader who
     * picks today's date out of the date input is asking for the page they are already reading.
     */
    if (target === bounds.currentDate) {
      setNote(null);
      setDate(target);
      return;
    }

    setDate(target);
    setNote(null);

    startTransition(async () => {
      /**
       * Every path that does not navigate puts the control back on the day that is on screen.
       *
       * `date` is optimistic: it moves before the POST so the input acknowledges the press. On
       * success that optimism is never observed, because the page navigates away. On refusal it
       * would be — and a control left reading `2026-07-28` above a report for the 31st is not a
       * cosmetic slip. It is what `atEarliest`, `atLatest` and the `target === bounds.currentDate`
       * short-circuit are all computed from, so the next press steps from a day the reader is not
       * looking at, and one of the two bounds is disabled against the wrong end of the history.
       *
       * This is the *default* path, not an edge: stepping needs a seat, so every anonymous reader
       * on `/` — which is every reader, `/` being session-less — gets the 401 branch.
       */
      const refuse = (detail: string): void => {
        setDate(bounds.currentDate);
        setNote(detail);
      };

      try {
        const response = await fetch('/api/time-travel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ date: target, teamKey }),
        });
        const body = (await response.json()) as { readonly href?: string; readonly detail?: string };

        if (!response.ok || body.href === undefined) {
          refuse(body.detail ?? 'Compass could not regenerate that day, so nothing has changed.');
          return;
        }

        /**
         * The destination has to be a permalink on this origin.
         *
         * `href` is a response body, and `location.assign` follows an absolute URL to another site
         * as readily as a path. The route only ever answers `archiveHref(reportId)`, so requiring
         * that shape costs nothing and means a handler that one day echoed something else — or a
         * response that is not this handler's at all — cannot turn a step into an off-site
         * navigation.
         */
        if (!body.href.startsWith('/archive/')) {
          refuse('Compass got an answer it did not recognise, so the report in front of you is unchanged.');
          return;
        }

        // A real navigation to a real permalink. `location.assign` rather than a router push, because the
        // destination is a Server Component that must be rendered from the row that was just written.
        window.location.assign(body.href);
      } catch {
        refuse('Compass could not be reached, so the report in front of you is unchanged.');
      }
    });
  };

  const atEarliest = date <= bounds.earliestDate;
  const atLatest = date >= bounds.latestDate;

  return (
    <section aria-labelledby="time-travel-heading" className="hairline mt-8 pt-6">
      <h2 id="time-travel-heading" className="section-label">
        time travel
      </h2>
      <p className="prose-narration mt-2 text-[15px] text-ink-muted">
        This deployment runs on a simulated clock, so you can step <span className="italic">now</span> across the seeded
        history and read the report Compass would have written that morning. Each step runs the whole pipeline for that
        instant — it is not a stored snapshot of a demo.{' '}
        {/*
          Said before the click rather than after it, and this is the only place it can be said.

          Stepping *writes*: it runs the pipeline and persists a report row, so the role matrix admits
          owners and managers and nobody else. `/` deliberately performs no session lookup at all — the
          zero-config promise is that the first request passes no gate, and `tests/cold-start.test.tsx`
          asserts the route contains no `cookies(` or session read — so this component cannot know who
          is reading and cannot hide itself from a reader without a seat.

          Stating the requirement is therefore better than discovering it: a reader who would other-
          wise click a control, get a 401 in a status line and conclude the feature is broken instead
          learns what it costs and where the published demonstration credentials are. One hop, which is
          the property `tests/demo-credentials.test.tsx` holds every unauthenticated surface to.
        */}
        Stepping writes a report, so it needs a seat —{' '}
        <a href="/account" className="tertiary-action">
          the demonstration credentials are on /account
        </a>
        .
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="time-step"
          disabled={pending || atEarliest}
          aria-label="Step back one day"
          onClick={() => travel(shiftDate(date, -1))}
        >
          <span aria-hidden="true">←</span> day
        </button>

        <label className="flex items-baseline gap-2 text-[13px] text-ink-faint">
          <span className="sr-only">Report date</span>
          <input
            type="date"
            className="time-date"
            value={date}
            min={bounds.earliestDate}
            max={bounds.latestDate}
            disabled={pending}
            onChange={(event) => travel(event.target.value)}
          />
        </label>

        <button
          type="button"
          className="time-step"
          disabled={pending || atLatest}
          aria-label="Step forward one day"
          onClick={() => travel(shiftDate(date, 1))}
        >
          day <span aria-hidden="true">→</span>
        </button>

        <span className="font-mono text-[11px] tabular-nums text-ink-faint">
          {bounds.earliestDate} … {bounds.latestDate}
        </span>
      </div>

      {/* `role="status"` rather than `alert`: a bound reached or a refused day is information, not an
          emergency, and an assertive region would interrupt a screen reader mid-heading. */}
      {note !== null && (
        <p className="stated-absence mt-3 text-[13px]" role="status">
          {note}
        </p>
      )}
      {pending && (
        <p className="mt-3 font-mono text-[11px] tabular-nums text-ink-faint" role="status">
          running the pipeline for {date}…
        </p>
      )}
    </section>
  );
}
