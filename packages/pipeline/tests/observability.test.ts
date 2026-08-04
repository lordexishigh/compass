import { instantFromIso, toEpochMillis } from '@compass/clock';
import { NARRATION_MAX_ATTEMPTS } from '@compass/narrator';
import { fabricatingNarrator, groundedNarrator, refusingNarrator } from '@compass/narrator/testkit';
import { RecordingSink } from '@compass/observability';
import { runReportPipeline } from '@compass/pipeline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  INGEST_WINDOW,
  NOW,
  ORGANIZATION_ID,
  REPORT_WINDOW,
  TEAM_KEY,
  TIMEZONE,
  UNAVAILABLE_SOURCE_KEY,
  createPipelineHarness,
  type PipelineHarness,
} from './helpers/harness.js';

/**
 * The structured-logging criterion, asserted through the real pipeline.
 *
 * > Pipeline runs, narration fallbacks, ingest coverage gaps and delivery failures each emit a
 * > structured log event with the org, team and instant.
 *
 * `packages/observability/tests/log.test.ts` proves the *emitters* build the right record. That is
 * necessary and it is not the criterion: an emitter nobody calls emits nothing, which is exactly the
 * state this suite was written to close — all four emitters existed, were unit-tested, and had no
 * production caller anywhere in the workspace.
 *
 * So these tests run `runReportPipeline` against a real PostgreSQL and a real fixture connector and
 * assert on what a *deployment* would have written. Three of the four events belong to this layer;
 * `delivery.failure` is the worker's, and `apps/worker/tests/delivery.test.ts` owns it.
 *
 * ## Why the sink is injected rather than the console captured
 *
 * Capturing `console.info` would assert on a JSON string and couple the test to the sink's
 * formatting. `RecordingSink` is the same seam `logSink` gives a deployment, so the records asserted
 * here are the objects a hosted log product would receive.
 */

let harness: PipelineHarness;

const SCOPE = { kind: 'team', teamKey: TEAM_KEY } as const;

const request = (runIdSuffix: string, overrides: Record<string, unknown> = {}) => ({
  organizationId: ORGANIZATION_ID,
  scope: SCOPE,
  now: NOW,
  timezone: TIMEZONE,
  window: REPORT_WINDOW,
  ingestWindow: INGEST_WINDOW,
  runId: `77777777-7777-4777-8777-0000000000${runIdSuffix}`,
  connector: harness.connector,
  database: harness.database.db,
  ...overrides,
});

beforeAll(async () => {
  harness = await createPipelineHarness();
}, 120_000);

afterAll(async () => {
  await harness.close();
});

describe('every pipeline run says so', () => {
  it('emits pipeline.run with the organization, the team and the report instant', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('01', { logSink: sink }));

    const record = sink.last('pipeline.run');
    expect(record, 'the pipeline emitted no run event').not.toBeNull();
    expect(record?.organizationId).toBe(ORGANIZATION_ID);
    expect(record?.teamKey).toBe(TEAM_KEY);
    // The instant the report was generated *for*, not a wall-clock read — which is what lets a log
    // line be lined up against the report it describes.
    expect(record?.at).toBe(toEpochMillis(NOW));
    expect(record?.level).toBe('info');
  });

  it('reports which renderer actually wrote the prose', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('02', { logSink: sink, narrator: groundedNarrator() }));

    expect(sink.last('pipeline.run')?.extras['rendererId']).toBe('narrated');
  });

  it('calls a run with no narrator `template`, honestly, rather than a degradation', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('03', { logSink: sink }));

    expect(sink.last('pipeline.run')?.extras['rendererId']).toBe('template');
    // A deployment with no ANTHROPIC_API_KEY is the documented zero-config state. Emitting a
    // `narration.fallback` warning on every run of it would train an operator to filter the event.
    expect(sink.last('narration.fallback')).toBeNull();
  });

  it('measures a duration rather than reporting a placeholder', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('04', { logSink: sink }));

    const duration = sink.last('pipeline.run')?.extras['durationMillis'];
    expect(typeof duration).toBe('number');
    // A whole pipeline run against a real database cannot take zero milliseconds. This is the
    // assertion that would fail if `startTimer` ever silently degraded to its no-monotonic-source
    // branch, which returns 0 — a number nobody measured.
    expect(duration as number).toBeGreaterThan(0);
  });

  it('carries no team for a merged report, because it genuinely has none', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('05', { logSink: sink, scope: { kind: 'merged' } }));

    const record = sink.last('pipeline.run');
    // `null` rather than `''`: an empty string reads as a team called nothing, and the merged report
    // is about all of them.
    expect(record?.teamKey).toBeNull();
    expect(record?.extras['scopeKind']).toBe('merged');
  });
});

describe('a source that did not cover the window is named', () => {
  it('emits ingest.coverage_gap for the configured source that was rate-limited', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('06', { logSink: sink }));

    const gaps = sink.records.filter((entry) => entry.event === 'ingest.coverage_gap');
    expect(gaps.length, 'the fixture has one unavailable source, so exactly one gap is expected').toBe(1);

    const gap = gaps[0];
    expect(gap?.organizationId).toBe(ORGANIZATION_ID);
    expect(gap?.teamKey).toBe(TEAM_KEY);
    expect(gap?.at).toBe(toEpochMillis(NOW));
    expect(gap?.extras['sourceKey']).toBe(UNAVAILABLE_SOURCE_KEY);
    expect(gap?.extras['status']).toBe('unavailable');
    // The connector's own sentence, unedited. Compass does not soften "rate limited", and this is
    // the field an operator groups by after the source key.
    expect(String(gap?.extras['reason'])).toContain('429');
    expect(gap?.level).toBe('warn');
  });

  it('emits nothing for the three sources that answered', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('07', { logSink: sink }));

    const sources = sink.records
      .filter((entry) => entry.event === 'ingest.coverage_gap')
      .map((entry) => entry.extras['sourceKey']);

    // A gap event per healthy source would make the event useless: the signal is the exception.
    expect(sources).toEqual([UNAVAILABLE_SOURCE_KEY]);
  });
});

describe('a narration fallback says which kind of thing went wrong', () => {
  it('emits narration.fallback with cause `grounding` when the validator refuses the prose', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('08', { logSink: sink, narrator: fabricatingNarrator() }));

    const record = sink.last('narration.fallback');
    expect(record, 'a fabricated narration emitted no fallback event').not.toBeNull();
    expect(record?.organizationId).toBe(ORGANIZATION_ID);
    expect(record?.teamKey).toBe(TEAM_KEY);
    expect(record?.at).toBe(toEpochMillis(NOW));
    /**
     * The field the whole `NarrationFallbackCause` union exists for.
     *
     * `outcome` is `rejected` for a grounding failure *and* for a report over the word ceiling,
     * deliberately — from the reader's side both are "the model wrote something Compass would not
     * publish". An operator alerting on the 0.20 fallback rate needs the opposite: a broken prompt
     * and prose that got too long need different people and different fixes.
     */
    expect(record?.extras['cause']).toBe('grounding');
    expect(record?.extras['outcome']).toBe('rejected');
    /**
     * The attempt count, which has to come from `traces` rather than from `sections`.
     *
     * `fabricatingNarrator` is rejected on every attempt, so the section consumes all three of
     * `NARRATION_MAX_ATTEMPTS` before the report falls back. This assertion is load-bearing: every
     * fallback path in `narrateReport` returns `templateSections()`, which stamps `attempts: 0` on
     * all six sections, so an implementation reading the count off `sections` reports `0` here while
     * every other field on this event is correct. That is precisely how the bug this pins survived.
     */
    expect(record?.extras['attempts']).toBe(NARRATION_MAX_ATTEMPTS);
    expect(record?.extras['attempts']).toBe(3);
    // A fallback is a degradation, not a failure: the reader still gets six complete sections.
    expect(record?.level).toBe('warn');
  });

  it('distinguishes a provider refusal from a grounding failure', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('09', { logSink: sink, narrator: refusingNarrator() }));

    const record = sink.last('narration.fallback');
    // Same disclosure note to the reader, different remedy for the operator: check the key, do not
    // go looking for a broken validator rule.
    expect(record?.extras['cause']).toBe('refusal');
    expect(record?.extras['outcome']).toBe('refused');
    // One, not three: a refusal is terminal and deliberately not retried, so the count distinguishes
    // "the provider declined once" from "we burned the whole allowance on ungrounded prose".
    expect(record?.extras['attempts']).toBe(1);
  });

  it('names the section that failed, so a repeated offender is groupable', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('10', { logSink: sink, narrator: fabricatingNarrator() }));

    // The first section attempted is the one that fails, and narration is sequential in fixed order.
    expect(sink.last('narration.fallback')?.extras['sectionKey']).toBe('yesterday');
  });

  it('emits no fallback event when narration was grounded', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('11', { logSink: sink, narrator: groundedNarrator() }));

    expect(sink.last('narration.fallback')).toBeNull();
    expect(sink.last('pipeline.run')?.extras['rendererId']).toBe('narrated');
  });
});

describe('the log is a table, not prose', () => {
  it('keeps the organization and instant as fields on every event the run emitted', async () => {
    const sink = new RecordingSink();
    await runReportPipeline(request('12', { logSink: sink, narrator: fabricatingNarrator() }));

    // All three of this layer's events fired in one run: a coverage gap, a narration fallback and
    // the run itself. That combination is what makes "which organizations had a bad morning" a
    // query rather than a grep.
    expect([...new Set(sink.records.map((entry) => entry.event))].sort()).toEqual([
      'ingest.coverage_gap',
      'narration.fallback',
      'pipeline.run',
    ]);

    for (const entry of sink.records) {
      expect(entry.organizationId, `${entry.event} lost its organization`).toBe(ORGANIZATION_ID);
      expect(entry.at, `${entry.event} lost its instant`).toBe(toEpochMillis(NOW));
      // Present as a key even when null: an absent key and a null one are different things to a
      // log query, and "this had no team" is a fact worth stating.
      expect(entry, `${entry.event} lost its team`).toHaveProperty('teamKey');
      expect(entry.timestamp, `${entry.event} lost its readable timestamp`).toBe(
        new Date(toEpochMillis(NOW)).toISOString(),
      );
    }
  });

  it('does not fail the run when the sink throws', async () => {
    /**
     * A logging call that took out a generation would turn an observability concern into an outage.
     * The report is already persisted by the time anything is emitted, so a broken sink must cost
     * nothing — this asserts the `catch` in `emitRunEvents` rather than trusting the comment on it.
     */
    const hostile = {
      write: () => {
        throw new Error('the log transport is down');
      },
    };

    const result = await runReportPipeline(request('13', { logSink: hostile }));
    expect(result.stored.id, 'a broken log sink must not stop a report being generated').toBeTruthy();
  });
});

describe('the instant is the report’s, not the host’s', () => {
  it('logs the time-travelled instant when a past report is regenerated', async () => {
    const past = instantFromIso('2026-07-30T07:30:00Z');
    const sink = new RecordingSink();

    await runReportPipeline(request('14', { logSink: sink, now: past, narrator: null }));

    // If any emitter read a clock, this would be today. The golden and time-travel gates depend on
    // the same property, which is why `at` is a parameter everywhere in this package.
    expect(sink.last('pipeline.run')?.at).toBe(toEpochMillis(past));
    expect(sink.last('pipeline.run')?.at).not.toBe(toEpochMillis(NOW));
  });
});
