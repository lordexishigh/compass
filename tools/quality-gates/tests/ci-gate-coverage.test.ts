import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, listWorkspacePackages } from './helpers/workspace.js';

/**
 * Every workspace that has a test suite runs under a *named* gate in CI.
 *
 * ## Why this gate exists
 *
 * `ci.yml` fans `pnpm test` out across the workspace so a failure names the gate in the check title
 * rather than only in a 3,000-line log. The fan-out is a hand-maintained matrix, and a hand-maintained
 * list of workspaces drifts the moment somebody adds a package: `@compass/billing` and
 * `@compass/github-connector` were both added with suites and neither appeared in the matrix, so their
 * tests ran only inside the whole-workspace `verify` sweep and reported under *its* name.
 *
 * That is the same false-green the fan-out was built to prevent, one level up — and it is invisible,
 * because the sweep is green and the matrix is green and nothing says a package is missing from one of
 * them. So the coverage is asserted here instead of remembered.
 *
 * ## Why it reads the workflow as text
 *
 * The matrix is parsed with a regex over `--filter <name>` rather than by loading the YAML. There is
 * no YAML parser in this repository's dependency tree, and adding one to assert a list of package names
 * would be a dependency bought for a substring search. The flags are spelled out literally in `ci.yml`
 * — a deliberate choice its own comment explains — which is exactly what makes them safe to read this
 * way.
 */

const CI_WORKFLOW = 'ci.yml';

const workflowText = (): string =>
  readFileSync(join(REPO_ROOT, '.github', 'workflows', CI_WORKFLOW), 'utf8');

/** The `gate-suites` block, so a `--filter` in some other job cannot satisfy this. */
function gateSuitesBlock(text: string): string {
  const start = text.indexOf('  gate-suites:');
  expect(start, `${CI_WORKFLOW} has no \`gate-suites\` job`).toBeGreaterThan(-1);

  // Ends at the next top-level job key — two spaces, a name, a colon, end of line.
  const rest = text.slice(start + '  gate-suites:'.length);
  const next = /\n {2}[a-z][a-z0-9-]*:\s*$/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

const filteredPackages = (block: string): readonly string[] =>
  [...block.matchAll(/--filter\s+(\S+)/g)].map((match) => match[1] ?? '');

/** Workspaces that actually have something to run. A package with no `test` script is not a gap. */
const testablePackages = () =>
  listWorkspacePackages().filter((workspacePackage) => {
    const scripts = workspacePackage.manifest.scripts ?? {};
    return typeof scripts['test'] === 'string' && scripts['test'].length > 0;
  });

describe('the CI suite fan-out covers the whole workspace', () => {
  it('finds a gate-suites matrix with filters in it', () => {
    const filters = filteredPackages(gateSuitesBlock(workflowText()));

    // Guards the two regexes above: a renamed job or a restructured matrix would otherwise reduce
    // every assertion below to a vacuous pass over an empty list.
    expect(filters.length, 'no `--filter` flags were parsed out of gate-suites').toBeGreaterThan(5);
    expect(filters.every((name) => name.startsWith('@compass/'))).toBe(true);
  });

  it('names every workspace that has a test script', () => {
    const covered = new Set(filteredPackages(gateSuitesBlock(workflowText())));
    const missing = testablePackages()
      .map((workspacePackage) => workspacePackage.name)
      .filter((name) => !covered.has(name))
      .sort();

    expect(
      missing,
      'these workspaces have a `test` script but no leg in `gate-suites`, so their failures would be ' +
        'reported under the whole-workspace sweep rather than under a gate that names them. Add a ' +
        '`--filter` for each to .github/workflows/ci.yml.',
    ).toEqual([]);
  });

  it('does not filter a workspace that no longer exists', () => {
    // The other direction. A filter naming a deleted package makes `pnpm --filter` match nothing, and
    // `pnpm test` over an empty selection *succeeds* — so the leg stays green while testing nothing.
    const declared = new Set(listWorkspacePackages().map((workspacePackage) => workspacePackage.name));
    const stale = filteredPackages(gateSuitesBlock(workflowText()))
      .filter((name) => !declared.has(name))
      .sort();

    expect(
      stale,
      'these filters name packages that are not in the workspace; `pnpm --filter` would select nothing ' +
        'and the leg would pass without running a test.',
    ).toEqual([]);
  });
});

/**
 * The assembled product is gated, not just the source.
 *
 * The gap this closes was the whole of the build-quality review's lowest score: `pnpm verify` was
 * green — lint, architecture, typecheck and 7,500 tests — while the final smoke test was red, which
 * means every gate ran against the *source* and none against the artifact anybody would deploy.
 *
 * `pnpm verify` cannot close it, and should not: `pnpm smoke` fetches a URL, so it needs a booted
 * container and a live PostgreSQL. A static check cannot own that. So the gate is a separate job, and
 * what this test asserts is that the job still exists and still runs the documented path end to end.
 * Deleting it, renaming its steps, or quietly dropping the fetch now fails a test rather than turning
 * one check grey in a list nobody reads.
 *
 * Read as text for the reason the matrix above is: there is no YAML parser in this dependency tree,
 * and adding one to search for job names would be a dependency bought for a substring search.
 */
describe('the cold-start smoke job gates the assembled product', () => {
  const coldStartJob = (): string => {
    const text = workflowText();
    const start = text.indexOf('  cold-start:');
    expect(start, `${CI_WORKFLOW} has no \`cold-start\` job — the assembled product would be ungated`).toBeGreaterThan(
      -1,
    );
    const rest = text.slice(start + '  cold-start:'.length);
    const next = /\n {2}[a-z][a-z0-9-]*:\s*$/m.exec(rest);
    return next === null ? rest : rest.slice(0, next.index);
  };

  it('builds and boots the real container rather than a test harness', () => {
    const job = coldStartJob();

    expect(job).toContain('docker compose build');
    expect(job).toContain('docker compose up -d');
  });

  it('runs the smoke test, which is what actually fetches the report', () => {
    // `pnpm run smoke` is `tools/smoke`'s CLI: it GETs `/`, asserts all six section landmarks and
    // then follows the first evidence link. Asserting the command rather than its behaviour here —
    // `tools/smoke/tests/report-html.test.ts` owns the behaviour.
    expect(coldStartJob()).toContain('pnpm run smoke');
  });

  it('is a job of its own, so its failure is a named check rather than a line in `verify`', () => {
    const text = workflowText();

    // The root script exists and is what CI calls, so a developer can run the same gate locally.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      readonly scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.['smoke']).toBeDefined();
    expect(manifest.scripts?.['smoke:docker']).toContain('docker compose up');

    // And `verify` deliberately does not invoke it: a gate that needs a container must not make
    // `pnpm verify` fail on a laptop with no Docker, which is how a gate gets commented out.
    expect(manifest.scripts?.['verify']).not.toContain('smoke');
    expect(text).toContain('name: docker compose cold start');
  });

  it('tears the container down and prints its logs when the smoke test fails', () => {
    // A red smoke job whose only artifact is "exit 1" gets rerun rather than read.
    const job = coldStartJob();

    expect(job).toContain('docker compose logs');
    expect(job).toContain('docker compose down');
  });
});

/**
 * The credential-literal rule is wired over shipped source, and stays wired.
 *
 * `no-secret-disclosure` banned a credential *leaving* the process and had nothing to say about one
 * sitting in the source: `packages/auth/src/bootstrap.ts` held a working owner password behind a
 * comment calling it a demonstration default, and every gate in `eslint.config.js` passed it.
 *
 * A `RuleTester` in `tools/eslint-plugin-compass` proves the rule reports. This proves the wiring,
 * which is the half that actually protects anything — a rule registered against the wrong glob
 * passes every unit test and guards nothing.
 */
describe('compass/no-credential-literal is registered over shipped source', () => {
  const configText = (): string => readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');

  it('is an error, not a warning', () => {
    expect(configText()).toContain("'compass/no-credential-literal': 'error'");
  });

  it('covers every package’s and app’s own source', () => {
    const config = configText();

    expect(config).toContain('SHIPPED_SOURCES');
    expect(config).toContain("'packages/*/src/**/*.{ts,tsx}'");
    expect(config).toContain("'apps/*/src/**/*.{ts,tsx}'");
    // The web app keeps shipped code outside `src/`, so omitting these would leave every route
    // handler and Server Component unguarded.
    for (const directory of ['app', 'components', 'lib']) {
      expect(config, `apps/web/${directory} is not covered`).toContain(`'apps/web/${directory}/**/*.{ts,tsx}'`);
    }
  });

  it('no longer has a credential literal to find in the file that had one', () => {
    /**
     * The defect itself, asserted as absent. A reader adding a default back would fail lint; this
     * fails even if somebody disabled the rule for that file.
     *
     * Matched as an *assignment* rather than as a mention, because the file names the removed
     * constant on purpose — the comment above `DEMO_OWNER_EMAIL` explains what used to sit beside
     * it and why it does not any more, and that explanation is the thing most likely to stop
     * somebody putting it back.
     */
    const bootstrap = readFileSync(join(REPO_ROOT, 'packages', 'auth', 'src', 'bootstrap.ts'), 'utf8');

    expect(bootstrap).not.toMatch(/DEMO_OWNER_PASSWORD\s*(?::[^=]*)?=/);
    expect(bootstrap).toContain('generateOwnerPassword');
    expect(bootstrap).toContain('MissingOwnerPasswordError');
  });
});
