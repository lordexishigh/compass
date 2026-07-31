import { SystemClock, previousCivilDayWindow, toIso } from '@compass/clock';
import { MissingDatabaseUrlError, createDatabase, resolveDatabaseUrl } from '@compass/db';
import { SeedConnector } from '@compass/seed-connector';

import { resolveProvider, resolveTimezone } from './foundation-report';

/**
 * System readiness, stated honestly.
 *
 * A missing database URL is a *stated* condition, not a 500: the product has to
 * degrade in the open, naming the capability that is unavailable and why.
 */
export type CheckStatus = 'ready' | 'degraded' | 'not_configured';

export interface ReadinessCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface ReadinessReport {
  readonly status: CheckStatus;
  readonly observedAt: string;
  readonly checks: readonly ReadinessCheck[];
}

async function checkDatabase(): Promise<ReadinessCheck> {
  let url: string;
  try {
    url = resolveDatabaseUrl('pooled');
  } catch (error) {
    return {
      name: 'database',
      status: 'not_configured',
      detail:
        error instanceof MissingDatabaseUrlError
          ? error.message
          : 'No database connection string is configured.',
    };
  }

  const handle = createDatabase(url);
  try {
    await handle.pool.query('select 1');
    return { name: 'database', status: 'ready', detail: 'PostgreSQL answered a round trip.' };
  } catch (error) {
    return {
      name: 'database',
      status: 'degraded',
      detail: `PostgreSQL did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readiness(): Promise<ReadinessReport> {
  const timezone = resolveTimezone();
  const now = new SystemClock().now();
  const window = previousCivilDayWindow(now, timezone);

  const clockCheck: ReadinessCheck = {
    name: 'clock',
    status: 'ready',
    detail: `now resolved once at the edge: ${toIso(now)} (${timezone})`,
  };

  const provider = resolveProvider();
  const connector = new SeedConnector(provider.dataset);
  const health = await connector.reportSourceHealth({
    organizationId: provider.organizationId,
    window,
    now,
  });

  const connectorCheck: ReadinessCheck = {
    name: 'connector',
    status: health.overall === 'complete' ? 'ready' : 'degraded',
    detail: health.sources
      .map((source) => `${source.sourceKey}: ${source.status}`)
      .join(', '),
  };

  const datasetCheck: ReadinessCheck = {
    name: 'seed-dataset',
    status: provider.degradation === null ? 'ready' : 'not_configured',
    detail:
      provider.degradation ??
      `${provider.dataset.datasetId} loaded from seed/generated, covering ${
        provider.datasetWindow === null ? 'an unknown window' : `${toIso(provider.datasetWindow.start)} → ${toIso(provider.datasetWindow.end)}`
      }`,
  };

  const checks = [clockCheck, connectorCheck, datasetCheck, await checkDatabase()];
  const status: CheckStatus = checks.some((check) => check.status === 'not_configured')
    ? 'not_configured'
    : checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : 'ready';

  return { status, observedAt: toIso(now), checks };
}
