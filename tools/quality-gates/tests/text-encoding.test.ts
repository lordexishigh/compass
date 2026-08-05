import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, collectSourceFiles } from './helpers/workspace.js';

/**
 * Every authored file is UTF-8 without a BOM, and nothing in the tree is mojibaked.
 *
 * ## Why this gate exists
 *
 * It caught a real regression, and the regression reached *report prose* rather than a comment. A
 * scripted edit run through Windows PowerShell 5.1 — `Get-Content | ... | Set-Content -Encoding utf8` —
 * does two damaging things at once: `-Encoding utf8` writes a **BOM**, and the read/write round trip
 * re-encodes every non-ASCII character through the console codepage. Every em dash in
 * `packages/analysis/src/generate.ts` was mangled, which is not a comment problem: those strings are the
 * sprint headline, the Yesterday detail, the projection detail and the recommendation headline. The
 * merged report's ranked lines are built from exactly those sentences, and the merged report is the
 * surface under a word budget — the one page where garbled text is most visible and least excusable.
 *
 * One of the corrupted strings was also a *normalising regex* (`.replace(/\s+—/, ' —')`), so the
 * corruption silently disabled the normalisation it was written to perform. That is the class of bug a
 * grep for a byte sequence catches and a reviewer reading a diff does not.
 *
 * ## What it checks
 *
 * - **No BOM.** `EF BB BF` at the head of a file. Harmless in most tools and not harmless in all of
 *   them: a BOM inside a `.json` breaks strict parsers, and in a `.ts` it becomes part of the first
 *   token for anything reading the file as text rather than through the compiler.
 * - **No mojibake.** `U+00E2 U+20AC` is the fingerprint of UTF-8 decoded as CP1252 and re-encoded. It
 *   cannot occur in text anybody meant to write — that pair is not a sequence in any language here.
 * - **No replacement characters.** `U+FFFD` is what a *failed* repair leaves behind, which is how the
 *   first attempt at fixing the above made it worse: an em dash, a curly apostrophe and an arrow all
 *   collapse to the same `U+FFFD`, so at that point the information is gone rather than re-encoded.
 *
 * Documentation and configuration are scanned as well as code, because `docs/` carries the prose the doc
 * gates diff against constants, and a mangled em dash there would fail those gates for an invisible
 * reason.
 *
 * ## Why the needles are escapes
 *
 * A gate that spelled its own needle would be its own first offender, and excluding itself from the scan
 * would be worse — that exclusion is exactly the hole a future corruption slips through. Written as
 * escapes, this file is pure ASCII apart from the em dashes in this comment, and can be scanned by the
 * rule it enforces.
 */

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.md', '.css', '.json', '.mjs', '.cjs', '.js', '.sql'] as const;

const SCANNED_FILES = [
  ...collectSourceFiles(join(REPO_ROOT, 'packages'), SCANNED_EXTENSIONS),
  ...collectSourceFiles(join(REPO_ROOT, 'apps'), SCANNED_EXTENSIONS),
  ...collectSourceFiles(join(REPO_ROOT, 'tools'), SCANNED_EXTENSIONS),
  ...collectSourceFiles(join(REPO_ROOT, 'docs'), SCANNED_EXTENSIONS),
];

/** The fingerprint of UTF-8 decoded as CP1252 and re-encoded. */
const MOJIBAKE = '\u00e2\u20ac';

/** What a failed repair leaves behind. Never intentional. */
const REPLACEMENT = '\uFFFD';

const EM_DASH = '—';

const read = (file: { readonly absolutePath: string }): string => readFileSync(file.absolutePath, 'utf8');

describe('every authored file is UTF-8 without a BOM', () => {
  it('found the tree at all, so an empty scan cannot pass this file', () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(200);
    expect(SCANNED_FILES.map((file) => file.relativePath)).toContain('packages/analysis/src/generate.ts');
  });

  it('has no byte-order mark anywhere', () => {
    const offenders = SCANNED_FILES.filter((file) => {
      const bytes = readFileSync(file.absolutePath);
      return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    }).map((file) => file.relativePath);

    expect(
      offenders,
      'these files start with a UTF-8 BOM. On Windows that comes from `Set-Content -Encoding utf8` — use ' +
        '`[System.IO.File]::WriteAllText(path, text, New-Object System.Text.UTF8Encoding($false))`, or the Write tool.',
    ).toEqual([]);
  });

  it('has no mojibaked UTF-8 anywhere', () => {
    const offenders = SCANNED_FILES.filter((file) => read(file).includes(MOJIBAKE)).map((file) => file.relativePath);

    expect(
      offenders,
      'these files contain U+00E2 U+20AC, which is UTF-8 that was decoded as CP1252 and re-encoded. Every em dash, ' +
        'curly apostrophe and arrow in them is wrong, including any inside a regex — where the corruption also stops ' +
        'the pattern matching. Do not hand-fix the visible characters: re-save the file as UTF-8 without a BOM.',
    ).toEqual([]);
  });

  it('has no unicode replacement characters anywhere', () => {
    const offenders = SCANNED_FILES.filter((file) => read(file).includes(REPLACEMENT)).map(
      (file) => file.relativePath,
    );

    expect(offenders, 'these files contain U+FFFD, which is text that was destroyed rather than re-encoded').toEqual(
      [],
    );
  });
});

describe('the characters this repo actually writes survive a round trip', () => {
  const generate = (): string => readFileSync(join(REPO_ROOT, 'packages/analysis/src/generate.ts'), 'utf8');

  it('still spells the em dash in the prose the merged report is built from', () => {
    // Named sites rather than a blanket count: these four strings *are* what the merged report's ranked
    // lines are built from, so a corruption here shows on the one page with a word budget.
    const source = generate();

    // The sprint claim states the basis it measured in before its dash — `19% complete by
    // ticket count — 4 of 21 tickets and 11 of 48 points` — so the dash sits after the
    // interpolated basis label rather than after the percentage.
    expect(source, 'the sprint headline').toContain(`complete by \${basisLabel} ${EM_DASH} `);
    expect(source, 'the Yesterday detail').toContain(`${EM_DASH} evidence: `);
    expect(source, 'the recommendation headline').toContain(`displayName} ${EM_DASH} `);
    expect(source, 'the projection detail').toContain(`confidence ${EM_DASH} `);
  });

  it('keeps the Yesterday normalising regex matching its own em dash', () => {
    // The subtle half. `.replace(/\s+—/, ' —')` collapses the space before the detail's dash; with a
    // corrupted pattern it silently stops matching and the report renders a double space instead. Both
    // sides have to be the real character, so they are asserted together.
    const source = generate();

    expect(source).toContain(`/\\s+${EM_DASH}/`);
    expect(source).toContain(`' ${EM_DASH}'`);
  });

  it('keeps the reader-facing time-travel refusals spelled correctly', () => {
    // These sentences are returned as a 400 `detail` and rendered verbatim by the scrubber, so a mangled
    // dash in them is read by a manager rather than by a reviewer.
    const archive = readFileSync(join(REPO_ROOT, 'apps/web/lib/archive-source.ts'), 'utf8');

    expect(archive).toContain('outside the seeded history');
    expect(archive).not.toContain(MOJIBAKE);
    expect(archive).not.toContain(REPLACEMENT);
  });
});
