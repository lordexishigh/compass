import {
  OWNER_EMAIL_ENV_VAR,
  OWNER_PASSWORD_ENV_VAR,
  ownerConfigurationProblem,
  ownerCredentialsAreDefault,
  seatReadiness,
} from '@compass/auth';
import { SystemClock, previousCivilDayWindow, toEpochMillis, toIso, type Instant } from '@compass/clock';
import { logReadinessUnavailable } from '@compass/observability';
import {
  MissingDatabaseUrlError,
  ScopedDb,
  findOrganization,
  lastSuccessfulDeliveryAt,
  lastSuccessfulIngestAt,
  orgScope,
  readQueueDepth,
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

/**
 * What this *organization* has actually done lately, as opposed to what it is configured to do.
 *
 * The `checks` above answer "is this capability available". These answer "has it worked", which is a
 * different and more useful question: every check can be green while the worker has been dead since
 * Tuesday, and only these show it.
 *
 * Both fields are per-organization, and that is why queue depth is **not** here. Compass is
 * multi-tenant, so a payload that mixed a per-tenant instant with a deployment-wide count under one
 * heading would be telling a reader something false about one of them — `queue` is its own field
 * below for exactly that reason.
 *
 * Null means "never happened", not "broken": a cold start has never delivered anything, and
 * reporting that as an outage would be wrong. They are instants rather than booleans derived from a
 * threshold, because "recently" is the operator's judgement to make at 2am and not this file's to
 * bake in.
 */
export interface ActivityReport {
  /** ISO-8601, or null when no ingest has ever completed for this organization. */
  readonly lastSuccessfulIngestAt: string | null;
  /** ISO-8601, or null when nothing has ever been delivered for this organization. */
  readonly lastSuccessfulDeliveryAt: string | null;
  /** The organization both instants above are about. */
  readonly organizationId: string;
}

/**
 * The queue, which belongs to the deployment rather than to any organization.
 *
 * `pgboss.job` has no tenant column: its rows are the *process's* work, and a job's payload carries
 * an organization only because Compass happens to put one there. Counting by state is therefore a
 * deployment-wide number, and it is labelled as one instead of being filed under a per-tenant
 * heading — the alternative was a doc comment claiming "the numbers are not global" over a number
 * that is, which is the kind of small dishonesty this product cannot afford.
 *
 * Null when pg-boss's schema does not exist yet: the ordinary state of a deployment whose worker has
 * never booted, not a fault.
 */
export interface QueueReport {
  readonly queued: number;
  readonly active: number;
  readonly failed: number;
}

export interface ReadinessReport {
  readonly status: CheckStatus;
  readonly observedAt: string;
  readonly checks: readonly ReadinessCheck[];
  /**
   * Null only when there is no database connection to read it from — in which case
   * `checks` already carries a `database` entry saying so, and repeating the reason here
   * would be two sources for one fault.
   */
  readonly activity: ActivityReport | null;
  /** Deployment-wide, never per-organization. Null when the queue schema does not exist yet. */
  readonly queue: QueueReport | null;
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
 *
 * Also `not_configured`, and reported ahead of everything else, for an owner environment with
 * one of the two variables set: that one refuses to provision a seat at all, so it is a
 * misconfiguration rather than a warning about one.
 */
async function checkSeats(): Promise<ReadinessCheck> {
  /**
   * Before the database, because this needs no database and outranks what one would say.
   *
   * A half-configured owner environment makes the worker's boot refuse, so the seat is never
   * provisioned and the check below would report "no owner — run `pnpm run seed`" — advice
   * that fails again the same way and never mentions the variable that caused it. The web
   * process starts regardless of the worker, so this endpoint is where an operator finds out.
   */
  const configurationProblem = ownerConfigurationProblem();
  if (configurationProblem !== null) {
    return { name: 'seats', status: 'not_configured', detail: configurationProblem };
  }

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
  /**
   * `degraded` outranks `not_configured`, and the order is the whole point.
   *
   * It was the other way round, which made `degraded` unreachable on any deployment with an
   * unconfigured capability — and that is *every* deployment running the demo defaults, where mail,
   * Slack and the owner-still-on-the-published-password checks are all `not_configured` by design. So
   * a genuinely degraded database or a connector that had stopped answering was reported as
   * `not_configured`: the value this file's own comments define as "nothing is broken, something is
   * simply absent". An operator paged on that number would have been told the opposite of the truth.
   *
   * Something broken must outrank something merely absent. `not_configured` is a *stated choice* —
   * no mailer, so links go to the log — while `degraded` is a fault, and a fault is what an operator
   * needs to see first.
   */
  const status: CheckStatus = checks.some((check) => check.status === 'degraded')
    ? 'degraded'
    : checks.some((check) => check.status === 'not_configured')
      ? 'not_configured'
      : 'ready';

  const observed = await observeActivity(provider.organizationId, now);

  return {
    status,
    observedAt: toIso(now),
    checks,
    activity: observed.activity,
    queue: observed.queue,
  };
}

/**
 * The two per-organization instants and the deployment-wide queue depth, read together.
 *
 * They are read in one function because they need one connection and one failure path, and returned
 * as two fields because they are two different scopes. See `ActivityReport` and `QueueReport`.
 *
 * ## Why this never throws, and never changes `status`
 *
 * A readiness endpoint that fails because the thing it reports on is unavailable is not one — the
 * same reasoning `guard()` follows for `/api/health` specifically. So every read here is wrapped and
 * a failure degrades to null, which the payload's own documentation gives a meaning to.
 *
 * It also does not feed into the overall `status`. An empty queue and a never-delivered report are
 * the *correct* state of a cold deployment, and a health endpoint that went yellow on a fresh
 * `docker compose up` would train an operator to ignore it. These are numbers for a human to read;
 * the checks above are the assertions.
 */
async function observeActivity(
  organizationId: string,
  now: Instant,
): Promise<{ readonly activity: ActivityReport | null; readonly queue: QueueReport | null }> {
  const connection = pooledConnection();
  if (!connection.ok) return { activity: null, queue: null };

  try {
    const scoped = new ScopedDb(connection.db, orgScope(organizationId));

    const [queue, ingestAt, deliveryAt] = await Promise.all([
      // Unscoped on purpose: the queue belongs to the deployment. See `QueueReport`.
      readQueueDepth(connection.db),
      lastSuccessfulIngestAt(scoped),
      lastSuccessfulDeliveryAt(scoped),
    ]);

    return {
      activity: {
        lastSuccessfulIngestAt: ingestAt === null ? null : toIso(ingestAt),
        lastSuccessfulDeliveryAt: deliveryAt === null ? null : toIso(deliveryAt),
        organizationId,
      },
      queue,
    };
  } catch (error) {
    /**
     * Emitted as a structured event, not an interpolated sentence.
     *
     * This is the one log line on the web side, and it was the exception to the standard the logging
     * criterion sets: a `[compass] …` string carrying the organization glued into prose, with no
     * event name and no instant. Now it is the same shape every worker emitter produces, so "which
     * organizations could not read their own records today" is answerable.
     *
     * The driver's message goes in an extra rather than into `detail`, and `logReadinessUnavailable`
     * scrubs both — a connection error names the host, the port and the user, and `/api/health` is
     * public so a container's own HEALTHCHECK can call it.
     */
    logReadinessUnavailable(
      {
        organizationId,
        // Readiness is answered for the deployment, not for one team.
        teamKey: null,
        at: toEpochMillis(now),
        detail: 'Compass could not read its own activity while answering a readiness request.',
      },
      {
        surface: 'activity',
        // The driver's own words, in an extra rather than glued into `detail`. `logRecord` scrubs
        // every string extra with the same function a Sentry event goes through, so the host, the
        // port and the user a connection error names do not reach the line — and the reason it
        // failed still does, which is the half an operator needs.
        cause: error instanceof Error ? error.message : String(error),
      },
    );

    return { activity: null, queue: null };
  }
}
