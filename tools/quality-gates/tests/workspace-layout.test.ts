import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  listWorkspacePackages,
  packagesIn,
  readJsonFile,
  type WorkspacePackage,
} from './helpers/workspace.js';

interface RootManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

interface TsconfigReferences {
  readonly references?: readonly { readonly path: string }[];
}

interface TsconfigPaths {
  readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> };
}

const rootManifest = readJsonFile<RootManifest>(join(REPO_ROOT, 'package.json'));
const buildProject = readJsonFile<TsconfigReferences>(join(REPO_ROOT, 'tsconfig.build.json'));
const testsProject = readJsonFile<TsconfigPaths>(join(REPO_ROOT, 'tsconfig.tests.json'));

const layerPackages = packagesIn('packages');
const allPackages = listWorkspacePackages();

/** `[label, package]` tuples so `it.each` prints the directory under test. */
const asCases = (packages: readonly WorkspacePackage[]) =>
  packages.map((workspacePackage) => [workspacePackage.relativeDirectory, workspacePackage] as const);

describe('the pnpm workspace holds every layer as its own package', () => {
  it('contains the seven layer packages the architecture names', () => {
    expect(layerPackages.map((workspacePackage) => workspacePackage.directoryName)).toEqual([
      'analysis',
      'clock',
      'connector-port',
      'db',
      'ingest',
      'knowledge-model',
      'pipeline',
      'renderers',
      'seed-connector',
    ]);
  });

  it('holds every app and tool the deployment needs', () => {
    expect(
      allPackages
        .filter((workspacePackage) => workspacePackage.group !== 'packages')
        .map((workspacePackage) => workspacePackage.relativeDirectory),
    ).toEqual(['apps/web', 'apps/worker', 'tools/eslint-plugin-compass', 'tools/quality-gates']);
  });

  it.each(asCases(layerPackages))('%s has its own package.json, tsconfig and vitest config', (_label, pkg) => {
    for (const required of ['package.json', 'tsconfig.json', 'vitest.config.ts']) {
      expect(existsSync(join(pkg.absoluteDirectory, required)), `${pkg.relativeDirectory}/${required} is missing`).toBe(
        true,
      );
    }
  });

  it.each(asCases(layerPackages))('%s exports through a src/index.ts barrel', (_label, pkg) => {
    expect(existsSync(join(pkg.absoluteDirectory, 'src', 'index.ts')), `${pkg.relativeDirectory} has no barrel`).toBe(
      true,
    );
  });

  it.each(asCases(layerPackages))('%s keeps its tests in tests/', (_label, pkg) => {
    expect(existsSync(join(pkg.absoluteDirectory, 'tests')), `${pkg.relativeDirectory}/tests is missing`).toBe(true);
  });

  it.each(asCases(allPackages))('%s declares a test script', (_label, pkg) => {
    expect(pkg.manifest.scripts?.['test'], `${pkg.relativeDirectory} has no test script`).toBeDefined();
  });

  it.each(asCases(layerPackages))('%s declares a build script', (_label, pkg) => {
    expect(pkg.manifest.scripts?.['build'], `${pkg.relativeDirectory} has no build script`).toBe('tsc -b');
  });
});

describe('pnpm test reports per-package results', () => {
  it('runs every package recursively rather than a hand-maintained list', () => {
    expect(rootManifest.scripts?.['test']).toContain('pnpm -r');
    expect(rootManifest.scripts?.['test']).toContain('run test');
  });

  it.each(asCases(allPackages.filter((pkg) => existsSync(join(pkg.absoluteDirectory, 'vitest.config.ts')))))(
    '%s names its vitest project after itself, so its results are attributable',
    async (_label, pkg) => {
      const configUrl = pathToFileURL(join(pkg.absoluteDirectory, 'vitest.config.ts')).href;
      const module = (await import(/* @vite-ignore */ configUrl)) as {
        default?: { test?: { name?: string; passWithNoTests?: boolean } };
      };

      expect(module.default?.test?.name, `${pkg.relativeDirectory} does not name its vitest project`).toBe(pkg.name);
      // A package that silently has no tests must fail the run, not look green.
      expect(module.default?.test?.passWithNoTests).toBe(false);
    },
  );
});

describe('the TypeScript project graph matches the packages on disk', () => {
  it('type-checks every buildable package through tsconfig.build.json', () => {
    const referenced = (buildProject.references ?? []).map((reference) => reference.path).sort();
    const buildable = allPackages
      .filter((pkg) => pkg.manifest.scripts?.['build'] === 'tsc -b')
      .map((pkg) => pkg.relativeDirectory)
      .sort();

    expect(referenced).toEqual(buildable);
  });

  it('points every project reference at a real tsconfig', () => {
    for (const reference of buildProject.references ?? []) {
      expect(
        existsSync(join(REPO_ROOT, reference.path, 'tsconfig.json')),
        `${reference.path} is referenced but has no tsconfig.json`,
      ).toBe(true);
    }
  });

  it('excludes tests from the build project, so `pnpm build` checks shipped code only', () => {
    for (const pkg of layerPackages) {
      const config = readJsonFile<{ include?: readonly string[] }>(join(pkg.absoluteDirectory, 'tsconfig.json'));
      expect(config.include, `${pkg.relativeDirectory} must compile src only`).toEqual(['src/**/*.ts']);
    }
  });

  it('maps every layer package to its source for the tests project', () => {
    const paths = testsProject.compilerOptions?.paths ?? {};

    for (const pkg of layerPackages) {
      const expected = `${pkg.relativeDirectory}/src/index.ts`;
      expect(paths[pkg.name], `${pkg.name} has no path mapping in tsconfig.tests.json`).toEqual([expected]);
    }
  });
});

describe('the connector-port testkit is reachable as a subpath', () => {
  const connectorPort = layerPackages.find((pkg) => pkg.directoryName === 'connector-port');

  it('declares ./testkit in its exports map', () => {
    const exportsMap = connectorPort?.manifest.exports as Record<string, unknown> | undefined;

    expect(exportsMap?.['.'], 'the main barrel must stay exported').toBeDefined();
    expect(exportsMap?.['./testkit'], 'seed-connector imports the contract suite from this subpath').toBeDefined();
  });

  it('has a matching path mapping so the contract suite type-checks', () => {
    const paths = testsProject.compilerOptions?.paths ?? {};

    expect(paths['@compass/connector-port/testkit']).toEqual([
      'packages/connector-port/src/testkit/index.ts',
    ]);
  });

  it('keeps the testkit out of the runtime barrel', () => {
    // The testkit imports vitest. Re-exporting it from the main barrel would drag
    // a test runner into every runtime dependent of @compass/connector-port.
    const barrel = readFileSync(join(REPO_ROOT, 'packages/connector-port/src/index.ts'), 'utf8');

    expect(barrel).not.toContain('./testkit');
  });
});
