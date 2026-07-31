import { OWNER_EMAIL_ENV_VAR, OWNER_PASSWORD_ENV_VAR, ownerCredentialsAreDefault, seatReadiness } from '@compass/auth';
import { SystemClock, previousCivilDayWindow, toIso } from '@compass/clock';
import {
  MissingDatabaseUrlError,
  ScopedDb,
  findOrganization,
  orgScope,
  resolveDatabaseUrl,
  type CompassDatabase,
} from '@compass/db';
import { SeedConnector } from '@compass/seed-connector';

import { database } from './database';
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

/**
 * The connection both checks below share.
 *
 * The process-wide pool from `lib/database`, not a fresh one. The container's
 * `HEALTHCHECK` runs every ten seconds, and opening and tearing down a pool per check —
 * two per interval, as this file used to — is real connection churn against Postgres for
 * no information a reused pool does not also give. A missing `DATABASE_URL` is still a
 * *stated* condition rather than a throw, which is the whole point of this file, so the
 * resolution is attempted separately and reported.
 */
function pooledConnection():
  | { readonly ok: true; readonly db: CompassDatabase }
  | { readonly ok: false; readonly detail: string } {
  try {
    // Resolved first so a missing URL is reported as configuration rather than as a fault.
    resolveDatabaseUrl('pooled');
    return { ok: true, db: database() };
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof MissingDatabaseUrlError
          ? error.message
          : 'No database connection string is configured.',
    };
  }
}

async function checkDatabase(): Promise<ReadinessCheck> {
  const connection = pooledConnection();
  if (!connection.ok) {
    return { name: 'database', status: 'not_configured', detail: connection.detail };
  }

  try {
    // A real scoped SELECT rather than `select 1`, through the same repository the product
    // uses. It proves the round trip *and* that the schema is migrated; `select 1` would
    // pass against an empty database the app cannot actually read.
    await findOrganization(new ScopedDb(connection.db, orgScope(resolveProvider().organizationId)));
    return { name: 'database', status: 'ready', detail: 'PostgreSQL answered a scoped round trip.' };
  } catch (error) {
    return {
      name: 'database',
      status: 'degraded',
      detail: `PostgreSQL did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
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
  const connection = pooledConnection();
  if (!connection.ok) {
    return {
      name: 'seats',
      status: 'not_configured',
      detail: 'No database, so no seats could be read. Sign-in is unavailable.',
    };
  }

  try {
    const organizationId = resolveProvider().organizationId;
    const seats = await seatReadiness(new ScopedDb(connection.db, orgScope(organizationId)));

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
  }
  // No `finally` closing a pool: the connection is the process-wide one, and closing it
  // here would tear down the pool the report path is using.
}

/**
 * Where a sign-in link actually goes.
 *
 * Stated rather than implied, because "mail is configured" is the difference between an
 * invitation that reaches a colleague and one an operator has to copy out of a log. A
 * real transport arrives with `alpha-delivery-email-and-slack`.
 */
function mailCheck(): ReadinessCheck {
  const baseUrl = process.env['COMPASS_BASE_URL'];
  const originConfigured = baseUrl !== undefined && baseUrl.length > 0;

  return {
    name: 'mail',
    status: 'not_configured',
    detail:
      'No mail transport is configured, so sign-in links, password resets and invitations are written to the process ' +
      'log and returned in the invite response instead of being delivered. Nothing is silently dropped.' +
      // Reported here because it is the other half of the same capability: a deployment
      // that gains a transport but has no configured origin will refuse to send rather
      // than mail a link built from a request header, and this is where an operator looks
      // to find out why.
      (originConfigured
        ? ` Links will point at ${baseUrl}.`
        : ' COMPASS_BASE_URL is not set, so links can only be built for a request that arrived over loopback; any ' +
          'other origin is refused rather than taken from a request header.'),
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
