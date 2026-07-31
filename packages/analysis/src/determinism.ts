/**
 * The determinism gate's serialiser and its one documented allowlist.
 *
 * Generating a report twice for the same `(organization, team, instant)` must
 * produce byte-identical JSON. That is not a nice property — it is the
 * precondition for everything else the product claims. Time travel re-runs the
 * same path for a past instant and must land on the same report. Golden fixtures
 * are only meaningful if a re-run reproduces them. And a manager who reloads the
 * page and sees a different number has no reason to believe either one.
 *
 * Exactly three fields are excluded from the comparison, and they are excluded
 * because they are *about the run* rather than about the org: when generation
 * happened, which run did it, and which narration trace belongs to it. Everything
 * else — every count, every date, every ordering — is semantic and must match.
 *
 * The list lives here, in the analysis package, because this is the layer that
 * defines the report. `packages/pipeline` re-exports it rather than declaring its
 * own, `packages/analysis/DETERMINISM.md` documents it in prose, and
 * `tests/determinism.test.ts` parses that document and fails if the two disagree.
 * A constant, a document and a test that reads both is the only arrangement where
 * the documentation cannot rot.
 */
export const NON_SEMANTIC_REPORT_FIELDS: readonly string[] = Object.freeze([
  'generatedAt',
  'narrationTraceId',
  'runId',
]);

export class NonSerializableReportValueError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Value at ${path} ${detail}; a report must serialise to stable, canonical JSON.`);
    this.name = 'NonSerializableReportValueError';
    this.path = path;
  }
}

/**
 * Canonical JSON: object keys in code-unit order, no incidental whitespace.
 *
 * Arrays keep their order deliberately. Sorting them here would *hide* a
 * determinism bug rather than surface it — if two runs disagree about the order
 * of the Yesterday items, that is a defect in the ordering key, and this gate's
 * job is to make it fail loudly rather than to paper over it.
 *
 * `undefined` is a hard error, not a silently dropped key, at every position
 * except an object property (where dropping it is what `JSON.stringify` does and
 * what the exclusion list relies on). A stray `undefined` inside an array would
 * otherwise serialise as `null` and quietly change meaning.
 */
export function canonicalReportJson(
  value: unknown,
  options: { readonly exclude?: readonly string[] } = {},
): string {
  const exclude = new Set(options.exclude ?? NON_SEMANTIC_REPORT_FIELDS);
  return serialize(value, '$', exclude);
}

function serialize(value: unknown, path: string, exclude: ReadonlySet<string>): string {
  if (value === null) return 'null';

  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'boolean') return value === true ? 'true' : 'false';
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new NonSerializableReportValueError(path, `is ${String(value)}`);
    }
    // `-0` and `0` are the same number but stringify differently, which would
    // make two arithmetically identical reports compare unequal.
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (kind === 'undefined') {
    throw new NonSerializableReportValueError(path, 'is undefined (omit the key instead)');
  }
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    throw new NonSerializableReportValueError(path, `is a ${kind}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => serialize(entry, `${path}[${index}]`, exclude)).join(',')}]`;
  }
  if (value instanceof Date) {
    throw new NonSerializableReportValueError(path, 'is a Date (store an Instant instead)');
  }
  if (value instanceof Map || value instanceof Set) {
    throw new NonSerializableReportValueError(path, 'is a Map or Set (use a sorted array instead)');
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, nested]) => !exclude.has(key) && nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${serialize(nested, `${path}.${key}`, exclude)}`)
    .join(',')}}`;
}

/** True when two reports are identical under the gate. */
export function reportsAreIdentical(left: unknown, right: unknown): boolean {
  return canonicalReportJson(left) === canonicalReportJson(right);
}

export interface CanonicalDifference {
  readonly path: string;
  readonly left: string;
  readonly right: string;
}

/**
 * The first place two reports diverge, for a failure message worth reading.
 *
 * A byte-diff of two 40KB JSON strings tells a developer nothing. This walks both
 * structures and names the path — `$.findings.yesterday[3].completedAt` — which
 * is usually enough to identify the nondeterministic source on sight.
 */
export function firstCanonicalDifference(left: unknown, right: unknown, path = '$'): CanonicalDifference | null {
  const leftJson = canonicalReportJson(left);
  const rightJson = canonicalReportJson(right);
  if (leftJson === rightJson) return null;
  return walk(left, right, path);
}

/**
 * A serialisation that never throws, for the *diagnostic* path only.
 *
 * `canonicalReportJson` refuses `undefined` on purpose, but the differ has to be
 * able to describe a key that exists on one side and not the other — that is
 * precisely the difference it was called to find.
 */
function describe(value: unknown): string {
  if (value === undefined) return '<absent>';
  try {
    return canonicalReportJson(value);
  } catch (error) {
    return `<unserialisable: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

function walk(left: unknown, right: unknown, path: string): CanonicalDifference {
  const difference: CanonicalDifference = {
    path,
    left: truncate(describe(left)),
    right: truncate(describe(right)),
  };

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return difference;
    for (let index = 0; index < left.length; index += 1) {
      if (describe(left[index]) !== describe(right[index])) {
        return walk(left[index], right[index], `${path}[${index}]`);
      }
    }
    return difference;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (NON_SEMANTIC_REPORT_FIELDS.includes(key)) continue;
      if (describe(left[key]) !== describe(right[key])) {
        return walk(left[key], right[key], `${path}.${key}`);
      }
    }
  }

  return difference;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

const truncate = (text: string): string => (text.length <= 200 ? text : `${text.slice(0, 197)}…`);
