import {
  SystemClock,
  formatCivilDate,
  formatCivilDateTime,
  previousCivilDayWindow,
  toIso,
  type Instant,
  type TimeWindow,
} from '@compass/clock';
import type { SourceHealthReport } from '@compass/connector-port';
import { createEmptyStructuredReport, type ReportCoverageNote, type StructuredReport } from '@compass/analysis';
import { SeedConnector } from '@compass/seed-connector';

/**
 * The request edge.
 *
 * This is one of the two places in Compass allowed to construct a Clock (the
 * other is the worker). It resolves `now` once, derives the team's previous
 * civil day as a half-open window, and passes that instant down — nothing below
 * this file reads the time.
 *
 * The connector is resolved here too. The page cannot tell, and does not ask,
 * whether the provider behind the port is seeded or live.
 */
export const DEMO_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_TEAM_KEY = 'platform';

export function resolveTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return env['COMPASS_DEFAULT_TIMEZONE'] ?? 'Europe/London';
}

export interface FoundationView {
  readonly report: StructuredReport;
  readonly health: SourceHealthReport;
  readonly now: Instant;
  readonly window: TimeWindow;
  readonly timezone: string;
  readonly reportDate: string;
  readonly observedAt: string;
}

function coverageNotes(health: SourceHealthReport): readonly ReportCoverageNote[] {
  return health.sources.map((source) => ({
    sourceKey: source.sourceKey,
    status: source.status,
    detail: source.detail,
  }));
}

export async function loadFoundationView(): Promise<FoundationView> {
  const timezone = resolveTimezone();
  const now = new SystemClock().now();
  const window = previousCivilDayWindow(now, timezone);

  const connector = new SeedConnector();
  const health = await connector.reportSourceHealth({
    organizationId: DEMO_ORGANIZATION_ID,
    window,
    now,
  });

  const report = createEmptyStructuredReport({
    organizationId: DEMO_ORGANIZATION_ID,
    scope: { kind: 'team', teamKey: DEMO_TEAM_KEY },
    instant: now,
    timezone,
    window,
    coverage: coverageNotes(health),
  });

  return {
    report,
    health,
    now,
    window,
    timezone,
    reportDate: formatCivilDate(now, timezone),
    observedAt: formatCivilDateTime(now, timezone),
  };
}

/** The window a report covers, written the way the freshness line says it. */
export function describeWindow(window: TimeWindow, timezone: string): string {
  return `${formatCivilDateTime(window.start, timezone)} → ${formatCivilDateTime(window.end, timezone)}`;
}

export function windowIso(window: TimeWindow): string {
  return `[${toIso(window.start)}, ${toIso(window.end)})`;
}
