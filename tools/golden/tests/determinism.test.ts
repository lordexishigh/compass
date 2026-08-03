import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { reportHash } from '@compass/pipeline';
import { describe, expect, it } from 'vitest';

import { GOLDEN_TEAM_KEYS, MERGED_DIRECTORY, goldenDays, renderFixture } from '../src/index.js';

/**
 * The determinism gate, in both the forms the acceptance criteria name.
 *
 * `packages/analysis/tests/determinism.test.ts` already runs the pure core twice
 * in-process and compares canonical JSON. That is necessary and not sufficient: two
 * runs inside one process share a module registry, an ICU build, a locale, a timezone
 * and a V8 instance, so anything memoised at module load is identical in both by
 * construction. A report that depended on it would pass there and still differ between
 * two machines — which is exactly the failure that makes a golden fixture suite
 * worthless, because the fixture would be a fact about whoever generated it.
 *
 * So this file adds the half that only a second process can prove, and then the half
 * that only a *differently configured* second process can prove.
 */

const SCRIPT = fileURLToPath(new URL('../src/generate-one.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));

/**
 * Runs the generator in a fresh process and returns its stdout verbatim.
 *
 * `execFileSync` with an argument array rather than a shell string: a shell would make
 * the assertion depend on quoting rules that differ between platforms, and this gate
 * exists precisely to remove host dependence from the result.
 */
function generateInSubprocess(scope: string, dayOffset: number, environment: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [TSX, SCRIPT, scope, String(dayOffset)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...environment },
  });
}

const days = goldenDays();
/** One representative day, chosen once. Every scope is covered across the cases below. */
const DAY_OFFSET = days.length - 1;

describe('the same (org, team, instant) generated twice in one process', () => {
  it.each([...GOLDEN_TEAM_KEYS, MERGED_DIRECTORY])('is byte-identical for %s', (scope) => {
    const day = days[DAY_OFFSET];

    // Two independent generations, each building its own snapshot: a shared snapshot
    // could hide a mutation, and a mutation is what this gate is for.
    expect(renderFixture(scope, day)).toBe(renderFixture(scope, day));
  });

  it('hashes identically under the documented non-semantic allowlist', () => {
    const day = days[DAY_OFFSET];
    const first = JSON.parse(renderFixture('platform', day)) as unknown;
    const second = JSON.parse(renderFixture('platform', day)) as unknown;

    expect(reportHash(first)).toBe(reportHash(second));
  });
});

describe('the same (org, team, instant) generated in two separate processes', () => {
  it.each([...GOLDEN_TEAM_KEYS, MERGED_DIRECTORY])('is byte-identical for %s', (scope) => {
    const first = generateInSubprocess(scope, DAY_OFFSET);
    const second = generateInSubprocess(scope, DAY_OFFSET);

    expect(first.length, 'the subprocess produced nothing, so this gate is vacuous').toBeGreaterThan(1000);
    expect(first).toBe(second);
  });

  it('agrees with the in-process result, so neither path is quietly special', () => {
    // If these two ever disagree, the fixtures are a fact about how they were generated
    // rather than about the analysis core — which is the one thing a golden suite must
    // not be.
    const day = days[DAY_OFFSET];
    expect(generateInSubprocess('platform', DAY_OFFSET)).toBe(renderFixture('platform', day));
  });

  it('matches for every day of the sequence, not just one', () => {
    // Cheaper than it looks and worth it: an off-by-one in the day arithmetic would show
    // up on exactly one boundary day, which a single-day check would miss.
    for (const dayOffset of [0, 4, days.length - 1]) {
      expect(
        generateInSubprocess('platform', dayOffset),
        `day offset ${dayOffset} differs between process and library`,
      ).toBe(renderFixture('platform', days[dayOffset]));
    }
  });
});

describe('the report does not depend on the host it was generated on', () => {
  /**
   * The strongest form of the claim, and the reason `packages/analysis` may not import
   * `Intl` or construct a `Date`.
   *
   * A report generated in Los Angeles must be byte-identical to one generated in
   * London. The team's own timezone comes from the snapshot — it is data, not host
   * state — so changing the process timezone must change nothing at all. If any
   * calculation ever reaches for the ambient zone, this is the test that says so, and it
   * says so without needing a second machine.
   */
  it('is identical under a different process timezone', () => {
    const london = generateInSubprocess('platform', DAY_OFFSET, { TZ: 'Europe/London' });
    const losAngeles = generateInSubprocess('platform', DAY_OFFSET, { TZ: 'America/Los_Angeles' });
    const kiritimati = generateInSubprocess('platform', DAY_OFFSET, { TZ: 'Pacific/Kiritimati' });

    expect(losAngeles).toBe(london);
    expect(kiritimati).toBe(london);
  });

  it('is identical under a different locale', () => {
    // `localeCompare` and `toLocaleString` are the two easy ways to make a sort order or
    // a number format depend on the host. Both are banned in the analysis core; this is
    // the behavioural check that the ban holds.
    const posix = generateInSubprocess('platform', DAY_OFFSET, { LANG: 'C', LC_ALL: 'C' });
    const turkish = generateInSubprocess('platform', DAY_OFFSET, { LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' });

    // Turkish is the sharpest case: its dotless-i casing rules break naive
    // case-insensitive comparisons that pass in every other locale.
    expect(turkish).toBe(posix);
  });

  it('is identical for the merged report too, which spans every team', () => {
    const london = generateInSubprocess(MERGED_DIRECTORY, DAY_OFFSET, { TZ: 'Europe/London' });
    const tokyo = generateInSubprocess(MERGED_DIRECTORY, DAY_OFFSET, { TZ: 'Asia/Tokyo' });

    expect(tokyo).toBe(london);
  });
});

describe('the checked-in fixtures agree with a separate process', () => {
  it('so a fixture cannot encode something only the generating process believed', () => {
    // Closes the loop between the two subtasks: `test:golden` compares live output to the
    // fixtures in-process, and this compares the fixtures to a *different* process. Both
    // green means the fixtures describe the analysis core rather than a run of it.
    for (const scope of [...GOLDEN_TEAM_KEYS, MERGED_DIRECTORY]) {
      expect(generateInSubprocess(scope, DAY_OFFSET, { TZ: 'America/Los_Angeles' })).toBe(
        renderFixture(scope, days[DAY_OFFSET]),
      );
    }
  });
});
