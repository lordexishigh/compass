import { writeFixtures } from './index.js';

/**
 * `pnpm run golden:update` — regenerate every fixture.
 *
 * Deliberately the smallest possible program. It takes no flags, no date range and no
 * team filter, because every one of those would be a way to regenerate *part* of the
 * suite and leave the rest describing an older analysis core. A golden suite that can
 * be half-updated is a golden suite whose failures nobody trusts.
 *
 * What it prints is what a reviewer needs before reading the diff: how many files
 * changed, how many did not, and anything it removed. It does not print the diff
 * itself — `git diff` does that better, and the whole design of the fixture format is
 * to make that diff readable.
 */
const summary = writeFixtures();

const lines = [
  `golden fixtures: ${summary.written} written, ${summary.unchanged} already current.`,
  ...(summary.removed.length === 0
    ? []
    : [`removed ${summary.removed.length} fixture(s) no longer in the sequence:`, ...summary.removed.map((path) => `  ${path}`)]),
  summary.written === 0 && summary.removed.length === 0
    ? 'Nothing changed, so there is nothing to review.'
    : 'Review the change with `git diff -- fixtures/` before committing: the fixture diff is the review of the analysis change that caused it.',
];

// The one place in this package that writes to a terminal. `no-console` allows `info`.
console.info(lines.join('\n'));
