import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXTURE_FILE_NAMES, loadSeedFixtures, resolveSeedDirectory, seedFixturesDirectory } from '@compass/seed-connector';

/**
 * The seed is text a human can review, and this is the gate that keeps it that
 * way. A checked-in binary or a single-line minified array would satisfy every
 * volume requirement in the manifest while being completely unreviewable, so
 * "human-readable" is defined here as three concrete numbers rather than left to
 * good intentions.
 *
 * The scan is scoped strictly to `seed/`. A repo-wide version would trip over
 * build output the moment anyone runs `next build`, and a gate that fails for an
 * unrelated reason gets disabled.
 */

const SEED_DIRECTORY = resolveSeedDirectory();

/** Extensions the seed is allowed to contain. Anything else is a blob by default. */
const ALLOWED_EXTENSIONS = new Set(['.json', '.md']);

/** A reviewable line. Generated JSON tops out around 290 characters. */
const MAX_LINE_LENGTH = 400;

/** Mean bytes per line. A minified file has thousands; the seed has under 70. */
const MAX_MEAN_BYTES_PER_LINE = 120;

interface SeedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
  readonly text: string;
}

function collectSeedFiles(directory: string = SEED_DIRECTORY): readonly SeedFile[] {
  const collected: SeedFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(absolutePath);
      collected.push({
        relativePath: relative(SEED_DIRECTORY, absolutePath).split('\\').join('/'),
        absolutePath,
        bytes,
        text: bytes.toString('utf8'),
      });
    }
  };
  walk(directory);
  return collected;
}

const seedFiles = collectSeedFiles();
const asCases = seedFiles.map((file) => [file.relativePath, file] as const);

describe('everything under seed/ is human-readable text', () => {
  it('finds files to check at all, so an empty scan cannot pass silently', () => {
    expect(seedFiles.length).toBeGreaterThan(10);
    expect(seedFiles.map((file) => file.relativePath)).toContain('MANIFEST.md');
  });

  it.each(asCases)('%s has an extension the seed format allows', (_label, file) => {
    expect(ALLOWED_EXTENSIONS.has(extname(file.relativePath)), `${file.relativePath} is not .json or .md`).toBe(true);
  });

  it.each(asCases)('%s is valid UTF-8 with no byte-order mark', (_label, file) => {
    // Round-tripping through UTF-8 is lossy for arbitrary bytes, so a binary
    // file cannot survive it unchanged.
    expect(Buffer.from(file.text, 'utf8').equals(file.bytes), `${file.relativePath} is not UTF-8`).toBe(true);
    expect(file.text.charCodeAt(0), `${file.relativePath} starts with a byte-order mark`).not.toBe(0xfeff);
  });

  it.each(asCases)('%s holds no NUL or stray control bytes', (_label, file) => {
    // eslint-disable-next-line no-control-regex -- the point of this test is control bytes
    const offending = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.exec(file.text);
    expect(offending, `${file.relativePath} contains the control byte ${JSON.stringify(offending?.[0])}`).toBeNull();
  });

  it.each(asCases)('%s is not minified: no line runs past the readable limit', (_label, file) => {
    const lines = file.text.split('\n');
    const longest = lines.reduce(
      (worst, line, index) => (line.length > worst.length ? { length: line.length, index: index + 1 } : worst),
      { length: 0, index: 0 },
    );
    expect(
      longest.length,
      `${file.relativePath}:${longest.index} is ${longest.length} characters long; a reviewable seed keeps lines under ${MAX_LINE_LENGTH}`,
    ).toBeLessThanOrEqual(MAX_LINE_LENGTH);
  });

  it.each(asCases)('%s averages few enough bytes per line to be a diff, not a blob', (_label, file) => {
    const lineCount = Math.max(1, file.text.split('\n').length);
    const meanBytesPerLine = file.bytes.length / lineCount;
    expect(
      Math.round(meanBytesPerLine),
      `${file.relativePath} averages ${Math.round(meanBytesPerLine)} bytes per line`,
    ).toBeLessThanOrEqual(MAX_MEAN_BYTES_PER_LINE);
  });

  it.each(asCases)('%s uses newline endings only, so regeneration is byte-identical', (_label, file) => {
    expect(file.text.includes('\r'), `${file.relativePath} contains a carriage return`).toBe(false);
    expect(file.text.endsWith('\n'), `${file.relativePath} has no trailing newline`).toBe(true);
  });
});

describe('the fixtures are the hand-edited half of the seed', () => {
  it('holds exactly the five documented fixture files', () => {
    const found = readdirSync(seedFixturesDirectory(SEED_DIRECTORY)).sort();
    expect(found).toEqual([...FIXTURE_FILE_NAMES].sort());
  });

  it('parses every fixture file into the declarative format', () => {
    const fixtures = loadSeedFixtures(seedFixturesDirectory(SEED_DIRECTORY));

    expect(fixtures.organization.datasetId.length).toBeGreaterThan(0);
    expect(fixtures.people.developers.length).toBeGreaterThanOrEqual(12);
    expect(fixtures.projects.projects.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.narrative.semanticSubjects.length).toBeGreaterThan(0);
    expect(fixtures.pathologies.offGoalWorkStream.issues.length).toBeGreaterThan(0);
  });

  it('carries a prose comment in each fixture, so an editor knows what it is for', () => {
    for (const fileName of FIXTURE_FILE_NAMES) {
      const raw = JSON.parse(
        readFileSync(join(seedFixturesDirectory(SEED_DIRECTORY), fileName), 'utf8'),
      ) as Record<string, unknown>;
      expect(Array.isArray(raw['$comment']), `seed/fixtures/${fileName} has no $comment`).toBe(true);
    }
  });
});

describe('git is told to leave the seed alone', () => {
  it('pins seed/** to newline endings in .gitattributes', () => {
    const repoRoot = join(SEED_DIRECTORY, '..');
    const attributes = readFileSync(join(repoRoot, '.gitattributes'), 'utf8');

    // Without this, a Windows checkout rewrites LF to CRLF and the "generate
    // twice, compare bytes" gate passes on one platform and fails on the other.
    expect(attributes).toMatch(/^seed\/\*\* +text +eol=lf$/m);
  });

  it('has a seed directory that is a directory, not a stray file', () => {
    expect(statSync(SEED_DIRECTORY).isDirectory()).toBe(true);
  });
});
