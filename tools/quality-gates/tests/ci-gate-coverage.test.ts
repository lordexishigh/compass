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
