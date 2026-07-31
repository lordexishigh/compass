import { instantFromIso } from '@compass/clock';
import { findLatestReportForDate, listNarrationTraces, loadReportBundle } from '@compass/db';
import { NARRATION_MAX_ATTEMPTS } from '@compass/narrator';
import { FABRICATED_TOKENS, fabricatingNarrator, groundedNarrator } from '@compass/narrator/testkit';
import { runReportPipeline } from '@compass/pipeline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  INGEST_WINDOW,
  NOW,
  ORGANIZATION_ID,
  REPORT_WINDOW,
  TEAM_KEY,
  TIMEZONE,
  createPipelineHarness,
  type PipelineHarness,
} from './helpers/harness.js';

/**
 * Narration through the real pipeline, against a real database.
 *
 * The narrator tests prove the retry loop and the validator in isolation. These
 * prove the half that only exists once rows are written: that a grounded narration
 * reaches `report_sections.prose`, that a rejected one sets `fallback_renderer` with
 * a reason, that both write `narration_traces`, and that a replay of the same instant
 * replaces those traces rather than accumulating a second run's attempts beside the
 * first.
 */

let harness: PipelineHarness;

const SCOPE = { kind: 'team', teamKey: TEAM_KEY } as const;
const SCOPE_COLUMNS = { scopeKind: 'team', scopeKey: TEAM_KEY };

/** A distinct instant per case, so each writes its own report row. */
const request = (runIdSuffix: string, now = NOW, overrides: Record<string, unknown> = {}) => ({
  organizationId: ORGANIZATION_ID,
  scope: SCOPE,
  now,
  timezone: TIMEZONE,
  window: REPORT_WINDOW,
  ingestWindow: INGEST_WINDOW,
  runId: `55555555-5555-4555-8555-0000000000${runIdSuffix}`,
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

const scoped = () => harness.database.scopedFor(ORGANIZATION_ID);

describe('a grounded narration reaches the stored report', () => {
  it('stores the narrated prose, marks the renderer, and records no fallback', async () => {
    const result = await runReportPipeline(request('01', NOW, { narrator: groundedNarrator() }));

    expect(result.narration?.rendererId).toBe('narrated');
    expect(result.narration?.fallback).toBeNull();
    expect(result.stored.rendererId).toBe('narrated');
    expect(result.stored.fallbackRenderer).toBe(false);
    expect(result.stored.fallbackReason).toBeNull();

    const bundle = await loadReportBundle(scoped(), result.stored.id);
    expect(bundle?.sections).toHaveLength(6);

    // Every section's stored prose is the narration, not the template's.
    for (const section of bundle?.sections ?? []) {
      const narrated = result.narration?.sections.find((entry) => entry.key === section.sectionKey);
      expect(narrated, `no narration for \`${section.sectionKey}\``).toBeDefined();
      expect(section.prose).toBe(narrated?.prose);
    }
  });

  it('keeps the whole-report prose, with the masthead the narrator never saw', async () => {
    const result = await runReportPipeline(request('02', NOW, { narrator: groundedNarrator() }));

    // The masthead and the freshness line come from the deterministic renderer, so
    // narration replaces section bodies and nothing else.
    expect(result.stored.prose).toContain(result.rendered.masthead);
    expect(result.stored.prose).toContain('01 YESTERDAY');
    expect(result.stored.prose).toContain('06 WINS');
  });

  it('writes one grounded trace per section', async () => {
    const result = await runReportPipeline(request('03', NOW, { narrator: groundedNarrator() }));
    const traces = await listNarrationTraces(scoped(), result.stored.id);

    expect(traces).toHaveLength(6);
    expect(new Set(traces.map((trace) => trace.sectionKey)).size).toBe(6);
    for (const trace of traces) {
      expect(trace.outcome).toBe('grounded');
      expect(trace.attempt).toBe(1);
      expect(trace.attemptCount).toBe(1);
      expect(trace.narratorId).toBe('fake:grounded');
      expect(trace.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(trace.promptVersion).toBe('narrate-section/1');
      expect(trace.untraceableTokens).toEqual([]);
      expect(trace.recordedAt).toBe(NOW);
    }
  });

  it('orders the traces by section then attempt, the order they happened', async () => {
    const result = await runReportPipeline(request('04', NOW, { narrator: groundedNarrator() }));
    const traces = await listNarrationTraces(scoped(), result.stored.id);

    const keys = traces.map((trace) => `${trace.sectionKey}:${trace.attempt}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('a fabricated narration never reaches the stored report', () => {
  it('sets the fallback flag with a reason and stores the template prose', async () => {
    const result = await runReportPipeline(request('05', NOW, { narrator: fabricatingNarrator() }));

    expect(result.stored.rendererId).toBe('template');
    expect(result.stored.fallbackRenderer).toBe(true);
    expect(result.stored.fallbackReason).toContain('could not be grounded in 3 attempts');
    // And the reason names the token, which is what makes the flag actionable.
    expect(result.stored.fallbackReason).toContain('#999917');
  });

  it('stores not one fabricated token, in any section or in the whole-report prose', async () => {
    const result = await runReportPipeline(request('06', NOW, { narrator: fabricatingNarrator() }));
    const bundle = await loadReportBundle(scoped(), result.stored.id);

    const everything = [result.stored.prose, ...(bundle?.sections ?? []).map((section) => section.prose)].join('\n');
    for (const fabricated of FABRICATED_TOKENS) {
      expect(everything, `\`${fabricated}\` reached the database`).not.toContain(fabricated);
    }
  });

  it('stores the deterministic renderer own sections instead', async () => {
    const result = await runReportPipeline(request('07', NOW, { narrator: fabricatingNarrator() }));
    const bundle = await loadReportBundle(scoped(), result.stored.id);

    for (const section of bundle?.sections ?? []) {
      const rendered = result.rendered.sections.find((entry) => entry.key === section.sectionKey);
      expect(section.prose).toBe(rendered?.prose);
    }
  });

  it('records every rejected attempt, naming the tokens', async () => {
    const result = await runReportPipeline(request('08', NOW, { narrator: fabricatingNarrator() }));
    const traces = await listNarrationTraces(scoped(), result.stored.id);

    expect(traces).toHaveLength(NARRATION_MAX_ATTEMPTS);
    expect(traces.map((trace) => trace.attempt)).toEqual([1, 2, 3]);
    for (const trace of traces) {
      expect(trace.outcome).toBe('rejected');
      expect(trace.attemptCount).toBe(NARRATION_MAX_ATTEMPTS);
      expect(trace.untraceableTokens).toEqual(expect.arrayContaining(['#999917']));
    }
  });
});

describe('no narrator configured', () => {
  it('stores the template render with no fallback flag and no traces', async () => {
    // The zero-config default. It is *not* a fallback: nothing was attempted, so an
    // operator alerting on the fallback rate must not be woken by it.
    const result = await runReportPipeline(request('09'));

    expect(result.narration).toBeNull();
    expect(result.stored.rendererId).toBe('template');
    expect(result.stored.fallbackRenderer).toBe(false);
    expect(result.stored.fallbackReason).toBeNull();
    expect(await listNarrationTraces(scoped(), result.stored.id)).toEqual([]);
  });
});

describe('a replay replaces the traces rather than accumulating them', () => {
  it('leaves one run worth of attempts after a re-run with fewer', async () => {
    const now = instantFromIso('2026-07-31T10:15:00.000Z');

    // First: three rejected attempts on the first section.
    const rejected = await runReportPipeline(request('10', now, { narrator: fabricatingNarrator() }));
    expect(await listNarrationTraces(scoped(), rejected.stored.id)).toHaveLength(NARRATION_MAX_ATTEMPTS);

    // Then the same instant again, with a narrator that succeeds first time. The row
    // id is derived from (organization, scope, instant), so this is the same report —
    // and keeping the earlier run's attempts would report an attempt count that never
    // happened for the report that now exists.
    const grounded = await runReportPipeline(request('11', now, { narrator: groundedNarrator() }));
    expect(grounded.stored.id).toBe(rejected.stored.id);

    const traces = await listNarrationTraces(scoped(), grounded.stored.id);
    expect(traces).toHaveLength(6);
    expect(traces.every((trace) => trace.outcome === 'grounded')).toBe(true);
    expect(grounded.stored.fallbackRenderer).toBe(false);
    expect(grounded.stored.fallbackReason).toBeNull();
  });
});

describe('the stored report is what the read path returns', () => {
  it('surfaces the fallback flag through the normal lookup', async () => {
    const now = instantFromIso('2026-07-31T11:30:00.000Z');
    await runReportPipeline(request('12', now, { narrator: fabricatingNarrator() }));

    const found = await findLatestReportForDate(scoped(), SCOPE_COLUMNS, '2026-07-31');
    expect(found?.fallbackRenderer).toBe(true);
    expect(found?.fallbackReason).not.toBeNull();
  });
});
