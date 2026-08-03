import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateStructuredReport, mergeTeamReports, type MergedReport, type StructuredReport } from '@compass/analysis';
import { addDaysInZone, formatCivilDate, startOfDayInZone, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import { NON_SEMANTIC_FIELDS, canonicalPrettyJson } from '@compass/pipeline';
import { SEED_NOW, SEED_ORGANIZATION_ID, SEED_TIMEZONE, buildSeedSnapshot } from '@compass/seed-snapshot';

/**
 * @compass/golden — the checked-in report fixtures, and the one place that writes them.
 *
 * ## What a golden fixture is for here
 *
 * Report quality on the seeded dataset is the acceptance bar for this product, and
 * quality is not a thing a unit test asserts. What a unit test can assert is that
 * *the report did not change*, and that is what makes a change to a detector, a
 * threshold or a phrasing visible: it arrives as a diff in a file a reviewer reads,
 * beside the code change that caused it. A threshold nudged from 2 days to 3 is one
 * line of code and forty lines of fixture, and the forty lines are the actual review.
 *
 * ## Why the whole sequence, and why ten days
 *
 * A single day cannot show continuity. Ten consecutive simulated days per team can:
 * an item that persists keeps one stable id across all ten files, an item that
 * resolves stops appearing, and the elapsed-fact machinery accrues visible age. The
 * fixtures are therefore the regression test for change-awareness as much as for any
 * individual detector — `tests/golden.test.ts` reads them back and asserts exactly
 * that.
 *
 * ## Determinism is a precondition, not a hope
 *
 * Every fixture is a pure function of `(team, instant)`: `buildSeedSnapshot` reads the
 * checked-in seed and takes its instant as a parameter, and `generateStructuredReport`
 * is the pure analysis core. Nothing here asks a clock for `now`. The serialisation
 * goes through `canonicalPrettyJson` with the same documented non-semantic allowlist
 * the determinism hash uses, so `runId` and `generatedAt` are excluded and a fixture
 * cannot churn on a value that carries no meaning.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** `fixtures/reports/<team>/<date>.json`, from the repository root. */
export const FIXTURE_ROOT = join(REPO_ROOT, 'fixtures', 'reports');

/**
 * The seeded teams, in the order `seed/MANIFEST.md` declares them.
 *
 * Listed rather than discovered, and deliberately: a team silently dropped from the
 * seed would otherwise silently drop its fixtures too, and the suite would go green
 * while covering less. `tests/golden.test.ts` cross-checks this list against the
 * snapshot, so a team added to the seed fails until its fixtures exist.
 */
export const GOLDEN_TEAM_KEYS = ['checkout', 'insights', 'platform'] as const;

export type GoldenTeamKey = (typeof GOLDEN_TEAM_KEYS)[number];

/** The merged cross-team report's own directory, beside the teams it merges. */
export const MERGED_DIRECTORY = 'merged';

/**
 * How many consecutive simulated days the suite covers. Ten is the acceptance bar's
 * floor and also the point at which the fourteen-day elapsed trail is more than half
 * populated, so the trail itself is under test rather than being all-false padding.
 */
export const GOLDEN_DAY_COUNT = 10;

/**
 * The report instant for one day of the sequence.
 *
 * `SEED_NOW` is the last day, and the sequence runs backwards from it, so day 10 is
 * the day the rest of the repository's fixtures and tests already describe. Each
 * instant is the seeded generation moment on its own civil day in the seed's zone —
 * not `SEED_NOW` minus N×24h, which would drift across a DST boundary and make the
 * civil date in the filename disagree with the instant inside the file.
 */
export function goldenInstantFor(dayOffset: number): Instant {
  const startOfLastDay = startOfDayInZone(SEED_NOW, SEED_TIMEZONE);
  const startOfThatDay = addDaysInZone(startOfLastDay, SEED_TIMEZONE, -(GOLDEN_DAY_COUNT - 1 - dayOffset));
  return (startOfThatDay + (SEED_NOW - startOfLastDay)) as Instant;
}

/** The window a daily report covers: the whole civil day before its instant. */
export function goldenWindowFor(instant: Instant): TimeWindow {
  const startOfToday = startOfDayInZone(instant, SEED_TIMEZONE);
  return timeWindow(addDaysInZone(startOfToday, SEED_TIMEZONE, -1), startOfToday);
}

export interface GoldenDay {
  /** 0-based position in the sequence; 9 is `SEED_NOW`'s day. */
  readonly dayOffset: number;
  readonly instant: Instant;
  readonly window: TimeWindow;
  /** `YYYY-MM-DD` in the seed's zone — the fixture's filename. */
  readonly reportDate: string;
}

/** The ten days, oldest first. A pure function of the seed's own constants. */
export function goldenDays(): readonly GoldenDay[] {
  return Array.from({ length: GOLDEN_DAY_COUNT }, (_unused, dayOffset) => {
    const instant = goldenInstantFor(dayOffset);
    return {
      dayOffset,
      instant,
      window: goldenWindowFor(instant),
      reportDate: formatCivilDate(instant, SEED_TIMEZONE),
    };
  });
}

/** One team's report for one day, from the seeded dataset. */
export function generateTeamReport(teamKey: string, day: GoldenDay): StructuredReport {
  return generateStructuredReport(
    buildSeedSnapshot({ scope: { kind: 'team', teamKey }, instant: day.instant, window: day.window }),
    day.instant,
  );
}

/** The merged cross-team report for one day, over every seeded team. */
export function generateMergedReport(day: GoldenDay): MergedReport {
  return mergeTeamReports({
    organizationId: SEED_ORGANIZATION_ID,
    instant: day.instant,
    timezone: SEED_TIMEZONE,
    window: day.window,
    teamReports: GOLDEN_TEAM_KEYS.map((teamKey) => ({ teamKey, report: generateTeamReport(teamKey, day) })),
  });
}

/**
 * The bytes a fixture holds.
 *
 * The non-semantic allowlist is applied here rather than at comparison time, so what
 * is checked in is already free of `runId` and `generatedAt`. A fixture that stored
 * them and a comparison that ignored them would put two rules in two places; storing
 * the canonical form means the file on disk *is* the thing being asserted.
 */
export const serializeFixture = (report: unknown): string =>
  canonicalPrettyJson(report, { exclude: NON_SEMANTIC_FIELDS });

export interface FixtureRef {
  /** Team key, or `merged`. */
  readonly scope: string;
  readonly reportDate: string;
  readonly path: string;
  readonly relativePath: string;
}

export function fixtureRef(scope: string, reportDate: string): FixtureRef {
  const path = join(FIXTURE_ROOT, scope, `${reportDate}.json`);
  return { scope, reportDate, path, relativePath: `fixtures/reports/${scope}/${reportDate}.json` };
}

/** Every fixture the suite expects to exist: each team's ten days, plus merged. */
export function expectedFixtures(): readonly FixtureRef[] {
  return goldenDays().flatMap((day) =>
    [...GOLDEN_TEAM_KEYS, MERGED_DIRECTORY].map((scope) => fixtureRef(scope, day.reportDate)),
  );
}

/** Regenerates one fixture's expected content without touching the disk. */
export function renderFixture(scope: string, day: GoldenDay): string {
  return serializeFixture(scope === MERGED_DIRECTORY ? generateMergedReport(day) : generateTeamReport(scope, day));
}

export const readFixture = (ref: FixtureRef): string => readFileSync(ref.path, 'utf8');

export interface WriteSummary {
  readonly written: number;
  readonly unchanged: number;
  readonly removed: readonly string[];
}

/**
 * Writes every fixture, and removes any that no longer belongs.
 *
 * The removal half is what keeps `golden:update` reviewable. Without it, changing the
 * seed's date range would leave the old days on disk for ever: the suite would keep
 * passing against them because nothing asserts the *absence* of a stale fixture, and
 * the directory would slowly become a record of every date range the project has ever
 * had. `expectedFixtures()` is the definition of what belongs, and anything else in
 * the tree goes — so a regeneration after a seed change shows up as deletions a
 * reviewer can see, not as accumulation nobody notices.
 *
 * A file whose bytes already match is left alone rather than rewritten, so `git
 * status` after a no-op update is genuinely clean.
 */
export function writeFixtures(): WriteSummary {
  const days = goldenDays();
  const expected = new Set(expectedFixtures().map((ref) => ref.path));

  let written = 0;
  let unchanged = 0;

  for (const scope of [...GOLDEN_TEAM_KEYS, MERGED_DIRECTORY]) {
    mkdirSync(join(FIXTURE_ROOT, scope), { recursive: true });

    for (const day of days) {
      const ref = fixtureRef(scope, day.reportDate);
      const content = renderFixture(scope, day);

      let existing: string | null = null;
      try {
        existing = readFileSync(ref.path, 'utf8');
      } catch {
        existing = null;
      }

      if (existing === content) {
        unchanged += 1;
        continue;
      }
      writeFileSync(ref.path, content, 'utf8');
      written += 1;
    }
  }

  const removed: string[] = [];
  for (const scope of readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const entry of readdirSync(join(FIXTURE_ROOT, scope.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(FIXTURE_ROOT, scope.name, entry.name);
      if (expected.has(path)) continue;
      rmSync(path);
      removed.push(`fixtures/reports/${scope.name}/${entry.name}`);
    }
  }

  return { written, unchanged, removed };
}

// ---------------------------------------------------------------------------
// The diff a failing golden test prints
// ---------------------------------------------------------------------------

export interface FieldDifference {
  /** A JSON path — `$.findings.blockers[0].headline`. */
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Every field that differs between a fixture and live output, as paths.
 *
 * Per-field rather than a text diff, because the acceptance criterion asks for a
 * *readable* failure and the two are not the same thing. A textual diff of a
 * two-thousand-line fixture reports that lines 412–460 changed; this reports
 * `$.findings.blockers[0].threshold.value: 2 → 3`, which names the decision that
 * moved. Both are derived from the same canonical bytes, so neither can disagree
 * with the file on disk.
 *
 * Capped, and the cap is stated in the message rather than silently applied: a
 * detector rewrite legitimately changes hundreds of fields, and printing all of them
 * buries the first one, which is the one worth reading.
 */
export function fieldDifferences(expected: string, actual: string, limit = 25): readonly FieldDifference[] {
  const left = parseOrNull(expected);
  const right = parseOrNull(actual);
  if (left === null || right === null) {
    return [{ path: '$', expected: describe(left), actual: describe(right) }];
  }

  const found: FieldDifference[] = [];
  walk(left, right, '$', found, limit);
  return found;
}

const parseOrNull = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

const describe = (value: unknown): string => (value === null ? '<unparseable>' : JSON.stringify(value).slice(0, 120));

function walk(left: unknown, right: unknown, path: string, found: FieldDifference[], limit: number): void {
  if (found.length >= limit) return;

  const leftIsObject = typeof left === 'object' && left !== null;
  const rightIsObject = typeof right === 'object' && right !== null;

  if (!leftIsObject || !rightIsObject) {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      found.push({ path, expected: describe(left), actual: describe(right) });
    }
    return;
  }

  if (Array.isArray(left) !== Array.isArray(right)) {
    found.push({ path, expected: describe(left), actual: describe(right) });
    return;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      // Reported as its own difference, and then the shared prefix is still walked:
      // "one more blocker" and "a different blocker" are different regressions, and a
      // length mismatch alone would hide which.
      found.push({ path: `${path}.length`, expected: String(left.length), actual: String(right.length) });
    }
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      walk(left[index], right[index], `${path}[${index}]`, found, limit);
    }
    return;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()) {
    walk(leftRecord[key], rightRecord[key], `${path}.${key}`, found, limit);
  }
}

/** The failure message `test:golden` prints. Names the file and the command to fix it. */
export function describeDifferences(ref: FixtureRef, differences: readonly FieldDifference[]): string {
  const lines = differences.map((difference) => `  ${difference.path}\n    fixture: ${difference.expected}\n    live:    ${difference.actual}`);
  const more = differences.length >= 25 ? '\n  …and possibly more; the first 25 are shown.' : '';

  return (
    `${ref.relativePath} no longer matches what the analysis core produces.\n` +
    `${differences.length} field(s) differ:\n${lines.join('\n')}${more}\n\n` +
    'If the change is intended, run `pnpm run golden:update` and review the diff it leaves — ' +
    'the fixture change *is* the review of the analysis change.'
  );
}
