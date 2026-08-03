import { DAILY_REPORT_WORD_BUDGET, countWords } from '@compass/analysis';
import { RENDERER_ID as TEMPLATE_RENDERER_ID } from '@compass/renderers';
import { describe, expect, it } from 'vitest';

import {
  NARRATED_RENDERER_ID,
  NARRATION_MAX_ATTEMPTS,
  narrateReport,
  narrationPayload,
  sectionRequests,
  validateGrounding,
  type NarratorPort,
} from '@compass/narrator';
import {
  FABRICATED_TOKENS,
  fabricatingNarrator,
  groundedNarrator,
  recordingNarrator,
  refusingNarrator,
  unavailableNarrator,
} from '@compass/narrator/testkit';

import { RAW_COMMIT_MESSAGE, fullReport } from './helpers/reports.js';

/**
 * A narrator whose prose is grounded and far too long.
 *
 * Built by repeating a grounded narrator's own output, which is the trick that makes this test about
 * one thing. Repetition adds no new tokens, so the grounding validator still passes every claim —
 * the *only* rule the report can now fail is the word ceiling. A fake that invented filler words
 * would be rejected for fabrication first and would prove nothing about the budget.
 */
function verboseNarrator(times: number): NarratorPort {
  const inner = groundedNarrator();

  return {
    narratorId: 'fake:verbose',
    async narrate(request) {
      const response = await inner.narrate(request);
      return { ...response, prose: Array.from({ length: times }, () => response.prose).join(' ') };
    },
  };
}

/**
 * Subtask 003: bounded retries, and no report ever delivered with ungrounded prose.
 *
 * The central test uses `fabricatingNarrator`, which invents a pull request, a
 * tracker key, a percentage, a person, a date and a revision on *every* attempt and
 * says so. Nothing it writes may reach the returned prose.
 */

describe('N is documented and bounded', () => {
  it('is three attempts per section', () => {
    expect(NARRATION_MAX_ATTEMPTS).toBe(3);
  });
});

describe('a grounded narrator produces a narrated report', () => {
  it('narrates all six sections and reports no fallback', async () => {
    const result = await narrateReport(fullReport(), { narrator: groundedNarrator() });

    expect(result.rendererId).toBe(NARRATED_RENDERER_ID);
    expect(result.fallback).toBeNull();
    expect(result.sections.map((section) => section.key)).toEqual([
      'yesterday',
      'progress',
      'blockers',
      'risks',
      'recommendations',
      'wins',
    ]);
    for (const section of result.sections) {
      expect(section.prose.length, `\`${section.key}\` was narrated as empty`).toBeGreaterThan(0);
    }
  });

  it('writes one grounded trace per section, first time', async () => {
    const result = await narrateReport(fullReport(), { narrator: groundedNarrator() });

    expect(result.traces).toHaveLength(6);
    for (const trace of result.traces) {
      expect(trace.outcome).toBe('grounded');
      expect(trace.attempt).toBe(1);
      expect(trace.attemptCount).toBe(1);
      expect(trace.untraceableTokens).toEqual([]);
    }
  });

  it('records the model, prompt hash, prompt version and narrator on every trace', async () => {
    const result = await narrateReport(fullReport(), { narrator: groundedNarrator(), model: 'claude-sonnet-5' });

    for (const trace of result.traces) {
      expect(trace.model).toBe('fake-grounded-1');
      expect(trace.narratorId).toBe('fake:grounded');
      expect(trace.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(trace.promptVersion).toBe('narrate-section/1');
      expect(trace.proseLength).toBeGreaterThan(0);
    }
  });

  it('produces prose that passes the validator independently', async () => {
    // The narrator is a fake, so this is really a check on the *validator*: if it
    // had a false positive, echoing the payload back would trip it.
    const report = fullReport();
    const result = await narrateReport(report, { narrator: groundedNarrator() });
    const requests = new Map(sectionRequests(narrationPayload(report)).map((entry) => [entry.section.key, entry]));

    for (const section of result.sections) {
      const verdict = validateGrounding(section.prose, requests.get(section.key)!);
      expect(verdict.grounded, `\`${section.key}\`: ${section.prose}`).toBe(true);
    }
  });
});

describe('a narrator that always fabricates never reaches the page', () => {
  it('falls back to the template renderer after exactly N attempts', async () => {
    const result = await narrateReport(fullReport(), { narrator: fabricatingNarrator() });

    expect(result.rendererId).toBe('template');
    expect(result.fallback).not.toBeNull();
    expect(result.fallback?.outcome).toBe('rejected');
    // The first section fails, so the report falls back there rather than paying
    // for five more sections that will be discarded.
    expect(result.traces).toHaveLength(NARRATION_MAX_ATTEMPTS);
    expect(result.traces.map((trace) => trace.attempt)).toEqual([1, 2, 3]);
    expect(result.traces.every((trace) => trace.attemptCount === NARRATION_MAX_ATTEMPTS)).toBe(true);
  });

  it('returns not one fabricated token in any section, in any of the six', async () => {
    const result = await narrateReport(fullReport(), { narrator: fabricatingNarrator() });
    const everything = result.sections.map((section) => section.prose).join('\n');

    for (const fabricated of FABRICATED_TOKENS) {
      expect(everything, `the fabricated \`${fabricated}\` reached the report`).not.toContain(fabricated);
    }
  });

  it('returns the template renderer own six sections instead', async () => {
    const result = await narrateReport(fullReport(), { narrator: fabricatingNarrator() });

    expect(result.sections).toHaveLength(6);
    for (const section of result.sections) {
      const rendered = result.rendered.sections.find((entry) => entry.key === section.key);
      expect(section.prose).toBe(rendered?.prose);
      expect(section.attempts).toBe(0);
    }
  });

  it('names the tokens it rejected on every trace row', async () => {
    const result = await narrateReport(fullReport(), { narrator: fabricatingNarrator() });

    for (const trace of result.traces) {
      expect(trace.outcome).toBe('rejected');
      expect(trace.untraceableTokens.length).toBeGreaterThan(0);
      expect(trace.untraceableTokens).toEqual(expect.arrayContaining(['#999917']));
    }
    expect(result.fallback?.reason).toContain('could not be grounded in 3 attempts');
  });

  it('still narrates nothing when N is raised, because the stub never improves', async () => {
    const result = await narrateReport(fullReport(), { narrator: fabricatingNarrator(), maxAttempts: 5 });

    expect(result.rendererId).toBe('template');
    expect(result.traces).toHaveLength(5);
  });
});

describe('terminal provider outcomes are not retried', () => {
  it('falls back immediately on a refusal', async () => {
    const result = await narrateReport(fullReport(), { narrator: refusingNarrator() });

    expect(result.rendererId).toBe('template');
    expect(result.fallback?.outcome).toBe('refused');
    // One attempt, not three: a classifier decision does not change on a retry.
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.outcome).toBe('refused');
    expect(result.fallback?.reason).toContain('declined');
  });

  it('falls back immediately when the transport fails', async () => {
    const result = await narrateReport(fullReport(), { narrator: unavailableNarrator() });

    expect(result.rendererId).toBe('template');
    expect(result.fallback?.outcome).toBe('unavailable');
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.outcome).toBe('unavailable');
    expect(result.traces[0]?.detail).toContain('ECONNREFUSED');
  });
});

describe('no narrator configured', () => {
  it('renders from the template with no attempt and no trace', async () => {
    const result = await narrateReport(fullReport(), { narrator: null });

    expect(result.rendererId).toBe('template');
    expect(result.traces).toEqual([]);
    // A reason is still stated, so a caller can tell the reader why the prose is
    // templated — but the *pipeline* does not treat this as a fallback, because
    // nothing was attempted.
    expect(result.fallback?.reason).toContain('No narrator is configured');
    expect(result.sections).toHaveLength(6);
  });
});

describe('markup in a narration is rejected and retried', () => {
  it('retries a response wrapped in a code fence, then falls back', async () => {
    const fenced = {
      narratorId: 'fake:fenced',
      narrate: () =>
        Promise.resolve({
          prose: '```\nDEV-501 merged as #883.\n```',
          model: 'fake-fenced-1',
          inputTokens: null,
          outputTokens: null,
          refusal: null,
        }),
    };

    const result = await narrateReport(fullReport(), { narrator: fenced });

    expect(result.rendererId).toBe('template');
    expect(result.traces).toHaveLength(NARRATION_MAX_ATTEMPTS);
    expect(result.traces.every((trace) => trace.outcome === 'malformed')).toBe(true);
    expect(result.traces[0]?.detail).toContain('markup');
  });

  it('rejects a leaked reasoning tag rather than printing it', async () => {
    const leaky = {
      narratorId: 'fake:leaky',
      narrate: () =>
        Promise.resolve({
          prose: '<thinking>the payload says 62%</thinking>\nSprint 43 is 62% complete.',
          model: 'fake-leaky-1',
          inputTokens: null,
          outputTokens: null,
          refusal: null,
        }),
    };

    const result = await narrateReport(fullReport(), { narrator: leaky });
    expect(result.sections.map((section) => section.prose).join('\n')).not.toContain('<thinking>');
  });

  it('rejects an empty response', async () => {
    const silent = {
      narratorId: 'fake:silent',
      narrate: () =>
        Promise.resolve({ prose: '   \n  ', model: 'fake-silent-1', inputTokens: null, outputTokens: null, refusal: null }),
    };

    const result = await narrateReport(fullReport(), { narrator: silent });
    expect(result.traces.every((trace) => trace.outcome === 'malformed')).toBe(true);
    expect(result.traces[0]?.detail).toContain('no prose');
  });
});

describe('what actually leaves the process', () => {
  it('sends six requests, one per section, with no raw ingested text', async () => {
    const recorder = recordingNarrator(groundedNarrator());
    await narrateReport(fullReport(), { narrator: recorder });

    expect(recorder.requests).toHaveLength(6);
    expect(recorder.requests.map((request) => request.sectionKey)).toEqual([
      'yesterday',
      'progress',
      'blockers',
      'risks',
      'recommendations',
      'wins',
    ]);

    for (const request of recorder.requests) {
      expect(request.user).not.toContain(RAW_COMMIT_MESSAGE);
      expect(request.attempt).toBe(1);

      // The injected sentence lives inside the fixture's commit message, so it is
      // looked for inside the fence only — Compass's own notice quotes the phrase as
      // an example of what to disregard.
      const open = request.user.indexOf('<untrusted-report-data>') + '<untrusted-report-data>'.length;
      const fenced = request.user.slice(open, request.user.indexOf('</untrusted-report-data>'));
      expect(fenced.toLowerCase()).not.toContain('ignore previous instructions');
    }
  });

  it('re-sends the identical prompt on a retry, so a retry is not a new question', async () => {
    const recorder = recordingNarrator(fabricatingNarrator());
    await narrateReport(fullReport(), { narrator: recorder });

    expect(recorder.requests).toHaveLength(NARRATION_MAX_ATTEMPTS);
    const [first, ...rest] = recorder.requests;
    for (const request of rest) {
      expect(request.user).toBe(first?.user);
      expect(request.system).toBe(first?.system);
    }
    expect(recorder.requests.map((request) => request.attempt)).toEqual([1, 2, 3]);
  });
});

/**
 * The daily's fail-closed word ceiling — the owning test `docs/budgets.md` names for
 * `DAILY_REPORT_WORD_BUDGET`.
 *
 * The budget is checked on the narration path and nowhere else, and the reason is recorded in
 * `packages/analysis/src/budgets.ts`: it was first placed inside `renderReport`, where it fired on the
 * *deterministic* renderer — the thing narration falls back to — because the seeded corpus renders
 * about 1,750 templated words. There was nothing left to fall back to. Here it guards the only path
 * that can run long.
 */
describe('a narrated report over the word ceiling falls back to the template renderer', () => {
  it('accepts a grounded report that is within budget', async () => {
    const result = await narrateReport(fullReport(), { narrator: groundedNarrator() });

    expect(result.rendererId).toBe(NARRATED_RENDERER_ID);
    expect(result.fallback).toBeNull();
    // The control: the fixture must be *inside* the budget, or the test below proves nothing.
    expect(countWords(result.sections.map((section) => section.prose).join('\n\n'))).toBeLessThanOrEqual(
      DAILY_REPORT_WORD_BUDGET,
    );
  });

  it('discards grounded prose that runs past the ceiling', async () => {
    // 40× the grounded output: every token still traceable, the total far past 900 words.
    const result = await narrateReport(fullReport(), { narrator: verboseNarrator(40) });

    expect(result.rendererId).toBe(TEMPLATE_RENDERER_ID);
    expect(result.fallback).not.toBeNull();
    expect(result.fallback?.outcome, 'over budget is a rejection, like a grounding failure').toBe('rejected');
    // Whole-report, not one section: no `sectionKey`, because no single section is at fault.
    expect(result.fallback?.sectionKey).toBeNull();
  });

  it('says how long it ran and what the ceiling was, so the disclosure is checkable', async () => {
    const result = await narrateReport(fullReport(), { narrator: verboseNarrator(40) });

    expect(result.fallback?.reason).toContain(String(DAILY_REPORT_WORD_BUDGET));
    expect(result.fallback?.reason).toMatch(/\d+ words/);
    // The reader is told the report is still complete — only the wording is templated.
    expect(result.fallback?.reason).toContain('complete');
  });

  it('sends the deterministic render, so the manager still gets a report', async () => {
    const result = await narrateReport(fullReport(), { narrator: verboseNarrator(40) });

    // The whole point of failing closed: six sections, from the renderer that cannot run long.
    expect(result.sections).toHaveLength(6);
    expect(result.rendered.sections).toHaveLength(6);
    for (const section of result.sections) {
      expect(section.prose.length).toBeGreaterThan(0);
    }
  });

  it('keeps the traces, so the fallback is diagnosable', async () => {
    // Six sections were narrated successfully before the total tripped the ceiling; throwing their
    // traces away would leave no record of what the model actually wrote.
    const result = await narrateReport(fullReport(), { narrator: verboseNarrator(40) });

    expect(result.traces).toHaveLength(6);
  });
});
