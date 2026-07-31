import { MILLIS_PER_HOUR, differenceInMillis, instantFromIso, toIso, zonedParts, type Instant } from '@compass/clock';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_GENERATION_LOCAL_TIME,
  GENERATION_RETRY_LIMIT,
  InvalidGenerationPayloadError,
  generationJobOptions,
  generationJobsDue,
  handleReportGenerate,
  reportInstantFor,
  shiftCivilDate,
  type GenerationDependencies,
  type TeamCadence,
} from '../src/generation.js';

/**
 * Per-team generation.
 *
 * The idempotency criterion — "runs twice for the same (org, team, date) produces one Report row" —
 * is satisfied by arithmetic rather than by a check: `saveReport` derives the row's primary key from
 * `reportIdFor(org, scope, reportInstant)`, so two runs that agree on the instant write the same
 * row. These tests assert the agreement, which is the part that can regress; the constraint itself is
 * covered by `packages/db`.
 */

const at = (iso: string): Instant => instantFromIso(iso);

const team = (overrides: Partial<TeamCadence> = {}): TeamCadence => ({
  teamKey: 'platform',
  timezone: 'Europe/London',
  ...overrides,
});

const dependencies = (
  overrides: Partial<GenerationDependencies> = {},
): GenerationDependencies => ({
  ensureReport: async () => ({ reportId: 'report-1', generated: true }),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  ...overrides,
});

const payload = (overrides: Record<string, unknown> = {}) => ({
  organizationId: '11111111-1111-4111-8111-111111111111',
  scopeKind: 'team' as const,
  scopeKey: 'platform',
  reportDate: '2026-08-03',
  timezone: 'Europe/London',
  generationTime: '06:00',
  ...overrides,
});

describe('the report instant a generation is stamped with', () => {
  it('is derived from the civil date and the team zone, not from a clock', () => {
    // 06:00 London in August is 05:00Z. Nothing about the tick's own instant appears in it.
    expect(toIso(reportInstantFor(payload()))).toBe('2026-08-03T05:00:00.000Z');
  });

  it('is identical for two runs of the same (team, date), which is what makes one row', () => {
    const first = reportInstantFor(payload());
    const second = reportInstantFor(payload());

    expect(first).toBe(second);
  });

  it('differs per team zone, so a Tokyo team generates on Tokyo calendar time', () => {
    expect(toIso(reportInstantFor(payload({ timezone: 'Asia/Tokyo' })))).toBe('2026-08-02T21:00:00.000Z');
    // Same civil date, different instants: each team's report is stamped on its own clock.
    expect(reportInstantFor(payload({ timezone: 'Asia/Tokyo' }))).not.toBe(reportInstantFor(payload()));
  });

  it('differs per date, so consecutive days are separate rows', () => {
    expect(reportInstantFor(payload({ reportDate: '2026-08-04' }))).not.toBe(reportInstantFor(payload()));
  });
});

describe('DST', () => {
  it('keeps the generation time at 06:00 local across the spring transition', () => {
    // 29 March 2026 is when Europe/London springs forward. The wall-clock time is what a manager
    // set; the elapsed gap between two generations is 23 hours as a consequence.
    const before = reportInstantFor(payload({ reportDate: '2026-03-28' }));
    const after = reportInstantFor(payload({ reportDate: '2026-03-29' }));

    expect(differenceInMillis(after, before) / MILLIS_PER_HOUR).toBe(23);
    expect(zonedParts(after, 'Europe/London').hour).toBe(6);
  });

  it('keeps it at 06:00 local across the autumn transition', () => {
    // 25 October 2026: 25 hours elapsed, same wall clock.
    const before = reportInstantFor(payload({ reportDate: '2026-10-24' }));
    const after = reportInstantFor(payload({ reportDate: '2026-10-25' }));

    expect(differenceInMillis(after, before) / MILLIS_PER_HOUR).toBe(25);
    expect(zonedParts(after, 'Europe/London').hour).toBe(6);
  });

  it('still produces a report when the generation time falls in the hour a transition skipped', () => {
    // London jumps 01:00 → 02:00 on 29 March 2026, so 01:30 local never happens. A team configured
    // to generate then must still get a report rather than silently losing a day once a year.
    const instant = reportInstantFor(payload({ reportDate: '2026-03-29', generationTime: '01:30' }));

    expect(toIso(instant)).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedParts(instant, 'Europe/London').hour, 'after the skipped hour, not inside it').toBe(2);
  });

  it('is a single instant on a date whose generation time the transition repeated', () => {
    // 01:30 happens twice on 25 October 2026. One instant means one row, which is the property that
    // matters — two would mean two reports for one day.
    const instant = reportInstantFor(payload({ reportDate: '2026-10-25', generationTime: '01:30' }));
    expect(toIso(instant)).toBe('2026-10-25T01:30:00.000Z');
  });
});

describe('which teams are due', () => {
  it('is nothing before the generation time in the team own zone', () => {
    // 04:00Z is 05:00 London — before 06:00.
    expect(
      generationJobsDue([team()], at('2026-08-03T04:00:00Z'), 'org', { lookbackDays: 0 }),
    ).toEqual([]);
  });

  it('is the team once its own 06:00 has passed', () => {
    const due = generationJobsDue([team()], at('2026-08-03T06:00:00Z'), 'org', { lookbackDays: 0 });

    expect(due).toHaveLength(1);
    expect(due[0]?.scopeKey).toBe('platform');
    expect(due[0]?.reportDate).toBe('2026-08-03');
  });

  it('reads the boundary per zone, so two teams differ at one instant', () => {
    // 21:30Z is 06:30 next day in Tokyo (due) and 22:30 the same day in London (due for today too),
    // but the *dates* differ because each team is on its own calendar.
    const due = generationJobsDue(
      [team({ teamKey: 'platform' }), team({ teamKey: 'tokyo', timezone: 'Asia/Tokyo' })],
      at('2026-08-03T21:30:00Z'),
      'org',
      { lookbackDays: 0 },
    );

    const byTeam = new Map(due.map((job) => [job.scopeKey, job]));
    expect(byTeam.get('platform')?.reportDate).toBe('2026-08-03');
    expect(byTeam.get('tokyo')?.reportDate, 'already 4 August in Tokyo').toBe('2026-08-04');
  });

  it('catches up a day the worker was down for, oldest first', () => {
    const due = generationJobsDue([team()], at('2026-08-04T06:00:00Z'), 'org', { lookbackDays: 1 });

    expect(due.map((job) => job.reportDate)).toEqual(['2026-08-03', '2026-08-04']);
  });

  it('adds the merged report when asked, on the first team cadence', () => {
    const due = generationJobsDue([team()], at('2026-08-03T06:00:00Z'), 'org', {
      lookbackDays: 0,
      mergedReport: true,
    });

    expect(due.map((job) => `${job.scopeKind}:${job.scopeKey}`)).toEqual(['team:platform', 'merged:*']);
  });

  it('skips a team whose configured generation time is malformed rather than failing the tick', () => {
    // One bad row must not stop every other team's report.
    const due = generationJobsDue(
      [team({ teamKey: 'broken', generationTime: '6:00' }), team({ teamKey: 'fine' })],
      at('2026-08-03T06:00:00Z'),
      'org',
      { lookbackDays: 0 },
    );

    expect(due.map((job) => job.scopeKey)).toEqual(['fine']);
  });

  it('defaults the generation time when a team has none', () => {
    const due = generationJobsDue([team()], at('2026-08-03T06:00:00Z'), 'org', { lookbackDays: 0 });
    expect(due[0]?.generationTime).toBe(DEFAULT_GENERATION_LOCAL_TIME);
  });
});

describe('the queue options a generation job carries', () => {
  it('are keyed on (org, scope, date), so a duplicate tick is one job', () => {
    const options = generationJobOptions(payload());

    expect(options.singletonKey).toBe(
      'compass:generate:11111111-1111-4111-8111-111111111111:team:platform:2026-08-03',
    );
    expect(options.retryLimit).toBe(GENERATION_RETRY_LIMIT);
    expect(options.retryBackoff).toBe(true);
  });

  it('separate the merged report from a team report for the same day', () => {
    expect(generationJobOptions(payload({ scopeKind: 'merged', scopeKey: '*' })).singletonKey).not.toBe(
      generationJobOptions(payload()).singletonKey,
    );
  });
});

describe('generating a report', () => {
  it('pins the derived instant rather than passing a clock reading down', async () => {
    const ensureReport = vi.fn(async () => ({ reportId: 'report-1', generated: true }));

    await handleReportGenerate(dependencies({ ensureReport }), payload());

    expect(ensureReport).toHaveBeenCalledWith({
      organizationId: '11111111-1111-4111-8111-111111111111',
      scopeKind: 'team',
      scopeKey: 'platform',
      reportInstant: at('2026-08-03T05:00:00Z'),
      timezone: 'Europe/London',
    });
  });

  it('reports that nothing was regenerated when a report already existed', async () => {
    const result = await handleReportGenerate(
      dependencies({ ensureReport: async () => ({ reportId: 'report-1', generated: false }) }),
      payload(),
    );

    expect(result.status).toBe('already_present');
    expect(result.detail).toContain('already existed');
  });

  it('asks for the same instant on a second run, which is what makes one row', async () => {
    const seen: Instant[] = [];
    const ensureReport = async (request: { readonly reportInstant: Instant }) => {
      seen.push(request.reportInstant);
      return { reportId: 'report-1', generated: seen.length === 1 };
    };

    await handleReportGenerate(dependencies({ ensureReport }), payload());
    await handleReportGenerate(dependencies({ ensureReport }), payload(), 2);

    expect(seen[0]).toBe(seen[1]);
  });
});

describe('when generation fails', () => {
  it('names the org, scope and instant before rethrowing for the backoff', async () => {
    const errors: string[] = [];
    const failing = dependencies({
      ensureReport: async () => {
        throw new Error('the analysis core threw');
      },
      logger: { info: () => {}, warn: () => {}, error: (message: string) => errors.push(message) },
    });

    await expect(handleReportGenerate(failing, payload(), 3)).rejects.toThrow('the analysis core threw');

    // "Generation failed" without these three is not actionable.
    expect(errors[0]).toContain('11111111-1111-4111-8111-111111111111');
    expect(errors[0]).toContain('team:platform');
    expect(errors[0]).toContain('2026-08-03T05:00:00.000Z');
    expect(errors[0]).toContain(`attempt 3 of ${GENERATION_RETRY_LIMIT}`);
  });

  it('rethrows so pg-boss counts the attempt rather than swallowing the failure', async () => {
    // A swallowed failure would leave no report and no retry, and the delivery job would defer for
    // ever with nothing explaining why.
    await expect(
      handleReportGenerate(
        dependencies({
          ensureReport: async () => {
            throw new Error('transient');
          },
        }),
        payload(),
      ),
    ).rejects.toThrow();
  });

  it('throws on a malformed payload, because that is a bug upstream', async () => {
    await expect(handleReportGenerate(dependencies(), { nonsense: true })).rejects.toThrow(
      InvalidGenerationPayloadError,
    );
    await expect(handleReportGenerate(dependencies(), payload({ generationTime: '6am' }))).rejects.toThrow(
      InvalidGenerationPayloadError,
    );
  });
});

describe('civil-date arithmetic', () => {
  it('shifts the calendar date rather than subtracting elapsed time', () => {
    expect(shiftCivilDate('2026-03-29', -1)).toBe('2026-03-28');
    expect(shiftCivilDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftCivilDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});
