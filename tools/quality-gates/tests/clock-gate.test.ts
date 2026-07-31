import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isRuleEnabledFor, lintFiles, lintVirtualSource, ruleSeverityFor } from './helpers/lint.js';
import { countSanctionedDisables, scanAll, scanForForbiddenTimeReads } from './helpers/scan.js';
import {
  CLOCK_GUARDED_PACKAGES,
  CLOCK_INJECTED_PACKAGES,
  REPO_ROOT,
  allAuthoredSourceFiles,
  packageSourceFiles,
  packagesIn,
  workspacePackageByDirectory,
} from './helpers/workspace.js';

const NO_SYSTEM_CLOCK = 'compass/no-system-clock';
const NO_TIME_LIBRARY_IMPORTS = 'compass/no-time-library-imports';
const NO_CLOCK_INSTANTIATION = 'compass/no-clock-instantiation';

/**
 * The one fixture both gates are pointed at. Its line numbers are asserted, so
 * the file carries a "do not reformat" notice.
 */
const FIXTURE_RELATIVE_PATH = 'tools/quality-gates/fixtures/forbidden-clock-reads.ts.txt';
const fixtureText = readFileSync(join(REPO_ROOT, FIXTURE_RELATIVE_PATH), 'utf8');

/**
 * The three banned reads in the fixture, with the line each sits on. Line 12
 * names `Date.now()` in prose and must not be reported by either gate.
 *
 * `expression` is how the textual scan labels the read; `reportedAs` is how the
 * ESLint rule words it. They differ on purpose: the rule reports the AST node it
 * actually matched — a `MemberExpression`, so `Date.now` without the call — while
 * the scan matches the whole call form. Asserting both keeps either gate from
 * being quietly reworded.
 */
const EXPECTED_FIXTURE_VIOLATIONS = [
  { line: 16, expression: 'Date.now()', reportedAs: 'Date.now' },
  { line: 20, expression: 'new Date()', reportedAs: 'new Date()' },
  { line: 24, expression: 'performance.now()', reportedAs: 'performance.now' },
] as const;

const probePathIn = (directoryName: string): string =>
  `packages/${directoryName}/src/__clock_gate_probe__.ts`;

describe('the no-system-clock build gate', () => {
  it.each(CLOCK_GUARDED_PACKAGES)(
    'fails lint with the offending file:line for every banned read in packages/%s/src',
    async (directoryName) => {
      const probePath = probePathIn(directoryName);
      const violations = await lintVirtualSource(probePath, fixtureText);
      const clockViolations = violations.filter((violation) => violation.ruleId === NO_SYSTEM_CLOCK);

      expect(
        clockViolations.map((violation) => violation.line),
        `expected three banned reads to be reported in ${probePath}`,
      ).toEqual(EXPECTED_FIXTURE_VIOLATIONS.map((expected) => expected.line));

      for (const expected of EXPECTED_FIXTURE_VIOLATIONS) {
        const reported = clockViolations.find((violation) => violation.line === expected.line);
        expect(reported?.location).toBe(`${probePath}:${expected.line}:${reported?.column ?? 0}`);
        expect(reported?.message).toContain(expected.reportedAs);
      }
    },
  );

  it('names the file and the line in a form a build log can be read from', async () => {
    const probePath = probePathIn('pipeline');
    const [first] = (await lintVirtualSource(probePath, fixtureText)).filter(
      (violation) => violation.ruleId === NO_SYSTEM_CLOCK,
    );

    expect(first).toBeDefined();
    expect(first?.location).toMatch(/^packages\/pipeline\/src\/__clock_gate_probe__\.ts:16:\d+$/);
  });

  it('does not report a clock read that only appears in prose', async () => {
    const violations = await lintVirtualSource(probePathIn('analysis'), fixtureText);

    // The fixture mentions `Date.now()` in a comment on line 12.
    expect(violations.map((violation) => violation.line)).not.toContain(12);
  });

  it('allows conversions of an instant that already came from the Clock port', async () => {
    const violations = await lintVirtualSource(probePathIn('analysis'), fixtureText);

    // Line 30 is `new Date(epochMillis)` plus `Date.parse(iso)` — pure conversions.
    expect(violations.map((violation) => violation.line)).not.toContain(30);
  });

  it.each(['dayjs', 'luxon', 'moment', 'date-fns', 'node:perf_hooks'])(
    'rejects `%s`, whose no-argument constructor is a hidden wall-clock read',
    async (moduleName) => {
      const source = ['// a guarded layer reaching for a time library', `import x from '${moduleName}';`, '', 'export default x;', ''].join(
        '\n',
      );
      const violations = await lintVirtualSource(probePathIn('knowledge-model'), source);

      const reported = violations.find((violation) => violation.ruleId === NO_TIME_LIBRARY_IMPORTS);
      expect(reported, `expected '${moduleName}' to be rejected`).toBeDefined();
      expect(reported?.line).toBe(2);
      expect(reported?.message).toContain(moduleName);
    },
  );

  it('is enabled for exactly the guarded layers, so the globs cannot drift', async () => {
    const enabled: string[] = [];

    for (const workspacePackage of packagesIn('packages')) {
      const probe = `${workspacePackage.relativeDirectory}/src/__clock_gate_probe__.ts`;
      if (await isRuleEnabledFor(probe, NO_SYSTEM_CLOCK)) {
        enabled.push(workspacePackage.directoryName);
      }
    }

    expect(enabled.sort()).toEqual([...CLOCK_GUARDED_PACKAGES].sort());
  });

  it('holds the guarded layers clean right now', async () => {
    const violations = await lintFiles(CLOCK_GUARDED_PACKAGES.map((name) => `packages/${name}/src`));

    expect(violations.map((violation) => `${violation.location} ${violation.message}`)).toEqual([]);
  });
});

describe('the sanctioned system-clock read', () => {
  it('exists exactly once in the workspace, in SystemClock', () => {
    const census = allAuthoredSourceFiles()
      .map((file) => ({ file: file.relativePath, count: countSanctionedDisables(file) }))
      .filter((entry) => entry.count > 0);

    expect(census).toEqual([{ file: 'packages/clock/src/system-clock.ts', count: 1 }]);
  });

  it('is the only place any layer reads the host clock', () => {
    const guarded = CLOCK_GUARDED_PACKAGES.flatMap((directoryName) =>
      packageSourceFiles(workspacePackageByDirectory('packages', directoryName)),
    );

    expect(scanAll(guarded).map((read) => `${read.location} ${read.expression}`)).toEqual([]);
  });

  it('reads time through SystemClock and nothing else', () => {
    const systemClock = packageSourceFiles(workspacePackageByDirectory('packages', 'clock')).find((file) =>
      file.relativePath.endsWith('system-clock.ts'),
    );

    expect(systemClock, 'packages/clock/src/system-clock.ts is missing').toBeDefined();
    expect(systemClock?.text).toContain('Date.now()');
    expect(countSanctionedDisables(systemClock!)).toBe(1);
  });
});

describe('the source scan is an independent second opinion', () => {
  it('finds the same lines in the fixture that lint does', async () => {
    const scanned = scanForForbiddenTimeReads({
      absolutePath: join(REPO_ROOT, FIXTURE_RELATIVE_PATH),
      relativePath: FIXTURE_RELATIVE_PATH,
      text: fixtureText,
    });
    const linted = (await lintVirtualSource(probePathIn('ingest'), fixtureText)).filter(
      (violation) => violation.ruleId === NO_SYSTEM_CLOCK,
    );

    expect(scanned.map((read) => read.line)).toEqual(EXPECTED_FIXTURE_VIOLATIONS.map((expected) => expected.line));
    expect(scanned.map((read) => read.line)).toEqual(linted.map((violation) => violation.line));
    expect(scanned.map((read) => read.expression)).toEqual(
      EXPECTED_FIXTURE_VIOLATIONS.map((expected) => expected.expression),
    );
  });

  it('reports file:line for each read it finds', () => {
    const [first] = scanForForbiddenTimeReads({
      absolutePath: join(REPO_ROOT, FIXTURE_RELATIVE_PATH),
      relativePath: FIXTURE_RELATIVE_PATH,
      text: fixtureText,
    });

    expect(first?.location).toBe(`${FIXTURE_RELATIVE_PATH}:16`);
  });

  it('honours the one sanctioned disable comment', () => {
    const withDisable = [
      'export function edgeRead(): number {',
      '  // eslint-disable-next-line compass/no-system-clock -- the sanctioned read',
      '  return Date.now();',
      '}',
      '',
    ].join('\n');

    const found = scanForForbiddenTimeReads({
      absolutePath: 'virtual',
      relativePath: 'virtual/edge.ts',
      text: withDisable,
    });

    expect(found).toEqual([]);
  });
});

describe('no pipeline stage constructs a clock', () => {
  it.each(CLOCK_INJECTED_PACKAGES)('rejects a clock constructed inside packages/%s/src', async (directoryName) => {
    const source = [
      "import { SystemClock } from '@compass/clock';",
      '',
      'export function stage(): number {',
      '  const clock = new SystemClock();',
      '  return clock.now();',
      '}',
      '',
    ].join('\n');

    const probePath = probePathIn(directoryName);
    const violations = await lintVirtualSource(probePath, source);
    const reported = violations.find((violation) => violation.ruleId === NO_CLOCK_INSTANTIATION);

    expect(reported, `expected \`new SystemClock()\` to be rejected in ${probePath}`).toBeDefined();
    expect(reported?.location).toBe(`${probePath}:4:${reported?.column ?? 0}`);
    expect(reported?.line).toBe(4);
    expect(reported?.message).toContain('now: Instant');
  });

  it('rejects the shared clock singleton just as firmly as the constructor', async () => {
    const source = [
      "import { systemClock } from '@compass/clock';",
      '',
      'export const at = () => systemClock();',
      '',
    ].join('\n');

    const violations = await lintVirtualSource(probePathIn('pipeline'), source);

    expect(violations.find((violation) => violation.ruleId === NO_CLOCK_INSTANTIATION)?.line).toBe(3);
  });

  it('is enabled for exactly the injected layers', async () => {
    const enabled: string[] = [];

    for (const workspacePackage of packagesIn('packages')) {
      const probe = `${workspacePackage.relativeDirectory}/src/__clock_gate_probe__.ts`;
      if (await isRuleEnabledFor(probe, NO_CLOCK_INSTANTIATION)) {
        enabled.push(workspacePackage.directoryName);
      }
    }

    expect(enabled.sort()).toEqual([...CLOCK_INJECTED_PACKAGES].sort());
  });

  it('leaves @compass/clock free to define the clocks it owns', async () => {
    // The rule must not apply to the package that declares FixedClock/SystemClock.
    expect(await ruleSeverityFor('packages/clock/src/clock.ts', NO_CLOCK_INSTANTIATION)).toBe(0);
  });

  it('never imports a clock into a layer that should take `now` as a parameter', () => {
    const offenders = CLOCK_INJECTED_PACKAGES.flatMap((directoryName) =>
      packageSourceFiles(workspacePackageByDirectory('packages', directoryName))
        .filter((file) => /\b(?:SystemClock|SimulatedClock|FixedClock|systemClock)\b/.test(file.text))
        .map((file) => file.relativePath),
    );

    expect(offenders).toEqual([]);
  });
});
