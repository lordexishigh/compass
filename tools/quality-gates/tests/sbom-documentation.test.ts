import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './helpers/workspace.js';

/**
 * The SBOM is generated in CI and its retrieval process is documented — asserted, not asserted-to.
 *
 * ## Why this gate exists
 *
 * The acceptance criterion is *"an SBOM is generated in CI and its retrieval process is documented"*, and
 * the documented process is a set of facts that live in two files at once: `docs/SBOM.md` tells a
 * controller to download an artifact called `compass-sbom` retained for 90 days, and `.github/workflows/
 * ci.yml` is what decides whether an artifact by that name exists at all.
 *
 * Nothing about renaming the artifact, dropping `retention-days`, or deleting the job would fail a build.
 * The published instructions would simply start describing a download that 404s, and the first person to
 * find out would be an auditor. This is the repository's standing pattern for that shape — a code constant,
 * a document quoting it, and a gate diffing the two.
 *
 * ## Why it also runs the generator
 *
 * A documented retrieval process for a document that cannot be produced is worth nothing, and the two ways
 * `tools/sbom.mjs` could fail silently are both asserted here: emitting a *parseable but empty* bill of
 * materials, which a scanner reports as zero vulnerabilities, and emitting a non-deterministic one, which
 * makes `diff` between two builds useless — the single most valuable operation on a pair of SBOMs, and the
 * reason the generator deliberately writes no `metadata.timestamp`.
 *
 * The generator is fed a small fixture rather than a real `pnpm install` tree: this gate must not take
 * ninety seconds, and the properties under test are properties of the transformation.
 */

const workflowText = (): string => readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const docText = (): string => readFileSync(join(REPO_ROOT, 'docs', 'SBOM.md'), 'utf8');

/** The `sbom` job only, so an `upload-artifact` in some other job cannot satisfy these. */
function sbomJob(text: string): string {
  const start = text.indexOf('\n  sbom:');
  expect(start, 'ci.yml has no `sbom` job — the SBOM is no longer generated in CI').toBeGreaterThan(-1);

  const rest = text.slice(start + '\n  sbom:'.length);
  const next = /\n {2}[a-z][a-z0-9-]*:\s*$/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/** Runs `tools/sbom.mjs` over a fixture tree, returning the parsed document and the raw bytes. */
function generate(tree: unknown): { readonly raw: string; readonly document: SbomDocument } {
  const raw = execFileSync(process.execPath, [join(REPO_ROOT, 'tools', 'sbom.mjs')], {
    input: JSON.stringify(tree),
    encoding: 'utf8',
  });
  return { raw, document: JSON.parse(raw) as SbomDocument };
}

interface SbomComponent {
  readonly name: string;
  readonly version: string;
  readonly purl?: string;
  readonly properties: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

interface SbomDocument {
  readonly bomFormat: string;
  readonly specVersion: string;
  readonly metadata: { readonly timestamp?: string };
  readonly components: readonly SbomComponent[];
}

/**
 * A miniature workspace: one direct dependency with a transitive one, a dev dependency, a workspace link,
 * and a cycle. The cycle is the point of the fixture rather than decoration — the npm graph has them, and
 * a walk that recursed into an already-recorded component would overflow on a real lockfile.
 */
const FIXTURE_TREE = [
  {
    name: 'compass',
    version: '0.1.0',
    dependencies: {
      'drizzle-orm': {
        version: '0.45.2',
        dependencies: {
          'cyclic-a': { version: '1.0.0', dependencies: { 'cyclic-b': { version: '2.0.0' } } },
        },
      },
      '@compass/analysis': { version: 'link:../../packages/analysis' },
    },
    devDependencies: {
      vitest: { version: '4.0.0' },
    },
  },
];

// `cyclic-b` points back at `cyclic-a`, closing the loop.
(FIXTURE_TREE[0]!.dependencies['drizzle-orm']!.dependencies['cyclic-a']!.dependencies['cyclic-b'] as Record<
  string,
  unknown
>)['dependencies'] = { 'cyclic-a': { version: '1.0.0' } };

const propertyOf = (component: SbomComponent, name: string): string | undefined =>
  component.properties.find((property) => property.name === name)?.value;

describe('CI generates the SBOM the documentation describes', () => {
  it('has an sbom job that runs the generator and publishes a named artifact', () => {
    const job = sbomJob(workflowText());

    expect(job).toContain('tools/sbom.mjs');
    expect(job).toContain('actions/upload-artifact');
    expect(job).toMatch(/name:\s*compass-sbom/);
  });

  it('publishes under the artifact name and retention the document tells people to expect', () => {
    const job = sbomJob(workflowText());
    const doc = docText();

    /**
     * The artifact name, in both places.
     *
     * `docs/SBOM.md` is what a controller without repository access follows, and `gh run download --name`
     * takes this string literally. A rename on one side is a 404 on the other.
     */
    expect(job).toMatch(/name:\s*compass-sbom/);
    expect(doc).toContain('`compass-sbom`');

    // Retention, likewise: the document promises a window, and `retention-days` is what grants it.
    const retention = /retention-days:\s*(\d+)/.exec(job);
    expect(retention, '`sbom` job publishes no `retention-days`, so the documented window is a guess')
      .not.toBeNull();
    expect(doc).toContain(`${retention?.[1]} days`);
  });

  it('fails the job rather than publishing nothing when generation breaks', () => {
    // `if-no-files-found: warn` would turn a broken generator into a green run with no artifact, which is
    // the failure this whole gate is about: the instructions stay published and the download stops working.
    expect(sbomJob(workflowText())).toContain('if-no-files-found: error');
  });

  it('documents the retrieval path, not merely the existence of a file', () => {
    const doc = docText();

    // The three things somebody actually needs: what it is called, how to get it with access, and who to
    // ask without access.
    expect(doc).toContain('gh run download');
    expect(doc).toContain('trust@compass.example');
    expect(doc).toContain('tools/sbom.mjs');
  });
});

describe('the generated document', () => {
  it('is CycloneDX and lists transitive and build dependencies, not just direct runtime ones', () => {
    const { document } = generate(FIXTURE_TREE);
    const names = document.components.map((component) => component.name);

    expect(document.bomFormat).toBe('CycloneDX');
    expect(document.specVersion).toBe('1.5');

    expect(names).toContain('drizzle-orm'); // direct
    expect(names).toContain('cyclic-a'); // transitive — the half a CVE announcement is about
    expect(names).toContain('vitest'); // dev — a compromised test runner reaches the artifact too
  });

  it('records workspace packages as such rather than dropping or mis-versioning them', () => {
    const { document } = generate(FIXTURE_TREE);
    const workspace = document.components.find((component) => component.name === '@compass/analysis');

    expect(workspace, '@compass/analysis vanished from the inventory').toBeDefined();
    expect(propertyOf(workspace!, 'compass:workspace')).toBe('true');
    // No purl: a link resolves to a path and has no published version to point a scanner at.
    expect(workspace?.purl).toBeUndefined();
    expect(workspace?.version).toBe('0.0.0-workspace');

    const thirdParty = document.components.find((component) => component.name === 'drizzle-orm');
    expect(propertyOf(thirdParty!, 'compass:workspace')).toBe('false');
    expect(thirdParty?.purl).toBe('pkg:npm/drizzle-orm@0.45.2');
  });

  it('encodes the scope separator in a purl so scanners can resolve a scoped package', () => {
    const { document } = generate([
      { name: 'compass', dependencies: { '@anthropic-ai/sdk': { version: '0.115.0' } } },
    ]);

    // A raw `/` in the name segment is not a valid purl, and a scanner that cannot parse the purl reports
    // nothing about the package — a silent gap rather than an error.
    expect(document.components[0]?.purl).toBe('pkg:npm/%40anthropic-ai/sdk@0.115.0');
  });

  it('terminates on a cyclic graph', () => {
    // Asserted by the fixture completing at all: `cyclic-b` depends on `cyclic-a`. If the walk recursed
    // into already-recorded components this would be a stack overflow, and it would first happen on a real
    // lockfile in CI rather than here.
    const { document } = generate(FIXTURE_TREE);
    expect(document.components.filter((component) => component.name === 'cyclic-a')).toHaveLength(1);
  });

  it('is byte-identical across runs of the same tree, and carries no timestamp', () => {
    const first = generate(FIXTURE_TREE);
    const second = generate(FIXTURE_TREE);

    /**
     * The reason `metadata.timestamp` is deliberately absent.
     *
     * `diff` between two SBOMs answers "did our dependencies change between these builds", which is the
     * most useful thing a pair of them is for. A clock reading in the file makes every pair differ.
     */
    expect(first.raw).toBe(second.raw);
    expect(first.document.metadata.timestamp).toBeUndefined();
  });

  it('sorts components by name then version, so a package is not split apart', () => {
    const { document } = generate([
      {
        name: 'compass',
        dependencies: {
          'code-transformer-bundler-plugins': { version: '0.7.3' },
          'code-transformer': { version: '0.18.1' },
        },
      },
    ]);

    // Sorting a joined `name@version` key would file `code-transformer-bundler-plugins` first, because `-`
    // sorts before `@`. Deterministic either way; only one of them is readable.
    expect(document.components.map((component) => component.name)).toEqual([
      'code-transformer',
      'code-transformer-bundler-plugins',
    ]);
  });

  it('refuses to emit an empty bill of materials', () => {
    /**
     * The most dangerous output this tool could produce.
     *
     * A CycloneDX document with zero components parses cleanly and every scanner reports zero
     * vulnerabilities against it. A *missing* SBOM is a visible failure; an empty one is a false assurance
     * that looks exactly like a clean bill of health.
     */
    expect(() => generate([{ name: 'compass', version: '0.1.0' }])).toThrow();
  });
});
