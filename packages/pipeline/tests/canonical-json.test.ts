import { describe, expect, it } from 'vitest';

import { NON_SEMANTIC_REPORT_FIELDS } from '@compass/analysis';
import {
  NON_SEMANTIC_FIELDS,
  NonSerializableValueError,
  canonicalJson,
  canonicalPrettyJson,
  isSameReport,
  reportHash,
} from '@compass/pipeline';

/**
 * The pretty form a golden fixture is stored in.
 *
 * The property that matters is not how it looks — it is that it differs from the
 * compact form in *whitespace only*. A fixture whose key order or allowlist
 * differed from the hash's would make `test:golden` and the determinism gate two
 * different checks that could pass and fail independently, which is exactly the
 * failure a single serializer is meant to prevent.
 */
describe('canonical pretty JSON, for a fixture a human reviews', () => {
  const sample = {
    scope: { teamKey: 'platform', kind: 'team' },
    findings: { blockers: [{ stableId: 'b2', ageDays: 4 }, { stableId: 'b1', ageDays: 9 }] },
    counts: { blockers: 2 },
    empty: {},
    none: [],
  };

  it('encodes exactly what the compact form encodes', () => {
    expect(JSON.parse(canonicalPrettyJson(sample))).toEqual(JSON.parse(canonicalJson(sample)));
  });

  it('differs from the compact form in whitespace and nothing else', () => {
    const stripped = canonicalPrettyJson(sample).replace(/\n\s*/g, '').replace(/": /g, '":');
    expect(stripped).toBe(canonicalJson(sample));
  });

  it('sorts keys the same way, so a fixture diff is never an ordering artefact', () => {
    expect(canonicalPrettyJson({ b: 1, a: 2 })).toBe(canonicalPrettyJson({ a: 2, b: 1 }));
    const lines = canonicalPrettyJson({ zebra: 1, apple: 2 }).split('\n');
    expect(lines[1]?.trim().startsWith('"apple"')).toBe(true);
  });

  it('puts one value per line, which is what makes a diff name the field that moved', () => {
    // The whole justification for checking fixtures in. A single-line blob would
    // report any change as one modified line.
    const lines = canonicalPrettyJson(sample).trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(10);
    expect(lines[0]).toBe('{');
    expect(lines.at(-1)).toBe('}');
  });

  it('ends with exactly one newline', () => {
    const rendered = canonicalPrettyJson(sample);
    expect(rendered.endsWith('}\n')).toBe(true);
    expect(rendered.endsWith('}\n\n')).toBe(false);
  });

  it('keeps an empty object and an empty array on one line', () => {
    expect(canonicalPrettyJson({ empty: {}, none: [] })).toBe('{\n  "empty": {},\n  "none": []\n}\n');
  });

  it('honours the same non-semantic allowlist', () => {
    const withStamps = { ...sample, runId: 'run-1', generatedAt: 1 };
    const pretty = canonicalPrettyJson(withStamps, { exclude: NON_SEMANTIC_FIELDS });

    expect(pretty).not.toContain('runId');
    expect(pretty).not.toContain('generatedAt');
    expect(JSON.parse(pretty)).toEqual(JSON.parse(canonicalJson(sample, { exclude: NON_SEMANTIC_FIELDS })));
  });

  it('refuses the same unreproducible values', () => {
    expect(() => canonicalPrettyJson({ at: new Date(0) })).toThrow(NonSerializableValueError);
    expect(() => canonicalPrettyJson({ ratio: Number.NaN })).toThrow(NonSerializableValueError);
  });

  it('is stable across calls, so `golden:update` produces no diff when nothing changed', () => {
    expect(canonicalPrettyJson(sample)).toBe(canonicalPrettyJson(sample));
  });
});

describe('canonical JSON', () => {
  it('orders keys so insertion order cannot change a hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
    expect(canonicalJson({ outer: { z: 1, a: { y: 1, b: 2 } } })).toBe('{"outer":{"a":{"b":2,"y":1},"z":1}}');
  });

  it('preserves array order, because ordering arrays is the snapshot layer job', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('refuses values that cannot be reproduced', () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(NonSerializableValueError);
    expect(() => canonicalJson({ ratio: Number.NaN })).toThrow(NonSerializableValueError);
    expect(() => canonicalJson({ load: () => 1 })).toThrow(NonSerializableValueError);
    expect(() => canonicalJson(undefined)).toThrow(NonSerializableValueError);
  });

  it('drops undefined members rather than emitting a hole', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('the determinism gate', () => {
  const report = (runId: string, generatedAt: number) => ({
    runId,
    generatedAt,
    organizationId: 'org',
    sections: [{ key: 'yesterday', items: [] }],
  });

  it('re-exports the allowlist rather than keeping a second copy of it', () => {
    // Asserting the same literal here would *be* the second copy this design
    // exists to avoid: the list is owned by @compass/analysis and documented in
    // its DETERMINISM.md, which `packages/analysis/tests` checks against the
    // prose. This side's job is only to prove the pipeline forwards it intact.
    expect(NON_SEMANTIC_FIELDS).toBe(NON_SEMANTIC_REPORT_FIELDS);
    expect([...NON_SEMANTIC_FIELDS].sort()).toEqual([...NON_SEMANTIC_FIELDS]);
    expect(NON_SEMANTIC_FIELDS).toContain('generatedAt');
    expect(NON_SEMANTIC_FIELDS).toContain('runId');
  });

  it('hashes two runs of the same report identically', () => {
    expect(reportHash(report('run-1', 1))).toBe(reportHash(report('run-2', 2)));
    expect(isSameReport(report('run-1', 1), report('run-2', 2))).toBe(true);
  });

  it('notices a semantic difference', () => {
    const changed = { ...report('run-1', 1), sections: [{ key: 'yesterday', items: ['DEV-501'] }] };

    expect(isSameReport(report('run-1', 1), changed)).toBe(false);
  });

  it('excludes the allowlist by name, nested as well as at the top level', () => {
    expect(canonicalJson({ a: { runId: 'x', keep: 1 } }, { exclude: NON_SEMANTIC_FIELDS })).toBe('{"a":{"keep":1}}');
  });

  it('produces a stable sha256 hex digest', () => {
    expect(reportHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(reportHash({ a: 1 })).toBe(reportHash({ a: 1 }));
  });
});
