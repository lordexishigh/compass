import type { SourceFile } from './workspace.js';

/**
 * A textual scan for host-clock reads, run independently of ESLint.
 *
 * ESLint is the gate that fails the build; this scan is the second opinion. It
 * exists because the lint gate has one failure mode a rule test cannot see: if
 * the plugin stops loading, or a `files` glob is edited, every rule silently
 * reports nothing and lint goes green. A dumb scan over the same trees cannot be
 * disabled by a config change, so the two have to agree.
 *
 * Comments are blanked before scanning so prose that *names* `Date.now()` — the
 * documentation in `@compass/clock` does exactly that — is not a violation.
 */

export interface ForbiddenTimeRead {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** `file:line` — the location the acceptance criterion asks lint to name. */
  readonly location: string;
  readonly expression: string;
}

interface Pattern {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * `new Date(epochMillis)` and `Date.parse(iso)` are deliberately absent: they
 * convert a value that already came from the Clock port. Only the zero-argument
 * form reads *now*.
 */
const FORBIDDEN_PATTERNS: readonly Pattern[] = [
  { label: 'new Date()', pattern: /\bnew\s+Date\s*\(\s*\)/g },
  { label: 'Date.now()', pattern: /\bDate\s*\.\s*now\s*\(/g },
  { label: 'performance.now()', pattern: /\bperformance\s*\.\s*now\s*\(/g },
  { label: 'performance.timeOrigin', pattern: /\bperformance\s*\.\s*timeOrigin\b/g },
  { label: 'process.hrtime()', pattern: /\bprocess\s*\.\s*hrtime\b/g },
  { label: 'process.uptime()', pattern: /\bprocess\s*\.\s*uptime\s*\(/g },
];

/** Time libraries whose no-argument constructors are wall-clock reads. */
const FORBIDDEN_MODULES = [
  'dayjs',
  'moment',
  'moment-timezone',
  'luxon',
  'date-fns',
  'date-fns-tz',
  '@js-joda/core',
  'js-joda',
  'perf_hooks',
  'node:perf_hooks',
  'temporal-polyfill',
];

const DISABLE_COMMENT = /eslint-disable(?:-next-line|-line)?\s+compass\/no-system-clock\b/;

/**
 * Replaces comment bodies with spaces, preserving every newline so line and
 * column numbers still point at the real source.
 */
function blankComments(text: string): string {
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

/** The 1-based line and column of `offset` within `text`. */
function positionOf(text: string, offset: number): { line: number; column: number } {
  const preceding = text.slice(0, offset);
  const line = preceding.split('\n').length;
  const lastNewline = preceding.lastIndexOf('\n');
  return { line, column: offset - lastNewline };
}

/**
 * Lines carrying a sanctioned `eslint-disable ... compass/no-system-clock`, and
 * the line each one covers. The scan honours the same exemption ESLint does, so
 * `SystemClock` is not reported twice by two gates that disagree.
 */
function exemptLines(text: string): ReadonlySet<number> {
  const exempt = new Set<number>();
  text.split('\n').forEach((lineText, index) => {
    if (!DISABLE_COMMENT.test(lineText)) return;
    const lineNumber = index + 1;
    exempt.add(lineNumber);
    if (/eslint-disable-next-line/.test(lineText)) exempt.add(lineNumber + 1);
  });
  return exempt;
}

export function scanForForbiddenTimeReads(file: SourceFile): readonly ForbiddenTimeRead[] {
  const code = blankComments(file.text);
  const exempt = exemptLines(file.text);
  const found: ForbiddenTimeRead[] = [];

  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const { line, column } = positionOf(code, match.index);
      if (exempt.has(line)) continue;
      found.push({
        file: file.relativePath,
        line,
        column,
        location: `${file.relativePath}:${line}`,
        expression: label,
      });
    }
  }

  for (const moduleName of FORBIDDEN_MODULES) {
    const importPattern = new RegExp(
      `(?:from|import|require\\s*\\()\\s*['"]${moduleName.replace(/[/@.]/g, '\\$&')}(?:/[^'"]*)?['"]`,
      'g',
    );
    for (const match of code.matchAll(importPattern)) {
      const { line, column } = positionOf(code, match.index);
      found.push({
        file: file.relativePath,
        line,
        column,
        location: `${file.relativePath}:${line}`,
        expression: `import '${moduleName}'`,
      });
    }
  }

  return found.sort((left, right) => left.line - right.line || left.column - right.column);
}

export const scanAll = (files: readonly SourceFile[]): readonly ForbiddenTimeRead[] =>
  files.flatMap((file) => scanForForbiddenTimeReads(file));

/** Count of sanctioned disable comments in a file — the census asserts on this. */
export function countSanctionedDisables(file: SourceFile): number {
  return file.text.split('\n').filter((lineText) => DISABLE_COMMENT.test(lineText)).length;
}
