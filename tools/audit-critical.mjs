#!/usr/bin/env node
/**
 * The dependency gate: a critical vulnerability *that has a fix available* blocks the release.
 *
 * ## Why this is a script and not `pnpm audit --audit-level critical`
 *
 * The acceptance criterion is narrower than what `pnpm audit` enforces, in both directions:
 *
 *  - It blocks only when a **fix is available**. `pnpm audit --audit-level critical` fails on a
 *    critical advisory with no patched version at all, which is a finding somebody has to triage
 *    rather than something a pull request can act on. A gate that cannot be made green by any change
 *    to this repository stops being a gate and starts being a reason to add `|| true`.
 *  - It must **name the package and the fixed version**. `pnpm audit`'s human output does say so, but
 *    it says it among every moderate and low advisory in the tree, and CI truncates. This prints only
 *    what blocks, with the version to move to.
 *
 * Reads `pnpm audit --json` on stdin so the gate is testable and so a network failure inside `pnpm`
 * surfaces as `pnpm`'s own non-zero exit rather than as an empty pass here.
 *
 * Exit codes: 0 nothing blocking, 1 at least one blocking advisory, 2 the input could not be parsed.
 * A parse failure is deliberately *not* a pass: an audit whose output shape changed is an audit
 * nobody is reading.
 */

const SEVERITIES_THAT_BLOCK = new Set(['critical']);

/**
 * `pnpm audit --json` emits the npm registry's bulk-advisory shape: an `advisories` map keyed by id,
 * each with `severity`, `module_name` and `findings[].paths`, plus a `patched_versions` range that is
 * `<0.0.0` when there is no fix.
 */
function blockingAdvisories(report) {
  const advisories = report?.advisories;
  if (advisories === undefined || advisories === null || typeof advisories !== 'object') return [];

  return Object.values(advisories)
    .filter((advisory) => SEVERITIES_THAT_BLOCK.has(String(advisory?.severity ?? '').toLowerCase()))
    .map((advisory) => ({
      package: String(advisory?.module_name ?? 'unknown'),
      severity: String(advisory?.severity ?? 'unknown'),
      title: String(advisory?.title ?? 'no title given'),
      url: String(advisory?.url ?? ''),
      /**
       * The version to move to.
       *
       * `patched_versions` is a semver *range* (`>=4.17.21`), which is the honest thing to print: the
       * advisory does not name one version, it names every version that is not affected.
       * `<0.0.0` is the registry's way of saying nothing is patched yet.
       */
      fixedIn: String(advisory?.patched_versions ?? '').trim(),
      vulnerable: String(advisory?.vulnerable_versions ?? '').trim(),
    }))
    .map((advisory) => ({
      ...advisory,
      hasFix: advisory.fixedIn.length > 0 && advisory.fixedIn !== '<0.0.0',
    }));
}

function main(raw) {
  let report;
  try {
    // A leading BOM is not valid JSON to `JSON.parse` and is entirely plausible on the way in — a
    // Windows shell pipe adds one, and this repository has already been bitten by BOMs twice.
    //
    // Tested by code point rather than by a regex containing the character: a raw BOM in source is
    // invisible to a reviewer, and it is exactly what `no-irregular-whitespace` exists to catch.
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    report = JSON.parse(withoutBom);
  } catch (cause) {
    process.stderr.write(
      'GATE: dependency-scan — could not parse `pnpm audit --json` output.\n' +
        `  ${cause instanceof Error ? cause.message : String(cause)}\n` +
        '  This is a failure rather than a pass on purpose: an audit whose output shape changed is an\n' +
        '  audit nobody is reading.\n',
    );
    return 2;
  }

  const critical = blockingAdvisories(report);
  const blocking = critical.filter((advisory) => advisory.hasFix);
  const unfixable = critical.filter((advisory) => !advisory.hasFix);

  // Reported but not blocking, so the finding is visible without making the gate unsatisfiable.
  for (const advisory of unfixable) {
    process.stdout.write(
      `GATE: dependency-scan — NOT BLOCKING (no fix published yet): ${advisory.package} — ` +
        `${advisory.title}${advisory.url ? ` (${advisory.url})` : ''}\n` +
        '  Nothing in this repository can resolve it today. Triage it; do not ignore it.\n',
    );
  }

  if (blocking.length === 0) {
    process.stdout.write(
      `GATE: dependency-scan — PASS. ${critical.length} critical advisor${critical.length === 1 ? 'y' : 'ies'}, ` +
        `${unfixable.length} without a published fix, 0 blocking.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `GATE: dependency-scan — FAIL. ${blocking.length} critical vulnerabilit${
      blocking.length === 1 ? 'y has' : 'ies have'
    } a fix available and must be upgraded before release:\n`,
  );
  for (const advisory of blocking) {
    process.stderr.write(
      `  - ${advisory.package}: installed range ${advisory.vulnerable || '(unstated)'} is vulnerable — ` +
        `upgrade to ${advisory.fixedIn}\n` +
        `      ${advisory.title}${advisory.url ? `\n      ${advisory.url}` : ''}\n`,
    );
  }
  process.stderr.write('  Run `pnpm update <package>` (or add a pnpm override) and re-run this gate.\n');

  return 1;
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.exitCode = main(Buffer.concat(chunks).toString('utf8'));
});
