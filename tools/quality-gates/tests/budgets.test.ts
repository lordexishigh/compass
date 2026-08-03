import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DAILY_REPORT_READING_BUDGET,
  DAILY_REPORT_WORD_BUDGET,
  MAX_MERGED_ITEMS,
  MERGED_REPORT_WORD_BUDGET,
  countWords,
  generateStructuredReport,
} from '@compass/analysis';
import { renderReport } from '@compass/renderers';
import { SEED_NOW, buildSeedSnapshot } from '@compass/seed-snapshot';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './helpers/workspace.js';

/**
 * The prose budget is one number, and the document quotes it.
 *
 * A number written in prose next to a number written in code is two sources of truth, and the one that
 * drifts is always the prose. `docs/budgets.md` is where the *reasoning* lives — two minutes at 200
 * words a minute, one thumb-scroll on a phone — and `packages/analysis/src/budgets.ts` is where the
 * value lives. This gate is what stops a future change to one leaving the other stating a limit Compass
 * does not enforce.
 */
const BUDGETS = readFileSync(join(REPO_ROOT, 'docs/budgets.md'), 'utf8');

describe('the merged report budget is documented as the number the code uses', () => {
  it('states the budget in the form the code can be compared against', () => {
    expect(BUDGETS).toContain(`**The budget is ${MERGED_REPORT_WORD_BUDGET}.**`);
  });

  it('names the constant and its module, so a reader can go and check', () => {
    expect(BUDGETS).toContain('MERGED_REPORT_WORD_BUDGET');
    expect(BUDGETS).toContain('packages/analysis/src/budgets.ts');
  });

  it('documents where the count runs, because on the payload it would mean nothing', () => {
    // The subtle way this requirement gets broken: counting the structured payload's headlines instead
    // of the rendered sentences. The doc says which, so a reviewer can hold the code to it.
    expect(BUDGETS).toContain('after rendering');
    expect(BUDGETS).toContain('assertWithinWordBudget');
  });

  it('documents that it fails closed rather than truncating', () => {
    expect(BUDGETS).toContain('WordBudgetExceededError');
    expect(BUDGETS.toLowerCase()).toContain('does not truncate');
  });

  it('names the knob to turn when the budget is exceeded', () => {
    // Not "raise the budget". The ranking is what should give.
    expect(BUDGETS).toContain('MAX_MERGED_ITEMS');
    expect(MAX_MERGED_ITEMS).toBeGreaterThan(0);
  });

  it('explains why the merged report is never narrated', () => {
    // The property the whole budget guarantee rests on: a model cannot be asked to respect a word
    // ceiling, so it is not asked to write this page at all.
    expect(BUDGETS).toContain('never narrated');
  });
});

/**
 * The daily report's ninety-second read, measured over the reference dataset.
 *
 * This is the budget with no runtime enforcer, and that is deliberate: `DAILY_REPORT_WORD_BUDGET`
 * (900) is the fail-closed ceiling a narrated report is discarded for, while this (450) is the length
 * the daily is *designed* to be. A design target has to be measured against something real or it is
 * an intention, so it is measured here, against the seeded organization — the same dataset the
 * product's acceptance bar is stated over.
 *
 * The number is read out of `docs/budgets.md` as well as imported from the constant, so a change to
 * one without the other fails rather than silently making the doc wrong.
 */
describe('the daily reading budget is documented, and the seeded reports fit it', () => {
  const TEAM_KEYS = ['platform', 'checkout', 'insights'] as const;

  /** The number the table states, parsed rather than restated. */
  const documentedReadingBudget = (): number => {
    const row = /\|\s*One team's daily report, ~90-second read\s*\|\s*(\d+) words\s*\|/.exec(BUDGETS);
    expect(row, "docs/budgets.md has no table row for the daily report's reading budget").not.toBeNull();
    return Number.parseInt(row?.[1] ?? '0', 10);
  };

  it('states the same number the constant holds', () => {
    expect(documentedReadingBudget()).toBe(DAILY_REPORT_READING_BUDGET);
    expect(BUDGETS).toContain('DAILY_REPORT_READING_BUDGET');
  });

  it('names this file as the owning test, so the doc says where the number is enforced', () => {
    expect(BUDGETS).toContain('tools/quality-gates/tests/budgets.test.ts');
  });

  it('keeps the two daily numbers distinct and correctly ordered', () => {
    // Collapsing them would either fail closed on a busy day (450 as a ceiling) or let the corpus
    // double before anything complained (900 as the target).
    expect(DAILY_REPORT_READING_BUDGET).toBeLessThan(DAILY_REPORT_WORD_BUDGET);
    expect(BUDGETS).toContain('900 words');
  });

  /**
   * `prose` and not `text`, which is what the document says the count covers.
   *
   * `text` carries the page's own furniture — the fixed `01`…`06` numerals and the section titles —
   * and those are not measurements of anything.
   */
  const seededWordCount = (teamKey: string): number =>
    countWords(
      renderReport(generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW)).prose,
    );

  /**
   * The measured ceiling, and why it is not 450.
   *
   * The seeded reports render between roughly 1,400 and 2,000 words today — three to four times the
   * ninety-second target and above even the 900-word fail-closed ceiling. That is a real gap between
   * what the product is designed to be and what it currently emits, and it is recorded here as a
   * number rather than resolved by moving the target, because raising a budget to whatever the code
   * happens to produce is precisely how a budget stops meaning anything. `docs/budgets.md` states the
   * gap in the same terms.
   *
   * What this constant buys in the meantime is a **ratchet**: the daily cannot get *longer* without a
   * deliberate edit here, so the drift that a design target exists to prevent is prevented, and the
   * remaining work is a stated product decision about what to cut rather than an unknown.
   *
   * Closing it is a change to `maxItemsPerSection` or `MAX_SENTENCES_PER_ITEM` — the same knob the
   * merged report turns — and it will move every golden fixture, which is the review.
   */
  const MEASURED_DAILY_CEILING = 2000;

  it.each(TEAM_KEYS)('renders %s no longer than the recorded ceiling', (teamKey) => {
    const counted = seededWordCount(teamKey);

    expect(
      counted,
      `${teamKey} renders ${counted} words. The recorded ceiling is ${MEASURED_DAILY_CEILING}; the daily may not get ` +
        'longer without a deliberate decision. If this is intended, shorten the report rather than raising the number.',
    ).toBeLessThanOrEqual(MEASURED_DAILY_CEILING);

    // And not vacuously small: a renderer that emitted nothing would also "fit".
    expect(counted, `${teamKey} rendered almost nothing, so this budget check proves nothing`).toBeGreaterThan(40);
  });

  it('records the gap between the target and what is rendered, so it cannot be forgotten', () => {
    /**
     * This test exists to *fail* the day the gap closes.
     *
     * If the daily ever fits 450 words, the ratchet above becomes the wrong shape — the target itself
     * should be the assertion — and this is what says so. A gap that is only described in prose is a
     * gap that stays open; a gap with a test attached is one somebody has to come back to.
     */
    const worst = Math.max(...TEAM_KEYS.map(seededWordCount));

    expect(worst, 'the daily now fits its reading budget — assert DAILY_REPORT_READING_BUDGET directly and delete the ratchet').toBeGreaterThan(
      DAILY_REPORT_READING_BUDGET,
    );
    expect(BUDGETS, 'docs/budgets.md must state the gap, not just the target').toContain('not yet met');
  });

  it('counts words the way the document says it does', () => {
    // Whitespace-separated tokens with no exclusions. `PLAT-742` is one word on the page.
    expect(countWords('PLAT-742 is blocked')).toBe(3);
    expect(countWords('  spaced   out  ')).toBe(2);
    expect(countWords('')).toBe(0);
    expect(BUDGETS).toContain('Whitespace-separated tokens');
  });
});
