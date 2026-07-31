import type { Instant, TimeWindow } from '@compass/clock';

/**
 * The materialized snapshot: the only thing the analysis core is ever shown.
 *
 * It is fully materialized before the call — no lazy loading, no database
 * handles, no promises, no clock — so determinism reduces to canonical ordering
 * at this boundary. `sealSnapshot` enforces exactly that, and fails with the
 * path of the offending value rather than producing a report that cannot be
 * reproduced.
 *
 * The entity collections themselves land with the knowledge-model task; this is
 * the envelope and its invariants.
 */
export interface SnapshotEnvelope<TCollections extends object> {
  readonly organizationId: string;
  readonly scope: { readonly kind: 'team'; readonly teamKey: string } | { readonly kind: 'merged' };
  /** The instant the snapshot represents — supplied, never read from a clock. */
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly collections: TCollections;
}

export class SnapshotSerializationError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Snapshot value at ${path} ${detail}. A snapshot must be plain, serializable data.`);
    this.name = 'SnapshotSerializationError';
    this.path = path;
  }
}

const PLAIN_PROTOTYPES = new Set<unknown>([Object.prototype, null]);

function assertPlain(value: unknown, path: string): void {
  if (value === null) return;

  const kind = typeof value;
  if (kind === 'function') {
    throw new SnapshotSerializationError(path, 'is a function');
  }
  if (kind === 'symbol') {
    throw new SnapshotSerializationError(path, 'is a symbol');
  }
  if (kind === 'bigint') {
    throw new SnapshotSerializationError(path, 'is a bigint and would not survive JSON');
  }
  if (kind === 'number' && !Number.isFinite(value as number)) {
    throw new SnapshotSerializationError(path, 'is not a finite number');
  }
  if (kind !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPlain(entry, `${path}[${index}]`));
    return;
  }
  if (value instanceof Date) {
    throw new SnapshotSerializationError(path, 'is a Date; store an Instant (epoch millis) instead');
  }
  if (value instanceof Map || value instanceof Set) {
    throw new SnapshotSerializationError(path, 'is a Map or Set; use a sorted array instead');
  }
  if (value instanceof Promise) {
    throw new SnapshotSerializationError(path, 'is a Promise; the snapshot must be fully materialized');
  }
  if (!PLAIN_PROTOTYPES.has(Object.getPrototypeOf(value))) {
    throw new SnapshotSerializationError(path, 'is a class instance, not a plain object');
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    assertPlain(nested, `${path}.${key}`);
  }
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

/**
 * Validates and freezes a snapshot. Call this at the boundary: everything past
 * it is guaranteed plain, immutable and serializable.
 */
export function sealSnapshot<TCollections extends object>(
  snapshot: SnapshotEnvelope<TCollections>,
): SnapshotEnvelope<TCollections> {
  assertPlain(snapshot.collections, '$.collections');
  return deepFreeze(snapshot);
}

export function isSealed(snapshot: SnapshotEnvelope<object>): boolean {
  return Object.isFrozen(snapshot) && Object.isFrozen(snapshot.collections);
}
