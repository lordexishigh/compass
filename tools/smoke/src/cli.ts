import { ProbeTimeout } from './probe.js';
import { ColdStartCheckFailed } from './report-html.js';
import { DeadSourceLinkError, parseSmokeArgs, runSmoke } from './smoke-run.js';

/**
 * `pnpm smoke` against a running deployment; `pnpm smoke:docker` after
 * `docker compose up`. CI runs the second one on a clean container, which is the
 * acceptance criterion stated as a command rather than as a paragraph.
 *
 * It exits non-zero with every problem named. A smoke test that says only "failed"
 * costs a second container boot to learn anything, and container boots are the
 * slowest thing in the loop.
 */
async function main(): Promise<void> {
  const options = parseSmokeArgs(process.argv.slice(2));

  try {
    await runSmoke(options);
  } catch (error) {
    // Both failure modes already carry every problem in their message, so this
    // prints one line rather than a stack an operator has to read past.
    if (
      error instanceof ColdStartCheckFailed ||
      error instanceof ProbeTimeout ||
      error instanceof DeadSourceLinkError
    ) {
      console.error(`[smoke] ${error.message}`);
    } else {
      console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
