import type { TimeWindow } from '@compass/clock';

import { describeWindow } from '../lib/foundation-report';

/**
 * What the seeded substrate covers, and what it does not.
 *
 * A day outside the seeded span is a real condition — the fixtures end on a
 * fixed date, and the host clock keeps moving. Compass names it rather than
 * rendering a day with nothing in it as a quiet day. This lives in its own
 * component so both branches are reachable from a test without a system clock.
 */
export function SeededHistoryNote({
  datasetWindow,
  coversWindow,
  timezone,
}: {
  readonly datasetWindow: TimeWindow | null;
  readonly coversWindow: boolean;
  readonly timezone: string;
}) {
  return (
    <>
      {datasetWindow !== null && (
        <p className="prose-narration mt-4">
          The seeded history runs{' '}
          <span className="font-mono tabular-nums text-ink-muted">{describeWindow(datasetWindow, timezone)}</span>.
        </p>
      )}
      {!coversWindow && (
        <p className="stated-absence mt-4">
          Today&rsquo;s window sits outside that history, so there is nothing to read for this date. Compass says so
          rather than presenting an empty day as a quiet one.
        </p>
      )}
    </>
  );
}
