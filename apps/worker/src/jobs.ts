import { instantFromIso, timeWindow, toIso, type Instant, type TimeWindow } from '@compass/clock';
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
  /**
   * The incremental ingest tick.
   *
   * Computes the next half-open window per (org, source) from how far that source has actually been
   * read and enqueues one `ingest.window` job each. A cron cannot do this directly because the
   * window depends on the last successful coverage, which is a database read.
   */
  ingestTick: 'ingest.tick',
  /**
   * The generation tick.
   *
   * Asks which teams' generation time has passed in *their* zone and enqueues one
   * `report.generate` per (org, team, civil date). Runs ahead of the delivery tick, and delivery
   * defers on a missing report either way, so ordering does not depend on tick timing.
   */
  generateTick: 'generate.tick',
  reportGenerate: 'report.generate',
  /**
   * The scheduler tick.
   *
   * A cron cannot enqueue per-subscription work directly — every manager has their own send time
   * and zone — so one recurring job asks "what is due now" and enqueues the individual deliveries.
   * Idempotency lives on those, not here, so a tick that runs twice costs nothing.
   */
  deliveryTick: 'delivery.tick',
  reportDeliver: 'report.deliver',
  /**
   * The retention purge.
   *
   * Daily rather than hourly: the shortest window Compass offers is 30 days, so an hourly
   * purge would be 23 no-op rows a day on the retention page and no earlier a deletion.
   */
  retentionPurge: 'privacy.retention-purge',
  /**
   * The deletion sweep: completes every request whose seven-day grace period has ended.
   *
   * Hourly. The promise is "your data is gone after seven days, and certainly within
   * thirty"; an hour of lateness on the seventh day breaks neither, and a tick that runs
   * while nothing is due costs one indexed read.
   */
  deletionSweep: 'privacy.deletion-sweep',
  /**
   * The channel notice: announces Compass in every ingested channel that has not been told.
   *
   * Its own job rather than part of the enable request, so that Slack being unreachable
   * cannot turn a manager's settings change into an error page — and so the announcement is
   * retried until it lands instead of being lost.
   */
  channelNotice: 'privacy.channel-notice',
  /**
   * The subprocessor change notice.
   *
   * Compass promises at least 30 days' warning before the subprocessor list changes, and a promise with
   * no job behind it is a sentence on a page. This one compares the digest of the published list against
   * the digest each subscriber was last told and mails the difference — so editing the list *is* the
   * trigger, and there is no human step to skip in the release where it matters.
   *
   * Daily rather than more often: the obligation is measured in days, a notice sent at 04:00 instead of
   * 03:00 is indistinguishable to the recipient, and the job is a no-op on every day the list has not
   * changed.
   */
  subprocessorNotice: 'trust.subprocessor-notice',
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
  /**
   * Projects the window into the knowledge model, and reconciles contradictions.
   *
   * Optional, and the distinction is real rather than a convenience. Supplied in production, so a
   * scheduled ingest actually accumulates entities — without it the job would journal coverage and
   * ingest nothing, which would make "scheduled incremental ingest" a cursor that advances over an
   * empty model. Omitted by the tests that assert only the *coverage* half (which window was asked
   * for, what a degraded source records), because those need no database at all and reading one
   * would make them slow for no extra assurance.
   *
   * The projection itself is idempotent — `packages/ingest/tests/model-ingest.test.ts` asserts a
   * replayed window adds zero entity versions and zero duplicate rows against a real engine — so a
   * re-run of this job is safe by construction rather than by a check here.
   */
  readonly projectIntoModel?: (request: {
    readonly organizationId: string;
    readonly window: TimeWindow;
    readonly sourceKeys: readonly string[] | undefined;
    readonly now: Instant;
    readonly runId: string;
  }) => Promise<IngestRunSummary>;
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
  const runId = dependencies.newId();

  /**
   * Project into the model when a store was supplied, otherwise just read the window.
   *
   * The projection is the point of a scheduled ingest — a cursor advancing over an empty model
   * would be a job that looks healthy and accumulates nothing. Both paths produce the same
   * `IngestRunSummary`, so the coverage and journalling below are identical either way.
   */
  const summary =
    dependencies.projectIntoModel === undefined
      ? (
          await ingestWindow(dependencies.connector, {
            organizationId: payload.organizationId,
            window,
            now,
            ...(payload.sourceKeys ? { sourceKeys: payload.sourceKeys } : {}),
          })
        ).summary
      : await dependencies.projectIntoModel({
          organizationId: payload.organizationId,
          window,
          sourceKeys: payload.sourceKeys,
          now,
          runId,
        });

  await dependencies.persistIngestRun(summary, {
    runId,
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
