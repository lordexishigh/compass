import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isRuleEnabledFor, lintVirtualSource } from './helpers/lint.js';
import {
  FORBIDDEN_LIBRARIES,
  FORBIDDEN_NODE_BUILTINS,
  FORBIDDEN_WORKSPACE_PACKAGES,
  findExportedFunctionsMissingInstant,
  findSnapshotAccessors,
  scanAllForImpurity,
  scanForImpurity,
} from './helpers/imports.js';
import {
  REPO_ROOT,
  packageSourceFiles,
  readJsonFile,
  workspacePackageByDirectory,
  type PackageManifest,
  type SourceFile,
} from './helpers/workspace.js';

/**
 * The analysis architecture test.
 *
 * The product's central claim is that everything arguable is decided in one pure,
 * deterministic function. That claim is only as good as its enforcement, so it is
 * enforced three independent ways and this file checks all three agree:
 *
 *  1. **The manifest.** `@compass/analysis` declares no runtime dependencies, so
 *     an import of a database, an HTTP client or the clock package does not
 *     resolve.
 *  2. **ESLint** (`compass/no-analysis-io`), which reports at the import site.
 *  3. **A textual scan**, which answers to no configuration and therefore cannot
 *     be switched off by editing one.
 *
 * A failure names the module and the import, because "analysis is impure" is not
 * a message anybody can act on.
 */
const analysisPackage = workspacePackageByDirectory('packages', 'analysis');
const analysisSources = packageSourceFiles(analysisPackage);

const fixture: SourceFile = {
  absolutePath: join(REPO_ROOT, 'tools/quality-gates/fixtures/impure-analysis-module.ts.txt'),
  relativePath: 'packages/analysis/src/impure-probe.ts',
  text: readFileSync(join(REPO_ROOT, 'tools/quality-gates/fixtures/impure-analysis-module.ts.txt'), 'utf8'),
};

describe('the analysis package declares no runtime dependency on I/O, a database or a clock', () => {
  it('declares no runtime dependencies at all', () => {
    expect(analysisPackage.manifest.dependencies ?? {}).toEqual({});
  });

  it('declares no peer dependency either, which would be a runtime edge by another name', () => {
    expect(analysisPackage.manifest.peerDependencies ?? {}).toEqual({});
  });

  it.each([...FORBIDDEN_WORKSPACE_PACKAGES])('does not depend on %s at runtime', (packageName) => {
    const manifest = analysisPackage.manifest as PackageManifest;
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(packageName);
  });

  it.each([...FORBIDDEN_LIBRARIES])('does not depend on %s at runtime', (packageName) => {
    expect(Object.keys(analysisPackage.manifest.dependencies ?? {})).not.toContain(packageName);
  });

  it('keeps @compass/clock a dev dependency only, used by tests to prove brand compatibility', () => {
    // The Instant brand is re-declared structurally in `instant.ts` precisely so
    // no runtime edge is needed. The dev dependency exists so a test can assert
    // the two brands stay assignable in both directions.
    expect(Object.keys(analysisPackage.manifest.dependencies ?? {})).not.toContain('@compass/clock');
    expect(Object.keys(analysisPackage.manifest.devDependencies ?? {})).toContain('@compass/clock');
  });
});

describe('no analysis module imports I/O, time or randomness', () => {
  it('has analysis sources to scan at all', () => {
    // A gate that silently scans nothing is worse than no gate.
    expect(analysisSources.length).toBeGreaterThan(10);
  });

  it('finds no forbidden import or impure expression anywhere in the analysis core', () => {
    const violations = scanAllForImpurity(analysisSources);
    const rendered = violations.map((violation) => `${violation.location} — ${violation.specifier} (${violation.why})`);

    expect(rendered, 'the analysis core must be pure').toEqual([]);
  });

  it('names the module and the import when a violation exists', () => {
    const violations = scanForImpurity(fixture);
    const byLocation = violations.map((violation) => `${violation.location} ${violation.specifier}`);

    // Every failure line names the file, the line, and the offending import —
    // which is exactly what the acceptance criterion asks the gate to report.
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:7 node:fs');
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:8 node:crypto');
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:9 drizzle-orm/node-postgres');
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:11 @compass/clock');
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:12 @compass/knowledge-model');
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:17 Math.random()');
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:18 Date.now()');
    expect(byLocation).toContain('packages/analysis/src/impure-probe.ts:25 process.env');
  });

  it('classifies each violation so the message can explain itself', () => {
    const violations = scanForImpurity(fixture);
    const categories = new Set(violations.map((violation) => violation.category));

    expect([...categories].sort()).toEqual(['expression', 'library', 'node_builtin', 'workspace_package']);
    for (const violation of violations) expect(violation.why.length).toBeGreaterThan(10);
  });

  it('does not report a module that only mentions a forbidden name in a comment', () => {
    const commentOnly: SourceFile = {
      absolutePath: 'virtual',
      relativePath: 'packages/analysis/src/comment-only.ts',
      text: [
        '// This deliberately names node:fs, Math.random() and @compass/clock in prose.',
        '/* Date.now() and Intl.DateTimeFormat too. */',
        "export const value = 1;",
      ].join('\n'),
    };

    expect(scanForImpurity(commentOnly)).toEqual([]);
  });
});

describe('the ESLint gate agrees with the scan', () => {
  it('enables compass/no-analysis-io for the analysis source tree', async () => {
    expect(await isRuleEnabledFor('packages/analysis/src/probe.ts', 'compass/no-analysis-io')).toBe(true);
  });

  it('leaves other layers alone — they are allowed to do I/O', async () => {
    for (const path of [
      'packages/ingest/src/probe.ts',
      'packages/pipeline/src/probe.ts',
      'packages/db/src/probe.ts',
      'apps/worker/src/probe.ts',
    ]) {
      expect(await isRuleEnabledFor(path, 'compass/no-analysis-io'), `${path} must not be gated`).toBe(false);
    }
  });

  it('reports the module and the import at the import statement', async () => {
    const violations = await lintVirtualSource(
      'packages/analysis/src/probe.ts',
      ["import { readFileSync } from 'node:fs';", "import { SystemClock } from '@compass/clock';", 'export const x = readFileSync;'].join(
        '\n',
      ),
    );

    const messages = violations.filter((violation) => violation.ruleId === 'compass/no-analysis-io');
    expect(messages.map((violation) => violation.location)).toEqual([
      'packages/analysis/src/probe.ts:1:1',
      'packages/analysis/src/probe.ts:2:1',
    ]);
    expect(messages[0]?.message).toContain('node:fs');
    expect(messages[1]?.message).toContain('@compass/clock');
  });

  it('reports randomness and host reads as expressions', async () => {
    const violations = await lintVirtualSource(
      'packages/analysis/src/probe.ts',
      ['export const jitter = Math.random();', 'export const id = crypto.randomUUID();'].join('\n'),
    );

    const messages = violations.filter((violation) => violation.ruleId === 'compass/no-analysis-io');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toContain('Math.random');
    expect(messages[1]?.message).toContain('crypto.randomUUID');
  });

  it('allows the imports the analysis core actually uses', async () => {
    const violations = await lintVirtualSource(
      'packages/analysis/src/probe.ts',
      ["import { compareStable } from './instant.js';", 'export const ordered = [1, 2].sort();'].join('\n'),
    );

    expect(violations.filter((violation) => violation.ruleId === 'compass/no-analysis-io')).toEqual([]);
  });

  it('lints the real analysis tree clean', async () => {
    const { lintFiles } = await import('./helpers/lint.js');
    const violations = await lintFiles(['packages/analysis/src']);

    expect(violations.filter((violation) => violation.ruleId === 'compass/no-analysis-io')).toEqual([]);
  });
});

describe('every exported analysis function takes an explicit instant', () => {
  it('finds no snapshot-consuming export without an instant parameter', () => {
    const missing = analysisSources.flatMap((file) => findExportedFunctionsMissingInstant(file));
    const rendered = missing.map((entry) => `${entry.location} ${entry.functionName}(${entry.parameters})`);

    expect(rendered, 'a function handed the whole snapshot must be told which instant to reason about').toEqual([]);
  });

  it('catches a snapshot-consuming export that was not given one', () => {
    const missing = findExportedFunctionsMissingInstant({
      absolutePath: 'virtual',
      relativePath: 'packages/analysis/src/probe.ts',
      text: [
        'export function fine(snapshot: AnalysisSnapshot, instant: Instant): number { return 1; }',
        'export function broken(snapshot: AnalysisSnapshot): number { return 2; }',
        'export function unrelated(left: number, right: number): number { return left + right; }',
      ].join('\n'),
    });

    expect(missing.map((entry) => entry.functionName)).toEqual(['broken']);
    expect(missing[0]?.location).toBe('packages/analysis/src/probe.ts:2');
  });

  it('accepts an explicit TimeWindow in place of a bare instant, but nothing looser', () => {
    const missing = findExportedFunctionsMissingInstant({
      absolutePath: 'virtual',
      relativePath: 'packages/analysis/src/probe.ts',
      text: [
        // A window is two instants: strictly more temporal detail than one.
        'export function bounded(snapshot: AnalysisSnapshot, window: TimeWindow): number { return 1; }',
        // A name that merely reads like time is not being told when.
        'export function named(snapshot: AnalysisSnapshot, window: string): number { return 2; }',
        'export function timely(snapshot: AnalysisSnapshot, since: number): number { return 3; }',
      ].join('\n'),
    });

    expect(missing.map((entry) => entry.functionName)).toEqual(['named', 'timely']);
  });

  it('exempts only functions tagged @snapshotAccessor with a stated reason', () => {
    const source: SourceFile = {
      absolutePath: 'virtual',
      relativePath: 'packages/analysis/src/probe.ts',
      text: [
        '/** @snapshotAccessor a keyed lookup, nothing temporal. */',
        'export function tagged(snapshot: AnalysisSnapshot): number { return 1; }',
        '/** @snapshotAccessor */',
        'export function tagWithNoReason(snapshot: AnalysisSnapshot): number { return 2; }',
        '/** Just a comment mentioning nothing. */',
        'export function untagged(snapshot: AnalysisSnapshot): number { return 3; }',
      ].join('\n'),
    };

    // An empty tag is not an exemption: the reason is the whole point.
    expect(findExportedFunctionsMissingInstant(source).map((entry) => entry.functionName)).toEqual([
      'tagWithNoReason',
      'untagged',
    ]);
    expect(findSnapshotAccessors(source).map((entry) => entry.functionName)).toEqual(['tagged']);
  });

  it('does not let a tag further up the file exempt an unrelated declaration', () => {
    const source: SourceFile = {
      absolutePath: 'virtual',
      relativePath: 'packages/analysis/src/probe.ts',
      text: [
        '/** @snapshotAccessor this exempts the next declaration only. */',
        'export function tagged(snapshot: AnalysisSnapshot): number { return 1; }',
        '',
        'export function later(snapshot: AnalysisSnapshot): number { return 2; }',
      ].join('\n'),
    };

    expect(findExportedFunctionsMissingInstant(source).map((entry) => entry.functionName)).toEqual(['later']);
  });

  it('keeps the exemptions few, justified, and visible', () => {
    const accessors = analysisSources.flatMap((file) => findSnapshotAccessors(file));

    for (const accessor of accessors) {
      expect(accessor.reason.length, `${accessor.location} ${accessor.functionName} states no reason`).toBeGreaterThan(
        20,
      );
    }
    // Not a cap for its own sake: an exemption count that creeps upward is how
    // "the analysis core is told the instant" quietly stops being true.
    expect(accessors.length, accessors.map((entry) => entry.location).join(', ')).toBeLessThanOrEqual(12);
  });

  it('names the entry point the architecture document promises', async () => {
    const barrel = readFileSync(join(analysisPackage.absoluteDirectory, 'src/index.ts'), 'utf8');
    expect(barrel).toContain('generateStructuredReport');
  });
});

describe('the determinism allowlist is documented where it is used', () => {
  const documentPath = join(analysisPackage.absoluteDirectory, 'DETERMINISM.md');

  it('ships a DETERMINISM.md next to the code it describes', () => {
    expect(readFileSync(documentPath, 'utf8').length).toBeGreaterThan(500);
  });

  it('documents each excluded field in a table a test can parse', () => {
    const document = readFileSync(documentPath, 'utf8');
    const documented = [...document.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|/gm)].map((match) => match[1]).sort();

    expect(documented).toEqual(['generatedAt', 'narrationTraceId', 'runId']);
  });

  it('is the same list the pipeline uses, not a second copy', () => {
    const pipeline = readFileSync(join(REPO_ROOT, 'packages/pipeline/src/canonical-json.ts'), 'utf8');

    expect(pipeline).toContain('NON_SEMANTIC_REPORT_FIELDS');
    // A second literal list here is exactly the drift this test exists to stop.
    expect(pipeline).not.toMatch(/NON_SEMANTIC_FIELDS[^=]*=\s*\[/);
  });
});

describe('the analysis package keeps its place in the build graph', () => {
  it('is referenced by tsconfig.build.json', () => {
    const build = readJsonFile<{ references?: readonly { path: string }[] }>(join(REPO_ROOT, 'tsconfig.build.json'));
    expect((build.references ?? []).map((reference) => reference.path)).toContain('packages/analysis');
  });

  it('is mapped to its source for the tests project', () => {
    const tests = readJsonFile<{ compilerOptions?: { paths?: Record<string, readonly string[]> } }>(
      join(REPO_ROOT, 'tsconfig.tests.json'),
    );
    expect(tests.compilerOptions?.paths?.['@compass/analysis']).toEqual(['packages/analysis/src/index.ts']);
  });

  it('has no forbidden import that the node builtin list forgot to mention', () => {
    // Guards the guard: if a builtin is dropped from the list by accident the
    // scan silently stops checking it, so the list itself is asserted.
    for (const builtin of ['fs', 'http', 'https', 'child_process', 'crypto', 'net', 'os', 'process']) {
      expect(FORBIDDEN_NODE_BUILTINS as readonly string[]).toContain(builtin);
    }
  });
});
