import {
  DAILY_REPORT_READING_BUDGET,
  DAILY_REPORT_WORD_BUDGET,
  MERGED_REPORT_WORD_BUDGET,
  NARRATION_FALLBACK_ALERT_RATE,
  WordBudgetExceededError,
  assertWithinWordBudget,
  countWords,
  narrationFallbackAlert,
} from '@compass/analysis';
import { describe, expect, it } from 'vitest';

/**
 * The budget arithmetic, and the relationships between the numbers.
 *
 * `docs/budgets.md` states each figure and `tools/quality-gates/tests/budgets.test.ts` holds the
 * document to the code. This file is the other half: it asserts the *behaviour* the figures drive, and
 * the orderings between them that make the set coherent rather than four unrelated constants.
 */

describe('the narration-fallback alert rate', () => {
  it('is one report in five', () => {
    expect(NARRATION_FALLBACK_ALERT_RATE).toBe(0.2);
  });

  it('does not alert on a day with no reports at all', () => {
    /**
     * The case that would otherwise be `NaN`.
     *
     * Zero reports generated is a real condition and it is a *different* one: the scheduler did not
     * run. Folding it into the fallback rate would page whoever is on call about narration when
     * narration was never reached, and `0/0` is exactly the arithmetic that does that silently.
     */
    expect(narrationFallbackAlert({ reportsGenerated: 0, reportsFellBack: 0 })).toEqual({
      rate: 0,
      alerting: false,
    });
    // Defensive: a nonsensical count must not become an alert either.
    expect(narrationFallbackAlert({ reportsGenerated: 0, reportsFellBack: 3 }).alerting).toBe(false);
  });

  it('does not alert on a single fallback in a normal day', () => {
    // One report in ten falling back is the expected event this whole mechanism exists to absorb.
    // If it paged anybody, the fallback would be a liability rather than a feature.
    const verdict = narrationFallbackAlert({ reportsGenerated: 10, reportsFellBack: 1 });

    expect(verdict.rate).toBeCloseTo(0.1, 10);
    expect(verdict.alerting).toBe(false);
  });

  it('treats exactly the documented rate as the ceiling rather than the first failure', () => {
    // 2 of 10 is 0.20 — the stated budget, not a breach of it.
    expect(narrationFallbackAlert({ reportsGenerated: 10, reportsFellBack: 2 })).toEqual({
      rate: 0.2,
      alerting: false,
    });

    // 3 of 10 is over.
    expect(narrationFallbackAlert({ reportsGenerated: 10, reportsFellBack: 3 }).alerting).toBe(true);
  });

  it('alerts when every report fell back, which is the outage this number exists to catch', () => {
    /**
     * The failure mode the rate is really for.
     *
     * A broken prompt or grounding rule takes out *every* report, and because the fallback works the
     * product keeps rendering. From outside it looks like a deployment that has quietly decided to be
     * templated, which is why "everything still renders" needs a number attached to it.
     */
    const verdict = narrationFallbackAlert({ reportsGenerated: 3, reportsFellBack: 3 });

    expect(verdict.rate).toBe(1);
    expect(verdict.alerting).toBe(true);
  });

  it('is a rate, so a three-team and a thirty-team deployment need no different threshold', () => {
    // The same proportion decides the same way at both scales — which is the argument for a rate over
    // a count, asserted rather than stated.
    const small = narrationFallbackAlert({ reportsGenerated: 3, reportsFellBack: 1 });
    const large = narrationFallbackAlert({ reportsGenerated: 30, reportsFellBack: 10 });

    expect(small.alerting).toBe(large.alerting);
    expect(small.rate).toBeCloseTo(large.rate, 10);
  });
});

describe('the word budgets and the orderings between them', () => {
  it('states the three figures the document quotes', () => {
    expect(MERGED_REPORT_WORD_BUDGET).toBe(400);
    expect(DAILY_REPORT_READING_BUDGET).toBe(450);
    expect(DAILY_REPORT_WORD_BUDGET).toBe(900);
  });

  it('puts the merged budget below the daily reading budget', () => {
    // The merged report is read *instead of* the per-team ones, so it has to be the shorter document.
    // If this ever inverted, the merged view would have stopped being a digest.
    expect(MERGED_REPORT_WORD_BUDGET).toBeLessThan(DAILY_REPORT_READING_BUDGET);
  });

  it('leaves the daily ceiling clear of the length the daily is designed to be', () => {
    /**
     * Headroom, asserted as a relationship rather than as two independent numbers.
     *
     * If the fail-closed ceiling ever crept down towards the design target, a legitimately busy day
     * would start being refused and the manager would get a templated report for no reason. Doubling
     * is the documented margin.
     */
    expect(DAILY_REPORT_WORD_BUDGET).toBeGreaterThanOrEqual(DAILY_REPORT_READING_BUDGET * 2);
  });
});

describe('counting words the way a reader would', () => {
  it('counts whitespace-separated tokens with no exclusions', () => {
    // `01`, `PLAT-742` and `#9201` are each a word on the page, so each is a word here. Any rule that
    // discounted them would make the enforced budget larger than the one a reader experiences.
    expect(countWords('01 PLAT-742 blocked on #9201')).toBe(5);
  });

  it('is zero for nothing, and unbothered by surrounding or repeated whitespace', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('  two   words  ')).toBe(2);
    expect(countWords('across\na line\tbreak')).toBe(4);
  });
});

describe('the merged budget fails closed rather than truncating', () => {
  it('permits prose exactly at the budget', () => {
    const exactly = Array.from({ length: MERGED_REPORT_WORD_BUDGET }, (_, index) => `w${index}`).join(' ');

    expect(countWords(exactly)).toBe(MERGED_REPORT_WORD_BUDGET);
    expect(() => assertWithinWordBudget(exactly, MERGED_REPORT_WORD_BUDGET, 'merged report')).not.toThrow();
  });

  it('throws on the word after it, naming the label, the count and the budget', () => {
    const oneTooMany = Array.from({ length: MERGED_REPORT_WORD_BUDGET + 1 }, (_, index) => `w${index}`).join(' ');

    let thrown: unknown;
    try {
      assertWithinWordBudget(oneTooMany, MERGED_REPORT_WORD_BUDGET, 'merged cross-team report');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WordBudgetExceededError);
    const error = thrown as WordBudgetExceededError;
    expect(error.counted).toBe(MERGED_REPORT_WORD_BUDGET + 1);
    expect(error.budget).toBe(MERGED_REPORT_WORD_BUDGET);
    // The message has to say what to do about it, and the answer is never "raise the budget".
    expect(error.detail).toContain('merged cross-team report');
    expect(error.detail).toContain('per-team report');
  });

  it('does not truncate — the prose it was handed is unchanged', () => {
    // Stated as a property of the function: it returns nothing and mutates nothing, so there is no
    // path by which a report could come back shortened and look fine.
    const prose = Array.from({ length: 10 }, (_, index) => `w${index}`).join(' ');
    const before = prose;

    expect(assertWithinWordBudget(prose, 10, 'probe')).toBeUndefined();
    expect(prose).toBe(before);
  });
});
