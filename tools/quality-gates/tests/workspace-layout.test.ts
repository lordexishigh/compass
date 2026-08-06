import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  listWorkspacePackages,
  packagesIn,
  readJsonFile,
  repoRelative,
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
  it('contains every layer package the architecture names', () => {
    expect(layerPackages.map((workspacePackage) => workspacePackage.directoryName)).toEqual([
      'analysis',
      'auth',
      // Beside `auth` and above `clock` only: plans, seat pricing and subscription entitlement. It
      // holds no database handle — the web app and the worker own persistence, exactly as the
      // narrator writes no rows — which is what lets a fourteen-day trial expiry be unit-tested
      // against a literal instant.
      'billing',
      'clock',
      'connector-port',
      'db',
      'delivery',
      // A live code connector beside `seed-connector`, directly above `connector-port`. Nothing in
      // ingest, the knowledge model, analysis or the renderers may import it: the provider is
      // resolved at the composition root and injected, which
      // `tests/provider-neutrality.test.ts` asserts over source text.
      'github-connector',
      'ingest',
      // A live tracker connector, in exactly the same position as `github-connector` and under the same
      // prohibition: nothing in ingest, the knowledge model, analysis or the renderers may import it.
      // Its own package rather than a provider inside one `connectors` package, because the layer rule
      // is enforced by package boundary — one package holding three providers would let a change to the
      // tracker's response parsing reach the code host's tests, and `tests/provider-neutrality.test.ts`
      // would have nothing to assert over.
      'jira-connector',
      'knowledge-model',
      // Manager Memos: the one write path into the org model. Above `knowledge-model`
      // because it writes through the roster service — the single Absence writer — rather
      // than reaching for the table, and nowhere near `analysis`, which honours a memo by
      // reading it out of the snapshot it already receives.
      'memos',
      // Between `renderers` and `pipeline`: narration's fail-closed fallback is the
      // deterministic template renderer, so it sits above the renderers and calls
      // them, and it writes no rows, so it sits below the pipeline.
      'narrator',
      // The bottom of the graph, beside `clock`: structured logging and the error-reporter
      // scrubber. It depends on nothing — `types: []`, no npm imports, `now` a parameter on
      // every emitter — which is what lets every layer above it emit a log line without
      // inverting the dependency order. The scrubber lives here rather than in the app so
      // the worker and the web edge cannot disagree about what may leave the process.
      'observability',
      'pipeline',
      'renderers',
      'seed-connector',
      // Not a layer in the pipeline: the seeded organization projected into an
      // `AnalysisSnapshot` for any `(team, instant)`. It is a package rather than a test
      // helper because three consumers need it — the analysis suites, the golden fixture
      // suite and the determinism gate — and a helper reachable only by a relative path
      // into `packages/analysis/tests` could not serve the last two without the sort of
      // cross-package relative import the architecture rules forbid.
      'seed-snapshot',
      // A live chat connector, in exactly the same position as the other two live ones and under the same
      // prohibition. Its own package for the same reason: chat is the family Compass stores verbatim, so
      // the per-channel opt-in rules and the scope set that deliberately cannot enumerate a workspace are
      // worth isolating behind a package boundary, rather than folded into a shared `connectors` package
      // where a change to one provider's parsing could reach another's tests.
      'slack-connector',
      // Not a layer either: the published legal and trust content — the subprocessor list, the DPIA,
      // the Article 22 position, the no-individual-ranking stance, terms and the privacy policy — as
      // frozen constants and two pure functions over them. It sits at the very bottom beside `clock`
      // and `observability`, depending on nothing (`types: []`, no npm imports), because three
      // consumers need the same words: the web app renders them, the worker's 30-day notice job
      // diffs the subprocessor digest, and its own suite asserts the claims the acceptance criteria
      // name. Prose duplicated between a page and a job drifts, and the drift is invisible — both
      // copies read correctly on their own.
      'trust',
    ]);
  });

  it('holds every app and tool the deployment needs', () => {
    expect(
      allPackages
        .filter((workspacePackage) => workspacePackage.group !== 'packages')
        .map((workspacePackage) => workspacePackage.relativeDirectory),
    ).toEqual([
      'apps/web',
      'apps/worker',
      'tools/eslint-plugin-compass',
      // The golden report fixtures, their per-field diff and the determinism gate. A
      // package rather than a directory of tests because it also owns the *writer* —
      // `golden:update` — and a fixture format is only reviewable if exactly one thing
      // produces it.
      'tools/golden',
      // The throttled-profile performance runner that owns the LCP and time-travel
      // budgets, beside the numbers it measures.
      'tools/perf-budget',
      'tools/quality-gates',
      // The cold-start smoke test. A package rather than a shell step in a
      // workflow file, so that its assertions are unit-tested and so that
      // `apps/web`'s cold-start test can run the very checks CI runs.
      'tools/smoke',
    ]);
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

  it('runs the dependency-cruiser layer rules as part of `verify`', () => {
    // The architecture rules were declared and never invoked, so the layer order
    // was documented rather than enforced. A gate nothing runs is a comment.
    expect(rootManifest.scripts?.['arch']).toContain('depcruise');
    expect(rootManifest.scripts?.['verify'], '`verify` must run the architecture gate').toContain('run arch');
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

/**
 * Ownership terms, declared once and everywhere.
 *
 * A monorepo where the root says one thing and nineteen workspaces say nothing is not
 * ambiguous only in the abstract: `npm pack`, every SBOM generator and every corporate
 * licence scanner read the *manifest*, not the LICENSE file, and a manifest with no
 * `license` field is reported as "UNKNOWN" — which a procurement review reads as a risk
 * rather than as an omission. So the field is asserted on every workspace rather than on
 * the root alone, and a new package is a build failure until it declares one.
 *
 * The value is `SEE LICENSE IN LICENSE` rather than an SPDX identifier, and that is the
 * correct spelling rather than a cop-out: SPDX ids name *published* licences, and these
 * terms are not one of them. npm documents this exact form for a licence that is not on
 * the SPDX list, and it has the property the bare `UNLICENSED` keyword lacks — it points
 * a reader at the file that states the terms instead of asserting them in four syllables.
 * A permissive identifier here would be a grant nobody made.
 */
describe('every workspace declares who owns it', () => {
  /** The one place the value is written. Every assertion below compares against it. */
  const LICENSE_FIELD = 'SEE LICENSE IN LICENSE';
  const LICENSE_PATH = join(REPO_ROOT, 'LICENSE');

  it('ships a LICENSE at the repository root', () => {
    expect(existsSync(LICENSE_PATH), 'a repository with no LICENSE leaves reuse terms to guesswork').toBe(true);

    const text = readFileSync(LICENSE_PATH, 'utf8');
    expect(text).toContain('All rights reserved');
    expect(text.length, 'a stub LICENSE is worse than none — it looks settled').toBeGreaterThan(500);
  });

  it('names a real holder rather than a placeholder', () => {
    /**
     * `packages/trust/src/content.ts` refuses to publish the `[DATE]`-bearing legal drafts on
     * the grounds that a document with a bracket in it is worse than no document. A LICENSE
     * with `[COMPANY]` in it is the same defect, and it is the single likeliest thing to be
     * left behind when one is added in a hurry.
     */
    const text = readFileSync(LICENSE_PATH, 'utf8');
    const placeholders = text.match(/\[[A-Z][A-Z _-]{2,}\]|<[a-z ]+entity[a-z ]*>|TODO|FIXME|XXX/g) ?? [];

    expect(placeholders, 'the LICENSE still carries a fill-in-the-blank').toEqual([]);
    expect(text, 'the LICENSE names no copyright holder').toMatch(/Copyright \(c\) \d{4} \S/);
  });

  it('points the manifest at that file rather than at an SPDX id it does not have', () => {
    const root = readJsonFile<{ readonly license?: string }>(join(REPO_ROOT, 'package.json'));
    expect(root.license).toBe(LICENSE_FIELD);
  });

  it('resolves the file every manifest points at, so a rename cannot dangle', () => {
    /**
     * The assertion that makes `SEE LICENSE IN <file>` safe to use at all.
     *
     * The value is not a claim about terms, it is a *reference* — and a reference is only worth
     * more than a bare keyword while the thing it names is on disk. Renaming `LICENSE` to
     * `LICENSE.md` breaks 28 manifests at once, silently: every tool that resolves the field gets
     * nothing back, and the ambiguity this whole gate exists to close quietly re-opens with the
     * field still populated and still looking correct.
     *
     * So the filename is parsed out of the declared value rather than hard-coded, and checked.
     * A future move only has to update the manifests, and this fails until it does.
     */
    const manifests = [
      join(REPO_ROOT, 'package.json'),
      ...allPackages.map((workspacePackage) => join(workspacePackage.absoluteDirectory, 'package.json')),
    ];

    const dangling = manifests
      .map((path) => ({ path, license: readJsonFile<{ readonly license?: string }>(path).license }))
      .flatMap(({ path, license }) => {
        const named = /^SEE LICENSE IN (.+)$/.exec(license ?? '')?.[1];
        // Only the referencing form has a file to resolve. A bare SPDX id names a published
        // licence and is answerable without one, so it is not this assertion's business.
        if (named === undefined) return [];
        return existsSync(join(REPO_ROOT, named)) ? [] : [`${repoRelative(path)} → ${named}`];
      });

    expect(dangling, 'these manifests name a licence file that is not at the repository root').toEqual([]);
  });

  it.each(asCases(allPackages))('%s declares it too', (_label, workspacePackage) => {
    const manifest = readJsonFile<{ readonly license?: string; readonly private?: boolean }>(
      join(workspacePackage.absoluteDirectory, 'package.json'),
    );

    expect(manifest.license, `${workspacePackage.relativeDirectory} has no license field`).toBe(LICENSE_FIELD);
    // Proprietary terms and a publishable package would be a contradiction: the field says
    // nobody may use it and the absent `private` flag says npm may publish it to everybody.
    expect(manifest.private, `${workspacePackage.relativeDirectory} is proprietary but publishable`).toBe(true);
  });

  it('says the same thing in every manifest, so no workspace is on different terms', () => {
    /**
     * The assertion the per-package one cannot make. Each case above checks a manifest against
     * the constant; this checks the manifests against *each other*, so a future change that
     * relicenses the repo has to move all 28 together or fail here — a monorepo where one
     * package is BUSL and the rest are proprietary is the ambiguity this gate exists to stop,
     * and it would pass a per-file check that had been edited to match.
     */
    const declared = new Set(
      [join(REPO_ROOT, 'package.json'), ...allPackages.map((p) => join(p.absoluteDirectory, 'package.json'))].map(
        (path) => readJsonFile<{ readonly license?: string }>(path).license ?? '(none)',
      ),
    );

    expect([...declared], 'the workspaces do not agree on their licence').toEqual([LICENSE_FIELD]);
  });
});
