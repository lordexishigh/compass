import { createHash } from 'node:crypto';

import { NON_SEMANTIC_REPORT_FIELDS } from '@compass/analysis';

/**
 * The determinism gate.
 *
 * Generating a report twice for the same (org, team, instant) must produce
 * byte-identical structured JSON. Two things make that checkable: a canonical
 * serializer with sorted keys, and one documented allowlist of fields that are
 * genuinely non-semantic and therefore excluded from the hash.
 *
 * The allowlist is *re-exported*, not redeclared. It is a property of the report
 * shape, which the analysis layer owns and `packages/analysis/DETERMINISM.md`
 * documents; a second copy here would be a second thing to keep in step, and it
 * would drift the first time somebody edited only one of them.
 */
export const NON_SEMANTIC_FIELDS: readonly string[] = NON_SEMANTIC_REPORT_FIELDS;

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

/**
 * One walk, two shapes.
 *
 * `indent` empty means the compact form the hash is computed over; a non-empty
 * `indent` means the pretty form a fixture is stored in. Every other decision —
 * key order, the exclusion set, which values are refused outright — is shared,
 * which is what keeps a golden fixture and a determinism hash from disagreeing
 * about anything except whitespace.
 */
function serialize(
  value: unknown,
  path: string,
  exclude: ReadonlySet<string>,
  indent = '',
  current = '',
): string {
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

  const inner = current + indent;
  // An empty container is `[]` / `{}` in both forms: a newline around nothing is
  // whitespace a reviewer has to skip past.
  const open = (bracket: '[' | '{') => (indent === '' ? bracket : `${bracket}\n${inner}`);
  const close = (bracket: ']' | '}') => (indent === '' ? bracket : `\n${current}${bracket}`);
  const separator = indent === '' ? ',' : `,\n${inner}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const entries = value.map((entry, index) => serialize(entry, `${path}[${index}]`, exclude, indent, inner));
    return `${open('[')}${entries.join(separator)}${close(']')}`;
  }

  if (value instanceof Date) {
    throw new NonSerializableValueError(path, 'is a Date (store an Instant instead)');
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, nested]) => !exclude.has(key) && nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  if (entries.length === 0) return '{}';
  const gap = indent === '' ? ':' : ': ';
  const rendered = entries.map(
    ([key, nested]) => `${JSON.stringify(key)}${gap}${serialize(nested, `${path}.${key}`, exclude, indent, inner)}`,
  );
  return `${open('{')}${rendered.join(separator)}${close('}')}`;
}

/**
 * The same canonical form, pretty-printed for a checked-in fixture.
 *
 * ## Why this lives beside `canonicalJson` rather than in the golden tooling
 *
 * A golden fixture and a determinism hash have to disagree about exactly one
 * thing — whitespace — and about nothing else. Key order, the non-semantic
 * allowlist and the refusal to serialise a `Date` or a `NaN` must be identical, or
 * `test:golden` and the determinism gate would be checking two different notions
 * of "the same report" and could pass and fail independently. So both walk the same
 * `serialize` function through one `indent` parameter; there is no second
 * implementation to keep in step.
 *
 * ## Why pretty at all
 *
 * A fixture is reviewed as a diff. Compact JSON puts a whole report on one line, so
 * changing one headline shows up as a single unreadable modified line — the "opaque
 * blob" the acceptance criteria rule out. Two-space indent with one value per line
 * makes `git diff` name the field that moved, which is the entire point of checking
 * the fixtures in.
 *
 * The trailing newline is deliberate: without it every editor and every `>>` append
 * produces a spurious "\ No newline at end of file" line in the diff.
 */
export function canonicalPrettyJson(
  value: unknown,
  options: { readonly exclude?: readonly string[] } = {},
): string {
  const exclude = new Set(options.exclude ?? []);
  return `${serialize(value, '$', exclude, '  ', '')}\n`;
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
