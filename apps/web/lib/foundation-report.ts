import { formatCivilDateTime, toIso, windowsOverlap, type TimeWindow } from '@compass/clock';
import {
  DEFAULT_TEAM_KEY,
  SEEDED_ORGANIZATION_ID,
  resolveSubstrate,
  resolveTimezone,
  type ResolvedSubstrate,
  type SeedDataset,
} from '@compass/seed-connector';

/**
 * Which substrate answered.
 *
 * The web app is a process edge, so it is allowed to know that a seeded provider
 * exists and to construct one. Nothing it hands downstream carries that fact: the
 * pipeline receives a `ConnectorPort` and cannot tell, which is the property the
 * whole architecture rests on and which `tools/quality-gates` checks by reading
 * every layer's imports.
 *
 * The *decision* itself — which organization, which team, which zone, which
 * instant — is not made here. It lives in `@compass/seed-connector`'s
 * `resolveSeededRun`, because the boot script has to reach the same answer or the
 * two processes would generate two reports for the same day. This module is the
 * web app's thin view onto that authority plus the small formatting helpers the
 * readiness endpoint uses.
 */
export { SEEDED_ORGANIZATION_ID as DEMO_ORGANIZATION_ID, DEFAULT_TEAM_KEY as DEMO_TEAM_KEY, resolveTimezone };

/** Retained name for the readiness endpoint and the artifact page. */
export type ResolvedProvider = ResolvedSubstrate;

export const resolveProvider = resolveSubstrate;

/**
 * Whether the substrate has anything at all to say about a window.
 *
 * Exported because it is the one thing on the view that depends on the host
 * date: the seeded span ends on a fixed day, so this turns false on its own once
 * the clock passes it. A test can force a window either side of the span.
 */
export function datasetCoversWindow(datasetWindow: TimeWindow | null, window: TimeWindow): boolean {
  return datasetWindow !== null && windowsOverlap(datasetWindow, window);
}

export function countRecords(dataset: SeedDataset): number {
  return Object.values(dataset.records).reduce((sum, records) => sum + (records as readonly unknown[]).length, 0);
}

/** The window a report covers, written the way the freshness line says it. */
export function describeWindow(window: TimeWindow, timezone: string): string {
  return `${formatCivilDateTime(window.start, timezone)} → ${formatCivilDateTime(window.end, timezone)}`;
}

export function windowIso(window: TimeWindow): string {
  return `[${toIso(window.start)}, ${toIso(window.end)})`;
}
