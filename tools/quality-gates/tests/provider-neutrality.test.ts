import { describe, expect, it } from 'vitest';

import { packageSourceFiles, workspacePackageByDirectory } from './helpers/workspace.js';

/**
 * The zero-change swap, enforced: no layer below the composition root knows a provider exists.
 *
 * ## What this gate is actually protecting
 *
 * The architecture's central claim is that "the seeded connector is indistinguishable from a live
 * GitHub/Jira/Slack connector" — that swapping the provider is a *configuration* change and touches
 * no code in ingest, the knowledge model, the analysis core or the renderers. That claim is easy to
 * state and easy to lose: one `if (source === 'github')` in reconciliation, added to fix one
 * provider's quirk, and the property is gone with nothing failing. Ingest still works. The reports
 * still render. The seeded tests still pass, because they exercise the other branch.
 *
 * So the property is asserted directly, over source text, in the layers where it has to hold.
 *
 * ## Two checks, because they fail differently
 *
 * 1. **No provider *import*.** The structural hazard: a neutral layer that reaches for
 *    `@compass/github-connector` has stopped being neutral whatever its logic looks like.
 *    `.dependency-cruiser.cjs` already forbids `seed-connector` here for exactly this reason; this
 *    extends the same rule to the live packages, and does it as a textual scan so the two mechanisms
 *    are independent — the same belt-and-braces arrangement the clock gate uses.
 * 2. **No provider *name* in code.** The subtler one: a string literal or an identifier mentioning a
 *    provider means a branch on it, or a field named after it, either of which makes one provider's
 *    shape visible above the port.
 *
 * ## Why comments are stripped rather than allowlisted
 *
 * Every one of these layers legitimately *discusses* providers in prose — `report-pipeline.ts`
 * explains that the seeded connector exists "so that this code path is the same one a GitHub
 * connector will run", which is the rule being documented, not broken. A scan that failed on that
 * would be a scan nobody could keep green, and the usual repair is an allowlist that quietly grows
 * until it covers a real violation. Stripping comments first means the gate reads what *executes*,
 * which is the only thing that can branch.
 *
 * ## Delivery channels are not data providers
 *
 * `@compass/delivery` is not scanned at all: it is above the port and is *supposed* to know what a Slack
 * message is. But `memos` — which is scanned, because it is part of report generation — declares
 * `MEMO_SOURCE_CHANNELS = ['email', 'slack', 'web']`, the channel a manager's memo *arrived on*. That is
 * the same distinction, inside a package that does have to be neutral about data providers.
 *
 * So the carve-out is implemented as a **rule** rather than as an allowlist of files, because an
 * allowlist is the thing that quietly grows until it covers a real violation. A line is exempt only if it
 * declares a channel vocabulary *and* names `email` on the same line — see `isChannelVocabulary`. A
 * provider branch cannot satisfy either half: `if (source === 'github')` names no channel and no email,
 * and neither does a field named after a provider.
 */

/**
 * The layers a provider must be invisible to.
 *
 * The criterion names "the ingest, knowledge-model, analysis and report packages", and **report
 * generation is not one package**: it is spread across `renderers` (the prose), `narrator` (the LLM
 * narration and its fail-closed template fallback) and `memos` (the one write path into the org model).
 * A gate that scanned only `renderers` would pass while being blind to two thirds of the thing it was
 * meant to protect — so all three are listed, and `pipeline` with them because it is the layer that wires
 * ingest to analysis to render and is therefore the most tempting place to put a provider branch.
 */
const NEUTRAL_PACKAGES = [
  'ingest',
  'knowledge-model',
  'analysis',
  'renderers',
  'narrator',
  'memos',
  'pipeline',
] as const;

/** The providers, as they would appear in code. */
const PROVIDER_TOKENS = ['github', 'jira', 'slack'] as const;

/** Connector packages nothing neutral may import — the seeded one included. */
const PROVIDER_PACKAGES = [
  '@compass/github-connector',
  '@compass/jira-connector',
  '@compass/slack-connector',
  '@compass/seed-connector',
] as const;

/**
 * Source with comments and string-free prose removed.
 *
 * Block comments first, then line comments. Deliberately naive about `//` inside a string literal:
 * over-stripping can only ever *hide* a violation from this gate, and the import check below reads
 * the unstripped text, so the structural half cannot be fooled by it.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * Whether a line declares the channel a message arrived on, rather than a data provider.
 *
 * Both halves are required and each one alone would be too loose. The name has to say `CHANNEL`, which is
 * what makes it a statement about transport; and the line has to also name `email`, which no data-provider
 * list would ever contain — Compass does not ingest from email. Together they admit
 * `MEMO_SOURCE_CHANNELS = ['email', 'slack', 'web']` and nothing that could branch on a provider.
 */
const isChannelVocabulary = (line: string): boolean =>
  // No leading `\b`: the constant is `MEMO_SOURCE_CHANNELS`, and `_` is a word character, so a boundary
  // between `_` and `C` never matches. Upper-case on purpose — it admits a SCREAMING_CASE vocabulary
  // constant and not a local called `channels`, which is one more turn of narrowing for free.
  /CHANNELS?\b/.test(line) && /\bemail\b/i.test(line);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

const filesOf = (directoryName: string) =>
  packageSourceFiles(workspacePackageByDirectory('packages', directoryName));

describe('no neutral layer imports a provider connector', () => {
  it.each(NEUTRAL_PACKAGES)('packages/%s/src imports no connector package', (directoryName) => {
    const violations: Violation[] = [];

    for (const file of filesOf(directoryName)) {
      // The unstripped text on purpose: an import cannot hide in a comment, and reading the raw file
      // means a stripping bug cannot weaken this half of the gate.
      const lines = file.text.split('\n');
      lines.forEach((line, index) => {
        for (const packageName of PROVIDER_PACKAGES) {
          // `from '<pkg>'` or `import('<pkg>')` — a mention inside prose has no quote before it.
          // `-` first in the class so it is a literal rather than a range, which is what lets both
          // it and the scope separator be escaped without an escape ESLint reads as pointless.
          if (new RegExp(`['"\`]${packageName.replace(/[-/]/g, '\\$&')}`).test(line)) {
            violations.push({
              file: file.relativePath,
              line: index + 1,
              detail: `imports ${packageName}`,
            });
          }
        }
      });
    }

    expect(
      violations.map((violation) => `${violation.file}:${violation.line} ${violation.detail}`),
      'the provider is resolved at the composition root and injected; nothing below the port may name one',
    ).toEqual([]);
  });
});

describe('no neutral layer names a provider in code', () => {
  it.each(NEUTRAL_PACKAGES)('packages/%s/src mentions no provider outside a comment', (directoryName) => {
    const violations: Violation[] = [];

    for (const file of filesOf(directoryName)) {
      const executable = stripComments(file.text).split('\n');

      executable.forEach((line, index) => {
        if (isChannelVocabulary(line)) return;
        for (const token of PROVIDER_TOKENS) {
          // Word-bounded and case-insensitive, so `GithubConnector`, `'github'` and `sourceIsJira`
          // all trip it while `slackness` — were anybody to write it — does not.
          if (new RegExp(`\\b${token}\\b`, 'i').test(line)) {
            violations.push({
              file: file.relativePath,
              line: index + 1,
              detail: `names \`${token}\` in executable code`,
            });
          }
        }
      });
    }

    expect(
      violations.map((violation) => `${violation.file}:${violation.line} ${violation.detail}`),
      'a provider name above the port means one provider’s shape is visible to a layer that must not ' +
        'be able to tell them apart. Move the behaviour behind ConnectorPort.',
    ).toEqual([]);
  });

  it('is not vacuous: the scan finds a planted violation', () => {
    /**
     * The guard this gate needs and would otherwise lack.
     *
     * Every assertion above passes on an empty violation list, which is also what a broken scanner
     * produces. This proves the matcher rejects the thing it exists to reject, and that comment
     * stripping does not swallow real code.
     */
    const planted = [
      '// A comment mentioning github is fine and must not trip the gate.',
      '/* Nor a block comment about Jira. */',
      "const provider = 'github';",
    ].join('\n');

    const executable = stripComments(planted);

    expect(executable).not.toContain('comment mentioning');
    expect(executable).not.toContain('block comment about');
    // The one line that executes is the one that is caught.
    expect(/\bgithub\b/i.test(executable)).toBe(true);
    expect(/\bjira\b/i.test(executable)).toBe(false);
  });

  it('exempts a channel vocabulary and nothing that merely resembles one', () => {
    /**
     * The guard the exemption needs, and would otherwise lack.
     *
     * An exemption nobody tests is an exemption that widens on its next edit. This pins both directions:
     * the one line it exists for is admitted, and four lines a careless widening would also admit are not.
     */
    expect(isChannelVocabulary("export const MEMO_SOURCE_CHANNELS = ['email', 'slack', 'web'] as const;")).toBe(
      true,
    );

    // A provider branch names no channel and no email.
    expect(isChannelVocabulary("const provider = 'github';")).toBe(false);
    // A channel-shaped name with no email is not a channel vocabulary; it is a provider list.
    expect(isChannelVocabulary("const CHANNELS = ['slack', 'github'];")).toBe(false);
    // An email mention with no channel declaration does not license a provider name either.
    expect(isChannelVocabulary("const from = 'email'; const host = 'github';")).toBe(false);
    // And the exemption is per line, so it cannot cover the statement after it.
    expect(isChannelVocabulary("if (source === 'jira') return;")).toBe(false);
  });

  it('scans a non-empty set of files, so a renamed package cannot empty the gate', () => {
    // Without this, a typo in NEUTRAL_PACKAGES would reduce every assertion above to a pass over
    // nothing — the exact shape of failure the clock gate's own "enabled for exactly" test prevents.
    for (const directoryName of NEUTRAL_PACKAGES) {
      expect(filesOf(directoryName).length, `packages/${directoryName}/src has no scanned files`).toBeGreaterThan(0);
    }
  });
});
