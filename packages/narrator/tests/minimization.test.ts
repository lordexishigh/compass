import {
  MINIMIZATION_MODES,
  NARRATED_RENDERER_ID,
  RealNameLeakError,
  assertNoRealNames,
  narrateReport,
  narrationPayload,
  realNamesIn,
  redactPayload,
  redactText,
  restoreText,
  sectionRequests,
  validateGrounding,
  type NameRedaction,
} from '@compass/narrator';
import { groundedNarrator, payloadFromRequest, recordingNarrator } from '@compass/narrator/testkit';
import { RENDERER_ID as TEMPLATE_RENDERER_ID } from '@compass/renderers';
import { describe, expect, it } from 'vitest';

import { fullReport } from './helpers/reports.js';

/**
 * Subtask 006: the three LLM data-minimization modes.
 *
 * The three acceptance criteria are asserted as three separate claims, and none of them is
 * argued from the code — each is checked against the bytes that would have left the process,
 * captured by `recordingNarrator`. That fake is the seam the whole feature is testable at:
 * everything above it is production code with the network removed.
 *
 * The report used here names two people in every field a name can reach — a headline, a
 * detail, a change clause, an alignment subject label — because a redaction that covered the
 * headline and missed the change clause would pass a laxer test and leak on every recurring
 * item.
 */

const PRIYA = 'Priya Raman';
const MARCUS = 'Marcus Hale';

const REDACTIONS: readonly NameRedaction[] = [
  { realName: PRIYA, pseudonym: 'Wren Alder' },
  { realName: MARCUS, pseudonym: 'Heron Basalt' },
];

/**
 * The full fixture report with two people's names written into every item's prose.
 *
 * Built by rewriting `fullReport()` rather than by assembling items from scratch, and that is
 * not laziness — the template renderer needs each item's cause and interpretation to line up
 * with its section, and a hand-built item that skipped one renders as a crash rather than as a
 * clean failure. Rewriting the *text* of a report that is already well formed changes exactly
 * the thing under test and nothing else.
 */
function reportNamingPeople() {
  const report = fullReport();

  return {
    ...report,
    sections: report.sections.map((section) => ({
      ...section,
      summary: section.summary === undefined ? undefined : `${section.summary} ${PRIYA} is named here.`,
      items: section.items.map((item, index) => ({
        ...item,
        // Both people in every item, in both fields a name can reach, so a redaction that
        // covered the headline and missed the detail cannot pass.
        headline: `${index === 0 ? PRIYA : MARCUS} — ${item.headline}`,
        detail: `${item.detail} ${PRIYA} and ${MARCUS} are both on this.`,
      })),
    })),
  };
}

describe('the three modes are a closed set', () => {
  it('is exactly full, redacted and none', () => {
    expect([...MINIMIZATION_MODES]).toEqual(['full', 'redacted', 'none']);
  });
});

// ---------------------------------------------------------------------------
// Criterion: redacted mode sends only pseudonyms, and re-substitutes locally
// ---------------------------------------------------------------------------

describe('redacted mode', () => {
  it('sends no real name in any outbound request', async () => {
    const narrator = recordingNarrator(groundedNarrator());

    await narrateReport(reportNamingPeople(), {
      narrator,
      minimization: 'redacted',
      redactions: REDACTIONS,
    });

    // Six sections, six requests. An assertion over an empty list would pass vacuously, so
    // the count is checked first.
    expect(narrator.requests).toHaveLength(6);

    for (const request of narrator.requests) {
      // Both halves of what leaves: the system prompt and the user turn.
      expect(realNamesIn(request.system, REDACTIONS), `system prompt for ${request.sectionKey}`).toEqual([]);
      expect(realNamesIn(request.user, REDACTIONS), `request for ${request.sectionKey}`).toEqual([]);

      // And the payload block, parsed back out, so a name hidden in a field the greps above
      // happen to span cannot pass.
      expect(realNamesIn(JSON.stringify(payloadFromRequest(request)), REDACTIONS)).toEqual([]);
    }
  });

  it('carries the pseudonyms in their place, rather than deleting the sentence', async () => {
    const narrator = recordingNarrator(groundedNarrator());

    await narrateReport(reportNamingPeople(), {
      narrator,
      minimization: 'redacted',
      redactions: REDACTIONS,
    });

    const everything = narrator.requests.map((request) => request.user).join('\n');

    // The point of a pseudonym rather than a redaction bar: the model still has somebody to
    // write a sentence about, so the prose reads like prose.
    expect(everything).toContain('Wren Alder');
    expect(everything).toContain('Heron Basalt');
  });

  it('puts the real names back in the prose a manager reads', async () => {
    const result = await narrateReport(reportNamingPeople(), {
      narrator: groundedNarrator(),
      minimization: 'redacted',
      redactions: REDACTIONS,
    });

    expect(result.rendererId).toBe(NARRATED_RENDERER_ID);

    const prose = result.sections.map((section) => section.prose).join('\n');

    expect(prose).toContain(PRIYA);
    expect(prose).toContain(MARCUS);
    // The stand-ins do not survive to the page: a reader must not have to learn that
    // `Wren Alder` means their colleague.
    expect(prose).not.toContain('Wren Alder');
    expect(prose).not.toContain('Heron Basalt');
  });

  it('leaves tracker keys and identifiers untouched', async () => {
    const result = await narrateReport(reportNamingPeople(), {
      narrator: groundedNarrator(),
      minimization: 'redacted',
      redactions: REDACTIONS,
    });

    const prose = result.sections.map((section) => section.prose).join('\n');

    // The receipts are the whole reason the report is trustworthy. Redaction touches names,
    // and a tracker key that vanished with one would turn a withdrawal into a lost day.
    expect(prose).toContain('PLAT-742');
  });

  it('redacts a change clause and an alignment subject label, not only headlines', () => {
    // Asserted on the projection directly, because these are the fields a redaction written
    // against the obvious two would miss — and a recurring item carries its change clause on
    // every report it appears in, so the leak would be daily rather than once.
    const redacted = redactPayload(
      {
        context: {
          reportDate: '2026-07-31',
          scopeLabel: 'platform',
          timezone: 'Europe/London',
          windowStart: '2026-07-30 00:00',
          windowEnd: '2026-07-31 00:00',
          coverage: [],
        },
        sections: [
          {
            key: 'risks',
            index: 4,
            numeral: '04',
            title: 'Risks',
            summary: `${PRIYA} carries most of it`,
            emptyStatement: `Nothing for ${MARCUS} today.`,
            itemCount: 1,
            items: [
              {
                stableId: 'risk-1',
                headline: `${PRIYA} is the reviewer`,
                detail: 'The oldest is six days old.',
                changeTag: 'recurring',
                ageDays: 6,
                changeClause: `—— ${MARCUS} added as a reviewer, age unchanged`,
                evidenceLabels: ['#883'],
                ladder: null,
                alignment: {
                  kind: 'off_goal',
                  label: 'OFF-GOAL',
                  resolvedTier: 'inferred',
                  confidence: 1,
                  threshold: 0.3,
                  thresholdId: 'T17',
                  objectiveNodeId: 'OBJ-Q2-BILL',
                  objectiveTitle: `Unblock ${PRIYA}'s migration`,
                  question: `Whose work is ${MARCUS} doing?`,
                  subjectLabels: [PRIYA, 'PLAT-742'],
                },
              },
            ],
          },
        ],
      },
      REDACTIONS,
    );

    const everything = JSON.stringify(redacted);

    expect(realNamesIn(everything, REDACTIONS)).toEqual([]);
    // The stable id is untouched on purpose: it is the identity the feedback loop keys on, and
    // rewriting it would silently orphan every dismissal a manager has ever made.
    expect(redacted.sections[0]?.items[0]?.stableId).toBe('risk-1');
    expect(everything).toContain('#883');
    expect(everything).toContain('PLAT-742');
    expect(everything).toContain('OBJ-Q2-BILL');
  });

  it('grounds every section, because prose and payload are both pseudonymous', async () => {
    const report = reportNamingPeople();
    const redacted = redactPayload(narrationPayload(report), REDACTIONS);

    // The claim under test: grounding is evaluated against the *redacted* payload, so a
    // narration that restates it traces. Checked directly here as well as through
    // `narrateReport` above, because this is the property that would silently turn every
    // redacted report into a template fallback if the redaction were applied in the wrong place.
    for (const request of sectionRequests(redacted)) {
      const echoed = [
        request.section.summary ?? request.section.emptyStatement,
        ...request.section.items.map((item) => `${item.headline} ${item.detail}`),
      ].join('\n\n');

      const verdict = validateGrounding(echoed, request);
      expect(verdict.grounded, `${request.section.key}: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it('refuses to send, rather than warn, if a real name survives redaction', () => {
    // The leak assertion is what makes the promise a promise. Given a text the redaction did
    // not cover, it throws — and `narrateSection` turns that into a template-rendered report.
    expect(() => assertNoRealNames('the request', `${PRIYA} merged #883`, REDACTIONS)).toThrow(
      RealNameLeakError,
    );
  });

  it('does nothing at all when the map is empty, and says so by leaving the payload identical', () => {
    const payload = narrationPayload(reportNamingPeople());
    // An organization with no named developers has nothing to redact. Same object, not a copy:
    // the mode must not cost a deep clone per report to achieve nothing.
    expect(redactPayload(payload, [])).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// The substitution itself, at the edges that break in production
// ---------------------------------------------------------------------------

describe('the substitution', () => {
  it('replaces a partial first-name mention on the way out', () => {
    // A ticket title Compass did not compose — `Fix Priya's regex` — is exactly the hole a
    // full-name-only redaction leaves. Greedy on the way out is the safe direction.
    expect(redactText("Fix Priya's regex", REDACTIONS)).not.toContain('Priya');
  });

  it('does not restore a lone pseudonym word, so ordinary prose is never rewritten', () => {
    // Strict on the way back, deliberately. A greedy restore would have to guess whether
    // `Alder` is half a pseudonym or a repository, and guessing wrong prints a false
    // attribution in a manager's report.
    expect(restoreText('the Alder migration landed', REDACTIONS)).toBe('the Alder migration landed');
    expect(restoreText('Wren Alder merged it', REDACTIONS)).toBe(`${PRIYA} merged it`);
  });

  it('matches on word boundaries, so a name inside a longer word is left alone', () => {
    const overlapping: readonly NameRedaction[] = [{ realName: 'Ann', pseudonym: 'Tern Marl' }];
    expect(redactText('Announcement from Ann', overlapping)).toBe('Announcement from Tern Marl');
  });

  it('is case-insensitive, because a lower-cased name is still the name', () => {
    expect(redactText('priya raman merged it', REDACTIONS)).toBe('Wren Alder merged it');
  });
});

// ---------------------------------------------------------------------------
// Criterion: no-LLM mode makes zero calls and still produces six sections
// ---------------------------------------------------------------------------

describe('no-LLM mode', () => {
  it('makes zero requests, even with a working narrator in hand', async () => {
    const narrator = recordingNarrator(groundedNarrator());

    const result = await narrateReport(reportNamingPeople(), { narrator, minimization: 'none' });

    // Zero as a property of the control flow, not a number that happened to come out right:
    // the narrator was available and was never asked.
    expect(narrator.requests).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.rendererId).toBe(TEMPLATE_RENDERER_ID);
  });

  it('states on the report that nothing was sent to a model', async () => {
    const result = await narrateReport(reportNamingPeople(), {
      narrator: groundedNarrator(),
      minimization: 'none',
    });

    expect(result.fallback).not.toBeNull();
    expect(result.fallback?.reason).toContain('no part of it was sent to a language model');
  });

  it('still renders all six sections, in the fixed order', async () => {
    const result = await narrateReport(reportNamingPeople(), {
      narrator: groundedNarrator(),
      minimization: 'none',
    });

    expect(result.sections.map((section) => section.key)).toEqual([
      'yesterday',
      'progress',
      'blockers',
      'risks',
      'recommendations',
      'wins',
    ]);
    expect(result.sections.every((section) => section.prose.trim().length > 0)).toBe(true);
  });

  it('keeps the real names, because nothing left the machine to be redacted from', async () => {
    const result = await narrateReport(reportNamingPeople(), {
      narrator: groundedNarrator(),
      minimization: 'none',
      redactions: REDACTIONS,
    });

    expect(result.sections.map((section) => section.prose).join('\n')).toContain(PRIYA);
  });
});

// ---------------------------------------------------------------------------
// Criterion: all three modes produce a grounded six-section report
// ---------------------------------------------------------------------------

describe('all three modes produce a complete, grounded six-section report', () => {
  it.each(MINIMIZATION_MODES)('%s', async (mode) => {
    const result = await narrateReport(reportNamingPeople(), {
      narrator: groundedNarrator(),
      minimization: mode,
      redactions: REDACTIONS,
    });

    expect(result.sections).toHaveLength(6);
    expect(result.sections.every((section) => section.prose.trim().length > 0)).toBe(true);

    // `none` renders from the template and marks itself a fallback by design; the other two
    // must have survived the grounding validator, which is what `narrated` means.
    if (mode === 'none') {
      expect(result.rendererId).toBe(TEMPLATE_RENDERER_ID);
    } else {
      expect(result.rendererId).toBe(NARRATED_RENDERER_ID);
      expect(result.fallback).toBeNull();
    }

    // The rendered document is present in every mode: it is the masthead, the freshness line
    // and the fallback, and a mode that lost it would have nothing to show if narration failed.
    expect(result.rendered.sections).toHaveLength(6);
  });
});
