import { instantFromEpochMillis, type Instant } from '@compass/clock';
import { fromDatabaseInstant, namedEntity, toDatabaseInstant, type EntityKind, type NamedEntityDefinition } from '@compass/db';

/**
 * Tracked-field values, and the one place they are compared.
 *
 * Two problems live here and both are about determinism. First, a field's value
 * arrives as an `Instant` (a number) and lands in a `timestamptz` column, so it
 * comes back as a `Date`; comparing those directly would report a change on every
 * single observation. Second, a JSON column's value has no canonical spelling —
 * `{a:1,b:2}` and `{b:2,a:1}` are the same belief but different strings — so
 * object keys are sorted before comparison and before the value is written into
 * `entity_versions`.
 *
 * The canonical form is also what history stores: instants as epoch millis,
 * objects key-sorted. That is what makes an `entity_versions` row plain JSON that
 * a snapshot can serialise byte-identically years later.
 */

export type FieldValue = string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>;

export type FieldSet = Readonly<Record<string, FieldValue>>;

/** The canonical, plain-JSON form of a single value. */
export function canonicalValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, canonicalValue(nested)] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`A tracked field cannot hold ${String(value)}; it would not survive JSON.`);
  }
  return value;
}

/** Canonical JSON text, for equality. Never shown to a user. */
export function canonicalText(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? 'null';
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return canonicalText(left) === canonicalText(right);
}

export function canonicalFields(fields: FieldSet): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) {
    canonical[key] = canonicalValue(fields[key]);
  }
  return canonical;
}

export class UntrackedFieldError extends Error {
  constructor(kind: EntityKind, fields: readonly string[]) {
    super(
      `Observation of \`${kind}\` names ${fields.length === 1 ? 'a field' : 'fields'} the registry does not track: ${fields.join(', ')}. Add the column and the registry entry together.`,
    );
    this.name = 'UntrackedFieldError';
  }
}

export class IncompleteObservationError extends Error {
  constructor(kind: EntityKind, fields: readonly string[]) {
    super(
      `Observation of \`${kind}\` omits ${fields.join(', ')}. A tracked field set must be complete, or an absent key would be indistinguishable from a value that changed to null.`,
    );
    this.name = 'IncompleteObservationError';
  }
}

/**
 * An observation must state every tracked field.
 *
 * A partial observation is rejected rather than merged, because merging would make
 * "this field was not observed" and "this field became null" the same event, and
 * the whole point of the version history is to be able to tell the difference.
 */
export function assertCompleteFieldSet(kind: EntityKind, fields: FieldSet): NamedEntityDefinition {
  const definition = namedEntity(kind);
  const tracked = new Set(definition.trackedFields);

  const unknownFields = Object.keys(fields).filter((field) => !tracked.has(field));
  if (unknownFields.length > 0) throw new UntrackedFieldError(kind, unknownFields.sort());

  const missing = definition.trackedFields.filter((field) => !(field in fields));
  if (missing.length > 0) throw new IncompleteObservationError(kind, [...missing].sort());

  return definition;
}

/** Field values as the SQL layer wants them: instants become `Date`. */
export function toColumnValues(definition: NamedEntityDefinition, fields: FieldSet): Record<string, unknown> {
  const instants = new Set(definition.instantFields);
  const values: Record<string, unknown> = {};

  for (const field of definition.trackedFields) {
    const value = fields[field] ?? null;
    if (!instants.has(field)) {
      values[field] = canonicalValue(value);
      continue;
    }
    if (value === null) {
      values[field] = null;
      continue;
    }
    if (typeof value !== 'number') {
      throw new TypeError(`\`${definition.kind}.${field}\` is an instant field but received ${typeof value}.`);
    }
    values[field] = toDatabaseInstant(instantFromEpochMillis(value));
  }

  return values;
}

/** Field values as read back from a row: `Date` becomes an `Instant` (epoch millis). */
export function fromColumnValues(
  definition: NamedEntityDefinition,
  row: Readonly<Record<string, unknown>>,
): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};

  for (const field of definition.trackedFields) {
    const raw = row[field] ?? null;
    fields[field] = raw instanceof Date ? (fromDatabaseInstant(raw) as unknown as number) : (canonicalValue(raw) as FieldValue);
  }

  return fields;
}

/** The tracked fields whose canonical value differs, sorted. */
export function changedFieldNames(
  definition: NamedEntityDefinition,
  prior: Readonly<Record<string, unknown>>,
  next: FieldSet,
): readonly string[] {
  return definition.trackedFields
    .filter((field) => !valuesEqual(prior[field] ?? null, next[field] ?? null))
    .sort();
}

/** Reads an instant-valued tracked field back off a canonical field set. */
export function instantField(fields: Readonly<Record<string, unknown>>, field: string): Instant | null {
  const value = fields[field];
  return typeof value === 'number' ? instantFromEpochMillis(value) : null;
}

/** A sorted set union — the idempotent way to grow a list-valued tracked field. */
export function unionSorted(existing: readonly unknown[] | null, additions: readonly string[]): readonly string[] {
  const values = new Set<string>();
  for (const value of existing ?? []) {
    if (typeof value === 'string') values.add(value);
  }
  for (const value of additions) values.add(value);
  return [...values].sort();
}
