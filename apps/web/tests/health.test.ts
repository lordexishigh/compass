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
    // The seed declares its archived code host as rate-limited on purpose, so a
    // degraded source is always exercisable without credentials.
    expect(connector?.detail).toContain('archive-code: unavailable');
    expect(connector?.status).toBe('degraded');
  });

  it('names the seeded dataset it is serving and the span it covers', async () => {
    const report = await readiness();

    const dataset = report.checks.find((check) => check.name === 'seed-dataset');
    expect(dataset?.status).toBe('ready');
    expect(dataset?.detail).toContain('northwind-v1');
    expect(dataset?.detail).toContain('2026-05-18T00:00:00.000Z');
  });

  it('names every capability it checked', async () => {
    const report = await readiness();

    expect(report.checks.map((check) => check.name)).toEqual(['clock', 'connector', 'seed-dataset', 'database']);
  });
});
