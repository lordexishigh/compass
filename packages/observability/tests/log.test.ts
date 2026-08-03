import {
  LEVEL_FOR_EVENT,
  LOG_EVENTS,
  RecordingSink,
  createConsoleSink,
  logDeliveryFailure,
  logIngestCoverageGap,
  logNarrationFallback,
  logPipelineRun,
  logReadinessUnavailable,
  logRecord,
  type ConsoleLike,
  type LogEvent,
} from '@compass/observability';
import { describe, expect, it } from 'vitest';

/**
 * The logging criterion: the four named events, each carrying organization, team and instant as
 * *fields*.
 *
 * The point of asserting on fields rather than on a rendered line is that "which organizations had a
 * coverage gap this week" has to be answerable. An interpolated sentence cannot answer it, and the
 * previous shape of every log line in this repo — `[compass] ingest degraded for <uuid>: <reason>` —
 * is exactly the shape that cannot.
 */

const ORGANIZATION = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const AT = Date.parse('2026-08-05T06:00:00.000Z');

const fields = (teamKey: string | null = 'platform') => ({
  organizationId: ORGANIZATION,
  teamKey,
  at: AT,
  detail: 'A sentence for a human reading the stream.',
});

describe('the closed set of events', () => {
  it('is exactly the four the criterion names, plus the web edge’s own', () => {
    // A fifth event is a compile error until it is declared, which is what stops the log growing a
    // vocabulary nobody has written a query for.
    expect([...LOG_EVENTS]).toEqual([
      'pipeline.run',
      'narration.fallback',
      'ingest.coverage_gap',
      'delivery.failure',
      'readiness.unavailable',
    ]);
  });

  it('assigns every event a level in one table', () => {
    for (const event of LOG_EVENTS) {
      expect(LEVEL_FOR_EVENT[event], `${event} has no level`).toMatch(/^(info|warn|error)$/);
    }
  });

  it('calls a narration fallback a degradation and a delivery failure a failure', () => {
    // The distinction is the product's own: a fallback still gives the reader six complete
    // sections, so waking somebody for it would be the wrong trade.
    expect(LEVEL_FOR_EVENT['narration.fallback']).toBe('warn');
    expect(LEVEL_FOR_EVENT['delivery.failure']).toBe('error');
  });
});

describe('every record carries the fields a query needs', () => {
  const emitters: readonly (readonly [LogEvent, (sink: RecordingSink) => void])[] = [
    [
      'pipeline.run',
      (sink) => logPipelineRun(fields(), { scopeKind: 'team', rendererId: 'narrated', durationMillis: 412 }, sink),
    ],
    [
      'narration.fallback',
      (sink) => logNarrationFallback(fields(), { sectionKey: 'risks', outcome: 'rejected', attempts: 3 }, sink),
    ],
    [
      'ingest.coverage_gap',
      (sink) =>
        logIngestCoverageGap(fields(null), { sourceKey: 'archive-code', status: 'unavailable', reason: 'rate_limited' }, sink),
    ],
    [
      'delivery.failure',
      (sink) => logDeliveryFailure(fields(), { channel: 'email', attempt: 3, status: 'failed' }, sink),
    ],
    ['readiness.unavailable', (sink) => logReadinessUnavailable(fields(null), { surface: 'activity' }, sink)],
  ];

  it.each(emitters)('%s carries organization, team and instant', (event, run) => {
    const sink = new RecordingSink();
    run(sink);

    const record = sink.last(event);
    expect(record, `${event} emitted nothing`).not.toBeNull();
    expect(record?.event).toBe(event);
    expect(record?.organizationId).toBe(ORGANIZATION);
    expect(record?.at).toBe(AT);
    // Derived from `at`, so the line is readable without a converter and cannot disagree with it.
    expect(record?.timestamp).toBe('2026-08-05T06:00:00.000Z');
    // `teamKey` is present as a key on every record even when null — an absent key and a null one
    // are different things to a log query, and "this had no team" is a fact worth stating.
    expect(record).toHaveProperty('teamKey');
  });

  it('distinguishes a genuinely team-less event from one that forgot its team', () => {
    const sink = new RecordingSink();
    logIngestCoverageGap(fields(null), { sourceKey: 's', status: 'unavailable', reason: 'r' }, sink);

    // An organization-wide ingest has no team. `null` says so where an empty string would read as a
    // team called nothing.
    expect(sink.last('ingest.coverage_gap')?.teamKey).toBeNull();
  });

  it('keeps each emitter’s own extras on the record', () => {
    const sink = new RecordingSink();
    logDeliveryFailure(fields(), { channel: 'slack', attempt: 2, status: 'failed' }, sink);

    expect(sink.last('delivery.failure')?.extras).toEqual({ channel: 'slack', attempt: 2, status: 'failed' });
  });
});

describe('a log line is scrubbed like an error report', () => {
  it('masks an address interpolated into the detail sentence', () => {
    // The commonest way a credential reaches a log: somebody puts `error.message` in the detail.
    const record = logRecord('delivery.failure', {
      ...fields(),
      detail: 'Resend rejected the message for priya.raman@northwind.example',
    });

    expect(record.detail).not.toContain('priya.raman@northwind.example');
    expect(record.detail).toContain('[redacted]');
  });

  it('masks a token-shaped extra but keeps the organization uuid', () => {
    const record = logRecord('delivery.failure', fields(), {
      providerError: 'invalid api key sk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928',
      organizationId: ORGANIZATION,
    });

    expect(String(record.extras['providerError'])).toContain('[redacted]');
    // A UUID is not a secret, and it is the field that makes the line attributable. Redacting it
    // would defeat the reason the log exists.
    expect(record.extras['organizationId']).toBe(ORGANIZATION);
  });

  it('leaves the receipts alone', () => {
    const record = logRecord('pipeline.run', { ...fields(), detail: 'PLAT-742 merged as #883 at 7a8b9c0' });

    expect(record.detail).toBe('PLAT-742 merged as #883 at 7a8b9c0');
  });
});

describe('the sink', () => {
  it('routes each level to the matching console method', () => {
    const calls: string[] = [];
    const fake: ConsoleLike = {
      info: () => calls.push('info'),
      warn: () => calls.push('warn'),
      error: () => calls.push('error'),
    };
    const sink = createConsoleSink(fake);

    logPipelineRun(fields(), { scopeKind: 'team', rendererId: 'narrated', durationMillis: 1 }, sink);
    logNarrationFallback(fields(), { sectionKey: null, outcome: 'refused', attempts: 1 }, sink);
    logDeliveryFailure(fields(), { channel: 'email', attempt: 1, status: 'failed' }, sink);

    expect(calls).toEqual(['info', 'warn', 'error']);
  });

  it('writes one parseable JSON object per line', () => {
    let line = '';
    const sink = createConsoleSink({ info: (message) => (line = message), warn: () => {}, error: () => {} });

    logPipelineRun(fields(), { scopeKind: 'merged', rendererId: 'template', durationMillis: 7 }, sink);

    // JSON rather than logfmt because every hosted log product parses it with no configuration.
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['event']).toBe('pipeline.run');
    expect(parsed['organizationId']).toBe(ORGANIZATION);
    expect(line.includes('\n')).toBe(false);
  });
});
