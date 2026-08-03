import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DAILY_REPORT_READING_BUDGET,
  DAILY_REPORT_WORD_BUDGET,
  MERGED_REPORT_WORD_BUDGET,
  NARRATION_FALLBACK_ALERT_RATE,
} from '@compass/analysis';
import { REPORT_LCP_BUDGET_MILLIS, TIME_TRAVEL_BUDGET_MILLIS } from '@compass/perf-budget';
import { COLD_START_BUDGET_MILLIS } from '@compass/smoke';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './helpers/workspace.js';

/**
 * `docs/budgets.md` lists **every** budget as a single number with its owning test.
 *
 * The acceptance criterion is structural, so this gate is structural: it parses the table at the top of
 * the document, checks each row against the constant it names, and checks that the test it names exists
 * on disk. `budgets.test.ts` beside this one covers the *reasoning* prose and the word budgets against
 * the seeded corpus; this covers the table as a table.
 *
 * ## Why the owning-test column is enforced rather than decorative
 *
 * A budget with no test is a wish. The failure mode is specific and this repository has already seen a
 * near miss of it: numbers drift into whichever file happens to need them — a timeout here, a
 * threshold there — and the document that was supposed to be the single place a number appears becomes
 * a summary of some of them. Naming the owning test in the row, and failing when that file does not
 * exist, is what keeps "each budget has an enforcer" true rather than aspirational.
 *
 * ## Why the numbers are compared as strings from the table
 *
 * The row is what a human reads. Comparing the parsed cell against the imported constant is the only
 * check that catches the case that actually happens — the constant is changed, every test still
 * passes because they all import it, and the document quietly describes the old product.
 */

const BUDGETS = readFileSync(join(REPO_ROOT, 'docs/budgets.md'), 'utf8');

interface TableRow {
  readonly budget: string;
  readonly number: string;
  readonly constant: string;
  readonly owningTest: string;
}

/**
 * The rows of the first markdown table in the document.
 *
 * Deliberately strict about shape: four pipe-delimited cells, the header and the `---` separator
 * dropped. A row that does not parse is a row this gate cannot check, so a malformed table fails the
 * count assertion below rather than being silently skipped.
 */
function parseTable(): readonly TableRow[] {
  const rows: TableRow[] = [];

  for (const line of BUDGETS.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length !== 4) continue;
    // The header row and the alignment separator.
    if (cells[0] === 'Budget' || cells[0]?.startsWith('---')) continue;

    rows.push({
      budget: cells[0] ?? '',
      number: cells[1] ?? '',
      constant: cells[2] ?? '',
      owningTest: cells[3] ?? '',
    });
  }

  return rows;
}

const ROWS = parseTable();

/** Every budget the code declares, and the figure the table must state for it. */
const EXPECTED: readonly { readonly constant: string; readonly number: string }[] = [
  { constant: 'REPORT_LCP_BUDGET_MILLIS', number: `${REPORT_LCP_BUDGET_MILLIS} ms` },
  { constant: 'TIME_TRAVEL_BUDGET_MILLIS', number: `${TIME_TRAVEL_BUDGET_MILLIS} ms` },
  { constant: 'COLD_START_BUDGET_MILLIS', number: `${COLD_START_BUDGET_MILLIS} ms` },
  { constant: 'MERGED_REPORT_WORD_BUDGET', number: `${MERGED_REPORT_WORD_BUDGET} words` },
  { constant: 'DAILY_REPORT_WORD_BUDGET', number: `${DAILY_REPORT_WORD_BUDGET} words` },
  { constant: 'DAILY_REPORT_READING_BUDGET', number: `${DAILY_REPORT_READING_BUDGET} words` },
  { constant: 'NARRATION_FALLBACK_ALERT_RATE', number: NARRATION_FALLBACK_ALERT_RATE.toFixed(2) },
];

describe('the budgets table', () => {
  it('parses at all, so an unparseable table cannot pass this file', () => {
    expect(ROWS.length, 'no budget rows were found in docs/budgets.md').toBeGreaterThanOrEqual(EXPECTED.length);
  });

  it('has a row for every budget the code declares, and no budget with no row', () => {
    /**
     * Both directions. A constant with no row is a number that has escaped the document — the exact
     * drift this file exists to stop. A row naming a constant that no longer exists is the reverse: a
     * document describing a budget the product does not have.
     */
    const named = ROWS.map((row) => row.constant.replaceAll('`', ''));

    for (const entry of EXPECTED) {
      expect(named, `${entry.constant} is a declared budget with no row in docs/budgets.md`).toContain(entry.constant);
    }

    const declared = new Set(EXPECTED.map((entry) => entry.constant));
    const orphans = named.filter((constant) => !declared.has(constant));
    expect(orphans, 'these rows name a constant this gate does not know about').toEqual([]);
  });

  it.each(EXPECTED)('states $constant as $number', ({ constant, number }) => {
    const row = ROWS.find((candidate) => candidate.constant.replaceAll('`', '') === constant);
    expect(row, `no row names ${constant}`).toBeDefined();

    expect(
      row?.number,
      `docs/budgets.md states "${row?.number}" for ${constant}, but the code says "${number}"`,
    ).toBe(number);
  });

  it.each(EXPECTED)('names an owning test for $constant that exists on disk', ({ constant }) => {
    const row = ROWS.find((candidate) => candidate.constant.replaceAll('`', '') === constant);
    const cell = row?.owningTest ?? '';

    // The cell may carry a parenthetical — "(threshold)" — so every backticked path in it is checked.
    const paths = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    expect(paths.length, `${constant} names no owning test`).toBeGreaterThan(0);

    for (const path of paths) {
      expect(
        existsSync(join(REPO_ROOT, path)),
        `${constant}'s owning test \`${path}\` does not exist — a budget with no enforcer is a wish`,
      ).toBe(true);
    }
  });

  it('states each number exactly once in the table, so there is one place to change it', () => {
    // Two rows quoting the same constant would be two things to keep in step, which is the condition
    // the whole document exists to remove.
    const named = ROWS.map((row) => row.constant.replaceAll('`', ''));
    expect(named.length, 'a constant appears in more than one row').toBe(new Set(named).size);
  });

  it('says where each constant lives, so a reader can go and check', () => {
    for (const path of [
      'packages/analysis/src/budgets.ts',
      'tools/perf-budget/src/index.ts',
      'tools/smoke/src/probe.ts',
    ]) {
      expect(BUDGETS, `docs/budgets.md must name ${path}`).toContain(path);
      expect(existsSync(join(REPO_ROOT, path)), `${path} does not exist`).toBe(true);
    }
  });
});

describe('the performance budgets are documented with the profile that makes them meaningful', () => {
  it('names the throttling profile, because a figure without one is not comparable', () => {
    // "Under 2000 ms" on a developer's laptop and on a throttled phone are different claims, and only
    // one of them is the acceptance criterion.
    expect(BUDGETS).toContain('4x CPU');
    expect(BUDGETS).toContain('Slow 4G');
  });

  it('states that the run fails rather than skips when it cannot measure', () => {
    /**
     * The property that decides whether the whole performance gate is worth anything.
     *
     * A CI job that passes when no browser was available reports that the product is fast, on the
     * authority of something that did not look. The document says which behaviour was chosen so a
     * reviewer can hold the runner to it, and `tools/perf-budget/tests/budget.test.ts` asserts the
     * error exists.
     */
    expect(BUDGETS).toContain('fails');
    expect(BUDGETS.toLowerCase()).toContain('rather than skips');
  });

  it('states the honest-progress requirement for a slow regeneration', () => {
    // The acceptance criterion is "within 5000 ms **or** show honest progress rather than hanging".
    // The second half is the part a document has to carry, because no timing assertion can express it.
    expect(BUDGETS).toContain('honest progress rather than hanging');
  });

  it('records that stepping to an already-generated day is a read and not a regeneration', () => {
    // Otherwise the budget would be measured against the wrong operation, and the five-per-hour
    // regeneration allowance would be spent by a manager scrolling through the archive.
    expect(BUDGETS).toContain('reportAlreadyGenerated');
  });
});
