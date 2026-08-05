import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  GOLDEN_DAY_COUNT,
  GOLDEN_TEAM_KEYS,
  MERGED_DIRECTORY,
  describeDifferences,
  expectedFixtures,
  fieldDifferences,
  fixtureRef,
  generateTeamReport,
  goldenDays,
  readFixture,
  renderFixture,
  serializeFixture,
} from '../src/index.js';

/**
 * The golden diff.
 *
 * Report quality on the seeded dataset is this product's acceptance bar, and quality
 * is not a thing a test can assert directly. What a test *can* assert is that the
 * report did not change — so a change to a detector, a threshold or a phrasing arrives
 * as a diff in a checked-in file, beside the code change that caused it, and a
 * reviewer reads both together.
 *
 * Three separate claims live here and they fail for different reasons:
 *
 *  1. **The fixtures exist**, for ten consecutive days per team plus the merged view.
 *  2. **Live output still matches them**, field by field, with a failure that names
 *     the path that moved rather than a line number.
 *  3. **The sequence is continuous** — the thing a single day's fixture cannot show:
 *     one stable id per persistent item across all ten days.
 */

const days = goldenDays();

describe('the fixture sequence covers what the acceptance bar asks for', () => {
  it('runs ten consecutive simulated days, with no gap and no repeat', () => {
    expect(days).toHaveLength(GOLDEN_DAY_COUNT);

    const dates = days.map((day) => day.reportDate);
    expect(new Set(dates).size, 'a repeated date would overwrite a fixture').toBe(dates.length);
    expect([...dates].sort(), 'the sequence must already be in date order').toEqual(dates);

    // Consecutive civil days: each date is the next calendar day, which is what makes
    // "10 consecutive days" true rather than "10 days".
    for (let index = 1; index < dates.length; index += 1) {
      const previous = Date.parse(`${dates[index - 1]}T00:00:00Z`);
      const current = Date.parse(`${dates[index]}T00:00:00Z`);
      expect(current - previous, `${dates[index - 1]} → ${dates[index]} is not one day`).toBe(86_400_000);
    }
  });

  it('covers every seeded team plus the merged report', () => {
    expect([...GOLDEN_TEAM_KEYS]).toEqual(['checkout', 'insights', 'platform']);
    expect(expectedFixtures()).toHaveLength(GOLDEN_DAY_COUNT * (GOLDEN_TEAM_KEYS.length + 1));
  });

  it('derives each day instant from the civil day, so a filename cannot disagree with its contents', () => {
    // Not `SEED_NOW - N×24h`: that drifts across a DST boundary and would put a report
    // dated the 26th inside the file named for the 27th.
    for (const day of days) {
      const report = generateTeamReport('platform', day);
      expect(report.instant).toBe(day.instant);
      expect(report.window.end - report.window.start).toBe(86_400_000);
    }
  });

  it('has a fixture on disk for every day of every scope', () => {
    const missing = expectedFixtures()
      .filter((ref) => !existsSync(ref.path))
      .map((ref) => ref.relativePath);

    expect(
      missing,
      'these fixtures do not exist. Run `pnpm run golden:update` to create them, then review the diff.',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The diff itself
// ---------------------------------------------------------------------------

describe('live output still matches the fixtures', () => {
  const cases = days.flatMap((day) =>
    [...GOLDEN_TEAM_KEYS, MERGED_DIRECTORY].map((scope) => ({ scope, day, label: `${scope}/${day.reportDate}` })),
  );

  it.each(cases)('$label', ({ scope, day }) => {
    const ref = fixtureRef(scope, day.reportDate);
    if (!existsSync(ref.path)) {
      // The existence check above is the one that reports this properly; failing here
      // as well would bury it in thirty duplicate messages.
      expect.fail(`${ref.relativePath} is missing — run \`pnpm run golden:update\`.`);
    }

    const expectedBytes = readFixture(ref);
    const actualBytes = renderFixture(scope, day);

    if (expectedBytes === actualBytes) return;

    const differences = fieldDifferences(expectedBytes, actualBytes);
    expect.fail(describeDifferences(ref, differences));
  });
});

describe('the failure a golden regression produces is readable', () => {
  it('names the field that moved, not the line that changed', () => {
    // The criterion asks for a *readable per-field* diff, so the diff engine is tested
    // directly rather than being trusted because the suite is green.
    const differences = fieldDifferences(
      serializeFixture({ findings: { blockers: [{ headline: 'A', threshold: { value: 2 } }] } }),
      serializeFixture({ findings: { blockers: [{ headline: 'A', threshold: { value: 3 } }] } }),
    );

    expect(differences).toEqual([
      { path: '$.findings.blockers[0].threshold.value', expected: '2', actual: '3' },
    ]);
  });

  it('reports a changed item count as its own difference, and still walks the shared prefix', () => {
    const differences = fieldDifferences(
      serializeFixture({ items: [{ id: 'a' }] }),
      serializeFixture({ items: [{ id: 'b' }, { id: 'c' }] }),
    );

    expect(differences.map((difference) => difference.path)).toEqual(['$.items.length', '$.items[0].id']);
  });

  it('tells the reader which command fixes an intended change', () => {
    const message = describeDifferences(fixtureRef('platform', days[0].reportDate), [
      { path: '$.x', expected: '1', actual: '2' },
    ]);

    expect(message).toContain('fixtures/reports/platform/');
    expect(message).toContain('golden:update');
    expect(message).toContain('$.x');
  });

  /**
   * The case that used to crash the reporter instead of reporting.
   *
   * `JSON.stringify(undefined)` returns `undefined` rather than a string, so describing a
   * key that exists on only one side threw. Every other test in this file changes a value
   * in place, which is why a gate that could not describe an added or removed field stayed
   * green — the crash only appeared when a real fixture change added one.
   */
  it('names a field that appeared, rather than throwing on it', () => {
    const differences = fieldDifferences(
      serializeFixture({ projection: { reason: 'insufficient_history' } }),
      serializeFixture({ projection: { reason: 'insufficient_history', band: { spanDays: 4 } } }),
    );

    expect(differences.map((difference) => difference.path)).toContain('$.projection.band');
    expect(differences.find((difference) => difference.path === '$.projection.band')).toMatchObject({
      expected: '<absent>',
      actual: '{"spanDays":4}',
    });
  });

  it('names a field that went away, from the other side', () => {
    const differences = fieldDifferences(
      serializeFixture({ projection: { detail: 'needs 2 completed sprints' } }),
      serializeFixture({ projection: {} }),
    );

    expect(differences).toEqual([
      { path: '$.projection.detail', expected: '"needs 2 completed sprints"', actual: '<absent>' },
    ]);
  });

  it('renders a real JSON null as null, not as unparseable bytes', () => {
    // `<unparseable>` belongs to `$` alone. Using it for a nested null sent a reader
    // looking for corrupt bytes over a field that was legitimately null.
    const differences = fieldDifferences(
      serializeFixture({ objectiveEffectiveUntil: null }),
      serializeFixture({ objectiveEffectiveUntil: 1_784_710_800_000 }),
    );

    expect(differences).toEqual([
      { path: '$.objectiveEffectiveUntil', expected: 'null', actual: '1784710800000' },
    ]);
  });

  it('does not silently print an unbounded diff', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_unused, index) => [`f${index}`, index]));
    const changed = Object.fromEntries(Array.from({ length: 60 }, (_unused, index) => [`f${index}`, index + 1]));

    const differences = fieldDifferences(serializeFixture(many), serializeFixture(changed));
    expect(differences).toHaveLength(25);
    expect(describeDifferences(fixtureRef('platform', days[0].reportDate), differences)).toContain('possibly more');
  });
});

// ---------------------------------------------------------------------------
// What ten days buys that one day cannot
// ---------------------------------------------------------------------------

describe('stable item identity across the ten-day sequence', () => {
  /** Every item id in a stored fixture, by section, read back off disk. */
  const idsByDay = (teamKey: string): readonly { readonly date: string; readonly ids: ReadonlySet<string> }[] =>
    days.map((day) => {
      const stored = JSON.parse(readFixture(fixtureRef(teamKey, day.reportDate))) as {
        readonly sections: readonly { readonly items: readonly { readonly stableId: string }[] }[];
      };
      return {
        date: day.reportDate,
        ids: new Set(stored.sections.flatMap((section) => section.items.map((item) => item.stableId))),
      };
    });

  it.each([...GOLDEN_TEAM_KEYS])('%s keeps one id per item that persists across days', (teamKey) => {
    const sequence = idsByDay(teamKey);

    /**
     * The claim, stated precisely.
     *
     * An id that appears on two days must be *the same id*, which is trivially true of
     * a set — so what is actually asserted is that ids recur at all. If identity were
     * derived from run time or insertion order rather than from source identity, every
     * day would mint fresh ids and the intersection between consecutive days would be
     * empty. That is the regression this catches, and it is exactly the one the scout's
     * brief warned would silently bake a bug into the fixtures.
     */
    const overlaps = sequence
      .slice(1)
      .map((today, index) => [...today.ids].filter((id) => sequence[index].ids.has(id)).length);

    expect(
      overlaps.some((count) => count > 0),
      `${teamKey} shares no item id between any two consecutive days, so identity is not derived from the item`,
    ).toBe(true);
  });

  it.each([...GOLDEN_TEAM_KEYS])('%s derives every id from the documented scheme, on every day', (teamKey) => {
    for (const { date, ids } of idsByDay(teamKey)) {
      for (const id of ids) {
        expect(id, `${teamKey}/${date} holds an id that is not from the derivation`).toMatch(/^v1:[0-9a-f]{16}$/);
      }
    }
  });

  it('gives the merged report ids that exist in the per-team report they came from', () => {
    // The merged view links down into the team report that holds the evidence, so a
    // merged id that no team report carries would be a dead link.
    for (const day of days) {
      const merged = JSON.parse(readFixture(fixtureRef(MERGED_DIRECTORY, day.reportDate))) as {
        readonly items: readonly { readonly stableId: string; readonly teamKey: string }[];
      };

      // Keyed on `string`, not on the literal union: `item.teamKey` comes out of a
      // parsed fixture, so it is whatever the file says. Narrowing the map's key type
      // would only move the mismatch to a cast.
      const teamIds = new Map<string, ReadonlySet<string>>(
        GOLDEN_TEAM_KEYS.map((teamKey) => {
          const stored = JSON.parse(readFixture(fixtureRef(teamKey, day.reportDate))) as {
            readonly sections: readonly { readonly items: readonly { readonly stableId: string }[] }[];
          };
          return [teamKey, new Set(stored.sections.flatMap((section) => section.items.map((item) => item.stableId)))];
        }),
      );

      for (const item of merged.items) {
        expect(
          teamIds.get(item.teamKey)?.has(item.stableId),
          `${day.reportDate}: merged item ${item.stableId} is not in ${item.teamKey}'s own report`,
        ).toBe(true);
      }
    }
  });
});

describe('the fixtures are reviewable rather than opaque', () => {
  it('stores one value per line, so a diff names the field that changed', () => {
    const ref = fixtureRef('platform', days.at(-1)!.reportDate);
    const lines = readFixture(ref).trimEnd().split('\n');

    expect(lines.length, 'a single-line fixture is the opaque blob the criteria rule out').toBeGreaterThan(50);
    expect(lines[0]).toBe('{');
  });

  it('ends every fixture with exactly one newline', () => {
    for (const ref of expectedFixtures()) {
      const bytes = readFixture(ref);
      expect(bytes.endsWith('\n'), `${ref.relativePath} has no trailing newline`).toBe(true);
      expect(bytes.endsWith('\n\n'), `${ref.relativePath} has a blank line at the end`).toBe(false);
    }
  });

  it('carries no run id or generation timestamp, so a fixture cannot churn on a meaningless value', () => {
    for (const ref of expectedFixtures()) {
      const bytes = readFixture(ref);
      expect(bytes, `${ref.relativePath} stores a runId`).not.toContain('"runId"');
      expect(bytes, `${ref.relativePath} stores a generatedAt`).not.toContain('"generatedAt"');
    }
  });

  it('regenerates byte-identically, which is what makes `golden:update` a no-op when nothing changed', () => {
    for (const day of [days[0], days.at(-1)!]) {
      for (const scope of [...GOLDEN_TEAM_KEYS, MERGED_DIRECTORY]) {
        expect(renderFixture(scope, day)).toBe(renderFixture(scope, day));
      }
    }
  });
});
