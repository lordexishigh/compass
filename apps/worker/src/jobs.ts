import { instantFromIso, timeWindow, toIso, type Instant } from '@compass/clock';
import type { ConnectorPort } from '@compass/connector-port';
import { ingestWindow, type IngestRunSummary } from '@compass/ingest';
import { z } from 'zod';

/**
 * Job handlers.
 *
 * Every handler takes `now` as its last parameter. The pg-boss binding at the
 * process edge is the only place a clock exists; the handlers themselves are
 * ordinary functions that a test can call with a FixedClock instant, which is
 * what makes per-timezone scheduling testable later.
 */
export const JOB_NAMES = {
  ingestWindow: 'ingest.window',
  reportGenerate: 'report.generate',
  reportDeliver: 'report.deliver',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const IngestWindowPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  /** ISO-8601 with an explicit offset. The window is half-open: [start, end). */
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  sourceKeys: z.array(z.string().min(1)).optional(),
});

export type IngestWindowPayload = z.infer<typeof IngestWindowPayloadSchema>;

export class InvalidJobPayloadError extends Error {
  constructor(job: JobName, detail: string) {
    super(`Job \`${job}\` received a payload it cannot act on: ${detail}`);
    this.name = 'InvalidJobPayloadError';
  }
}

export interface IngestRunIds {
  readonly runId: string;
  readonly coverageIds: readonly string[];
}

export interface WorkerDependencies {
  readonly connector: ConnectorPort;
  /** Writes the run through the scoped-query layer. Injected so tests need no database. */
  readonly persistIngestRun: (summary: IngestRunSummary, ids: IngestRunIds) => Promise<void>;
  readonly newId: () => string;
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * Pulls one window through the port and records what was and was not covered.
 *
 * A source being down is not a job failure — it is a coverage record — so this
 * resolves normally and the freshness line can say so. A malformed payload is a
 * job failure, loudly, before anything is written.
 */
export async function handleIngestWindow(
  dependencies: WorkerDependencies,
  rawPayload: unknown,
  now: Instant,
): Promise<IngestRunSummary> {
  const parsed = IngestWindowPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(
      JOB_NAMES.ingestWindow,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; '),
    );
  }

  const payload = parsed.data;
  const window = timeWindow(instantFromIso(payload.windowStart), instantFromIso(payload.windowEnd));

  const { summary } = await ingestWindow(dependencies.connector, {
    organizationId: payload.organizationId,
    window,
    now,
    ...(payload.sourceKeys ? { sourceKeys: payload.sourceKeys } : {}),
  });

  await dependencies.persistIngestRun(summary, {
    runId: dependencies.newId(),
    coverageIds: summary.coverage.map(() => dependencies.newId()),
  });

  if (summary.status === 'complete') {
    dependencies.logger.info(
      `[compass] ingested ${summary.totalRecords} records for ${payload.organizationId} over [${toIso(window.start)}, ${toIso(window.end)})`,
    );
  } else {
    dependencies.logger.warn(
      `[compass] ingest degraded for ${payload.organizationId}: ${summary.degradedDetails.join(' · ')}`,
    );
  }

  return summary;
}
