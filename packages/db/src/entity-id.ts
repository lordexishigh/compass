import { createHash } from 'node:crypto';

/**
 * Deterministic row identifiers.
 *
 * Primary keys are derived from the data they identify, not drawn from a random
 * generator, for one concrete reason: a snapshot of the database has to be
 * byte-comparable across runs. `randomUUID()` would make the idempotency test
 * ("ingest the same window three times and nothing changes") impossible to state,
 * because every row would differ in its id even when nothing about the entity
 * had.
 *
 * The construction is RFC 4122 name-based (version 5, SHA-1) with a fixed Compass
 * namespace, so the same (organization, kind, natural key) triple always produces
 * the same UUID — in this process, in the next release, and on another machine.
 */

/** The Compass namespace UUID. Fixed forever: changing it renumbers every row. */
export const COMPASS_UUID_NAMESPACE = '6b1c9d3a-4f27-4a6d-9c8e-1f3b5d7a9c02';

const NAMESPACE_BYTES = Buffer.from(COMPASS_UUID_NAMESPACE.replaceAll('-', ''), 'hex');

function formatUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * A version-5 UUID over `name` within the Compass namespace.
 *
 * `node:crypto` has no `uuidv5`, so the RFC construction is done here: hash the
 * namespace bytes followed by the name, then stamp the version and variant bits.
 */
export function deterministicUuid(name: string): string {
  const digest = createHash('sha1').update(NAMESPACE_BYTES).update(name, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('SHA-1 produced fewer than 16 bytes, which cannot happen.');
  }
  bytes[6] = (versionByte & 0x0f) | 0x50; // version 5
  bytes[8] = (variantByte & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(bytes);
}

/**
 * The id of an entity row. Derived from the tenant and the natural key, so the
 * same entity observed by two runs is one row rather than two.
 */
export function entityRowId(organizationId: string, kind: string, naturalKey: string): string {
  return deterministicUuid(`entity:${organizationId}:${kind}:${naturalKey}`);
}

/** The id of one `entity_versions` row. Unique per (entity, version) by construction. */
export function entityVersionRowId(
  organizationId: string,
  kind: string,
  naturalKey: string,
  version: number,
): string {
  return deterministicUuid(`entity-version:${organizationId}:${kind}:${naturalKey}:${version}`);
}

/**
 * The id of one history row, derived from the source's own record id. Two ingests
 * of an overlapping window therefore collide on the primary key as well as on the
 * natural uniqueness constraint.
 */
export function historyRowId(
  organizationId: string,
  table: string,
  sourceKey: string,
  sourceRecordId: string,
): string {
  return deterministicUuid(`history:${organizationId}:${table}:${sourceKey}:${sourceRecordId}`);
}

/** The id of a Correction, derived from the contradiction it records. */
export function correctionRowId(
  organizationId: string,
  subjectKind: string,
  subjectKey: string,
  priorVersion: number,
  evidenceSourceRecordId: string,
): string {
  return deterministicUuid(
    `correction:${organizationId}:${subjectKind}:${subjectKey}:${priorVersion}:${evidenceSourceRecordId}`,
  );
}

/** The id of an IngestRun. Derived from the window and connector, so a replay is one row. */
export function ingestRunRowId(
  organizationId: string,
  connectorId: string,
  windowStartMillis: number,
  windowEndMillis: number,
  attempt: number,
): string {
  return deterministicUuid(
    `ingest-run:${organizationId}:${connectorId}:${windowStartMillis}:${windowEndMillis}:${attempt}`,
  );
}
