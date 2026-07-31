import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { SystemClock, type Clock } from '@compass/clock';
import { ScopedDb, createDatabase, insertIngestRun, orgScope, resolveDatabaseUrl } from '@compass/db';
import type { IngestRunSummary } from '@compass/ingest';
import { SeedConnector } from '@compass/seed-connector';
import { PgBoss } from 'pg-boss';

import { JOB_NAMES, handleIngestWindow, type IngestRunIds, type WorkerDependencies } from './jobs.js';

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
    close,
  };
}

export interface RunningWorker {
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

export async function startWorker(): Promise<RunningWorker> {
  const clock = new SystemClock();
  const runtime = createWorkerRuntime(clock);
  const { dependencies } = runtime;

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
