import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * The repository root, two levels up from `apps/web`.
 *
 * Resolved from this file's own URL rather than from `process.cwd()`, because the config is loaded by
 * `next dev`, `next build` and `next start` and only the first of those is reliably run from the app
 * directory.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Loads the monorepo's own `.env` files into `process.env`.
 *
 * ## Why this is here at all
 *
 * Next reads `.env` and `.env.local` **relative to its own project directory**, which in this
 * repository is `apps/web`. Every environment file Compass documents lives at the repository root
 * instead — `.env.example` says "copy this to `.env`" and sits beside the compose file, the worker and
 * the migration runner read the same root files, and a hosted deployment provisions one there. So a
 * checkout with a perfectly good `DATABASE_URL` at the root started the web app with none, and `/`
 * answered a framework 500 from `resolveDatabaseUrl` on the first request — a configuration that looks
 * complete failing in the one place the zero-config promise is measured.
 *
 * Loading it in the config is Next's own answer for a monorepo (`loadEnvConfig` in the documented
 * recipe); this is that, without adding `@next/env` to the dependency graph for twenty lines.
 *
 * ## The precedence, which is the part worth getting right
 *
 * `.env.local` wins over `.env`, and **anything already in `process.env` wins over both**. That order
 * is not a detail: `docker compose` passes the database url as a real environment variable, and a root
 * `.env.local` left behind on a developer's machine must not quietly redirect a container at it.
 * Nothing here overwrites a value the process was actually given.
 */
function loadRootEnvironment(): void {
  for (const file of ['.env', '.env.local']) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      // Absent is the normal case — the documented cold start is `docker compose up`, which passes
      // the environment directly. A missing file is not a failure and must not be reported as one.
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      // Assignments only. A comment cannot match, because `#` is not a legal first character of a
      // variable name, and neither can a blank line or a continuation.
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (assignment === null) continue;

      const name = assignment[1]!;
      // Surrounding quotes are stripped; nothing inside them is. A connection string can legitimately
      // contain `#`, so this deliberately does not treat one as a trailing comment.
      const value = assignment[2]!.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');

      const existing = process.env[name];
      if (existing !== undefined && existing.length > 0) continue;
      process.env[name] = value;
    }
  }
}

loadRootEnvironment();

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as ESM with type declarations; Next consumes them
  // directly from their built `dist`, so `pnpm build` builds packages first.
  //
  // Nothing is listed in `serverExternalPackages`, and that is a deliberate outcome
  // rather than an omission: Argon2id comes from `hash-wasm`, which inlines its
  // WebAssembly and therefore bundles like any other JavaScript. A native binding needed
  // an entry here *and* still failed, because its binary lives in a separate
  // per-platform package the externals list does not name. See
  // `packages/auth/src/password.ts` for the whole of that reasoning.
  //
  // ## There is deliberately no `headers()` here
  //
  // Three static headers used to be set from this file. They now come from
  // `middleware.ts` along with the CSP, and this comment is the record of why the move
  // was necessary rather than tidy.
  //
  // A strict CSP needs a per-response nonce. `headers()` is evaluated once, at build
  // time, and cannot vary per response — so the CSP has to come from middleware. And a
  // header declared in *both* places is emitted twice: browsers then intersect the two
  // policies, which is the strictest possible reading of a mistake, and any assertion
  // that a header equals its documented value fails against a joined string.
  //
  // So middleware owns all six, `apps/web/lib/security-headers.ts` is the single source
  // of their values, and `tests/security-headers.test.ts` asserts this file declares no
  // `headers()` at all — the comment is not what keeps the ownership single.
};

export default config;
