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
import {
  RESEND_API_KEY_ENV_VAR,
  RESEND_FROM_ENV_VAR,
  SLACK_BOT_TOKEN_ENV_VAR,
} from '@compass/delivery';
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
 * Where a sign-in link and a daily report actually go.
 *
 * Stated rather than implied, because "mail is configured" is the difference between a daily
 * that lands in an inbox at 07:30 and one an operator has to copy out of a log. A missing key
 * is `not_configured` rather than `degraded`: nothing is broken, the report is still generated
 * and readable at `/`, and the honest description of the deployment is that it has no mail
 * transport — which is exactly what an operator needs to read here.
 */
function mailCheck(): ReadinessCheck {
  const baseUrl = process.env['COMPASS_BASE_URL'];
  const originConfigured = baseUrl !== undefined && baseUrl.length > 0;
  const apiKey = process.env[RESEND_API_KEY_ENV_VAR] ?? '';
  const from = process.env[RESEND_FROM_ENV_VAR] ?? '';

  const originDetail = originConfigured
    ? ` Links will point at ${baseUrl}.`
    : ` ${'COMPASS_BASE_URL'} is not set, so links can only be built for a request that arrived over loopback; any ` +
      'other origin is refused rather than taken from a request header.';

  if (apiKey.length === 0) {
    return {
      name: 'mail',
      status: 'not_configured',
      detail:
        `No ${RESEND_API_KEY_ENV_VAR} is set, so no email is delivered: scheduled reports are recorded as skipped ` +
        'with the reason, and sign-in links, password resets and invitations are written to the process log instead. ' +
        'Nothing is silently dropped, and the report is still readable in Compass.' +
        originDetail,
    };
  }

  if (from.length === 0) {
    return {
      name: 'mail',
      status: 'not_configured',
      detail:
        `${RESEND_API_KEY_ENV_VAR} is set but ${RESEND_FROM_ENV_VAR} is not, so Compass has no verified address to ` +
        'send from and Resend would refuse the message. Set it to an address on the domain whose SPF, DKIM and DMARC ' +
        'records you configured.' +
        originDetail,
    };
  }

  return {
    name: 'mail',
    status: 'ready',
    detail: `Email delivers through Resend from ${from}.${originDetail}`,
  };
}

/**
 * Whether Slack delivery is available.
 *
 * Its own check rather than a clause on the mail one: a deployment can legitimately have one
 * channel and not the other, and a manager asking "why is my Slack daily not arriving" should
 * find the answer without having to read a sentence about email.
 */
function slackCheck(): ReadinessCheck {
  const token = process.env[SLACK_BOT_TOKEN_ENV_VAR] ?? '';

  return token.length === 0
    ? {
        name: 'slack',
        status: 'not_configured',
        detail:
          `No ${SLACK_BOT_TOKEN_ENV_VAR} is set, so nothing is posted to Slack: a scheduled delivery is recorded as ` +
          'skipped with the reason rather than failing. Add a bot token with `chat:write` to deliver to a DM or a ' +
          'channel.',
      }
    : {
        name: 'slack',
        status: 'ready',
        detail: 'Slack delivers through chat.postMessage to a DM or a named channel.',
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

  const checks = [
    clockCheck,
    connectorCheck,
    datasetCheck,
    await checkDatabase(),
    await checkSeats(),
    mailCheck(),
    slackCheck(),
  ];
  const status: CheckStatus = checks.some((check) => check.status === 'not_configured')
    ? 'not_configured'
    : checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : 'ready';

  return { status, observedAt: toIso(now), checks };
}
