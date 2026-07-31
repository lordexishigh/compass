import { join } from 'node:path';

import { ESLint } from 'eslint';

import { REPO_ROOT, repoRelative, toPosix } from './workspace.js';

/**
 * One ESLint instance, resolved against the real root `eslint.config.js`.
 *
 * The point of going through the public API rather than a `RuleTester` is that
 * this proves the *wiring*: the plugin is registered, and the `files` globs
 * actually select the layers they claim to. A rule that works perfectly but is
 * scoped to the wrong directory fails here and passes a RuleTester.
 */
let shared: ESLint | undefined;

export function workspaceEslint(): ESLint {
  shared ??= new ESLint({ cwd: REPO_ROOT, errorOnUnmatchedPattern: false });
  return shared;
}

/** A lint message flattened to the `file:line:column` shape the gate asserts on. */
export interface LintViolation {
  readonly ruleId: string;
  /** e.g. `packages/analysis/src/probe.ts:3:10` — the offending file:line. */
  readonly location: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const COMPASS_RULE_PREFIX = 'compass/';

function toViolations(results: readonly ESLint.LintResult[]): readonly LintViolation[] {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId?.startsWith(COMPASS_RULE_PREFIX) === true)
      .map((message) => ({
        ruleId: message.ruleId ?? '',
        location: `${repoRelative(result.filePath)}:${message.line}:${message.column}`,
        file: repoRelative(result.filePath),
        line: message.line,
        column: message.column,
        message: message.message,
      })),
  );
}

/**
 * Lints `code` as if it were saved at `relativeFilePath`.
 *
 * The file is never written to disk. ESLint resolves configuration from the path
 * alone, which is exactly what the gate needs: it can ask "what would happen if
 * someone put this in `packages/pipeline/src`?" without mutating a real package
 * or leaving a poisoned file behind when a test fails.
 */
export async function lintVirtualSource(
  relativeFilePath: string,
  code: string,
): Promise<readonly LintViolation[]> {
  const filePath = join(REPO_ROOT, relativeFilePath);
  const results = await workspaceEslint().lintText(code, { filePath, warnIgnored: false });
  return toViolations(results);
}

/** Lints real files on disk, e.g. every guarded `src` tree. */
export async function lintFiles(patterns: readonly string[]): Promise<readonly LintViolation[]> {
  const results = await workspaceEslint().lintFiles(patterns.map((pattern) => toPosix(join(REPO_ROOT, pattern))));
  return toViolations(results);
}

/**
 * The severity ESLint would apply to `ruleId` for a file at `relativeFilePath`,
 * normalised to 0 (off) / 1 (warn) / 2 (error).
 */
export async function ruleSeverityFor(relativeFilePath: string, ruleId: string): Promise<0 | 1 | 2> {
  const config = await workspaceEslint().calculateConfigForFile(join(REPO_ROOT, relativeFilePath));
  const entry = (config as { rules?: Record<string, unknown> }).rules?.[ruleId];
  if (entry === undefined) return 0;

  const raw = Array.isArray(entry) ? entry[0] : entry;
  if (raw === 2 || raw === 'error') return 2;
  if (raw === 1 || raw === 'warn') return 1;
  return 0;
}

export const isRuleEnabledFor = async (relativeFilePath: string, ruleId: string): Promise<boolean> =>
  (await ruleSeverityFor(relativeFilePath, ruleId)) === 2;
