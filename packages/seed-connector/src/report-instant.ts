import { formatCivilDate, previousCivilDayWindow, windowsOverlap, type Instant, type TimeWindow } from '@compass/clock';

/**
 * Which day a seeded organization can honestly be reported on.
 *
 * The fixtures cover a fixed span and the host clock keeps moving. Once today
 * falls past the end of that span every section is truthfully empty — and a
 * manager opening the demo would read six stated absences and conclude the
 * product does not work, which is a worse outcome than being told the substrate
 * is historical.
 *
 * So this is the one place Compass is allowed to report on a day that is not
 * today, and it is allowed only for a *seeded* substrate: the fact lives beside
 * the fixtures rather than in the web app, because it is a property of the
 * dataset, and because both process edges — the request path and the boot
 * script — have to agree about it or they would generate two different reports
 * and race to overwrite each other.
 *
 * The shift is never silent. `note` is a sentence the page prints, naming the
 * day being shown and the day it is not.
 */
export interface SeededInstantInput {
  /** The span the substrate holds data for. Null when there is no substrate. */
  readonly datasetWindow: TimeWindow | null;
  /** The instant the substrate was authored to be "now". */
  readonly datasetNow: Instant | null;
  /** The host's own instant, resolved from a Clock at the edge. */
  readonly hostNow: Instant;
  readonly timezone: string;
}

export interface SeededInstant {
  readonly now: Instant;
  readonly window: TimeWindow;
  /** Null when the host's own day is being reported on, as it normally is. */
  readonly note: string | null;
}

export function resolveSeededInstant(input: SeededInstantInput): SeededInstant {
  const { datasetWindow, datasetNow, hostNow, timezone } = input;
  const hostWindow = previousCivilDayWindow(hostNow, timezone);

  if (datasetWindow === null || datasetNow === null || windowsOverlap(datasetWindow, hostWindow)) {
    return { now: hostNow, window: hostWindow, note: null };
  }

  return {
    now: datasetNow,
    window: previousCivilDayWindow(datasetNow, timezone),
    note:
      `The seeded organization's history ends on ${formatCivilDate(datasetWindow.end, timezone)}, so this report ` +
      `covers its last full day rather than ${formatCivilDate(hostNow, timezone)}. ` +
      'Compass would rather show you a real day and say which one than show you an empty one.',
  };
}
