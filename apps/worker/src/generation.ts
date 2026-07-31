import {
  LOCAL_TIME_PATTERN,
  formatCivilDate,
  instantAtLocalTime,
  isAfter,
  toIso,
  type Instant,
} from '@compass/clock';
import { z } from 'zod';

/**
 * Per-team daily report generation, on the team's own clock.
 *
 * ## Why the instant is derived rather than taken from `now`
 *
 * The acceptance criterion is that running the daily job twice for the same (org, team, date)
 * produces **one** Report row, and the mechanism is not a check in this file. `saveReport` derives
 * the report's primary key from `reportIdFor(org, scopeKind, scopeKey, reportInstant)`, so two runs
 * that agree on the instant write the same row and the second replaces the first in place. Two runs
 * that used `clock.now()` would disagree by however long the tick interval is, mint two ids, and
 * leave two rows for one day.
 *
 * So generation computes `reportInstant = instantAtLocalTime(civilDate, generationTime, timezone)`
 * — a *civil* fact about the team's wall clock, identical on every tick of that day. Idempotency
 * then comes from the database key rather than from a race-prone read-then-write, and time travel
 * still works because a deliberately different instant is a deliberately different row (which is
 * why the constraint is on the instant and `findLatestReportForDate` orders and limits).
 *
 * ## DST
 *
 * `instantAtLocalTime` owns the zone arithmetic and is asserted against measured values in
 * `packages/clock/tests/zone.test.ts`: 06:00 local stays 06:00 across both transitions, so the gap
 * between two consecutive generations is 23 hours in spring and 25 in autumn without a line of
 * daylight-saving code here. A skipped wall-clock time still resolves to a real instant, so a team
 * whose generation time falls in the lost hour still gets a report.
 *
 * ## Cadence
 *
 * The model has no per-team cadence field today — `teams` carries a `timezone` and a
 * `working_calendar`, and nothing else. Rather than invent a schema column and a roster control for
 * it, generation runs **daily at a documented local time in each team's own timezone**
 * (`DEFAULT_GENERATION_LOCAL_TIME`, overridable per deployment by `COMPASS_GENERATION_LOCAL_TIME`).
 * The per-team variation that exists in the model — the timezone — is honoured, which is what makes
 * a team in Tokyo generate on Tokyo's calendar day. This is stated as an assumption in the task
 * summary rather than buried here.
 */

/**
 * 06:00 in the team's own zone.
 *
 * Early enough to precede a delivery: the subscription default is 07:30 local, so generation has
 * finished before the first daily goes out, which is the ordering the delivery job also enforces
 * for itself by deferring when no report exists.
 */
export const DEFAULT_GENERATION_LOCAL_TIME = '06:00';

/** Five attempts with backoff, matching delivery. Documented in `docs/DEVELOPMENT.md`. */
export const GENERATION_RETRY_LIMIT = 5;

export const GeneratePayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  scopeKind: z.enum(['team', 'merged']),
  scopeKey: z.string().min(1),
  /** `YYYY-MM-DD` in `timezone` — the civil day this report is *for*. */
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  /** `HH:MM` local. Derived, not taken from a clock, so a replay agrees with the first run. */
  generationTime: z.string().regex(LOCAL_TIME_PATTERN),
});

export type GeneratePayload = z.infer<typeof GeneratePayloadSchema>;

export class InvalidGenerationPayloadError extends Error {
  constructor(detail: string) {
    super(`Job \`report.generate\` received a payload it cannot act on: ${detail}`);
    this.name = 'InvalidGenerationPayloadError';
  }
}

/**
 * The instant a report for this civil day is stamped with.
 *
 * The single source of the report's identity. Exported because both the generation job and the
 * ordering check need to agree on it, and a second copy of this expression would be a second answer.
 */
export const reportInstantFor = (payload: {
  readonly reportDate: string;
  readonly generationTime: string;
  readonly timezone: string;
}): Instant => instantAtLocalTime(payload.reportDate, payload.generationTime, payload.timezone);

/** The queue options a generation job is enqueued with. */
export const generationJobOptions = (payload: GeneratePayload) => ({
  // One scheduled generation per (org, scope, civil date) — the same tuple the report's own key is
  // derived from, so the queue and the database agree about what a duplicate is.
  singletonKey: `compass:generate:${payload.organizationId}:${payload.scopeKind}:${payload.scopeKey}:${payload.reportDate}`,
  retryLimit: GENERATION_RETRY_LIMIT,
  retryBackoff: true,
});

export interface TeamCadence {
  readonly teamKey: string;
  readonly timezone: string;
  /** `HH:MM` local. Defaults to `DEFAULT_GENERATION_LOCAL_TIME`. */
  readonly generationTime?: string | undefined;
}

/**
 * Which teams are due for generation at `now`, as job payloads.
 *
 * "Due" means the team's generation time for today *in that team's zone* has passed. Because the
 * boundary is computed from the zone's offset on that civil date, a DST transition moves it without
 * any code here mentioning daylight saving.
 *
 * `lookbackDays` covers a worker that was down over the generation time: the day is still generated,
 * late, rather than skipped forever. A replay costs nothing because the instant — and therefore the
 * row — is the same.
 */
export function generationJobsDue(
  teams: readonly TeamCadence[],
  now: Instant,
  organizationId: string,
  options: { readonly lookbackDays?: number; readonly mergedReport?: boolean } = {},
): readonly GeneratePayload[] {
  const lookback = Math.max(0, options.lookbackDays ?? 1);
  const due: GeneratePayload[] = [];

  for (const team of teams) {
    const generationTime = team.generationTime ?? DEFAULT_GENERATION_LOCAL_TIME;
    if (!LOCAL_TIME_PATTERN.test(generationTime)) continue;

    const today = formatCivilDate(now, team.timezone);

    for (let back = lookback; back >= 0; back -= 1) {
      const reportDate = shiftCivilDate(today, -back);
      const dueAt = instantAtLocalTime(reportDate, generationTime, team.timezone);
      if (isAfter(dueAt, now)) continue;

      due.push({
        organizationId,
        scopeKind: 'team',
        scopeKey: team.teamKey,
        reportDate,
        timezone: team.timezone,
        generationTime,
      });
    }
  }

  // The merged report, once, on the first team's zone and cadence. It is one report about every
  // team, so it cannot have a zone of its own; using the first team's keeps it deterministic.
  const first = teams[0];
  if (options.mergedReport === true && first !== undefined) {
    const generationTime = first.generationTime ?? DEFAULT_GENERATION_LOCAL_TIME;
    const today = formatCivilDate(now, first.timezone);

    for (let back = lookback; back >= 0; back -= 1) {
      const reportDate = shiftCivilDate(today, -back);
      if (isAfter(instantAtLocalTime(reportDate, generationTime, first.timezone), now)) continue;

      due.push({
        organizationId,
        scopeKind: 'merged',
        scopeKey: '*',
        reportDate,
        timezone: first.timezone,
        generationTime,
      });
    }
  }

  return due;
}

/**
 * Civil-date arithmetic on the string.
 *
 * Not instant arithmetic: shifting a date by a day is a calendar operation, and subtracting
 * 86,400,000 milliseconds from an instant is exactly what makes a DST day repeat or skip a date.
 */
export function shiftCivilDate(civilDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civilDate);
  if (!match) throw new InvalidGenerationPayloadError(`\`${civilDate}\` is not a \`YYYY-MM-DD\` civil date.`);

  const shifted = new Date(
    Date.UTC(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10) + days,
    ),
  );
  return shifted.toISOString().slice(0, 10);
}

export interface GenerationDependencies {
  /**
   * Generates or finds the report for this scope and instant.
   *
   * Injected as the whole operation rather than as a database handle so a test can drive the
   * handler without a pipeline, and so the handler itself holds no opinion about how a report is
   * produced — `ensureDailyReport` in `@compass/pipeline` is the one implementation.
   */
  readonly ensureReport: (request: {
    readonly organizationId: string;
    readonly scopeKind: 'team' | 'merged';
    readonly scopeKey: string;
    readonly reportInstant: Instant;
    readonly timezone: string;
  }) => Promise<{ readonly reportId: string; readonly generated: boolean }>;
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface GenerationResult {
  readonly status: 'generated' | 'already_present';
  readonly reportId: string;
  readonly reportDate: string;
  readonly detail: string;
}

/**
 * Generates one team's report for one civil day.
 *
 * A failure throws so pg-boss counts the attempt and applies the backoff — and it throws *after*
 * naming the organization, scope and instant in the log, because "generation failed" without those
 * three is not actionable. Nothing partial is left behind: `ensureDailyReport` writes the report and
 * its six sections in one call, and regenerates from scratch if it ever finds a report row whose
 * sections are missing.
 */
export async function handleReportGenerate(
  dependencies: GenerationDependencies,
  rawPayload: unknown,
  attempt = 1,
): Promise<GenerationResult> {
  const parsed = GeneratePayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new InvalidGenerationPayloadError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; '),
    );
  }

  const payload = parsed.data;
  const reportInstant = reportInstantFor(payload);

  try {
    const outcome = await dependencies.ensureReport({
      organizationId: payload.organizationId,
      scopeKind: payload.scopeKind,
      scopeKey: payload.scopeKey,
      reportInstant,
      timezone: payload.timezone,
    });

    const detail = outcome.generated
      ? `Generated ${payload.scopeKind}:${payload.scopeKey} for ${payload.reportDate}.`
      : `A report for ${payload.scopeKind}:${payload.scopeKey} on ${payload.reportDate} already existed; nothing was regenerated.`;

    dependencies.logger.info(`[compass] ${detail}`);
    return {
      status: outcome.generated ? 'generated' : 'already_present',
      reportId: outcome.reportId,
      reportDate: payload.reportDate,
      detail,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Org, scope and instant, so the failure is attributable without cross-referencing the queue.
    dependencies.logger.error(
      `[compass] generation failed for ${payload.organizationId} ${payload.scopeKind}:${payload.scopeKey} ` +
        `at ${toIso(reportInstant)} (attempt ${attempt} of ${GENERATION_RETRY_LIMIT}): ${reason}`,
    );
    throw error;
  }
}
