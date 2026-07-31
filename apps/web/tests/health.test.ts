import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readiness } from '../lib/health';

const original = { ...process.env };

beforeEach(() => {
  delete process.env['DATABASE_URL'];
  delete process.env['DATABASE_URL_DIRECT'];
});

afterEach(() => {
  process.env = { ...original };
});

describe('readiness', () => {
  it('states a missing database as a configuration fact, not a crash', async () => {
    const report = await readiness();

    const database = report.checks.find((check) => check.name === 'database');
    expect(database?.status).toBe('not_configured');
    expect(database?.detail).toContain('DATABASE_URL');
    expect(report.status).toBe('not_configured');
  });

  it('resolves the instant once, at the edge, and reports it', async () => {
    const report = await readiness();

    const clock = report.checks.find((check) => check.name === 'clock');
    expect(clock?.status).toBe('ready');
    expect(report.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('reports the connector per source, degraded when one is down', async () => {
    const report = await readiness();

    const connector = report.checks.find((check) => check.name === 'connector');
    expect(connector?.detail).toContain('primary-code: complete');
    expect(connector?.detail).toContain('legacy-code: unavailable');
    expect(connector?.status).toBe('degraded');
  });

  it('names every capability it checked', async () => {
    const report = await readiness();

    expect(report.checks.map((check) => check.name)).toEqual(['clock', 'connector', 'database']);
  });
});
