import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  SnapshotSerializationError,
  compareStable,
  isSealed,
  isSortedByStableKey,
  sealSnapshot,
  sortByCompositeKey,
  sortByStableKey,
  type SnapshotEnvelope,
} from '@compass/knowledge-model';

const envelope = <TCollections extends object>(collections: TCollections): SnapshotEnvelope<TCollections> => ({
  organizationId: '11111111-1111-4111-8111-111111111111',
  scope: { kind: 'team', teamKey: 'platform' },
  instant: instantFromIso('2026-07-30T08:00:00Z'),
  timezone: 'Europe/London',
  window: timeWindow(instantFromIso('2026-07-29T00:00:00Z'), instantFromIso('2026-07-30T00:00:00Z')),
  collections,
});

describe('canonical ordering', () => {
  it('compares by code unit, not by locale', () => {
    expect(compareStable('Z', 'a')).toBe(-1);
    expect(['a', 'Z', 'B'].slice().sort(compareStable)).toEqual(['B', 'Z', 'a']);
  });

  it('sorts a copy by a documented key', () => {
    const tickets = [{ key: 'DEV-9' }, { key: 'DEV-10' }, { key: 'DEV-1' }];

    const sorted = sortByStableKey(tickets, (ticket) => ticket.key);

    expect(sorted.map((ticket) => ticket.key)).toEqual(['DEV-1', 'DEV-10', 'DEV-9']);
    expect(tickets[0]?.key).toBe('DEV-9');
    expect(isSortedByStableKey(sorted, (ticket) => ticket.key)).toBe(true);
    expect(isSortedByStableKey(tickets, (ticket) => ticket.key)).toBe(false);
  });

  it('breaks ties with the next part of a composite key', () => {
    const items = [
      { at: 2, key: 'b' },
      { at: 1, key: 'z' },
      { at: 2, key: 'a' },
    ];

    expect(sortByCompositeKey(items, (item) => [item.at, item.key])).toEqual([
      { at: 1, key: 'z' },
      { at: 2, key: 'a' },
      { at: 2, key: 'b' },
    ]);
  });
});

describe('sealSnapshot', () => {
  it('accepts plain serializable data and freezes it through', () => {
    const snapshot = sealSnapshot(envelope({ tickets: [{ key: 'DEV-501', points: 8, blocked: false }] }));

    expect(isSealed(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.collections.tickets[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot)).collections.tickets[0].key).toBe('DEV-501');
  });

  it('refuses a Date, naming the path', () => {
    expect(() => sealSnapshot(envelope({ tickets: [{ resolvedAt: new Date(0) }] }))).toThrow(
      SnapshotSerializationError,
    );

    try {
      sealSnapshot(envelope({ tickets: [{ resolvedAt: new Date(0) }] }));
    } catch (error) {
      expect((error as SnapshotSerializationError).path).toBe('$.collections.tickets[0].resolvedAt');
    }
  });

  it('refuses handles that would make the snapshot un-reproducible', () => {
    expect(() => sealSnapshot(envelope({ load: () => [] }))).toThrow(SnapshotSerializationError);
    expect(() => sealSnapshot(envelope({ pending: Promise.resolve(1) }))).toThrow(SnapshotSerializationError);
    expect(() => sealSnapshot(envelope({ byKey: new Map() }))).toThrow(SnapshotSerializationError);
    expect(() => sealSnapshot(envelope({ seen: new Set() }))).toThrow(SnapshotSerializationError);
    expect(() => sealSnapshot(envelope({ count: Number.NaN }))).toThrow(SnapshotSerializationError);
    expect(() => sealSnapshot(envelope({ big: 1n }))).toThrow(SnapshotSerializationError);
  });

  it('refuses a class instance masquerading as data', () => {
    class Ticket {
      constructor(readonly key: string) {}
    }

    expect(() => sealSnapshot(envelope({ tickets: [new Ticket('DEV-501')] }))).toThrow(SnapshotSerializationError);
  });

  it('serialises byte-identically twice', () => {
    const build = () => sealSnapshot(envelope({ tickets: [{ key: 'DEV-501' }, { key: 'DEV-514' }] }));

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
