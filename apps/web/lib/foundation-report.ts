import {
  SystemClock,
  formatCivilDate,
  formatCivilDateTime,
  previousCivilDayWindow,
  toIso,
  windowsOverlap,
  type Instant,
  type TimeWindow,
} from '@compass/clock';
import type { SourceHealthReport } from '@compass/connector-port';
import { createEmptyStructuredReport, type ReportCoverageNote, type StructuredReport } from '@compass/analysis';
import { SeedConnector, foundationDataset, seedBundle, type SeedDataset } from '@compass/seed-connector';

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

/** Which substrate answered, and what to say if the intended one is absent. */
export interface ResolvedProvider {
  readonly dataset: SeedDataset;
  readonly organizationId: string;
  /** The span the substrate actually holds data for. */
  readonly datasetWindow: TimeWindow | null;
  /** Stated on the page when the substrate is not the one it should be. */
  readonly degradation: string | null;
}

/**
 * Resolves the seeded dataset, and says so plainly when it cannot.
 *
 * A missing `seed/generated/**` is a real condition on a fresh clone that has
 * not run `pnpm seed:generate`. The page still renders — it falls back to the
 * small foundation fixture — but it names what is missing rather than showing a
 * thinner report as if it were the whole picture.
 */
export function resolveProvider(): ResolvedProvider {
  try {
    const bundle = seedBundle();
    return {
      dataset: bundle.dataset,
      organizationId: bundle.organizationId,
      datasetWindow: bundle.window,
      degradation: null,
    };
  } catch (error) {
    return {
      dataset: foundationDataset,
      organizationId: DEMO_ORGANIZATION_ID,
      datasetWindow: null,
      degradation: `The seeded dataset could not be read, so this page is running on the small foundation fixture instead. ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface FoundationView {
  readonly report: StructuredReport;
  readonly health: SourceHealthReport;
  readonly now: Instant;
  readonly window: TimeWindow;
  readonly timezone: string;
  readonly reportDate: string;
  readonly observedAt: string;
  /** The span the seeded substrate covers, for the freshness line. */
  readonly datasetWindow: TimeWindow | null;
  /** False when today's report window sits outside the seeded history. */
  readonly datasetCoversWindow: boolean;
  readonly recordCount: number;
}

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

function coverageNotes(health: SourceHealthReport, degradation: string | null): readonly ReportCoverageNote[] {
  const fromSources = health.sources.map((source) => ({
    sourceKey: source.sourceKey,
    status: source.status,
    detail: source.detail,
  }));
  return degradation === null
    ? fromSources
    : [...fromSources, { sourceKey: 'seed-dataset', status: 'unavailable' as const, detail: degradation }];
}

export async function loadFoundationView(): Promise<FoundationView> {
  const timezone = resolveTimezone();
  const now = new SystemClock().now();
  const window = previousCivilDayWindow(now, timezone);
  const provider = resolveProvider();

  const connector = new SeedConnector(provider.dataset);
  const health = await connector.reportSourceHealth({
    organizationId: provider.organizationId,
    window,
    now,
  });

  const report = createEmptyStructuredReport({
    organizationId: provider.organizationId,
    scope: { kind: 'team', teamKey: DEMO_TEAM_KEY },
    instant: now,
    timezone,
    window,
    coverage: coverageNotes(health, provider.degradation),
  });

  return {
    report,
    health,
    now,
    window,
    timezone,
    reportDate: formatCivilDate(now, timezone),
    observedAt: formatCivilDateTime(now, timezone),
    datasetWindow: provider.datasetWindow,
    datasetCoversWindow: datasetCoversWindow(provider.datasetWindow, window),
    recordCount: countRecords(provider.dataset),
  };
}

function countRecords(dataset: SeedDataset): number {
  return Object.values(dataset.records).reduce((sum, records) => sum + (records as readonly unknown[]).length, 0);
}

/** The window a report covers, written the way the freshness line says it. */
export function describeWindow(window: TimeWindow, timezone: string): string {
  return `${formatCivilDateTime(window.start, timezone)} → ${formatCivilDateTime(window.end, timezone)}`;
}

export function windowIso(window: TimeWindow): string {
  return `[${toIso(window.start)}, ${toIso(window.end)})`;
}
