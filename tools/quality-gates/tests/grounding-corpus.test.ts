import { addDays, generateStructuredReport, type StructuredReport } from '@compass/analysis';
import {
  describeVerdict,
  narrationPayload,
  narrateReport,
  sectionRequests,
  validateGrounding,
} from '@compass/narrator';
import { FABRICATED_TOKENS, fabricatingNarrator, groundedNarrator } from '@compass/narrator/testkit';
import { describe, expect, it } from 'vitest';

/**
 * The grounding gate: the whole seeded corpus, every section, zero untraceable
 * tokens.
 *
 * The corpus is the real generated dataset — the same one the analysis core's tests
 * run against — projected into reports at several instants. That matters because the
 * seed plants the hard cases on purpose: the review bottleneck, the blocked-then-
 * merged ticket, the Kanban team with no story points, the OFF-GOAL commit, the
 * unattributed commits phrased as a question. A gate that ran over a hand-built
 * fixture would pass while avoiding every one of them.
 *
 * ## What this gate actually proves
 *
 * It proves the **validator** over real data, in both directions:
 *
 *  - a narrator that only restates the payload is accepted across the entire corpus,
 *    so the extractor does not over-match. This is the direction that matters most
 *    in CI, because an over-matching extractor would put every report on the fallback
 *    path and *nothing else would fail* — narration would silently switch itself off
 *    and the only symptom would be plainer prose.
 *  - a narrator that fabricates is rejected on every section of every report, so the
 *    extractor does not under-match.
 *
 * It deliberately does **not** call the Anthropic API. Prose is allowed to vary run
 * to run, so asserting on a real model's output would either be flaky or would
 * assert nothing; `docs/PROJECT.md` states the rule this follows — determinism is
 * defined over the structured report, and grounding is what constrains the prose.
 *
 * ## Why the template renderer's prose is not the corpus
 *
 * The deterministic renderer composes interpretation clauses that *derive* figures —
 * "Compass read 3 of 4 configured sources" is a count of the coverage list, not a
 * field in it. Those derivations are legitimate for a renderer whose arithmetic is
 * auditable and wrong for a model that was told to quote only, so grounding the
 * template renderer's output against a narration payload would report false
 * failures. The rule this gate enforces is narration's rule.
 */

const SEED = await import('../../../packages/analysis/tests/helpers/seed-snapshot.js');

/**
 * Several instants, not one.
 *
 * A single report exercises one shape of the data. Stepping `now` back across the
 * seeded history moves the current sprint, empties and refills sections, and changes
 * which ladder rungs are reachable — which is how a corpus of six sections becomes a
 * corpus of dozens.
 */
const OFFSETS: readonly number[] = [0, -1, -3, -7, -14, -21, -35];

interface CorpusReport {
  readonly label: string;
  readonly report: StructuredReport;
}

function corpus(): readonly CorpusReport[] {
  const snapshot = SEED.buildSeedSnapshot();

  return OFFSETS.flatMap((offset) => {
    const instant = addDays(SEED.SEED_NOW, offset);
    try {
      return [
        {
          label: `seed ${offset === 0 ? 'today' : `${offset}d`}`,
          report: generateStructuredReport(snapshot, instant),
        },
      ];
    } catch {
      // An instant before the dataset begins has nothing to report on. Skipping it
      // is correct; swallowing a failure at an instant inside the window would not
      // be, and `has a corpus worth gating` below is what catches an empty result.
      return [];
    }
  });
}

const available = SEED.seedIsAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  // Loud rather than silent: a gate that quietly passes because its corpus is
  // missing is worse than one that fails, and `pnpm seed:generate` is the fix.
  console.warn(
    'seed/generated is absent, so the grounding corpus gate is skipped. Run `pnpm seed:generate` to enable it.',
  );
}

suite('the grounding corpus', () => {
  const reports = corpus();

  it('has a corpus worth gating', () => {
    expect(reports.length, 'no report could be generated from the seed').toBeGreaterThanOrEqual(3);
  });

  it('covers every one of the six sections at least once with items', () => {
    const withItems = new Set<string>();
    for (const entry of reports) {
      for (const section of entry.report.sections) {
        if (section.items.length > 0) withItems.add(section.key);
      }
    }

    expect([...withItems].sort()).toEqual([
      'blockers',
      'progress',
      'recommendations',
      'risks',
      'wins',
      'yesterday',
    ]);
  });

  /**
   * The headline assertion: zero untraceable tokens over the whole corpus.
   *
   * One test rather than one per section, because the criterion is about the corpus
   * as a whole and a failure needs to name every token across it — a per-section
   * test would stop at the first and hide the rest behind another CI run.
   *
   * ## Why the word-budget fallback is tolerated and the grounding one is not
   *
   * `narrateReport` replaces `sections` with the *template* renderer's prose on any fallback, so a
   * report that fell back cannot have its `result.sections` validated against a narration payload —
   * the template renderer derives figures ("Compass read 3 of 4 configured sources") that are
   * legitimately absent from the payload, exactly as this file's own header explains. Validating
   * them anyway reports failures that say nothing about narration.
   *
   * The seeded corpus renders 1,400–2,000 words and is over `DAILY_REPORT_WORD_BUDGET` (900), which
   * `docs/budgets.md` states as an open gap. So the verbose stub trips the ceiling on the larger
   * instants and the whole report falls back for a reason that is **not** a grounding failure. This
   * gate is about the validator, so it fails on a `grounding` cause and records a `word-budget` one
   * as the documented condition it is — which is precisely the distinction
   * `NarrationFallbackCause` was added to make expressible. Before it, `outcome` was `rejected` for
   * both and the two were indistinguishable here.
   *
   * The sections of a word-budget fallback are still *narrated* prose up to the point the ceiling
   * was hit, so they are validated per section from the attempt itself rather than skipped: the
   * assertion keeps its coverage instead of quietly dropping the biggest reports.
   */
  it('reports zero untraceable tokens across every section of every report', async () => {
    const failures: string[] = [];
    const wordBudgetFallbacks: string[] = [];
    let sectionsChecked = 0;

    for (const entry of reports) {
      const requests = sectionRequests(narrationPayload(entry.report));
      const result = await narrateReport(entry.report, { narrator: groundedNarrator() });

      /**
       * Validate what the narrator actually said, not what survived the report-level ceiling.
       *
       * Each section is narrated independently through the same stub `narrateReport` used, so this
       * is the prose grounding was applied to — and it is available whether or not the report as a
       * whole was later published.
       */
      for (const request of requests) {
        const response = await groundedNarrator().narrate({
          model: 'fake-grounded-1',
          system: '',
          user: `<untrusted-report-data>${JSON.stringify({ section: request.section })}</untrusted-report-data>`,
          maxOutputTokens: 1024,
          sectionKey: request.section.key,
          attempt: 1,
        });

        sectionsChecked += 1;
        const verdict = validateGrounding(response.prose, request);
        if (!verdict.grounded) {
          failures.push(`${entry.label}/${request.section.key}: ${describeVerdict(verdict)}`);
        }
      }

      // A fallback for any reason *other* than the documented word-budget gap means narration
      // switched itself off, which is the silent failure this gate exists to catch.
      if (result.fallback !== null && result.fallback.cause !== 'not-configured') {
        if (result.fallback.cause === 'word-budget') wordBudgetFallbacks.push(entry.label);
        else failures.push(`${entry.label}: fell back (${result.fallback.cause}) — ${result.fallback.reason}`);
      }
    }

    expect(sectionsChecked, 'no section was checked').toBeGreaterThanOrEqual(reports.length * 6);
    expect(failures.join('\n')).toBe('');

    // Not silently tolerated: the gap is printed so it cannot be forgotten, and the day the daily
    // fits its ceiling this list empties on its own with no test to update.
    if (wordBudgetFallbacks.length > 0) {
      console.warn(
        `${wordBudgetFallbacks.length} of ${reports.length} seeded reports exceed DAILY_REPORT_WORD_BUDGET and fell ` +
          `back to the template renderer: ${wordBudgetFallbacks.join(', ')}. This is the open gap documented in ` +
          'docs/budgets.md § the ninety-second read, not a grounding failure.',
      );
    }
  });

  it('rejects a fabricating narrator on every report in the corpus', async () => {
    for (const entry of reports) {
      const result = await narrateReport(entry.report, { narrator: fabricatingNarrator() });

      expect(result.fallback, `${entry.label} accepted a fabricated narration`).not.toBeNull();
      expect(result.rendererId).toBe('template');

      const everything = result.sections.map((section) => section.prose).join('\n');
      for (const fabricated of FABRICATED_TOKENS) {
        expect(everything, `${entry.label} leaked \`${fabricated}\``).not.toContain(fabricated);
      }
    }
  });

  it('sends no raw ingested text for any report in the corpus', () => {
    for (const entry of reports) {
      for (const request of sectionRequests(narrationPayload(entry.report))) {
        const serialised = JSON.stringify(request);
        for (const field of ['searchedText', 'comparedTextA', 'comparedTextB', 'commitMessage']) {
          expect(serialised, `${entry.label} would send \`${field}\``).not.toContain(`"${field}"`);
        }
      }
    }
  });
});
