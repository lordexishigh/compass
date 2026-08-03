import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { fileURLToPath } from 'node:url';

/**
 * Every route the App Router serves, read off the filesystem.
 *
 * ## Why this is shared rather than copied
 *
 * Two suites need it — `authz-matrix.test.ts`, which fails the build when a route has no entry in
 * `ROLE_MATRIX`, and `two-org-isolation.test.ts`, which walks every route with the wrong tenant's
 * identifiers. A second copy of the walk would drift, and the drift would be invisible: both suites
 * would keep passing while one of them quietly stopped covering a directory.
 *
 * ## Derived, never listed
 *
 * A hand-maintained array here would be one more place to forget a route, which is the exact failure
 * these suites exist to prevent. The walk follows Next's file convention — `route.ts` under
 * `app/api` is an endpoint, `page.tsx` anywhere under `app` is a screen — so a new file is covered
 * the moment it exists, with no registration step to skip.
 *
 * Dynamic segments keep the filesystem's spelling: `[nodeId]`, not `:nodeId`. `ROLE_MATRIX` spells
 * them the same way on purpose, so the two can be diffed directly.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_ROOT = join(WEB_ROOT, 'app');

function walk(directory: string, fileNames: readonly string[], found: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Route groups `(name)` and private folders `_name` are not path segments. Neither appears in
      // this app today; handling them here means the walk stays correct if one is added.
      walk(full, fileNames, found);
      continue;
    }
    if (!fileNames.includes(entry.name)) continue;

    const segments = relative(APP_ROOT, dirname(full))
      .split(sep)
      .filter((segment) => segment.length > 0 && !segment.startsWith('(') && !segment.startsWith('_'));

    found.push(segments.length === 0 ? '/' : `/${segments.join('/')}`);
  }
}

/**
 * Every endpoint — every `route.ts` anywhere under `app`, not only under `app/api`.
 *
 * The "not only under `app/api`" is load-bearing and was learned the hard way twice. Next puts a
 * route handler wherever its path is, and Compass has one outside the conventional tree:
 * `app/login/route.ts`, the short sign-in address published to a verification harness. A walk rooted
 * at `app/api` misses it, and a route the coverage test cannot see is a route that can ship with no
 * entry in `ROLE_MATRIX` — which is precisely the failure the coverage test exists to prevent.
 */
export function apiRoutesOnDisk(): readonly string[] {
  const found: string[] = [];
  walk(APP_ROOT, ['route.ts', 'route.tsx'], found);
  return found.sort();
}

/**
 * Every rendered screen, `/` included.
 *
 * Walks the whole tree for page files. Endpoints cannot be picked up by mistake: Next forbids a
 * `page.tsx` and a `route.ts` in the same directory, so the two walks partition the surface rather
 * than overlapping.
 */
export function pageRoutesOnDisk(): readonly string[] {
  const found: string[] = [];
  walk(APP_ROOT, ['page.tsx', 'page.ts'], found);
  return found.sort();
}

/** Both, sorted — what the matrix is diffed against. */
export const allRoutesOnDisk = (): readonly string[] => [...apiRoutesOnDisk(), ...pageRoutesOnDisk()].sort();
