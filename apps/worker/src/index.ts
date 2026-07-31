import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { SystemClock, type Clock } from '@compass/clock';
import {
  ScopedDb,
  createDatabase,
  findLatestReportForDate,
  findMembershipByUserId,
  insertIngestRun,
  listActiveSubscriptions,
  listTeamScopes,
  loadReportBundle,
  orgScope,
  resolveDatabaseUrl,
  type CompassDatabase,
} from '@compass/db';
import {
  RESEND_API_KEY_ENV_VAR,
  RESEND_FROM_ENV_VAR,
  ResendEmailTransport,
  SLACK_BOT_TOKEN_ENV_VAR,
  SlackApiTransport,
} from '@compass/delivery';
import type { IngestRunSummary } from '@compass/ingest';
import { SeedConnector, resolveSeededRun } from '@compass/seed-connector';
import { PgBoss } from 'pg-boss';

import {
  deliveryJobOptions,
  deliveryJobsDue,
  handleReportDeliver,
  type DeliveryDependencies,
} from './delivery.js';
import { JOB_NAMES, handleIngestWindow, type IngestRunIds, type WorkerDependencies } from './jobs.js';
import { storedReportToRendered } from './stored-report.js';

/**
 * The worker process.
 *
 * This file is one of the two places in Compass allowed to hold a Clock (the
 * other is the web app's request edge). It resolves `now` once per job and
 * passes it down; no layer below constructs a clock.
 *
 * The connector is resolved here too, which is why nothing downstream can tell
 * whether the data came from the seeded provider or a live one.
 */
export interface WorkerRuntime {
  readonly dependencies: WorkerDependencies;
  /** The process's pool, so the delivery dependencies can share it rather than open a second. */
  readonly db: CompassDatabase;
  close(): Promise<void>;
}

export function createWorkerRuntime(clock: Clock): WorkerRuntime {
  const { db, close } = createDatabase(resolveDatabaseUrl('direct'));

  const persistIngestRun = async (summary: IngestRunSummary, ids: IngestRunIds): Promise<void> => {
    const scoped = new ScopedDb(db, orgScope(summary.organizationId));
    await insertIngestRun(
      scoped,
      {
        id: ids.runId,
        connectorId: summary.connectorId,
        window: summary.window,
        startedAt: summary.startedAt,
        completedAt: clock.now(),
        status: summary.status,
        totalRecords: summary.totalRecords,
        artifactCounts: summary.artifactCounts,
      },
      summary.coverage.map((coverage, index) => ({
        id: ids.coverageIds[index] ?? randomUUID(),
        coverage,
      })),
    );
  };

  return {
    dependencies: {
      connector: new SeedConnector(),
      persistIngestRun,
      newId: () => randomUUID(),
      logger: console,
    },
    db,
    close,
  };
}

export interface RunningWorker {
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

/**
 * Everything the delivery handler needs, resolved once at the process edge.
 *
 * The transports read their keys from the environment here and nowhere else, so a deployment with
 * no `RESEND_API_KEY` produces an unconfigured transport that reports `skipped` rather than a
 * process that throws on the first send. `COMPASS_BASE_URL` is the origin the report link and the
 * unsubscribe URL are built from; it falls back to localhost so the zero-config path still works.
 */
export function createDeliveryDependencies(clock: Clock, db: CompassDatabase): DeliveryDependencies {
  const baseUrl = (process.env['COMPASS_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');

  return {
    scopedFor: (organizationId: string) => new ScopedDb(db, orgScope(organizationId)),
    loadReport: async (scoped, scope, reportDate) => {
      const report = await findLatestReportForDate(scoped, scope, reportDate);
      return report === null ? null : loadReportBundle(scoped, report.id);
    },
    renderStored: storedReportToRendered,
    email: new ResendEmailTransport({
      apiKey: process.env[RESEND_API_KEY_ENV_VAR],
      from: process.env[RESEND_FROM_ENV_VAR],
    }),
    slack: new SlackApiTransport({ botToken: process.env[SLACK_BOT_TOKEN_ENV_VAR] }),
    baseUrl,
    // The token digest is what is stored, so the URL carries the digest and the route matches on
    // it directly. The secret itself was shown once, when the subscription was created.
    unsubscribeUrlFor: (subscription) =>
      `${baseUrl}/api/delivery/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeTokenHash)}`,
    newId: () => randomUUID(),
    logger: console,
  };
}

export async function startWorker(): Promise<RunningWorker> {
  const clock = new SystemClock();
  const runtime = createWorkerRuntime(clock);
  const { dependencies } = runtime;
  const deliveryDependencies = createDeliveryDependencies(clock, runtime.db);

  const boss = new PgBoss({ connectionString: resolveDatabaseUrl('direct'), schema: 'pgboss' });

  boss.on('error', (error: Error) => {
    console.error('[compass] pg-boss error:', error.message);
  });

  await boss.start();

  for (const queue of Object.values(JOB_NAMES)) {
    await boss.createQueue(queue);
  }

  await boss.work(JOB_NAMES.ingestWindow, async (jobs: readonly { data: unknown }[]) => {
    for (const job of jobs) {
      // One instant per job, resolved here and threaded down.
      await handleIngestWindow(dependencies, job.data, clock.now());
    }
  });

  /**
   * The scheduler tick: every five minutes, enqueue whatever is now due.
   *
   * Five minutes rather than every minute because the granularity that matters is a manager's send
   * time, which they set to the minute but do not notice to the minute — and rather than an hour
   * because a 07:30 daily arriving at 08:00 is a different product. `dueDeliveries` decides what is
   * due from the subscription's own zone, so this tick needs no per-zone cron.
   *
   * A tick that runs twice, or that runs after an outage and finds yesterday still due, costs
   * nothing: the idempotency lives on the individual delivery jobs and in `delivery_log`.
   */
  await boss.work(JOB_NAMES.deliveryTick, async () => {
    const now = clock.now();
    // The same tenant resolution the report edge and the boot script use, so the tick and the
    // report it delivers cannot disagree about which organization they are for.
    const organizationId = resolveSeededRun({ hostNow: now }).organizationId;
    const scoped = deliveryDependencies.scopedFor(organizationId);

    const subscriptions = await listActiveSubscriptions(scoped);
    const scopesByMembership = new Map<string, readonly string[]>();

    // Team keys come from the roster. Read once per user rather than per subscription, since a
    // person's two channels resolve to the same teams.
    const teamKeysFor = (subscription: { readonly userId: string }): readonly string[] =>
      scopesByMembership.get(subscription.userId) ?? [];

    for (const subscription of subscriptions) {
      if (scopesByMembership.has(subscription.userId)) continue;
      const membership = await findMembershipByUserId(scoped, subscription.userId);
      scopesByMembership.set(
        subscription.userId,
        membership === null ? [] : await listTeamScopes(scoped, membership.id),
      );
    }

    const jobs = deliveryJobsDue(subscriptions, teamKeysFor, now, organizationId);

    for (const job of jobs) {
      await boss.send(JOB_NAMES.reportDeliver, job, deliveryJobOptions(job));
    }

    if (jobs.length > 0) {
      console.info(`[compass] enqueued ${jobs.length} delivery job${jobs.length === 1 ? '' : 's'}`);
    }
  });

  // Every five minutes. The tick is cheap: one indexed read plus a scheduler computation.
  await boss.schedule(JOB_NAMES.deliveryTick, '*/5 * * * *', {}, { singletonKey: 'delivery-tick' });

  /**
   * Delivery.
   *
   * `retryCount` is pg-boss's own attempt counter and is threaded into the `delivery_log` row, so
   * the log reflects the real sequence of attempts rather than a count of rows. A failed send
   * throws out of the handler on purpose — that is how pg-boss applies `retryBackoff` — and its
   * row is written before the throw, so nothing about the failure is lost.
   */
  await boss.work(
    JOB_NAMES.reportDeliver,
    async (jobs: readonly { data: unknown; retryCount?: number }[]) => {
      for (const job of jobs) {
        await handleReportDeliver(
          deliveryDependencies,
          job.data,
          clock.now(),
          (job.retryCount ?? 0) + 1,
        );
      }
    },
  );

  console.info(`[compass] worker listening on ${Object.values(JOB_NAMES).join(', ')}`);

  return {
    boss,
    stop: async () => {
      await boss.stop({ graceful: true });
      await runtime.close();
    },
  };
}

async function main(): Promise<void> {
  const worker = await startWorker();

  const stop = async (signal: string): Promise<void> => {
    console.info(`[compass] ${signal} received, draining jobs`);
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(entryPoint).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error('[compass] worker failed to start:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
