import { instantFromIso, timeWindow, windowContains } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { FOUNDATION_UNAVAILABLE_SOURCE_KEY, FOUNDATION_WINDOW, SeedConnector } from '@compass/seed-connector';

const organizationId = '00000000-0000-4000-8000-000000000001';
const now = instantFromIso('2026-07-31T08:00:00Z');
const request = { organizationId, window: FOUNDATION_WINDOW, now };

describe('SeedConnector', () => {
  it('answers an arbitrary window, not just the fixture window', async () => {
    const connector = new SeedConnector();
    const narrow = timeWindow(instantFromIso('2026-07-30T00:00:00Z'), instantFromIso('2026-07-30T12:00:00Z'));

    const result = await connector.fetchCommits({ organizationId, window: narrow, now });

    expect(result.records.map((record) => record.revisionId)).toEqual(['3c4d5e6']);
    expect(result.records.every((record) => windowContains(narrow, record.occurredAt))).toBe(true);
  });

  it('excludes a record sitting exactly on the window end', async () => {
    const connector = new SeedConnector();
    const upToTheMerge = timeWindow(instantFromIso('2026-07-30T00:00:00Z'), instantFromIso('2026-07-30T11:41:00Z'));

    const result = await connector.fetchCommits({ organizationId, window: upToTheMerge, now });

    expect(result.records).toEqual([]);
  });

  it('includes a record sitting exactly on the window start', async () => {
    const connector = new SeedConnector();
    const fromTheMerge = timeWindow(instantFromIso('2026-07-30T11:41:00Z'), instantFromIso('2026-07-31T00:00:00Z'));

    const result = await connector.fetchCommits({ organizationId, window: fromTheMerge, now });

    expect(result.records.map((record) => record.revisionId)).toEqual(['3c4d5e6']);
  });

  it('degrades the whole answer when a configured source is down', async () => {
    const connector = new SeedConnector();

    const result = await connector.fetchCommits(request);

    expect(result.records.length).toBeGreaterThan(0);
    expect(result.status).toBe('unavailable');
    const down = result.coverage.find((entry) => entry.sourceKey === FOUNDATION_UNAVAILABLE_SOURCE_KEY);
    expect(down?.reason).toBe('authentication_failed');
    expect(down?.detail).toContain('legacy-code');
  });

  it('reports an unknown source as not configured rather than throwing', async () => {
    const connector = new SeedConnector();

    const result = await connector.fetchIssues({ ...request, sourceKeys: ['does-not-exist'] });

    expect(result.records).toEqual([]);
    expect(result.status).toBe('unavailable');
    expect(result.coverage[0]?.reason).toBe('not_configured');
    expect(result.coverage[0]?.detail).toContain('does-not-exist');
  });

  it('does not ask a tracker for commits', async () => {
    const connector = new SeedConnector();

    const result = await connector.fetchCommits({ ...request, sourceKeys: ['primary-tracker'] });

    expect(result.records).toEqual([]);
    expect(result.coverage[0]?.reason).toBe('capability_absent');
  });

  it('declares no deploy signal, so R5 can never be inferred', () => {
    expect(new SeedConnector().capabilities().deploySignal).toBe(false);
  });

  it('limits chat to opted-in conversations', () => {
    expect(new SeedConnector().capabilities().chatScope).toBe('opted_in_conversations');
  });

  it('reports per-source health with a last-observed instant', async () => {
    const health = await new SeedConnector().reportSourceHealth(request);

    expect(health.overall).toBe('unavailable');
    expect(health.sources.map((source) => source.sourceKey)).toEqual([
      'primary-code',
      'primary-tracker',
      'team-chat',
      'legacy-code',
    ]);
    expect(health.sources.find((source) => source.sourceKey === 'primary-code')?.lastObservedAt).not.toBeNull();
    expect(health.sources.find((source) => source.sourceKey === 'legacy-code')?.lastObservedAt).toBeNull();
  });
});
