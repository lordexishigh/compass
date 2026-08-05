#!/usr/bin/env node
/**
 * `pnpm run dev` — build the packages, then serve the web app, forwarding any arguments.
 *
 * ## The bug this exists to fix
 *
 * The script used to be a shell chain:
 *
 * ```
 * "dev": "pnpm run build:packages && pnpm --filter @compass/web run dev"
 * ```
 *
 * which works for a bare `pnpm run dev` and breaks the moment anybody passes an argument. `pnpm run dev
 * -- -p 58501` appends the extra tokens to the end of the script string **including the `--`**, so the
 * chain became `… && pnpm --filter @compass/web run dev "--" "-p" "58501"`, the inner `run` forwarded all
 * three to `next dev`, and Next — whose CLI treats `--` as end-of-options — read the *next* token as a
 * positional project directory:
 *
 * ```
 * Invalid project directory provided, no such directory: …/apps/web/-p
 * ```
 *
 * So the dev server exited 1 before listening. Choosing a port is the most ordinary thing to want from a
 * dev script (two checkouts, a busy 3000, a boot probe on a fixed port), and the failure blamed a
 * directory nobody had typed.
 *
 * ## Why a script rather than a cleverer one-liner
 *
 * The `--` has to be dropped somewhere, and a shell chain cannot portably edit its own arguments —
 * anything using `shift`, `$@` or `%*` would work on one of Windows and POSIX and not the other, and this
 * repo is developed on both. Twenty lines of Node is the smaller thing to reason about, and it also buys
 * two properties the chain did not have:
 *
 *  - **No shell at all.** Both children are spawned as `process.execPath <resolved js entry>`, so a port
 *    argument is never re-parsed by cmd.exe or sh, and there is no quoting to get wrong.
 *  - **`&&` semantics, kept deliberately.** A failing `tsc -b` exits with its own code and the dev server
 *    never starts. That ordering is the point of the script: `next dev` against half-built workspace
 *    packages fails later, further away, and with a stranger message.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDirectory = join(repositoryRoot, 'apps', 'web');

/**
 * Arguments to hand `next dev`, with any bare `--` removed.
 *
 * pnpm keeps the separator when it appends a run's extra arguments, so `-- -p 58501` arrives here as
 * three tokens. Every one of them except the separator is meant for Next. A bare `--` is never a Next
 * argument in its own right, so dropping it is unambiguous rather than a heuristic — and dropping *all*
 * of them costs nothing, since a second separator would be equally meaningless.
 */
const forwarded = process.argv.slice(2).filter((argument) => argument !== '--');

/**
 * Resolves a package's JS entry point rather than its `.bin` shim.
 *
 * The shims are `.CMD` files on Windows, which `spawn` cannot execute without `shell: true` — and a shell
 * is the thing this script exists to keep out of the argument path. Resolving the entry means both
 * children are plain Node processes.
 */
const entryPoint = (specifier, fromPackageJson) =>
  createRequire(fromPackageJson).resolve(specifier);

/** Spawns a Node child that inherits stdio, and resolves with its exit code. */
const run = (scriptPath, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd, stdio: 'inherit' });

    /**
     * Signals are forwarded rather than left to the terminal.
     *
     * On POSIX a Ctrl-C reaches the whole foreground process group anyway, but on Windows it does not —
     * and a dev server that survived its launcher would hold the port and make the next `pnpm run dev`
     * fail for a reason with no visible cause.
     */
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      // A signalled child has a null code. 128 + signal number is the shell convention, and any
      // non-zero value is enough for the caller to see it did not exit cleanly.
      resolve(code ?? (signal === undefined || signal === null ? 1 : 128));
    });
  });

const built = await run(
  entryPoint('typescript/bin/tsc', join(repositoryRoot, 'package.json')),
  ['-b', 'tsconfig.build.json'],
  repositoryRoot,
);

if (built !== 0) process.exit(built);

process.exit(
  await run(
    entryPoint('next/dist/bin/next', join(webDirectory, 'package.json')),
    ['dev', ...forwarded],
    webDirectory,
  ),
);
