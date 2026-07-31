import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import { ARTIFACT_KINDS, type ArtifactKind } from '@compass/connector-port';

import type { SeedDataset, SeedRecords, SeedSource } from './dataset.js';
import { loadSeedFixtures } from './fixtures.js';
import { generateSeed, type GeneratedObjective } from './generator.js';
import { computeManifest, renderManifestMarkdown, type SeedManifest } from './manifest.js';
import {
  MANIFEST_DATA_FILE_NAME,
  artifactFileName,
  fromReadableRecords,
  serializeRecords,
  stableJsonText,
  toReadableRecords,
} from './serialize.js';
import {
  resolveSeedDirectory,
  seedFixturesDirectory,
  seedGeneratedDirectory,
  seedManifestPath,
  SEED_MANIFEST_FILE_NAME,
} from './seed-paths.js';
import { buildTraceabilityContext, type TraceabilityContext } from './traceability.js';

/**
 * Writing the seed to disk, and reading it back.
 *
 * The generated tree is the product's runtime substrate, so it is checked in
 * rather than built on boot: a cold checkout must be able to render a report
 * without running a generator first. `writeSeedFiles` is what `pnpm
 * seed:generate` calls; `loadSeedBundle` is what the connector reads.
 */

export const DATASET_META_FILE_NAME = 'dataset.json';

export interface SeedDatasetMeta {
  readonly datasetId: string;
  readonly organizationId: string;
  readonly companyName: string;
  readonly deploySignal: boolean;
  readonly now: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly reportWindow: { readonly start: string; readonly end: string };
  readonly unavailableSourceKey: string | null;
  readonly sources: readonly SeedSource[];
  readonly objectives: readonly GeneratedObjective[];
}

export interface SeedBundle {
  readonly dataset: SeedDataset;
  readonly manifest: SeedManifest;
  readonly meta: SeedDatasetMeta;
  readonly window: TimeWindow;
  readonly reportWindow: TimeWindow;
  readonly now: Instant;
  readonly organizationId: string;
  readonly unavailableSourceKey: string | null;
  readonly traceabilityContext: TraceabilityContext;
}

export class SeedNotGeneratedError extends Error {
  constructor(seedDirectory: string, missing: string) {
    super(
      `The seed dataset has not been generated: ${missing} is missing under ${seedDirectory}. Run \`pnpm seed:generate\`.`,
    );
    this.name = 'SeedNotGeneratedError';
  }
}

/** Every file `pnpm seed:generate` writes, keyed by path relative to `seed/`. */
export function buildSeedFiles(fixturesDirectory?: string): ReadonlyMap<string, string> {
  const fixtures = loadSeedFixtures(fixturesDirectory);
  const generated = generateSeed(fixtures);
  const manifest = computeManifest(generated, fixtures);

  const meta: SeedDatasetMeta = {
    datasetId: generated.dataset.datasetId,
    organizationId: generated.organizationId,
    companyName: generated.companyName,
    deploySignal: generated.dataset.deploySignal,
    now: manifest.now,
    window: manifest.window,
    reportWindow: manifest.reportWindow,
    unavailableSourceKey: generated.unavailableSourceKey,
    sources: generated.dataset.sources,
    objectives: generated.objectives,
  };

  const files = new Map<string, string>();
  for (const [fileName, text] of serializeRecords(generated.dataset.records)) {
    files.set(`generated/${fileName}`, text);
  }
  files.set(`generated/${DATASET_META_FILE_NAME}`, stableJsonText(meta));
  files.set(`generated/${MANIFEST_DATA_FILE_NAME}`, stableJsonText(manifest));
  files.set(SEED_MANIFEST_FILE_NAME, renderManifestMarkdown(manifest, generated.dataset));
  return files;
}

export interface WriteSeedResult {
  readonly seedDirectory: string;
  readonly written: readonly string[];
  readonly changed: readonly string[];
  /** Files under `generated/` this generator no longer produces. */
  readonly stale: readonly string[];
}

/**
 * Writes every generated file, always with `\n` endings and no byte-order mark.
 * `.gitattributes` pins `seed/**` to LF so the bytes survive a checkout on
 * Windows; without both halves the byte-identity test passes on one platform
 * and fails on the other.
 */
export function writeSeedFiles(options: { readonly seedDirectory?: string } = {}): WriteSeedResult {
  const seedDirectory = options.seedDirectory ?? resolveSeedDirectory();
  const files = buildSeedFiles(seedFixturesDirectory(seedDirectory));

  mkdirSync(seedGeneratedDirectory(seedDirectory), { recursive: true });

  const written: string[] = [];
  const changed: string[] = [];
  for (const [relativePath, text] of files) {
    const absolutePath = join(seedDirectory, relativePath);
    const previous = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
    if (previous !== text) changed.push(relativePath);
    writeFileSync(absolutePath, text, { encoding: 'utf8' });
    written.push(relativePath);
  }

  // A file left behind by an older fixture set would still sit in the tree and
  // read as part of the seed, so a rename is reported rather than ignored. It is
  // named, not deleted: removing a file the generator does not own would be a
  // surprising thing for a generate command to do.
  const expected = new Set([...files.keys()].filter((path) => path.startsWith('generated/')));
  const stale = readdirSync(seedGeneratedDirectory(seedDirectory))
    .filter((entry) => !expected.has(`generated/${entry}`))
    .map((entry) => `generated/${entry}`)
    .sort();

  return { seedDirectory, written, changed, stale };
}

function readJson<TShape>(seedDirectory: string, relativePath: string): TShape {
  const absolutePath = join(seedDirectory, relativePath);
  if (!existsSync(absolutePath)) throw new SeedNotGeneratedError(seedDirectory, relativePath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as TShape;
}

/** Reads the checked-in dataset from disk. No generation, no clock, no network. */
export function loadSeedBundle(seedDirectory: string = resolveSeedDirectory()): SeedBundle {
  const meta = readJson<SeedDatasetMeta>(seedDirectory, `generated/${DATASET_META_FILE_NAME}`);
  const manifest = readJson<SeedManifest>(seedDirectory, `generated/${MANIFEST_DATA_FILE_NAME}`);

  const records = Object.fromEntries(
    ARTIFACT_KINDS.map((artifact) => [
      artifact,
      fromReadableRecords(
        artifact,
        readJson<Record<string, unknown>[]>(seedDirectory, `generated/${artifactFileName(artifact)}`),
      ),
    ]),
  ) as unknown as SeedRecords;

  const dataset: SeedDataset = {
    datasetId: meta.datasetId,
    deploySignal: meta.deploySignal,
    sources: meta.sources,
    records,
  };

  return {
    dataset,
    manifest,
    meta,
    window: timeWindow(instantFromIso(meta.window.start), instantFromIso(meta.window.end)),
    reportWindow: timeWindow(instantFromIso(meta.reportWindow.start), instantFromIso(meta.reportWindow.end)),
    now: instantFromIso(meta.now),
    organizationId: meta.organizationId,
    unavailableSourceKey: meta.unavailableSourceKey,
    traceabilityContext: buildTraceabilityContext({
      issues: records.issues,
      sprints: records.sprints,
      objectives: meta.objectives,
    }),
  };
}

let cachedBundle: SeedBundle | null = null;

/** The checked-in seed, read once per process. */
export function seedBundle(): SeedBundle {
  cachedBundle ??= loadSeedBundle();
  return cachedBundle;
}

export const seedDataset = (): SeedDataset => seedBundle().dataset;

/** Round-trips a dataset through the readable form — used by the round-trip test. */
export function roundTripRecords(records: SeedRecords): SeedRecords {
  return Object.fromEntries(
    ARTIFACT_KINDS.map((artifact: ArtifactKind) => [
      artifact,
      fromReadableRecords(artifact, [...toReadableRecords(artifact, records[artifact])]),
    ]),
  ) as unknown as SeedRecords;
}

export { seedManifestPath, seedGeneratedDirectory, seedFixturesDirectory };
