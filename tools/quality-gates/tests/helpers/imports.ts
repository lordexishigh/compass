import type { SourceFile } from './workspace.js';

/**
 * A textual scan for forbidden imports and impure expressions, run independently
 * of ESLint and of the module resolver.
 *
 * Three gates cover the analysis core's purity and they fail in different ways
 * on purpose:
 *
 *  - **Module resolution.** `@compass/analysis` declares no dependencies, so
 *    importing one is usually a build error. It is silent, though, if somebody
 *    adds the dependency to the manifest at the same time.
 *  - **ESLint** (`compass/no-analysis-io`) reports at the import statement. It is
 *    silent if the plugin stops loading or a `files` glob is edited.
 *  - **This scan.** It reads the files directly and answers to no configuration,
 *    so the other two cannot be switched off without it noticing.
 *
 * Comments are blanked before scanning, so the prose in `instant.ts` that
 * *mentions* `Date` and `Intl` is not a violation. Line and column numbers are
 * preserved through the blanking, because the acceptance criterion is that the
 * gate names the module and the import — a failure that says only "something,
 * somewhere" is a failure nobody can act on.
 */

export interface ForbiddenImport {
  readonly file: string;
  readonly line: number;
  /** `packages/analysis/src/x.ts:12` — the location the gate must name. */
  readonly location: string;
  /** The import specifier or expression that is not allowed. */
  readonly specifier: string;
  readonly category: 'node_builtin' | 'workspace_package' | 'library' | 'expression';
  readonly why: string;
}

/** Node built-ins that perform I/O, read host state or generate randomness. */
export const FORBIDDEN_NODE_BUILTINS = [
  'assert',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'repl',
  'stream',
  'timers',
  'tls',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
] as const;

/** Workspace layers the analysis core must not reach for — including the clock. */
export const FORBIDDEN_WORKSPACE_PACKAGES = [
  '@compass/clock',
  '@compass/connector-port',
  '@compass/db',
  '@compass/ingest',
  '@compass/knowledge-model',
  '@compass/pipeline',
  '@compass/renderers',
  '@compass/seed-connector',
] as const;

export const FORBIDDEN_LIBRARIES = [
  'drizzle-orm',
  'pg',
  'pg-boss',
  'postgres',
  'node-fetch',
  'axios',
  'undici',
  'zod',
  'dayjs',
  'luxon',
  'moment',
  'date-fns',
] as const;

/** Expressions that are nondeterministic, read the host, or perform I/O. */
const FORBIDDEN_EXPRESSIONS: readonly { readonly label: string; readonly pattern: RegExp; readonly why: string }[] = [
  { label: 'Math.random()', pattern: /\bMath\s*\.\s*random\s*\(/g, why: 'randomness makes a report irreproducible' },
  {
    label: 'crypto.randomUUID()',
    pattern: /\bcrypto\s*\.\s*(randomUUID|getRandomValues|randomBytes)\s*\(/g,
    why: 'randomness makes a report irreproducible',
  },
  { label: 'process.env', pattern: /\bprocess\s*\.\s*env\b/g, why: 'the analysis core reads no host state' },
  { label: 'process.argv', pattern: /\bprocess\s*\.\s*argv\b/g, why: 'the analysis core reads no host state' },
  { label: 'fetch(', pattern: /(?<![.\w])fetch\s*\(/g, why: 'the analysis core performs no I/O' },
  { label: 'new Date()', pattern: /\bnew\s+Date\s*\(\s*\)/g, why: 'the instant is always a parameter' },
  { label: 'Date.now()', pattern: /\bDate\s*\.\s*now\s*\(/g, why: 'the instant is always a parameter' },
  { label: 'Intl.', pattern: /\bIntl\s*\./g, why: 'ICU data is a host input and changes with the base image' },
  {
    label: 'localeCompare',
    pattern: /\.\s*localeCompare\s*\(/g,
    why: 'locale-sensitive ordering changes a report between machines',
  },
  {
    label: 'toLocaleString',
    pattern: /\.\s*toLocale(String|DateString|TimeString)\s*\(/g,
    why: 'locale-sensitive formatting changes a report between machines',
  },
];

/** Matches every static and dynamic import specifier in a module. */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
];

/** Blanks comment bodies, preserving newlines so line numbers still line up. */
export function blankComments(text: string): string {
  let result = '';
  let index = 0;
  const blank = (slice: string): string => slice.replace(/[^\n]/g, ' ');

  while (index < text.length) {
    const lineComment = text.indexOf('//', index);
    const blockComment = text.indexOf('/*', index);
    const next =
      lineComment === -1 ? blockComment : blockComment === -1 ? lineComment : Math.min(lineComment, blockComment);

    if (next === -1) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, next);

    if (next === lineComment) {
      const end = text.indexOf('\n', next);
      const stop = end === -1 ? text.length : end;
      result += blank(text.slice(next, stop));
      index = stop;
    } else {
      const end = text.indexOf('*/', next + 2);
      const stop = end === -1 ? text.length : end + 2;
      result += blank(text.slice(next, stop));
      index = stop;
    }
  }

  return result;
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

function classify(
  specifier: string,
): { readonly category: ForbiddenImport['category']; readonly why: string } | null {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;

  if ((FORBIDDEN_NODE_BUILTINS as readonly string[]).includes(bare)) {
    return { category: 'node_builtin', why: 'the analysis core performs no I/O and reads no host state' };
  }
  if ((FORBIDDEN_WORKSPACE_PACKAGES as readonly string[]).includes(specifier)) {
    return {
      category: 'workspace_package',
      why: 'the analysis core declares no dependencies, so every layer boundary stays a package boundary',
    };
  }
  if ((FORBIDDEN_LIBRARIES as readonly string[]).some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
    return { category: 'library', why: 'the analysis core is a pure function of its snapshot' };
  }
  return null;
}

/** Every forbidden import and impure expression in one file, ordered by line. */
export function scanForImpurity(file: SourceFile): readonly ForbiddenImport[] {
  const code = blankComments(file.text);
  const found: ForbiddenImport[] = [];

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const verdict = classify(specifier);
      if (verdict === null) continue;
      const line = lineOf(code, match.index);
      found.push({
        file: file.relativePath,
        line,
        location: `${file.relativePath}:${line}`,
        specifier,
        category: verdict.category,
        why: verdict.why,
      });
    }
  }

  for (const { label, pattern, why } of FORBIDDEN_EXPRESSIONS) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      const line = lineOf(code, match.index);
      found.push({
        file: file.relativePath,
        line,
        location: `${file.relativePath}:${line}`,
        specifier: label,
        category: 'expression',
        why,
      });
    }
  }

  return found.sort((left, right) => left.line - right.line || (left.specifier < right.specifier ? -1 : 1));
}

export const scanAllForImpurity = (files: readonly SourceFile[]): readonly ForbiddenImport[] =>
  files.flatMap((file) => scanForImpurity(file));

// ---------------------------------------------------------------------------
// "Every exported analysis function takes an explicit instant parameter"
// ---------------------------------------------------------------------------

export interface MissingInstantParameter {
  readonly file: string;
  readonly line: number;
  readonly location: string;
  readonly functionName: string;
  readonly parameters: string;
}

export interface SnapshotAccessor {
  readonly file: string;
  readonly line: number;
  readonly location: string;
  readonly functionName: string;
  /** The stated justification on the `@snapshotAccessor` tag. Never empty. */
  readonly reason: string;
}

/**
 * The documented escape hatch, and the only one.
 *
 * A function tagged `@snapshotAccessor <reason>` in its JSDoc is exempt from the
 * instant requirement. The tag is deliberately awkward: it has to be written at
 * the declaration, it has to carry a reason in prose, and
 * `analysis-purity.test.ts` counts the exemptions and fails if they multiply. An
 * exemption you can add by editing a list somewhere else spreads; one you have to
 * justify next to the code does not.
 */
export const SNAPSHOT_ACCESSOR_TAG = '@snapshotAccessor';

/**
 * Finds exported functions that reason about a snapshot without being told when.
 *
 * The rule the acceptance criterion states — "every exported analysis function
 * takes an explicit instant parameter" — is checked where it has teeth: any
 * exported function that accepts an `AnalysisSnapshot` must also accept an
 * `Instant`. A function that is handed the org's entire state and no instant can
 * only get "now" from somewhere it should not.
 *
 * Three things are out of scope, all deliberately:
 *
 *  - **Helpers that take no snapshot.** `percent(3, 4)` has no notion of time to
 *    be given, and demanding one would be cargo cult.
 *  - **Snapshot accessors**, tagged `@snapshotAccessor` with a stated reason.
 *    `entityByKey(snapshot, kind, key)` is a lookup, not a judgement; handing it
 *    an instant it would ignore makes the signature lie about what it does.
 *  - **Functions bounded by an explicit `TimeWindow`.** A window is a pair of
 *    instants, so a function given one has been told *more* about when to reason
 *    than a bare instant conveys, and still cannot reach for a clock. Requiring
 *    an additional `instant` it would not read would push authors toward the
 *    exemption tag, which is the outcome this gate exists to prevent.
 *
 * A regex over declarations rather than a parse: this gate must keep working if
 * the TypeScript version moves, and the shape it looks for — `export function
 * name(...)` — is one the repo writes consistently.
 */
export function findExportedFunctionsMissingInstant(file: SourceFile): readonly MissingInstantParameter[] {
  return scanSnapshotFunctions(file).missing;
}

/** Every exempt accessor in a file, with the reason each one states. */
export function findSnapshotAccessors(file: SourceFile): readonly SnapshotAccessor[] {
  return scanSnapshotFunctions(file).accessors;
}

function scanSnapshotFunctions(file: SourceFile): {
  readonly missing: readonly MissingInstantParameter[];
  readonly accessors: readonly SnapshotAccessor[];
} {
  // Offsets are preserved by the blanking, so a match found in `code` indexes
  // into `file.text` at the same place — which is what lets the JSDoc immediately
  // above a declaration be read back out of the original.
  const code = blankComments(file.text);
  const missing: MissingInstantParameter[] = [];
  const accessors: SnapshotAccessor[] = [];
  const declaration = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(<[^(]*>)?\s*\(/g;

  for (const match of code.matchAll(declaration)) {
    const name = match[1];
    if (name === undefined) continue;

    const openParen = code.indexOf('(', match.index + match[0].length - 1);
    const parameters = balancedSlice(code, openParen);
    if (parameters === null) continue;
    if (!/\bAnalysisSnapshot\b/.test(parameters)) continue;

    const line = lineOf(code, match.index);
    const location = `${file.relativePath}:${line}`;

    const exemption = accessorReason(file.text, match.index);
    if (exemption !== null) {
      accessors.push({ file: file.relativePath, line, location, functionName: name, reason: exemption });
      continue;
    }
    if (/\binstant\s*:/.test(parameters)) continue;
    if (/:\s*TimeWindow\b/.test(parameters)) continue;

    missing.push({
      file: file.relativePath,
      line,
      location,
      functionName: name,
      parameters: parameters.replace(/\s+/g, ' ').trim(),
    });
  }

  return { missing, accessors };
}

/**
 * The reason stated on the `@snapshotAccessor` tag in the JSDoc immediately above
 * `declarationIndex`, or null when there is no such tag.
 *
 * "Immediately above" means the comment block ends within the run of whitespace
 * before the declaration — a tag on some unrelated comment further up the file
 * does not exempt anything.
 */
function accessorReason(text: string, declarationIndex: number): string | null {
  const before = text.slice(0, declarationIndex);
  const commentEnd = before.lastIndexOf('*/');
  if (commentEnd === -1) return null;
  if (before.slice(commentEnd + 2).trim().length > 0) return null;

  const commentStart = before.lastIndexOf('/*', commentEnd);
  if (commentStart === -1) return null;

  const block = before.slice(commentStart, commentEnd);
  const tag = new RegExp(`${SNAPSHOT_ACCESSOR_TAG}\\s+([^\\n*]+)`).exec(block);
  const reason = tag?.[1]?.trim() ?? '';
  return reason.length === 0 ? null : reason;
}

/** The text between a `(` and its matching `)`, or null if unbalanced. */
function balancedSlice(text: string, openIndex: number): string | null {
  if (text[openIndex] !== '(') return null;
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  return null;
}
