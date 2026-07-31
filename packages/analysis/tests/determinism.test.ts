import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BANNED_OUTPUT_FIELD_PATTERNS,
  IndividualRankingError,
  NON_SEMANTIC_REPORT_FIELDS,
  THRESHOLDS,
  THRESHOLD_IDS,
  assertNoIndividualRanking,
  canonicalReportJson,
  createEmptyStructuredReport,
  findIndividualRankingViolations,
  firstCanonicalDifference,
  generateStructuredReport,
  reportsAreIdentical,
  type StructuredReport,
} from '@compass/analysis';

import { SEED_NOW, SEED_ORGANIZATION_ID, SEED_TIMEZONE, SEED_WINDOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * The two gates that make the analysis core safe to ship: it does not rank
 * people, and it produces the same report twice.
 *
 * Both are enforced in `generateStructuredReport` itself, which throws before
 * returning. These tests exist because a guard nobody has watched fail is a guard
 * nobody knows works — so each one is exercised in both directions: against every
 * real seeded team, and against a deliberately violating object.
 */
const TEAM_KEYS = ['platform', 'checkout', 'insights'] as const;

const reports = TEAM_KEYS.map((teamKey) => ({
  teamKey,
  report: generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW),
}));

describe('no analysis output ranks individuals', () => {
  it('finds no violation in any seeded team report', () => {
    for (const { teamKey, report } of reports) {
      const violations = findIndividualRankingViolations(report);
      expect(violations.map((violation) => `${violation.path}: ${violation.detail}`), teamKey).toEqual([]);
    }
  });

  it('carries no commit count, lines-of-code figure or productivity score anywhere in the JSON', () => {
    for (const { teamKey, report } of reports) {
      const json = canonicalReportJson(report);
      for (const banned of [
        'commitCount',
        'commitsPerDeveloper',
        'linesOfCode',
        'linesAdded',
        'linesChanged',
        'productivity',
        'leaderboard',
        'topPerformer',
        'throughputPerDeveloper',
      ]) {
        expect(json, `${teamKey} emits \`${banned}\``).not.toContain(`"${banned}"`);
      }
    }
  });

  it('orders every per-developer list by key, so no distribution is a leaderboard', () => {
    for (const { teamKey, report } of reports) {
      const byKey = (rows: readonly { readonly developerKey: string }[]): readonly string[] =>
        rows.map((row) => row.developerKey);

      for (const rows of [report.findings.workload.perDeveloper, report.findings.reviewQueue.openByReviewer]) {
        const keys = byKey(rows);
        expect(keys, teamKey).toEqual([...keys].sort());
      }
    }
  });

  it('rejects a banned field wherever it appears, however deeply nested', () => {
    const violations = findIndividualRankingViolations({
      findings: { workload: { perDeveloper: [{ developerKey: 'a', commitCount: 40 }] } },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('banned_field');
    expect(violations[0].path).toBe('$.findings.workload.perDeveloper[0].commitCount');
  });

  it('rejects a per-person list ordered by magnitude rather than by key', () => {
    const violations = findIndividualRankingViolations({
      perDeveloper: [
        { developerKey: 'zara-okonkwo', openItems: 9 },
        { developerKey: 'aisha-bello', openItems: 2 },
      ],
    });

    expect(violations.map((violation) => violation.kind)).toEqual(['person_list_ordered_by_magnitude']);
  });

  it('does not mistake an artifact list that mentions people for a ranking', () => {
    // The review queue is a list of pull requests, legitimately oldest-first.
    expect(
      findIndividualRankingViolations({
        entries: [
          { pullRequestNumber: '#9101', developerKey: 'zara-okonkwo', ageDays: 9 },
          { pullRequestNumber: '#9102', developerKey: 'aisha-bello', ageDays: 2 },
        ],
      }),
    ).toEqual([]);
  });

  it('throws at the boundary rather than returning a ranked report', () => {
    expect(() => assertNoIndividualRanking({ leaderboard: [] })).toThrow(IndividualRankingError);
    expect(() => assertNoIndividualRanking(reports[0].report)).not.toThrow();
  });

  it('anchors its patterns so ordinary field names are not swept up', () => {
    const innocent = ['workingDaysWaiting', 'rungLabel', 'trailingDays', 'reworkedMergedPullRequestShare', 'ranged'];
    for (const name of innocent) {
      expect(
        BANNED_OUTPUT_FIELD_PATTERNS.some((banned) => banned.pattern.test(name)),
        `\`${name}\` must not be treated as a ranking field`,
      ).toBe(false);
    }
  });
});

describe('the determinism gate', () => {
  it('produces byte-identical JSON for two runs over the same (org, team, instant)', () => {
    for (const teamKey of TEAM_KEYS) {
      // Two independent snapshots as well as two calls: a shared object could
      // hide a mutation, and a mutation is exactly what this gate is for.
      const first = generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW);
      const second = generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW);

      const difference = firstCanonicalDifference(first, second);
      expect(difference, `${teamKey} diverged at ${difference?.path ?? ''}`).toBeNull();
      expect(canonicalReportJson(first)).toBe(canonicalReportJson(second));
      expect(reportsAreIdentical(first, second)).toBe(true);
    }
  });

  it('ignores only the documented non-semantic fields', () => {
    const [{ report }] = reports;
    const stamped = (runId: string, generatedAt: number): unknown => ({ ...report, runId, generatedAt });

    expect(reportsAreIdentical(stamped('run-1', 1), stamped('run-2', 2))).toBe(true);
    // Anything outside the allowlist still counts.
    expect(reportsAreIdentical(stamped('run-1', 1), { ...(stamped('run-1', 1) as object), timezone: 'UTC' })).toBe(
      false,
    );
  });

  it('notices a difference and names the path it found it at', () => {
    const [{ report }] = reports;
    const changed: StructuredReport = { ...report, timezone: 'America/New_York' };

    const difference = firstCanonicalDifference(report, changed);
    expect(difference?.path).toBe('$.timezone');
  });

  it('refuses values that cannot be reproduced, rather than serialising them anyway', () => {
    expect(() => canonicalReportJson({ at: new Date(0) })).toThrow(/Date/);
    expect(() => canonicalReportJson({ ratio: Number.NaN })).toThrow(/NaN/);
    expect(() => canonicalReportJson({ seen: new Set([1]) })).toThrow(/Map or Set/);
    // `-0` and `0` are the same number and must not hash differently.
    expect(canonicalReportJson({ delta: -0 })).toBe(canonicalReportJson({ delta: 0 }));
  });

  it('leaves array order alone, so a bad ordering key fails instead of being hidden', () => {
    expect(canonicalReportJson([3, 1, 2])).toBe('[3,1,2]');
    expect(reportsAreIdentical([1, 2], [2, 1])).toBe(false);
  });

  it('holds for the empty report too, which is what a fresh install renders', () => {
    const empty = (): StructuredReport =>
      createEmptyStructuredReport({
        organizationId: SEED_ORGANIZATION_ID,
        scope: { kind: 'team', teamKey: 'platform' },
        instant: SEED_NOW,
        timezone: SEED_TIMEZONE,
        window: SEED_WINDOW,
      });

    expect(canonicalReportJson(empty())).toBe(canonicalReportJson(empty()));
  });
});

describe('the non-semantic allowlist is documented where it is defined', () => {
  const document = readFileSync(fileURLToPath(new URL('../DETERMINISM.md', import.meta.url)), 'utf8');

  /**
   * The field names in DETERMINISM.md's allowlist table — the first backticked
   * cell of every row. Parsed rather than restated, because a test that repeats
   * the list is a third copy of it.
   */
  const documented = [...document.matchAll(/^\|\s*`([A-Za-z0-9_]+)`\s*\|/gm)].map((match) => match[1]).sort();

  it('lists exactly the fields the constant excludes', () => {
    expect(documented.length).toBeGreaterThan(0);
    expect(documented).toEqual([...NON_SEMANTIC_REPORT_FIELDS].sort());
  });

  it('gives each excluded field a stated reason, not just a name', () => {
    for (const field of NON_SEMANTIC_REPORT_FIELDS) {
      const row = new RegExp(`^\\|\\s*\`${field}\`\\s*\\|([^|]+)\\|`, 'm').exec(document);
      expect(row, `DETERMINISM.md does not explain \`${field}\``).not.toBeNull();
      expect((row?.[1] ?? '').trim().length).toBeGreaterThan(20);
    }
  });

  it('names the run rather than the organization, which is what makes them non-semantic', () => {
    // Guards the criterion's own wording: the generation timestamp and the run id
    // are the two the acceptance criteria call out by name.
    expect(NON_SEMANTIC_REPORT_FIELDS).toContain('generatedAt');
    expect(NON_SEMANTIC_REPORT_FIELDS).toContain('runId');
    expect(NON_SEMANTIC_REPORT_FIELDS).not.toContain('instant');
  });
});

describe('every declared threshold is applied somewhere', () => {
  const sources = ['alignment', 'blockers', 'progress', 'projection', 'recommendations', 'review-queue', 'risks', 'technical-debt', 'wins', 'workload', 'yesterday', 'structured-report', 'ladder', 'elapsed', 'calibration']
    .map((name) => readFileSync(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)), 'utf8'))
    .join('\n');

  it('leaves no threshold declared and unused', () => {
    const unused = THRESHOLD_IDS.filter(
      (id) => !sources.includes(`THRESHOLDS.${id}.`) && !sources.includes(`thresholdRef('${id}')`),
    );

    expect(unused, 'a threshold nobody applies is a rule the product does not actually have').toEqual([]);
  });

  it('gives every threshold a statement a manager could argue with', () => {
    for (const id of THRESHOLD_IDS) {
      expect(THRESHOLDS[id].statement.length, `${id} states no rule`).toBeGreaterThan(20);
    }
  });

  it('carries the threshold into the output on every blocker and risk', () => {
    for (const { teamKey, report } of reports) {
      for (const blocker of report.findings.blockers) {
        expect(THRESHOLD_IDS, `${teamKey} ${blocker.stableId}`).toContain(blocker.threshold.id);
        expect(blocker.threshold.statement).toBe(THRESHOLDS[blocker.threshold.id].statement);
      }
      for (const risk of report.findings.risks) {
        expect(THRESHOLD_IDS, `${teamKey} ${risk.stableId}`).toContain(risk.threshold.id);
        expect(risk.threshold.value).toBe(THRESHOLDS[risk.threshold.id].value);
      }
    }
  });
});
