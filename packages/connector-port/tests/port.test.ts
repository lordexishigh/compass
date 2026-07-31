import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_FETCHERS,
  ARTIFACT_KINDS,
  ARTIFACT_SCHEMAS,
  CommitRecordSchema,
  compareRecords,
  completeCoverage,
  connectorResult,
  degradedCoverage,
  isFullyCovered,
  isInCanonicalOrder,
  partialCoverage,
  recordIdentity,
  sortRecords,
  unavailableCoverage,
  worstStatus,
  type SourceCoverage,
} from '@compass/connector-port';

const windowStart = instantFromIso('2026-07-29T00:00:00Z');
const windowEnd = instantFromIso('2026-07-30T00:00:00Z');
const window = timeWindow(windowStart, windowEnd);
const now = instantFromIso('2026-07-30T08:00:00Z');

const envelope = (sourceKey: string, sourceRecordId: string, iso: string) => ({
  sourceKey,
  sourceKind: 'code' as const,
  sourceRecordId,
  occurredAt: instantFromIso(iso),
});

describe('canonical ordering', () => {
  it('orders by event time, then source, then source record id', () => {
    const unordered = [
      envelope('b-code', '2', '2026-07-29T10:00:00Z'),
      envelope('a-code', '9', '2026-07-29T10:00:00Z'),
      envelope('a-code', '1', '2026-07-29T09:00:00Z'),
      envelope('a-code', '10', '2026-07-29T10:00:00Z'),
    ];

    expect(sortRecords(unordered).map(recordIdentity)).toEqual([
      'a-code::1',
      'a-code::10',
      'a-code::9',
      'b-code::2',
    ]);
  });

  it('does not mutate the input', () => {
    const records = [envelope('b', '2', '2026-07-29T10:00:00Z'), envelope('a', '1', '2026-07-29T09:00:00Z')];
    sortRecords(records);

    expect(records[0]?.sourceKey).toBe('b');
  });

  it('detects an out-of-order sequence', () => {
    const ordered = sortRecords([
      envelope('a', '1', '2026-07-29T09:00:00Z'),
      envelope('a', '2', '2026-07-29T10:00:00Z'),
    ]);

    expect(isInCanonicalOrder(ordered)).toBe(true);
    expect(isInCanonicalOrder([...ordered].reverse())).toBe(false);
    expect(isInCanonicalOrder([])).toBe(true);
  });

  it('compares by code unit, never by locale', () => {
    const upper = envelope('a', 'Z-item', '2026-07-29T09:00:00Z');
    const lower = envelope('a', 'a-item', '2026-07-29T09:00:00Z');

    expect(compareRecords(upper, lower)).toBe(-1);
  });
});

describe('coverage', () => {
  const base = {
    sourceKey: 'primary-tracker',
    sourceKind: 'tracker' as const,
    artifact: 'issues' as const,
    requestedWindow: window,
    observedAt: now,
  };

  it('names the source in the detail a manager reads', () => {
    const coverage = completeCoverage({ ...base, recordCount: 3 });

    expect(coverage.status).toBe('complete');
    expect(coverage.detail).toContain('primary-tracker');
    expect(coverage.coveredWindow).toEqual(window);
  });

  it('reports unavailability with a reason and no covered window', () => {
    const coverage = unavailableCoverage({
      ...base,
      reason: 'rate_limited',
      detail: 'primary-tracker refused: rate limited until 08:45.',
    });

    expect(coverage.status).toBe('unavailable');
    expect(coverage.recordCount).toBe(0);
    expect(coverage.coveredWindow).toBeNull();
    expect(coverage.reason).toBe('rate_limited');
  });

  it('reports a truncated window as partial', () => {
    const coverage = partialCoverage({
      ...base,
      recordCount: 2,
      reason: 'window_truncated',
      detail: 'primary-tracker returned only the first page.',
      coveredWindow: timeWindow(windowStart, now),
    });

    expect(coverage.status).toBe('partial');
    expect(coverage.coveredWindow).not.toBeNull();
  });

  it('lets the worst source decide the overall status', () => {
    const complete = completeCoverage({ ...base, recordCount: 1 });
    const partial = partialCoverage({
      ...base,
      sourceKey: 'secondary',
      recordCount: 1,
      reason: 'rate_limited',
      detail: 'secondary was throttled.',
      coveredWindow: window,
    });
    const unavailable = unavailableCoverage({
      ...base,
      sourceKey: 'chat',
      reason: 'unreachable',
      detail: 'chat is unreachable.',
    });

    expect(worstStatus([complete])).toBe('complete');
    expect(worstStatus([complete, partial])).toBe('partial');
    expect(worstStatus([complete, partial, unavailable])).toBe('unavailable');
    expect(worstStatus([])).toBe('complete');
  });
});

describe('ConnectorResult', () => {
  const coverage: SourceCoverage = unavailableCoverage({
    sourceKey: 'chat',
    sourceKind: 'chat',
    artifact: 'messages',
    requestedWindow: window,
    observedAt: now,
    reason: 'not_configured',
    detail: 'chat is not configured for this organization.',
  });

  it('derives its status from coverage so an empty array is never mistaken for a quiet day', () => {
    const result = connectorResult('messages', window, [], [coverage]);

    expect(result.records).toEqual([]);
    expect(result.status).toBe('unavailable');
    expect(isFullyCovered(result)).toBe(false);
    expect(degradedCoverage(result)).toHaveLength(1);
    expect(degradedCoverage(result)[0]?.detail).toContain('chat');
  });

  it('is frozen, so a caller cannot rewrite what a source reported', () => {
    const result = connectorResult('messages', window, [], [coverage]);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.coverage)).toBe(true);
  });
});

describe('the port surface', () => {
  it('maps all ten artifact families to a fetcher method', () => {
    expect(Object.keys(ARTIFACT_FETCHERS).sort()).toEqual([...ARTIFACT_KINDS].sort());
    expect(new Set(Object.values(ARTIFACT_FETCHERS)).size).toBe(ARTIFACT_KINDS.length);
  });

  it('has a record schema for every artifact family', () => {
    expect(Object.keys(ARTIFACT_SCHEMAS).sort()).toEqual([...ARTIFACT_KINDS].sort());
  });

  it('rejects a record carrying an unexpected provider field', () => {
    const parsed = CommitRecordSchema.safeParse({
      sourceKey: 'primary-code',
      sourceKind: 'code',
      sourceRecordId: 'c1',
      occurredAt: instantFromIso('2026-07-29T10:00:00Z'),
      repositoryKey: 'platform',
      revisionId: 'a1b2c3d',
      parentRevisionIds: [],
      authorIdentity: { kind: 'email', value: 'dev@example.com', displayName: 'Dev' },
      committerIdentity: null,
      authoredAt: instantFromIso('2026-07-29T09:50:00Z'),
      message: 'fix the thing',
      changedFileCount: 2,
      branchName: 'main',
      sha: 'a1b2c3d',
    });

    expect(parsed.success).toBe(false);
  });
});
