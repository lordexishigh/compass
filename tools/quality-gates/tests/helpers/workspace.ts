import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `tools/quality-gates/tests/helpers` → the repository root. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** The workspace globs from `pnpm-workspace.yaml`, as plain directory names. */
export const WORKSPACE_GROUPS = ['packages', 'apps', 'tools'] as const;

export type WorkspaceGroup = (typeof WORKSPACE_GROUPS)[number];

/**
 * Layers where reading the host clock is a build failure. `clock` is included:
 * `SystemClock` is the one sanctioned read and carries one documented disable
 * comment, which `clock-gate.test.ts` asserts is the only one in the workspace.
 *
 * This list is not trusted on its own — `clock-gate.test.ts` asks ESLint for the
 * effective config of every package and fails if the set of packages with the
 * rule enabled differs from this one, so the two cannot drift apart.
 */
export const CLOCK_GUARDED_PACKAGES = ['clock', 'ingest', 'knowledge-model', 'analysis', 'pipeline'] as const;

/** Layers that must never construct a clock at all — `now` arrives as a parameter. */
export const CLOCK_INJECTED_PACKAGES = ['ingest', 'knowledge-model', 'analysis', 'pipeline'] as const;

/** Directories that are build output or vendored code, never authored source. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage', '.git', '.turbo', 'drizzle']);

export interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface WorkspacePackage {
  /** The declared package name, e.g. `@compass/clock`. */
  readonly name: string;
  /** The directory name on disk, e.g. `clock`. */
  readonly directoryName: string;
  readonly absoluteDirectory: string;
  /** Repo-relative and forward-slashed, so assertion messages read the same everywhere. */
  readonly relativeDirectory: string;
  readonly group: WorkspaceGroup;
  readonly manifest: PackageManifest;
}

/** Forward slashes everywhere: these strings end up in failure messages. */
export const toPosix = (path: string): string => path.split('\\').join('/');

export const repoRelative = (absolutePath: string): string => toPosix(relative(REPO_ROOT, absolutePath));

export function readJsonFile<T>(absolutePath: string): T {
  const raw = readFileSync(absolutePath, 'utf8');
  // tsconfig files are JSONC: strip line comments and trailing commas before parsing.
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '');
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(withoutTrailingCommas) as T;
  } catch (cause) {
    throw new Error(`${repoRelative(absolutePath)} is not parseable JSON: ${(cause as Error).message}`);
  }
}

/**
 * Every package in the pnpm workspace, discovered from disk rather than from a
 * hard-coded list, so a package added without a test script is caught.
 */
export function listWorkspacePackages(): readonly WorkspacePackage[] {
  const found: WorkspacePackage[] = [];

  for (const group of WORKSPACE_GROUPS) {
    const groupDirectory = join(REPO_ROOT, group);
    if (!existsSync(groupDirectory)) continue;

    for (const entry of readdirSync(groupDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;

      const absoluteDirectory = join(groupDirectory, entry.name);
      const manifestPath = join(absoluteDirectory, 'package.json');
      if (!existsSync(manifestPath)) continue;

      const manifest = readJsonFile<PackageManifest>(manifestPath);
      found.push({
        name: manifest.name ?? `${group}/${entry.name}`,
        directoryName: entry.name,
        absoluteDirectory,
        relativeDirectory: `${group}/${entry.name}`,
        group,
        manifest,
      });
    }
  }

  return found.sort((left, right) => left.relativeDirectory.localeCompare(right.relativeDirectory));
}

export const packagesIn = (group: WorkspaceGroup): readonly WorkspacePackage[] =>
  listWorkspacePackages().filter((workspacePackage) => workspacePackage.group === group);

export function workspacePackageByDirectory(group: WorkspaceGroup, directoryName: string): WorkspacePackage {
  const match = listWorkspacePackages().find(
    (candidate) => candidate.group === group && candidate.directoryName === directoryName,
  );
  if (!match) {
    throw new Error(`No workspace package at ${group}/${directoryName}.`);
  }
  return match;
}

export interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly text: string;
}

/** Every authored `.ts`/`.tsx` file under `directory`, build output excluded. */
export function collectSourceFiles(
  directory: string,
  extensions: readonly string[] = ['.ts', '.tsx'],
): readonly SourceFile[] {
  if (!existsSync(directory)) return [];

  const collected: SourceFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      collected.push({
        absolutePath,
        relativePath: repoRelative(absolutePath),
        text: readFileSync(absolutePath, 'utf8'),
      });
    }
  };

  walk(directory);
  return collected.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** The `src` tree of a workspace package — the sources the clock gate polices. */
export const packageSourceFiles = (workspacePackage: WorkspacePackage): readonly SourceFile[] =>
  collectSourceFiles(join(workspacePackage.absoluteDirectory, 'src'));

/**
 * Authored product source across the whole workspace: every package's and app's
 * tree, plus the ESLint plugin. Used by the sanctioned-disable census.
 *
 * `tools/quality-gates` is excluded, and has to be: these gates quote the
 * disable comment and the banned expressions as *test data*, so counting them
 * would make the census report itself. The gate is not the thing being policed.
 */
export function allAuthoredSourceFiles(): readonly SourceFile[] {
  const files = WORKSPACE_GROUPS.flatMap((group) => collectSourceFiles(join(REPO_ROOT, group), ['.ts', '.tsx', '.js']));
  return files.filter((file) => !file.relativePath.startsWith('tools/quality-gates/'));
}
