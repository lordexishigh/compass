import { instantFromIso, isInstant, toIso, type Instant } from '@compass/clock';
import { ARTIFACT_KINDS, type ArtifactKind, type ConnectorRecordFor } from '@compass/connector-port';

import type { SeedRecords } from './dataset.js';

/**
 * The on-disk projection of the dataset.
 *
 * Two rules make `seed/generated/**` reviewable rather than a blob: instants are
 * written as ISO-8601 strings, because a reviewer has to be able to read a
 * timestamp; and every object's keys are written in code-unit order at a fixed
 * two-space indent, because a diff should show what changed and nothing else.
 *
 * The round trip is exact — `fromReadable(toReadable(record))` deep-equals the
 * record — and a test asserts it, so the readable form is the dataset rather
 * than a lossy rendering of it.
 */

/** Which fields of each artifact family hold an `Instant`. */
export const INSTANT_FIELDS = {
  commits: ['occurredAt', 'authoredAt'],
  pull_requests: ['occurredAt', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt'],
  reviews: ['occurredAt', 'submittedAt'],
  branch_refs: ['occurredAt', 'observedAt'],
  release_tags: ['occurredAt', 'releasedAt'],
  issues: ['occurredAt', 'createdAt', 'updatedAt', 'resolvedAt'],
  issue_transitions: ['occurredAt', 'transitionedAt'],
  sprints: ['occurredAt', 'startAt', 'endAt', 'completedAt'],
  sprint_scope_changes: ['occurredAt', 'changedAt'],
  messages: ['occurredAt', 'postedAt'],
} as const satisfies Record<ArtifactKind, readonly string[]>;

/** `seed/generated/commits.json` and friends. */
export const artifactFileName = (artifact: ArtifactKind): string => `${artifact}.json`;

export const MANIFEST_DATA_FILE_NAME = 'manifest.json';

export class SeedSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedSerializationError';
  }
}

type ReadableRecord = Record<string, unknown>;

function toReadableRecord(artifact: ArtifactKind, record: unknown): ReadableRecord {
  const instantFields: readonly string[] = INSTANT_FIELDS[artifact];
  const readable: ReadableRecord = {};
  for (const [key, value] of Object.entries(record as ReadableRecord)) {
    if (!instantFields.includes(key)) {
      readable[key] = value;
      continue;
    }
    if (value === null) {
      readable[key] = null;
      continue;
    }
    if (!isInstant(value)) {
      throw new SeedSerializationError(`${artifact}.${key} is declared an instant but holds ${JSON.stringify(value)}.`);
    }
    readable[key] = toIso(value);
  }
  return readable;
}

function fromReadableRecord(artifact: ArtifactKind, readable: ReadableRecord): unknown {
  const instantFields: readonly string[] = INSTANT_FIELDS[artifact];
  const record: ReadableRecord = {};
  for (const [key, value] of Object.entries(readable)) {
    if (!instantFields.includes(key)) {
      record[key] = value;
      continue;
    }
    if (value === null) {
      record[key] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw new SeedSerializationError(`${artifact}.${key} should be an ISO-8601 string but is ${typeof value}.`);
    }
    record[key] = instantFromIso(value) as Instant;
  }
  return record;
}

export const toReadableRecords = (artifact: ArtifactKind, records: readonly unknown[]): readonly ReadableRecord[] =>
  records.map((record) => toReadableRecord(artifact, record));

export const fromReadableRecords = <TKind extends ArtifactKind>(
  artifact: TKind,
  readable: readonly ReadableRecord[],
): readonly ConnectorRecordFor<TKind>[] =>
  readable.map((record) => fromReadableRecord(artifact, record)) as readonly ConnectorRecordFor<TKind>[];

/**
 * JSON with object keys in code-unit order, a fixed two-space indent and a
 * trailing newline. `JSON.stringify` is deliberately not used for objects: its
 * key order is insertion order, which would make the diff of a regenerated file
 * depend on the order the generator happened to assign fields.
 */
export function stableJsonText(value: unknown): string {
  return `${stringify(value, 0)}\n`;
}

function stringify(value: unknown, depth: number): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new SeedSerializationError(`A seed value is ${String(value)}, which JSON cannot represent.`);
    }
    return JSON.stringify(value);
  }
  if (kind === 'undefined') {
    throw new SeedSerializationError('A seed value is undefined; omit the key instead.');
  }

  const indent = '  '.repeat(depth + 1);
  const closingIndent = '  '.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const entries = value.map((entry) => `${indent}${stringify(entry, depth + 1)}`);
    return `[\n${entries.join(',\n')}\n${closingIndent}]`;
  }

  const pairs = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (pairs.length === 0) return '{}';
  const entries = pairs.map(([key, nested]) => `${indent}${JSON.stringify(key)}: ${stringify(nested, depth + 1)}`);
  return `{\n${entries.join(',\n')}\n${closingIndent}}`;
}

/** The generated artifact files, keyed by file name, in `ARTIFACT_KINDS` order. */
export function serializeRecords(records: SeedRecords): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const artifact of ARTIFACT_KINDS) {
    files.set(artifactFileName(artifact), stableJsonText(toReadableRecords(artifact, records[artifact])));
  }
  return files;
}
