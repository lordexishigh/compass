#!/usr/bin/env node
/**
 * Turns `pnpm list --recursive --depth Infinity --json` into a CycloneDX 1.5 bill of materials.
 *
 * ## Why this is fifty lines and not a dependency
 *
 * A supply-chain artifact generated *by* an unaudited third-party tool is a slightly awkward thing to
 * hand a security reviewer, and the transformation is a walk over a tree. `pnpm list` already knows the
 * exact graph `--frozen-lockfile` installed, which is the thing a vulnerability question is about; the
 * only work left is naming each component in the format scanners read.
 *
 * ## What ends up in it
 *
 * Every dependency at every depth, production and development alike. `--prod` would have produced a
 * shorter and less honest document: a compromised bundler or test runner reaches the built artifact just
 * as surely as a runtime dependency, so excluding them would answer the easy half of the question.
 *
 * Workspace packages are marked with a `compass:workspace` property rather than dropped. They are not
 * third-party risk, but a reviewer tracing "what is in this image" should not have to guess why
 * `@compass/analysis` is absent from a list of components.
 *
 * Reads stdin so it is testable and so a `pnpm list` failure surfaces as pnpm's own non-zero exit rather
 * than as an empty document that looks like a clean bill.
 */

/** Byte-order string compare. `localeCompare` is locale-sensitive, and the output must not be. */
const cmp = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** `pkg:npm/name@version`, with the scope's `/` encoded as the purl spec requires. */
const purlFor = (name, version) => {
  if (name.startsWith('@')) {
    const [scope, unscoped] = name.slice(1).split('/');
    return `pkg:npm/%40${scope}/${unscoped}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
};

/**
 * Walks every dependency map pnpm emits, at every depth.
 *
 * Keyed by `name@version` so one component appears once however many paths reach it — a graph, not a
 * tree, and a bill of materials that listed `tslib` forty times would be unreadable and would imply
 * forty copies.
 */
function collect(nodes, into) {
  for (const node of nodes) {
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'unsavedDependencies']) {
      const entries = node?.[group];
      if (entries === undefined || entries === null || typeof entries !== 'object') continue;

      for (const [name, detail] of Object.entries(entries)) {
        const version = typeof detail?.version === 'string' ? detail.version : null;
        if (version === null) continue;

        // A workspace link resolves to a path rather than a semver version. Recorded as such instead of
        // being emitted as a component with a nonsense version.
        const isWorkspace = version.startsWith('link:') || version.startsWith('file:');
        const key = `${name}@${version}`;

        // Seen already: skip *and do not recurse*. The npm graph has cycles — a package can be reachable
        // from its own transitive dependencies — so recursing on an already-recorded component is how this
        // walk would overflow the stack on a real lockfile rather than on a contrived one.
        if (into.has(key)) continue;

        into.set(key, {
          type: 'library',
          name,
          version: isWorkspace ? '0.0.0-workspace' : version,
          ...(isWorkspace ? {} : { purl: purlFor(name, version) }),
          properties: [
            { name: 'compass:workspace', value: String(isWorkspace) },
            { name: 'compass:scope', value: group === 'dependencies' ? 'runtime' : 'build' },
          ],
        });

        // pnpm nests the resolved graph under each entry when `--depth Infinity` is given.
        collect([detail], into);
      }
    }
  }
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let listed;
  try {
    // The BOM is stripped rather than tolerated by accident: `pnpm list > file` under PowerShell writes
    // one, and `JSON.parse` rejects it, so a developer reproducing the CI step on Windows would otherwise
    // hit a parse error that says nothing about what is actually wrong.
    //
    // Written as `\uFEFF` rather than as the character itself. A literal BOM in the source is invisible
    // in every editor and indistinguishable from a stray non-breaking space, which is exactly why
    // `no-irregular-whitespace` refuses one — and the escape says what it is.
    listed = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  } catch (cause) {
    process.stderr.write(
      'SBOM: could not parse `pnpm list --json` output.\n' +
        `  ${cause instanceof Error ? cause.message : String(cause)}\n` +
        '  This is a failure rather than an empty document on purpose: a bill of materials with no\n' +
        '  components is indistinguishable from a clean one.\n',
    );
    process.exitCode = 2;
    return;
  }

  const components = new Map();
  collect(Array.isArray(listed) ? listed : [listed], components);

  if (components.size === 0) {
    process.stderr.write('SBOM: no components were found, which cannot be right. Refusing to emit.\n');
    process.exitCode = 2;
    return;
  }

  /**
   * No `metadata.timestamp`.
   *
   * Deliberately: a timestamp makes two SBOMs of the identical dependency graph differ, so "did our
   * dependencies change between these builds" stops being answerable with `diff`. The build that produced
   * it is identified by the workflow run that holds the artifact.
   */
  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'compass', version: '0.1.0' },
      tools: [{ vendor: 'Compass', name: 'tools/sbom.mjs', version: '1' }],
    },
    // Sorted on the fields rather than on a joined `name@version` key: `-` sorts before `@`, so joining
    // would file `foo-bar` in between `foo` and `foo@2`, and a reviewer scanning for a package would find
    // its versions split apart. Deterministic either way; only one of them is readable.
    components: [...components.values()].sort(
      (left, right) => cmp(left.name, right.name) || cmp(left.version, right.version),
    ),
  };

  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
});
