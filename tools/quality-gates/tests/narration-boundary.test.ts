import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NARRATION_MAX_ATTEMPTS } from '@compass/narrator';
import { describe, expect, it } from 'vitest';

import { blankComments } from './helpers/imports.js';
import { REPO_ROOT, allAuthoredSourceFiles, listWorkspacePackages, type SourceFile } from './helpers/workspace.js';

/**
 * The narration boundary, checked textually.
 *
 * `.dependency-cruiser.cjs` cannot enforce this. Its `options.exclude` drops every
 * `node_modules` path out of the module graph, so a rule whose `to` names one never
 * matches and passes whatever the code does — the same silently-dead-rule failure
 * the `no-cross-package-relative-imports` comment in that file records. So this gate
 * reads the files instead and answers to no resolver and no configuration.
 *
 * Three properties, and each one is load-bearing for the product's central claim
 * that the LLM originates no factual claim:
 *
 *  1. **One caller.** The Anthropic SDK is imported in exactly one package. A second
 *     caller would be a second place a model could put a sentence in front of a
 *     manager without passing the grounding validator.
 *  2. **No tools.** The narration request carries no tool surface. A `tools` array
 *     anywhere in the narrator would give the model a way to fetch content that was
 *     never in the payload the validator checks against.
 *  3. **No key reading below the edge.** `ANTHROPIC_API_KEY` is read at a process
 *     edge and handed down, exactly like the clock and the connector.
 */

const SDK_SPECIFIER = '@anthropic-ai/sdk';
const SDK_SCOPE = '@anthropic-ai/';

/** The one package allowed to talk to the model. */
const NARRATOR_PACKAGE = 'packages/narrator';

/**
 * Process edges: the two places allowed to resolve a narrator from the environment.
 *
 * The same list as the clock's edges, for the same reason — a request handler and a
 * job loop are where the outside world is read, and everything below them is told.
 */
const ALLOWED_KEY_READERS: readonly string[] = [
  'packages/narrator/src/anthropic-narrator.ts',
  'apps/web/lib/report-source.ts',
  'apps/worker/src/',
];

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

interface Hit {
  readonly location: string;
  readonly detail: string;
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

function sdkImportsIn(file: SourceFile): readonly Hit[] {
  const code = blankComments(file.text);
  const hits: Hit[] = [];

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith(SDK_SCOPE)) continue;
      hits.push({ location: `${file.relativePath}:${lineOf(code, match.index)}`, detail: specifier });
    }
  }

  return hits;
}

const authored = allAuthoredSourceFiles();

describe('the Anthropic SDK has exactly one caller', () => {
  it('finds the SDK imported somewhere, so this gate is not vacuous', () => {
    // A gate that passes because the thing it polices has vanished is worse than no
    // gate. If narration is ever removed, this fails and says so.
    const all = authored.flatMap(sdkImportsIn);
    expect(all.length, `no file imports ${SDK_SPECIFIER}; has narration been removed?`).toBeGreaterThan(0);
  });

  it('imports it only from the narrator package', () => {
    const offenders = authored
      .filter((file) => !file.relativePath.startsWith(`${NARRATOR_PACKAGE}/`))
      .flatMap(sdkImportsIn);

    expect(
      offenders.map((hit) => `${hit.location} imports ${hit.detail}`),
      'narration is the only LLM use in the report path',
    ).toEqual([]);
  });

  it('imports it from exactly one module inside that package', () => {
    const inside = authored
      .filter((file) => file.relativePath.startsWith(`${NARRATOR_PACKAGE}/src/`))
      .filter((file) => sdkImportsIn(file).length > 0)
      .map((file) => file.relativePath);

    expect(inside).toEqual([`${NARRATOR_PACKAGE}/src/anthropic-narrator.ts`]);
  });

  it('declares the SDK in the narrator manifest and nowhere else', () => {
    const declaring = listWorkspacePackages()
      .filter((workspacePackage) => {
        const manifest = workspacePackage.manifest;
        return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(
          (group) => group !== undefined && Object.keys(group).some((name) => name.startsWith(SDK_SCOPE)),
        );
      })
      .map((workspacePackage) => workspacePackage.relativeDirectory);

    expect(declaring).toEqual([NARRATOR_PACKAGE]);
  });
});

describe('the narration request carries no tool surface', () => {
  const narratorSources = authored.filter((file) => file.relativePath.startsWith(`${NARRATOR_PACKAGE}/src/`));

  it('has sources to scan', () => {
    expect(narratorSources.length).toBeGreaterThan(0);
  });

  /**
   * The forbidden request keys.
   *
   * Tool use on the Messages API is opt-in: a request with no `tools` key cannot
   * produce a `tool_use` block, so the narrator has no way to search the web, fetch a
   * URL, run code or read a file. This looks for the keys that would opt in.
   */
  it.each([
    ['tools', /\btools\s*:/],
    ['tool_choice', /\btool_choice\s*:/],
    ['mcp_servers', /\bmcp_servers\s*:/],
    ['container', /\bcontainer\s*:/],
    ['betas', /\bbetas\s*:/],
  ])('sets no `%s` anywhere in the narrator', (key, pattern) => {
    const offenders: string[] = [];

    for (const file of narratorSources) {
      const code = blankComments(file.text);
      for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
        offenders.push(`${file.relativePath}:${lineOf(code, match.index)}`);
      }
    }

    expect(offenders, `\`${key}\` would give the narrator a way to fetch content the validator never saw`).toEqual([]);
  });

  it('performs no I/O of its own beyond the SDK call', () => {
    const offenders: string[] = [];

    for (const file of narratorSources) {
      const code = blankComments(file.text);
      for (const pattern of [/(?<![.\w])fetch\s*\(/g, /\breadFileSync\b/g, /\bnode:fs\b/g, /\bnode:http/g]) {
        for (const match of code.matchAll(pattern)) {
          offenders.push(`${file.relativePath}:${lineOf(code, match.index)} — ${match[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * "N documented in the repo" is an acceptance criterion, so the documentation and
 * the constant are checked against each other rather than both being trusted.
 *
 * A number written in prose next to a number written in code is two sources of truth
 * unless something compares them, and the one that drifts is always the prose.
 */
describe('the retry count is documented', () => {
  const development = readFileSync(join(REPO_ROOT, 'docs/DEVELOPMENT.md'), 'utf8');

  it('has a narration and grounding section', () => {
    expect(development).toContain('## Narration and grounding');
  });

  it('states N as the number the code uses', () => {
    expect(development).toContain(`**N is ${NARRATION_MAX_ATTEMPTS}.**`);
  });

  it('names the constant, so a reader can go and check', () => {
    expect(development).toContain('NARRATION_MAX_ATTEMPTS');
    expect(development).toContain('packages/narrator/src/narrate.ts');
  });

  it('documents that the fallback is recorded on the report row and shown to the reader', () => {
    expect(development).toContain('fallback_renderer');
    expect(development).toContain('fallback_reason');
  });
});

describe('the API key is read at a process edge', () => {
  /**
   * Product source only.
   *
   * A test that names the key is asserting what the resolver does with it — that an
   * absent key yields no narrator — which is the opposite of a violation. Comments
   * are blanked first, so the several files that *explain* the zero-config default in
   * prose are not offenders either.
   */
  const productSource = authored.filter((file) => !file.relativePath.includes('/tests/'));

  it('is named only where a narrator is resolved from the environment', () => {
    const offenders: string[] = [];

    for (const file of productSource) {
      const code = blankComments(file.text);
      if (!code.includes('ANTHROPIC_API_KEY')) continue;
      if (ALLOWED_KEY_READERS.some((allowed) => file.relativePath.startsWith(allowed))) continue;
      offenders.push(file.relativePath);
    }

    expect(offenders, 'the key is resolved at the edge and handed down, like the clock and the connector').toEqual([]);
  });

  it('is read in exactly one place, so the resolver is the only door', () => {
    const readers = productSource
      .filter((file) => blankComments(file.text).includes('ANTHROPIC_API_KEY'))
      .map((file) => file.relativePath);

    expect(readers).toEqual(['packages/narrator/src/anthropic-narrator.ts']);
  });
});
