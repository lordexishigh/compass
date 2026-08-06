import { formatCivilDate } from '@compass/clock';
import type { ResolvedWindow } from '@compass/memos';

/**
 * The memo window, in civil dates, in the run's zone.
 *
 * `ResolvedWindow` carries `Instant`s — epoch milliseconds — and `jsonOk` serialises them as the
 * numbers they are, so the confirmation read *"in force 1754179200000 → 1754438400000"*. The whole
 * point of that line is that a manager can check Compass's reading of "until Thursday" against the
 * Thursday they meant, and a millisecond count cannot be checked by anybody.
 *
 * Formatted at the edge rather than in the component for the reason every date in this app is: the
 * client has no timezone, `apps/web` components do no date arithmetic, and `lib/view-model.ts` and
 * `TimeTravelBounds` already hand pre-formatted strings down. The zone is the run's — the calendar
 * the report is written in — so the date shown back is the date tomorrow's report will honour.
 *
 * ## Why it lives in `lib/` rather than beside the handler that calls it
 *
 * It was exported from `app/api/memos/route.ts`, which is a module Next owns the shape of: a route
 * file is meant to export handlers and segment config and nothing else, and Next generates a
 * validator under `.next/types` that diffs the module's exports against that list. This particular
 * export does not trip it on Next 15.5.22 — `next build` and `tsc` over `.next/types/**` both pass
 * — but the contract is Next's to tighten, and depending on it holding is a bet with no upside.
 *
 * The concrete cost was already being paid: `tests/memo-window.test.ts` wants a date formatter and
 * was importing it from the route, which drags `guard`, the auth stack and the seeded connector
 * into a unit test that needs none of them.
 */
export function civilWindow(
  window: ResolvedWindow,
  timezone: string,
): { readonly effectiveFrom: string; readonly effectiveUntil: string | null; readonly openEnded: boolean } {
  return {
    effectiveFrom: formatCivilDate(window.effectiveFrom, timezone),
    effectiveUntil: window.effectiveUntil === null ? null : formatCivilDate(window.effectiveUntil, timezone),
    openEnded: window.openEnded,
  };
}
