import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_MERGED_ITEMS, MERGED_REPORT_WORD_BUDGET } from '@compass/analysis';
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
