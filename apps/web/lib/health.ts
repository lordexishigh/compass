import { OWNER_EMAIL_ENV_VAR, OWNER_PASSWORD_ENV_VAR, ownerCredentialsAreDefault, seatReadiness } from '@compass/auth';
import { SystemClock, previousCivilDayWindow, toIso } from '@compass/clock';
import { MissingDatabaseUrlError, ScopedDb, createDatabase, orgScope, resolveDatabaseUrl } from '@compass/db';
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

/**
 * Whether anyone can sign in, and whether the credentials are the published ones.
 *
 * `not_configured` for a deployment still on the demonstration owner password. Not
 * `degraded`, because nothing is broken — but not `ready` either, because a real
 * deployment on a published password is a state an operator must be told about in the
 * one place they look when something seems wrong.
 */
async function checkSeats(): Promise<ReadinessCheck> {
  let url: string;
  try {
    url = resolveDatabaseUrl('pooled');
  } catch {
    return {
      name: 'seats',
      status: 'not_configured',
      detail: 'No database, so no seats could be read. Sign-in is unavailable.',
    };
  }

  const handle = createDatabase(url);
  try {
    const organizationId = resolveProvider().organizationId;
    const seats = await seatReadiness(new ScopedDb(handle.db, orgScope(organizationId)));

    if (seats.owners === 0) {
      return {
        name: 'seats',
        status: 'not_configured',
        detail:
          'This organization has no owner, so nobody can manage it. Run `pnpm run seed` to create the first owner, ' +
          'or POST to /api/auth/register — that route is open only while there is no owner.',
      };
    }

    const usingDefaults = ownerCredentialsAreDefault();
    return {
      name: 'seats',
      status: usingDefaults ? 'not_configured' : 'ready',
      detail:
        `${seats.owners} owner${seats.owners === 1 ? '' : 's'}, ${seats.activeSeats} active seat` +
        `${seats.activeSeats === 1 ? '' : 's'}, ${seats.pendingInvitations} pending invitation` +
        `${seats.pendingInvitations === 1 ? '' : 's'}.` +
        (usingDefaults
          ? ` The owner is still on the published demonstration password — set ${OWNER_EMAIL_ENV_VAR} and ${OWNER_PASSWORD_ENV_VAR} before this deployment holds real data.`
          : ''),
    };
  } catch (error) {
    return {
      name: 'seats',
      status: 'degraded',
      detail: `Seats could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Where a sign-in link actually goes.
 *
 * Stated rather than implied, because "mail is configured" is the difference between an
 * invitation that reaches a colleague and one an operator has to copy out of a log. A
 * real transport arrives with `alpha-delivery-email-and-slack`.
 */
function mailCheck(): ReadinessCheck {
  return {
    name: 'mail',
    status: 'not_configured',
    detail:
      'No mail transport is configured, so sign-in links, password resets and invitations are written to the process ' +
      'log and returned in the invite response instead of being delivered. Nothing is silently dropped.',
  };
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

  const checks = [clockCheck, connectorCheck, datasetCheck, await checkDatabase(), await checkSeats(), mailCheck()];
  const status: CheckStatus = checks.some((check) => check.status === 'not_configured')
    ? 'not_configured'
    : checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : 'ready';

  return { status, observedAt: toIso(now), checks };
}
