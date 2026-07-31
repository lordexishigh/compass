import { describe, expect, it } from 'vitest';

import {
  RAW_INGESTED_TEXT_FIELDS,
  RawIngestedTextError,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  assertNoRawIngestedText,
  buildSectionPrompt,
  narrationPayload,
  sectionRequests,
} from '@compass/narrator';

import { RAW_BRANCH_NAME, RAW_COMMIT_MESSAGE, fullReport } from './helpers/reports.js';

/**
 * Subtask 001's central criterion: only the structured section payload is sent.
 *
 * The assertion is over *bytes*. `fullReport()` carries an alignment verdict whose
 * evidence holds a verbatim commit message, so the fixture contains a string that
 * must not appear in any request — and the test looks for it in the rendered prompt
 * rather than reasoning about the code that built it.
 */

describe('the narration payload is a projection, not a pass-through', () => {
  it('carries the six sections in the fixed order', () => {
    const payload = narrationPayload(fullReport());
    expect(payload.sections.map((section) => section.key)).toEqual([
      'yesterday',
      'progress',
      'blockers',
      'risks',
      'recommendations',
      'wins',
    ]);
    expect(payload.sections.map((section) => section.numeral)).toEqual(['01', '02', '03', '04', '05', '06']);
  });

  it('carries the masthead facts the narrator may name', () => {
    const payload = narrationPayload(fullReport());
    expect(payload.context.reportDate).toBe('2026-07-31');
    expect(payload.context.scopeLabel).toBe('platform');
    expect(payload.context.coverage.map((note) => note.sourceKey)).toEqual(['primary-code', 'primary-tracker']);
  });

  it('carries an alignment verdict without its resolution path', () => {
    const payload = narrationPayload(fullReport());
    const risks = payload.sections.find((section) => section.key === 'risks');
    const alignment = risks?.items[0]?.alignment;

    // The verdict travels: a sentence needs the score, the bar and the objective.
    expect(alignment?.label).toBe('OFF-GOAL');
    expect(alignment?.confidence).toBe(1);
    expect(alignment?.threshold).toBe(0.3);
    expect(alignment?.subjectLabels).toEqual(['PLAT-742']);

    // The searched text does not: there is no field for it on the projected shape.
    expect(alignment).not.toHaveProperty('evidence');
    expect(JSON.stringify(alignment)).not.toContain('rebase');
  });

  it('carries evidence labels but never source record ids', () => {
    const payload = narrationPayload(fullReport());
    const yesterday = payload.sections.find((section) => section.key === 'yesterday');

    expect(yesterday?.items[0]?.evidenceLabels).toEqual(['DEV-501', '#883', '7a8b9c0']);
    // `checkout-web:7a8b9c0d1e2f` is an internal key. It is not what a human says
    // out loud and it is not the narrator's business.
    expect(JSON.stringify(yesterday)).not.toContain('checkout-web');
  });

  it('does not carry the findings blob', () => {
    // `findings` holds every alignment resolution, including the compared texts of
    // every semantic scoring attempt. None of it is narration input.
    const payload = narrationPayload(fullReport());
    expect(payload).not.toHaveProperty('findings');
    expect(JSON.stringify(payload)).not.toContain(RAW_COMMIT_MESSAGE);
  });
});

describe('the structural raw-text gate', () => {
  it('names the field and the path when a raw-text field appears', () => {
    const offending = { section: { items: [{ alignment: { searchedText: 'a commit message' } }] } };

    expect(() => assertNoRawIngestedText(offending)).toThrow(RawIngestedTextError);
    expect(() => assertNoRawIngestedText(offending)).toThrow(/payload\.section\.items\[0\]\.alignment\.searchedText/);
  });

  it('guards every documented raw-text field name', () => {
    for (const field of RAW_INGESTED_TEXT_FIELDS) {
      expect(() => assertNoRawIngestedText({ [field]: 'anything' }), `\`${field}\` is not guarded`).toThrow(
        RawIngestedTextError,
      );
    }
  });

  it('passes the real projection', () => {
    expect(() => assertNoRawIngestedText(narrationPayload(fullReport()))).not.toThrow();
  });
});

describe('no raw ingested text reaches the request', () => {
  const requests = sectionRequests(narrationPayload(fullReport())).map(buildSectionPrompt);

  it('builds one prompt per section', () => {
    expect(requests).toHaveLength(6);
  });

  /**
   * The criterion names four kinds of raw text. The fixture supplies a commit
   * message and a branch name verbatim; a PR body, a tracker comment and a chat
   * message have no field in the structured report at all, which is asserted
   * separately by the field-name gate above so the guard is already closed for them.
   */
  it.each([
    ['a commit message', RAW_COMMIT_MESSAGE],
    ['a branch name', RAW_BRANCH_NAME],
  ])('sends no %s', (_what, needle) => {
    for (const prompt of requests) {
      expect(prompt.system.toLowerCase(), 'the system prompt leaked raw text').not.toContain(needle.toLowerCase());
      expect(prompt.user.toLowerCase(), 'the user message leaked raw text').not.toContain(needle.toLowerCase());
    }
  });

  /**
   * The injected sentence rides inside the fixture's commit message, so it can only
   * be looked for inside the *fenced payload* — Compass's own notice legitimately
   * quotes the phrase as an example of what to disregard, and a whole-prompt search
   * would match the instruction rather than any leak.
   */
  it('sends no injected instruction inside the payload', () => {
    for (const prompt of requests) {
      const open = prompt.user.indexOf(UNTRUSTED_OPEN) + UNTRUSTED_OPEN.length;
      const fenced = prompt.user.slice(open, prompt.user.indexOf(UNTRUSTED_CLOSE)).toLowerCase();
      expect(fenced, 'the fenced payload leaked an injected instruction').not.toContain('ignore previous instructions');
    }
  });

  it('sends no internal source record id', () => {
    for (const prompt of requests) {
      expect(prompt.user).not.toContain('checkout-web:7a8b9c0d1e2f');
      expect(prompt.user).not.toContain('platform-api:b2c3d40');
    }
  });

  it('does send the computed claims, so the narrator has something to write', () => {
    const yesterday = requests[0];
    expect(yesterday?.user).toContain('DEV-501 merged as #883');
    expect(yesterday?.user).toContain('#883');
  });

  it('hashes the prompt so a model or prompt change is auditable', () => {
    const hashes = new Set(requests.map((prompt) => prompt.promptHash));
    expect(hashes.size, 'each section must hash differently').toBe(6);
    for (const prompt of requests) {
      expect(prompt.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prompt.promptVersion).toBe('narrate-section/1');
    }
  });

  it('hashes identically for the same payload twice', () => {
    const again = sectionRequests(narrationPayload(fullReport())).map(buildSectionPrompt);
    expect(again.map((prompt) => prompt.promptHash)).toEqual(requests.map((prompt) => prompt.promptHash));
  });
});
