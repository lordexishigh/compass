import { FixedClock, instantFromIso } from '@compass/clock';
import type { IngestRunSummary } from '@compass/ingest';
import { FOUNDATION_UNAVAILABLE_SOURCE_KEY, SeedConnector } from '@compass/seed-connector';
import { describe, expect, it } from 'vitest';

import {
  InvalidJobPayloadError,
  JOB_NAMES,
  handleIngestWindow,
  type IngestRunIds,
  type WorkerDependencies,
} from '../src/jobs.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const clock = new FixedClock(instantFromIso('2026-07-31T08:00:00Z'));

const payload = {
  organizationId,
  windowStart: '2026-07-27T00:00:00Z',
  windowEnd: '2026-07-31T00:00:00Z',
};

function dependencies(): WorkerDependencies & {
  readonly persisted: { summary: IngestRunSummary; ids: IngestRunIds }[];
  readonly logs: string[];
} {
  const persisted: { summary: IngestRunSummary; ids: IngestRunIds }[] = [];
  const logs: string[] = [];
  let counter = 0;

  return {
    persisted,
    logs,
    connector: new SeedConnector(),
    persistIngestRun: async (summary, ids) => {
      persisted.push({ summary, ids });
    },
    newId: () => `id-${(counter += 1)}`,
    logger: {
      info: (message: string) => logs.push(`info ${message}`),
      warn: (message: string) => logs.push(`warn ${message}`),
      error: (message: string) => logs.push(`error ${message}`),
    },
  };
}

describe('ingest.window job', () => {
  it('is one of the registered queues', () => {
    expect(Object.values(JOB_NAMES)).toContain('ingest.window');
  });

  it('pulls the window through the port and records the run', async () => {
    const deps = dependencies();

    const summary = await handleIngestWindow(deps, payload, clock.now());

    expect(summary.connectorId).toBe('seed:foundation-v1');
    expect(summary.totalRecords).toBeGreaterThan(0);
    expect(deps.persisted).toHaveLength(1);
    expect(deps.persisted[0]?.ids.runId).toBe('id-1');
    expect(deps.persisted[0]?.ids.coverageIds).toHaveLength(summary.coverage.length);
  });

  it('uses the instant it was handed, never one of its own', async () => {
    const summary = await handleIngestWindow(dependencies(), payload, clock.now());

    expect(summary.startedAt).toBe(clock.now());
  });

  it('records a degraded run and warns, rather than failing the job', async () => {
    const deps = dependencies();

    const summary = await handleIngestWindow(deps, payload, clock.now());

    expect(summary.status).toBe('unavailable');
    expect(summary.unavailableSources).toContain(FOUNDATION_UNAVAILABLE_SOURCE_KEY);
    expect(deps.logs.join(' ')).toContain('warn');
    expect(deps.persisted).toHaveLength(1);
  });

  it('rejects a malformed payload before writing anything', async () => {
    const deps = dependencies();

    await expect(handleIngestWindow(deps, { organizationId: 'acme' }, clock.now())).rejects.toThrow(
      InvalidJobPayloadError,
    );
    await expect(handleIngestWindow(deps, undefined, clock.now())).rejects.toThrow(InvalidJobPayloadError);
    await expect(
      handleIngestWindow(deps, { ...payload, unexpected: true }, clock.now()),
    ).rejects.toThrow(InvalidJobPayloadError);
    expect(deps.persisted).toHaveLength(0);
  });

  it('rejects a window whose timestamps carry no offset', async () => {
    const deps = dependencies();

    await expect(
      handleIngestWindow(deps, { ...payload, windowStart: '2026-07-27T00:00:00' }, clock.now()),
    ).rejects.toThrow();
    expect(deps.persisted).toHaveLength(0);
  });

  it('is idempotent in what it reads: the same window twice yields the same counts', async () => {
    const first = await handleIngestWindow(dependencies(), payload, clock.now());
    const second = await handleIngestWindow(dependencies(), payload, clock.now());

    expect(second.artifactCounts).toEqual(first.artifactCounts);
    expect(second.totalRecords).toBe(first.totalRecords);
  });
});
