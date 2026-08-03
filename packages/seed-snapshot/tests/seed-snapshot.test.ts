import { addDaysInZone, type Instant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  SEED_NOW,
  SEED_ORGANIZATION_ID,
  SEED_TIMEZONE,
  SEED_WINDOW,
  buildSeedSnapshot,
  mergedButUnreachableSnapshot,
  orphanPullRequestSnapshot,
  resequencedTicketSnapshot,
  seedIsAvailable,
  wellRunTeamSnapshot,
} from '@compass/seed-snapshot';

/**
 * The fixture builder's own contract.
 *
 * This package feeds three consumers that all depend on one property: the snapshot is a
 * *pure function of its arguments*. The analysis suites rely on it to compare two
 * snapshots; the golden fixtures rely on it so a checked-in file is reproducible; the
 * determinism gate relies on it so a second process agrees with the first. None of
 * those tests would say which of them broke if this property broke, so it is asserted
 * here, once, where it lives.
 */

describe('the seed is present and reachable from this package', () => {
  it('finds the checked-in dataset', () => {
    // The paths moved when this became a package. A wrong relative depth would make
    // every consumer fail with a file-not-found rather than a useful message.
    expect(seedIsAvailable()).toBe(true);
  });

  it('names the seeded organization and zone the rest of the repository uses', () => {
    expect(SEED_ORGANIZATION_ID).toBe('00000000-0000-4000-8000-000000000001');
    expect(SEED_TIMEZONE).toBe('Europe/London');
    expect(SEED_WINDOW.end).toBeLessThanOrEqual(SEED_NOW);
  });
});

describe('the snapshot is a pure function of (team, instant, window)', () => {
  const TEAMS = ['platform', 'checkout', 'insights'] as const;

  it.each(TEAMS)('builds for %s with the envelope it was given', (teamKey) => {
    const snapshot = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });

    expect(snapshot.organizationId).toBe(SEED_ORGANIZATION_ID);
    expect(snapshot.scope).toEqual({ kind: 'team', teamKey });
    expect(snapshot.instant).toBe(SEED_NOW);
    expect(snapshot.timezone).toBe(SEED_TIMEZONE);
    expect(snapshot.collections.entities.length).toBeGreaterThan(50);
  });

  it.each(TEAMS)('produces an equal snapshot twice for %s, from two independent builds', (teamKey) => {
    const first = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });
    const second = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });

    // Deep equality rather than identity: the parse is cached, so a shared *object*
    // would prove nothing. What matters is that two builds agree field for field.
    expect(second).toEqual(first);
  });

  it('never reads a clock — a different instant is the only thing that changes the answer', () => {
    const earlier = addDaysInZone(SEED_NOW, SEED_TIMEZONE, -3) as Instant;

    const atSeedNow = buildSeedSnapshot({ instant: SEED_NOW });
    const atEarlier = buildSeedSnapshot({ instant: earlier });

    expect(atEarlier.instant).toBe(earlier);
    // The elapsed facts are computed against the instant, so they must move with it.
    // If the builder asked a clock for `now`, these would be equal.
    expect(atEarlier.collections.entities.map((entity) => entity.elapsed.ageDays)).not.toEqual(
      atSeedNow.collections.entities.map((entity) => entity.elapsed.ageDays),
    );
  });

  it('sorts every collection, so nothing downstream depends on insertion order', () => {
    const { collections } = buildSeedSnapshot();
    const keys = collections.entities.map((entity) => `${entity.kind} ${entity.naturalKey}`);

    expect(keys).toEqual([...keys].sort());
    expect(collections.entityCounts.map((count) => count.kind)).toEqual(
      [...collections.entityCounts.map((count) => count.kind)].sort(),
    );
  });

  it('gives the fourteen-day trail one entry per day for every entity', () => {
    for (const entity of buildSeedSnapshot().collections.entities) {
      expect(entity.elapsed.trail, `${entity.kind} ${entity.naturalKey}`).toHaveLength(14);
    }
  });
});

describe('the constructed fixtures the seed cannot express', () => {
  it('keeps each one buildable, because each covers a branch the seed never reaches', () => {
    // Every one of these exists because the generated dataset cannot produce the case —
    // a pull request nobody was asked to review, a ticket carried across two sprints, a
    // merge unreachable from trunk, a team that does everything right. They are asserted
    // here only for buildability; the branches they cover are asserted in `analysis`.
    for (const [label, snapshot] of [
      ['orphan pull request', orphanPullRequestSnapshot()],
      ['resequenced ticket', resequencedTicketSnapshot()],
      ['merged but unreachable', mergedButUnreachableSnapshot()],
      ['well-run team', wellRunTeamSnapshot()],
    ] as const) {
      expect(snapshot.organizationId, label).toBe(SEED_ORGANIZATION_ID);
      expect(snapshot.collections.entities.length, label).toBeGreaterThan(0);
    }
  });

  it('leaves the well-run team genuinely clean, which is what makes it a negative control', () => {
    // If this fixture ever grew a pathology it would stop being able to prove that a
    // threshold is not firing on everything.
    const snapshot = wellRunTeamSnapshot();
    const tickets = snapshot.collections.entities.filter((entity) => entity.kind === 'ticket');

    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((ticket) => ticket.fields['flaggedBlocked'] !== true)).toBe(true);
  });
});
