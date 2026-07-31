import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, collectSourceFiles, readJsonFile, workspacePackageByDirectory, type SourceFile } from './helpers/workspace.js';

/**
 * Nothing below the port may know a seeded provider exists.
 *
 * This is the property that makes "the pipeline cannot tell seeded data from a
 * live API" checkable rather than aspirational. The moment `@compass/analysis`
 * imports the seed — even for a type, even in a test helper — the seam is gone
 * and every claim resting on it becomes an assertion about intentions.
 *
 * dependency-cruiser already carries the same rule. This gate is deliberately
 * independent of it: it reads the files itself, so a cruiser config that stops
 * being run, or an `exclude` glob that quietly grows, cannot take the check with
 * it. It also covers two things a module-graph tool does not see — a dependency
 * entry in `package.json` and a TypeScript project reference — either of which
 * would make the import possible again the moment somebody wanted it.
 */

const SEED_PACKAGE = '@compass/seed-connector';

/** Every layer that sits below or beside the port and must stay ignorant of the seed. */
const ISOLATED_PACKAGES = ['analysis', 'db', 'ingest', 'knowledge-model', 'pipeline', 'renderers'] as const;

/**
 * Module specifiers, however they are written: `import`, `import type`,
 * `export … from`, a bare side-effect import, `import()` and `require()`. A
 * plain textual search would also flag a comment that names the package, which
 * is exactly the sort of false positive that gets a gate switched off.
 */
const MODULE_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;

const namesTheSeed = (specifier: string): boolean =>
  specifier === SEED_PACKAGE || specifier.startsWith(`${SEED_PACKAGE}/`) || /(^|\/)seed-connector(\/|$)/.test(specifier);

interface SeedImport {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

function findSeedImports(file: SourceFile): readonly SeedImport[] {
  const found: SeedImport[] = [];
  for (const match of file.text.matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1] ?? '';
    if (!namesTheSeed(specifier)) continue;
    found.push({
      file: file.relativePath,
      line: file.text.slice(0, match.index).split('\n').length,
      specifier,
    });
  }
  return found;
}

const packagesUnderTest = ISOLATED_PACKAGES.map((directoryName) =>
  workspacePackageByDirectory('packages', directoryName),
);
const asCases = packagesUnderTest.map((pkg) => [pkg.relativeDirectory, pkg] as const);

describe('no layer below the port imports the seeded provider', () => {
  it.each(asCases)('%s/src names no seed module', (_label, pkg) => {
    const offenders = collectSourceFiles(join(pkg.absoluteDirectory, 'src')).flatMap(findSeedImports);

    expect(
      offenders.map((entry) => `${entry.file}:${entry.line} imports ${entry.specifier}`),
      `${pkg.name} must not know a seeded provider exists`,
    ).toEqual([]);
  });

  it.each(asCases)('%s/tests names no seed module either', (_label, pkg) => {
    // A test that reaches for the seed is the usual way this rule dies: the
    // production import never appears, but the layer starts being *designed*
    // against seeded shapes.
    const offenders = collectSourceFiles(join(pkg.absoluteDirectory, 'tests')).flatMap(findSeedImports);

    expect(offenders.map((entry) => `${entry.file}:${entry.line} imports ${entry.specifier}`)).toEqual([]);
  });

  it.each(asCases)('%s declares no dependency on the seed package', (_label, pkg) => {
    const declared = {
      ...(pkg.manifest.dependencies ?? {}),
      ...(pkg.manifest.devDependencies ?? {}),
      ...(pkg.manifest.peerDependencies ?? {}),
    };

    expect(Object.keys(declared).filter((name) => name.includes('seed-connector'))).toEqual([]);
  });

  it.each(asCases)('%s does not reference the seed TypeScript project', (_label, pkg) => {
    const config = readJsonFile<{ references?: readonly { path: string }[] }>(
      join(pkg.absoluteDirectory, 'tsconfig.json'),
    );

    expect((config.references ?? []).map((reference) => reference.path).filter((path) => path.includes('seed'))).toEqual(
      [],
    );
  });
});

describe('the isolation gate can actually see a violation', () => {
  it.each([
    ["import { SeedConnector } from '@compass/seed-connector';", '@compass/seed-connector'],
    ["import type { SeedDataset } from '@compass/seed-connector';", '@compass/seed-connector'],
    ["export { SeedConnector } from '@compass/seed-connector';", '@compass/seed-connector'],
    ["const seed = await import('@compass/seed-connector');", '@compass/seed-connector'],
    ["const seed = require('@compass/seed-connector');", '@compass/seed-connector'],
    ["import '@compass/seed-connector';", '@compass/seed-connector'],
    ["import { seedDataset } from '../../seed-connector/src/index.js';", '../../seed-connector/src/index.js'],
  ])('flags %s', (source, specifier) => {
    const found = findSeedImports({ absolutePath: 'virtual', relativePath: 'virtual/probe.ts', text: source });

    expect(found.map((entry) => entry.specifier)).toEqual([specifier]);
  });

  it('does not flag prose that merely names the package', () => {
    const source = [
      '/**',
      ' * The seed connector (@compass/seed-connector) is resolved at the edge and',
      ' * never imported here.',
      ' */',
      "export const layer = 'analysis';",
      '',
    ].join('\n');

    expect(findSeedImports({ absolutePath: 'virtual', relativePath: 'virtual/prose.ts', text: source })).toEqual([]);
  });

  it('reads real files, so an empty scan cannot be mistaken for a clean one', () => {
    for (const pkg of packagesUnderTest) {
      expect(
        collectSourceFiles(join(pkg.absoluteDirectory, 'src')).length,
        `${pkg.relativeDirectory}/src has no source files to scan`,
      ).toBeGreaterThan(0);
    }
  });

  it('finds the seed imports that are legitimate, proving the matcher is not inert', () => {
    const edge = collectSourceFiles(join(REPO_ROOT, 'apps')).flatMap(findSeedImports);

    // The web app and the worker are the process edge: they are allowed — and
    // expected — to resolve a connector.
    expect(edge.length).toBeGreaterThan(0);
  });
});

describe('the same rule is encoded in the dependency-cruiser configuration', () => {
  it('forbids every isolated layer from reaching the seed package', () => {
    const configPath = join(REPO_ROOT, '.dependency-cruiser.cjs');
    expect(existsSync(configPath), '.dependency-cruiser.cjs is missing').toBe(true);

    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('no-seed-connector-below-the-port');
    for (const directoryName of ISOLATED_PACKAGES) {
      expect(config, `the cruiser rule does not cover ${directoryName}`).toMatch(
        new RegExp(`no-seed-connector-below-the-port[\\s\\S]{0,400}${directoryName}`),
      );
    }
  });
});
