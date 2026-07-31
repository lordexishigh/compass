import { resolveSeedDirectory } from '../seed-paths.js';
import { writeSeedFiles } from '../seed-dataset.js';

/**
 * `pnpm seed:generate`.
 *
 * Expands `seed/fixtures/**` into `seed/generated/**` plus `seed/MANIFEST.md`.
 * Deterministic by construction, so the honest way to check it is to run it and
 * then run `git diff --exit-code seed/` — a clean tree means the checked-in seed
 * and the fixtures still agree.
 *
 * Exit codes: 0 on success, 1 on a generation failure (the generator's own
 * soundness checks report the offending records by identifier).
 */
function main(): void {
  const seedDirectory = resolveSeedDirectory();
  const result = writeSeedFiles({ seedDirectory });

  console.info(`Seed written to ${result.seedDirectory}`);
  console.info(`  ${result.written.length} files, ${result.changed.length} changed`);
  for (const path of result.changed) {
    console.info(`  changed: ${path}`);
  }
  if (result.changed.length === 0) {
    console.info('  the checked-in seed already matches the fixtures');
  }
  for (const path of result.stale) {
    console.warn(`  stale: ${path} is no longer produced by the generator and should be deleted`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
