import {
  type Instant,
  type TimeWindow,
  formatWindow,
  instantFromEpochMillis,
  splitWindow,
  timeWindow,
  toEpochMillis,
  windowContains,
} from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { isInCanonicalOrder, recordIdentity } from '../ordering.js';
import { fetchArtifact, type ConnectorPort, type ConnectorRequest } from '../port.js';
import { ARTIFACT_KINDS, ARTIFACT_SCHEMAS, type ArtifactKind, type ConnectorRecordEnvelope } from '../records.js';
import { findProviderVocabularyViolations } from '../vocabulary.js';

export {
  FixtureConnector,
  type FixtureDataset,
  type FixtureRecords,
  type FixtureSource,
} from './fixture-connector.js';

export {
  ReplayHttpClient,
  ThrottledHttpClient,
  UnrecordedRequestError,
  jsonResponse,
} from './http-clients.js';

/**
 * The provider conformance kit.
 *
 * Any ConnectorPort implementation — the seeded provider today, GitHub and Jira
 * later — runs this unmodified. If a live provider passes it, downstream layers
 * genuinely cannot tell the difference, which is the property the whole
 * architecture rests on.
 */
export interface ConnectorContractOptions {
  /** Shown in the test names, e.g. `SeedConnector`. */
  readonly name: string;
  readonly createConnector: () => ConnectorPort | Promise<ConnectorPort>;
  readonly organizationId: string;
  /** A window the fixture has data in, for every artifact the connector supports. */
  readonly window: TimeWindow;
  readonly now: Instant;
  /** Where to cut the window for the partition property; defaults to the midpoint. */
  readonly splitAt?: Instant;
  /** A source configured to be down, to prove unavailability is reported not thrown. */
  readonly unavailableSourceKey?: string;
}

const asEnvelopes = (records: readonly unknown[]): readonly ConnectorRecordEnvelope[] =>
  records as readonly ConnectorRecordEnvelope[];

export function describeConnectorContract(options: ConnectorContractOptions): void {
  const { name, organizationId, window, now } = options;
  const splitAt =
    options.splitAt ??
    instantFromEpochMillis(
      toEpochMillis(window.start) + Math.floor((toEpochMillis(window.end) - toEpochMillis(window.start)) / 2),
    );

  const request = (forWindow: TimeWindow, sourceKeys?: readonly string[]): ConnectorRequest => ({
    organizationId,
    window: forWindow,
    now,
    ...(sourceKeys ? { sourceKeys } : {}),
  });

  const open = async (): Promise<ConnectorPort> => await options.createConnector();

  describe(`ConnectorPort contract — ${name}`, () => {
    it('implements every method of the port', async () => {
      const connector = await open();

      expect(typeof connector.connectorId).toBe('string');
      expect(connector.connectorId.length).toBeGreaterThan(0);
      expect(typeof connector.capabilities).toBe('function');
      expect(typeof connector.reportSourceHealth).toBe('function');

      for (const artifact of ARTIFACT_KINDS) {
        const result = await fetchArtifact(connector, artifact, request(window));
        expect(result.artifact, `${artifact} result must name its own artifact kind`).toBe(artifact);
        expect(result.window).toEqual(window);
        expect(Array.isArray(result.records)).toBe(true);
      }
    });

    it('declares capabilities that do not change between calls', async () => {
      const connector = await open();

      expect(connector.capabilities()).toEqual(connector.capabilities());
      expect(connector.capabilities().connectorId).toBe(connector.connectorId);
      for (const artifact of ARTIFACT_KINDS) {
        expect(typeof connector.capabilities().artifacts[artifact]).toBe('boolean');
      }
    });

    it('has data in the contract window for every artifact it claims to support', async () => {
      const connector = await open();
      const capabilities = connector.capabilities();

      for (const artifact of ARTIFACT_KINDS) {
        if (!capabilities.artifacts[artifact]) continue;
        const result = await fetchArtifact(connector, artifact, request(window));
        expect(
          result.records.length,
          `the contract window ${formatWindow(window)} has no ${artifact}; the suite would prove nothing about them`,
        ).toBeGreaterThan(0);
      }
    });

    describe.each([...ARTIFACT_KINDS])('%s', (artifact: ArtifactKind) => {
      it('returns only records whose event time lies inside the half-open window', async () => {
        const connector = await open();
        const result = await fetchArtifact(connector, artifact, request(window));

        for (const record of asEnvelopes(result.records)) {
          expect(
            windowContains(window, record.occurredAt),
            `${artifact} record ${record.sourceRecordId} sits outside ${formatWindow(window)}`,
          ).toBe(true);
        }
      });

      it('returns records that validate against the provider-neutral schema', async () => {
        const connector = await open();
        const result = await fetchArtifact(connector, artifact, request(window));

        for (const record of result.records) {
          const parsed = ARTIFACT_SCHEMAS[artifact].safeParse(record);
          expect(parsed.success ? null : parsed.error.issues).toBeNull();
        }
      });

      it('uses no provider-specific field names', async () => {
        const connector = await open();
        const result = await fetchArtifact(connector, artifact, request(window));

        expect(findProviderVocabularyViolations(result.records, `$.${artifact}`)).toEqual([]);
      });

      it('returns records in canonical order', async () => {
        const connector = await open();
        const result = await fetchArtifact(connector, artifact, request(window));

        expect(isInCanonicalOrder(asEnvelopes(result.records))).toBe(true);
      });

      it('returns each record once', async () => {
        const connector = await open();
        const result = await fetchArtifact(connector, artifact, request(window));

        const identities = asEnvelopes(result.records).map(recordIdentity);
        expect(new Set(identities).size).toBe(identities.length);
      });

      it('is idempotent: the same request twice is deeply equal', async () => {
        const connector = await open();

        const first = await fetchArtifact(connector, artifact, request(window));
        const second = await fetchArtifact(connector, artifact, request(window));

        expect(second).toEqual(first);
      });

      it('holds no cursor state: a fresh instance answers identically', async () => {
        const first = await fetchArtifact(await open(), artifact, request(window));
        const second = await fetchArtifact(await open(), artifact, request(window));

        expect(second).toEqual(first);
      });

      it('partitions exactly when the window is split, proving [start, end)', async () => {
        const connector = await open();
        const [firstHalf, secondHalf] = splitWindow(window, splitAt);

        const whole = await fetchArtifact(connector, artifact, request(window));
        const before = await fetchArtifact(connector, artifact, request(firstHalf));
        const after = await fetchArtifact(connector, artifact, request(secondHalf));

        const identitiesOf = (records: readonly unknown[]): readonly string[] =>
          asEnvelopes(records).map(recordIdentity);

        const beforeIds = identitiesOf(before.records);
        const afterIds = identitiesOf(after.records);

        // No record is counted twice by two abutting windows...
        expect(beforeIds.filter((identity) => afterIds.includes(identity))).toEqual([]);
        // ...and none falls between them.
        expect([...beforeIds, ...afterIds].sort()).toEqual([...identitiesOf(whole.records)].sort());
      });

      it('returns nothing for an empty window, and still reports coverage', async () => {
        const connector = await open();
        const result = await fetchArtifact(connector, artifact, request(timeWindow(window.start, window.start)));

        expect(result.records).toEqual([]);
        expect(result.coverage.length).toBeGreaterThan(0);
      });

      it('carries a coverage record naming each source and the requested window', async () => {
        const connector = await open();
        const result = await fetchArtifact(connector, artifact, request(window));

        expect(result.coverage.length).toBeGreaterThan(0);
        for (const coverage of result.coverage) {
          expect(coverage.artifact).toBe(artifact);
          expect(coverage.requestedWindow).toEqual(window);
          expect(coverage.detail).toContain(coverage.sourceKey);
          if (coverage.status === 'unavailable') {
            expect(coverage.reason).not.toBe('ok');
            expect(coverage.coveredWindow).toBeNull();
            expect(coverage.recordCount).toBe(0);
          }
        }

        const countedSources = new Set(result.coverage.map((coverage) => coverage.sourceKey));
        for (const record of asEnvelopes(result.records)) {
          expect(
            countedSources.has(record.sourceKey),
            `${artifact} returned a record from ${record.sourceKey} with no coverage entry`,
          ).toBe(true);
        }
      });

      it('reports an unsupported artifact as absent capability, not as an empty day', async () => {
        const connector = await open();
        if (connector.capabilities().artifacts[artifact]) return;

        const result = await fetchArtifact(connector, artifact, request(window));

        expect(result.records).toEqual([]);
        expect(result.status).not.toBe('complete');
        expect(result.coverage.every((coverage) => coverage.reason === 'capability_absent')).toBe(true);
      });
    });

    it('reports source health covering every configured source', async () => {
      const connector = await open();
      const health = await connector.reportSourceHealth(request(window));

      expect(health.connectorId).toBe(connector.connectorId);
      expect(health.window).toEqual(window);
      expect(health.sources.length).toBeGreaterThan(0);

      const declared = new Set(connector.capabilities().sources.map((source) => source.sourceKey));
      for (const source of health.sources) {
        expect(declared.has(source.sourceKey)).toBe(true);
        expect(source.detail.length).toBeGreaterThan(0);
      }
      expect(health).toEqual(await connector.reportSourceHealth(request(window)));
    });

    if (options.unavailableSourceKey !== undefined) {
      const downSource = options.unavailableSourceKey;

      it('reports an unavailable source as a coverage record rather than throwing', async () => {
        const connector = await open();

        for (const artifact of ARTIFACT_KINDS) {
          const result = await fetchArtifact(connector, artifact, request(window, [downSource]));

          expect(result.records).toEqual([]);
          expect(result.status).toBe('unavailable');
          expect(result.coverage.length).toBeGreaterThan(0);

          const coverage = result.coverage.find((entry) => entry.sourceKey === downSource);
          expect(coverage, `no coverage record named ${downSource}`).toBeDefined();
          expect(coverage?.status).toBe('unavailable');
          expect(coverage?.reason).not.toBe('ok');
          expect(coverage?.detail).toContain(downSource);
        }
      });

      it('names the unavailable source in the health report too', async () => {
        const connector = await open();
        const health = await connector.reportSourceHealth(request(window));
        const entry = health.sources.find((source) => source.sourceKey === downSource);

        expect(entry?.status).toBe('unavailable');
        expect(health.overall).not.toBe('complete');
      });
    }
  });
}
