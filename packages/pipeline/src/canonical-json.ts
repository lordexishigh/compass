import { createHash } from 'node:crypto';

/**
 * The determinism gate.
 *
 * Generating a report twice for the same (org, team, instant) must produce
 * byte-identical structured JSON. Two things make that checkable: a canonical
 * serializer with sorted keys, and one documented allowlist of fields that are
 * genuinely non-semantic and therefore excluded from the hash.
 */
export const NON_SEMANTIC_FIELDS: readonly string[] = ['generatedAt', 'runId', 'narrationTraceId'];

export class NonSerializableValueError extends Error {
  constructor(path: string, detail: string) {
    super(`Value at ${path} ${detail}; it cannot take part in a canonical serialisation.`);
    this.name = 'NonSerializableValueError';
  }
}

/**
 * JSON with object keys in code-unit order and no incidental whitespace.
 * Arrays keep their order — ordering arrays is the snapshot layer's job, and
 * silently sorting them here would hide a determinism bug rather than expose it.
 */
export function canonicalJson(value: unknown, options: { readonly exclude?: readonly string[] } = {}): string {
  const exclude = new Set(options.exclude ?? []);
  return serialize(value, '$', exclude);
}

function serialize(value: unknown, path: string, exclude: ReadonlySet<string>): string {
  if (value === null) return 'null';

  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new NonSerializableValueError(path, `is ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (kind === 'undefined') {
    throw new NonSerializableValueError(path, 'is undefined (omit the key instead)');
  }
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    throw new NonSerializableValueError(path, `is a ${kind}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => serialize(entry, `${path}[${index}]`, exclude)).join(',')}]`;
  }

  if (value instanceof Date) {
    throw new NonSerializableValueError(path, 'is a Date (store an Instant instead)');
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, nested]) => !exclude.has(key) && nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${serialize(nested, `${path}.${key}`, exclude)}`)
    .join(',')}}`;
}

/**
 * The content hash a report row stores. Computed over the canonical JSON with
 * the documented non-semantic allowlist removed, so two runs that differ only
 * in `generatedAt` or `runId` hash identically.
 */
export function reportHash(value: unknown, exclude: readonly string[] = NON_SEMANTIC_FIELDS): string {
  return createHash('sha256').update(canonicalJson(value, { exclude }), 'utf8').digest('hex');
}

/** True when two values are the same report under the determinism gate. */
export function isSameReport(left: unknown, right: unknown): boolean {
  return reportHash(left) === reportHash(right);
}
