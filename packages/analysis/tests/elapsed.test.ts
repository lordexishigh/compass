import { describe, expect, it } from 'vitest';

import {
  ELAPSED_FACT_KINDS,
  ELAPSED_FACT_MINIMUM_DAYS,
  MILLIS_PER_DAY,
  compareStable,
  computeElapsedFacts,
  countWord,
  isStableItemId,
  resolveScope,
  wholeDaysBetween,
  type ElapsedFactStatement,
  type Instant,
} from '@compass/analysis';

import { SEED_NOW, buildSeedSnapshot, resequencedTicketSnapshot } from './helpers/seed-snapshot.js';

/**
 * Elapsed facts — the sentences that make Compass a memory rather than a status
 * page.
 *
 * The claim under test is narrow and worth stating precisely: every fact is
 * derived from *stored history* and carries both the entity it is about and the
 * day count it asserts. A day count diffed against yesterday's report would be
 * wrong the first time a report was missed and would silently reset rather than
 * saying so, so the tests below check the arithmetic against the snapshot's own
 * append-only collections rather than against a previous output.
 */
const TEAM_KEYS = ['platform', 'checkout', 'insights'] as const;

const seeded = TEAM_KEYS.map((teamKey) => {
  const snapshot = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });
  return { teamKey, snapshot, facts: computeElapsedFacts(snapshot, SEED_NOW, resolveScope(snapshot)) };
});

const allFacts: readonly ElapsedFactStatement[] = seeded.flatMap((entry) => entry.facts);

describe('every fact carries the entity it is about and the day count it asserts', () => {
  it('produces elapsed facts from the seeded dataset at all', () => {
    expect(allFacts.length).toBeGreaterThan(0);
  });

  it('names an entity id, its kind and a human-readable label on every fact', () => {
    for (const fact of allFacts) {
      expect(fact.entityId.length, `${fact.stableId} names no entity`).toBeGreaterThan(0);
      expect(['ticket', 'pull_request']).toContain(fact.entityKind);
      expect(fact.entityLabel.length).toBeGreaterThan(0);
      expect(ELAPSED_FACT_KINDS as readonly string[]).toContain(fact.kind);
    }
  });

  it('asserts a day count that is a whole non-negative number of days', () => {
    for (const fact of allFacts) {
      expect(Number.isInteger(fact.dayCount), `${fact.stableId} asserts a fractional day count`).toBe(true);
      expect(fact.dayCount).toBeGreaterThanOrEqual(0);
      expect(fact.occurrences).toBeGreaterThanOrEqual(1);
    }
  });

  it('derives the day count from the stored instant it cites, not from anywhere else', () => {
    // This is the invariant that distinguishes "counted from history" from
    // "counted from yesterday's report": `since` is an instant that exists in the
    // snapshot, and `dayCount` is exactly the elapsed days from it.
    for (const fact of allFacts) {
      expect(fact.dayCount, `${fact.stableId} asserts a day count its own \`since\` does not support`).toBe(
        wholeDaysBetween(fact.since as Instant, SEED_NOW),
      );
      expect(fact.since, `${fact.stableId} claims to have started after the reporting instant`).toBeLessThanOrEqual(
        SEED_NOW,
      );
    }
  });

  it('counts a blocked ticket from the history that recorded the blockage', () => {
    // `still_blocked` counts from the earliest observed transition into a blocked
    // status, or the first sighting when the blockage predates ingest. Both are
    // stored facts; neither is the current belief's timestamp, which moves every
    // time anything on the ticket is touched.
    const blocked = seeded.flatMap((entry) =>
      entry.facts
        .filter((fact) => fact.kind === 'still_blocked')
        .map((fact) => ({ fact, snapshot: entry.snapshot })),
    );

    expect(blocked.length, 'the seeded dataset plants blocked work').toBeGreaterThan(0);

    for (const { fact, snapshot } of blocked) {
      const ticket = snapshot.collections.entities.find(
        (entity) => entity.kind === 'ticket' && entity.naturalKey === fact.entityId,
      );
      const earliestBlockedTransition = snapshot.collections.ticketTransitions
        .filter((transition) => transition.ticketKey === fact.entityId && /blocked/i.test(transition.toStatus))
        .map((transition) => transition.transitionedAt)
        .sort((left, right) => left - right)[0];

      expect(fact.since, `${fact.stableId} counts from an instant that is in no stored record`).toBe(
        earliestBlockedTransition ?? ticket?.firstSeenAt,
      );
      expect(fact.since).not.toBe(ticket?.beliefAt === ticket?.firstSeenAt ? -1 : ticket?.beliefAt);
    }
  });

  it('states the day count in the clause a reader sees, so the pill and the prose agree', () => {
    for (const fact of allFacts) {
      expect(fact.statement.length).toBeGreaterThan(0);
      if (fact.kind === 'still_blocked' || fact.kind === 'still_in_flight' || fact.kind === 'awaiting_review') {
        expect(fact.statement, `${fact.stableId} hides the number it asserts`).toContain(`day ${fact.dayCount}`);
      }
    }
  });

  it('carries at least one evidence artifact so the claim can be checked', () => {
    for (const fact of allFacts) {
      expect(fact.evidence.length, `${fact.stableId} carries no evidence`).toBeGreaterThan(0);
      for (const reference of fact.evidence) expect(reference.label.length).toBeGreaterThan(0);
    }
  });
});

describe('only recurrences worth stating are emitted', () => {
  it('drops a one-day-old fact that has happened once, because that is just "today"', () => {
    for (const fact of allFacts) {
      expect(
        fact.dayCount >= ELAPSED_FACT_MINIMUM_DAYS || fact.occurrences > 1,
        `${fact.stableId} is day ${fact.dayCount} and happened once — not yet worth a sentence`,
      ).toBe(true);
    }
  });
});

describe('ordering is total, so two runs agree', () => {
  it('orders by day count descending then stable id', () => {
    for (const { teamKey, facts } of seeded) {
      for (let index = 1; index < facts.length; index += 1) {
        const previous = facts[index - 1];
        const current = facts[index];
        const ordered =
          previous.dayCount > current.dayCount ||
          (previous.dayCount === current.dayCount && compareStable(previous.stableId, current.stableId) <= 0);
        expect(ordered, `${teamKey} emitted ${previous.stableId} before ${current.stableId}`).toBe(true);
      }
    }
  });

  it('emits an identical sequence on two runs over the same snapshot', () => {
    for (const teamKey of TEAM_KEYS) {
      const first = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });
      const second = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });

      expect(computeElapsedFacts(first, SEED_NOW, resolveScope(first))).toEqual(
        computeElapsedFacts(second, SEED_NOW, resolveScope(second)),
      );
    }
  });

  it('gives every fact a stable id derived from its kind and its subject alone', () => {
    // The ids now come from the shared derivation, so they are opaque digests rather than a
    // readable template. That makes the *property* the assertion, which is what the title always
    // meant: an id derived from the condition alone is one that does not move when the report does.
    for (const fact of allFacts) {
      expect(isStableItemId(fact.stableId), fact.stableId).toBe(true);
    }

    // Unique within a team, so "day 6" counts one thing rather than two.
    for (const { teamKey, facts } of seeded) {
      const ids = facts.map((fact) => fact.stableId);
      expect(new Set(ids).size, teamKey).toBe(ids.length);
    }
  });

  it('derives those ids from the condition, not from the run or the instant', () => {
    // Recomputed over the same snapshot at a *later* instant: the elapsed counts move, the ids do
    // not. An instant or a run id leaking into the derivation would make every fact new every
    // morning, which is the failure the whole identity scheme exists to prevent.
    const [first] = seeded;
    const laterFacts = computeElapsedFacts(
      first.snapshot,
      (SEED_NOW + MILLIS_PER_DAY) as Instant,
      resolveScope(first.snapshot),
    );

    const idsAt = (facts: readonly { readonly stableId: string }[]) => facts.map((fact) => fact.stableId).sort();
    expect(idsAt(laterFacts)).toEqual(idsAt(first.facts));
  });

  it('scopes those ids to the tenant, so two organizations never share one', () => {
    // One manager's dismissal must not suppress another organization's finding.
    const [first] = seeded;
    const otherTenant = { ...first.snapshot, organizationId: '99999999-9999-4999-8999-999999999999' };
    const otherFacts = computeElapsedFacts(otherTenant, SEED_NOW, resolveScope(otherTenant));

    const shared = new Set(first.facts.map((fact) => fact.stableId));
    for (const fact of otherFacts) {
      expect(shared.has(fact.stableId), fact.stableId).toBe(false);
    }
  });
});

describe('"resequenced twice" is read off the append-only scope-change log', () => {
  const snapshot = resequencedTicketSnapshot();
  const facts = computeElapsedFacts(snapshot, SEED_NOW, resolveScope(snapshot));
  const resequenced = facts.find((fact) => fact.kind === 'resequenced');

  it('emits the fact at all, which only stored history can support', () => {
    expect(resequenced, 'FLUX-1 was carried across two sprints').toBeDefined();
  });

  it('names the ticket and counts the deferrals rather than the days', () => {
    expect(resequenced?.entityId).toBe('FLUX-1');
    expect(resequenced?.entityKind).toBe('ticket');
    expect(resequenced?.occurrences).toBe(2);
    expect(resequenced?.statement).toBe('resequenced twice');
  });

  it('counts from the earliest scope change, not the most recent one', () => {
    const earliest = Math.min(...snapshot.collections.sprintScopeChanges.map((change) => change.changedAt));
    expect(resequenced?.since).toBe(earliest);
    expect(resequenced?.dayCount).toBe(wholeDaysBetween(earliest as Instant, SEED_NOW));
  });

  it('spells small counts as words, which is how the clause reads', () => {
    expect(countWord(1)).toBe('once');
    expect(countWord(2)).toBe('twice');
    expect(countWord(3)).toBe('three times');
    // And degrades to digits rather than running out of vocabulary.
    expect(countWord(11)).toBe('11 times');
  });
});
