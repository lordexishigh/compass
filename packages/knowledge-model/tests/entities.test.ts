import { MILLIS_PER_DAY, addExactDays } from '@compass/clock';
import { NAMED_ENTITIES, entityTableName } from '@compass/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  IncompleteObservationError,
  UntrackedFieldError,
  ageInDays,
  elapsedFactsFor,
  ticketsOfFeature,
  buildKnowledgeSnapshot,
} from '@compass/knowledge-model';

import {
  TEST_TIMEZONE,
  at,
  blockerFields,
  createStoreHarness,
  ticketFields,
  windowOf,
  type StoreHarness,
} from './helpers/store.js';

/**
 * Acceptance criteria for "named entity tables with first_seen_at / last_seen_at
 * and append-only history", asserted end to end against a real PostgreSQL.
 */
let harness: StoreHarness;

beforeAll(async () => {
  harness = await createStoreHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('a first sighting', () => {
  it('writes the entity row and version 1 together', async () => {
    const observedAt = at('2026-07-28T09:00:00Z');
    const result = await harness.store.observe({
      kind: 'ticket',
      naturalKey: 'PLAT-900',
      fields: ticketFields({ itemKey: 'PLAT-900', projectKey: 'PLAT' }),
      observedAt,
      evidence: { kind: 'issue', label: 'PLAT-900', sourceKey: 'primary-tracker', sourceRecordId: 'issue-PLAT-900' },
    });

    expect(result.outcome).toBe('created');
    expect(result.version).toBe(1);
    expect(result.firstSeenAt).toBe(observedAt);
    expect(result.lastSeenAt).toBe(observedAt);

    const versions = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: 'PLAT-900' });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.changedFields).toContain('status');
    expect(versions[0]?.evidenceSourceRecordId).toBe('issue-PLAT-900');
  });

  it('takes its instants from the observed record, not from any clock', async () => {
    const stored = await harness.store.read('ticket', 'PLAT-900');

    expect(stored?.firstSeenAt).toBe(at('2026-07-28T09:00:00Z'));
    expect(stored?.beliefAt).toBe(at('2026-07-28T09:00:00Z'));
  });

  it('refuses a partial field set rather than reading an absent key as null', async () => {
    const incomplete = { ...ticketFields({ itemKey: 'PLAT-901' }) };
    delete (incomplete as Record<string, unknown>)['status'];

    await expect(
      harness.store.observe({
        kind: 'ticket',
        naturalKey: 'PLAT-901',
        fields: incomplete,
        observedAt: at('2026-07-28T09:00:00Z'),
        evidence: null,
      }),
    ).rejects.toThrow(IncompleteObservationError);
  });

  it('refuses a field the registry does not track', async () => {
    await expect(
      harness.store.observe({
        kind: 'ticket',
        naturalKey: 'PLAT-902',
        fields: { ...ticketFields({ itemKey: 'PLAT-902' }), storyPointsV2: 3 },
        observedAt: at('2026-07-28T09:00:00Z'),
        evidence: null,
      }),
    ).rejects.toThrow(UntrackedFieldError);
  });
});

describe('a tracked field changing', () => {
  const naturalKey = 'CHK-701';

  beforeAll(async () => {
    await harness.store.observe({
      kind: 'ticket',
      naturalKey,
      fields: ticketFields({ status: 'Blocked', flaggedBlocked: true }),
      observedAt: at('2026-07-30T08:15:00Z'),
      evidence: { kind: 'issue', label: naturalKey, sourceKey: 'primary-tracker', sourceRecordId: 'issue-CHK-701' },
    });
  });

  it('appends a new history row and never rewrites one', async () => {
    const before = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: naturalKey });
    expect(before).toHaveLength(1);
    const originalBelief = JSON.stringify(before[0]?.trackedFields);

    await harness.store.observe({
      kind: 'ticket',
      naturalKey,
      fields: ticketFields({ status: 'Done', statusCategory: 'done', flaggedBlocked: false, resolvedAt: at('2026-07-30T18:40:00Z') }),
      observedAt: at('2026-07-30T18:40:00Z'),
      evidence: { kind: 'issue', label: naturalKey, sourceKey: 'primary-tracker', sourceRecordId: 'issue-CHK-701' },
    });

    const after = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: naturalKey });

    expect(after).toHaveLength(2);
    // The prior belief is byte-for-byte where it was.
    expect(JSON.stringify(after[0]?.trackedFields)).toBe(originalBelief);
    expect(after[0]?.version).toBe(1);
    expect(after[1]?.version).toBe(2);
    expect(after[1]?.changedFields).toEqual(['flaggedBlocked', 'resolvedAt', 'status', 'statusCategory']);
  });

  it('advances the entity row while leaving first_seen_at where it was', async () => {
    const stored = await harness.store.read('ticket', naturalKey);

    expect(stored?.version).toBe(2);
    expect(stored?.fields['status']).toBe('Done');
    expect(stored?.firstSeenAt).toBe(at('2026-07-30T08:15:00Z'));
    expect(stored?.lastSeenAt).toBe(at('2026-07-30T18:40:00Z'));
  });

  it('adds no version when the same belief is observed again', async () => {
    const before = await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: naturalKey });

    const result = await harness.store.observe({
      kind: 'ticket',
      naturalKey,
      fields: ticketFields({ status: 'Done', statusCategory: 'done', flaggedBlocked: false, resolvedAt: at('2026-07-30T18:40:00Z') }),
      observedAt: at('2026-07-31T09:00:00Z'),
      evidence: null,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.changedFields).toEqual([]);
    expect(await harness.store.versions({ entityKind: 'ticket', entityNaturalKey: naturalKey })).toHaveLength(
      before.length,
    );
    // A sighting is not a change of belief, but it is still a sighting.
    expect((await harness.store.read('ticket', naturalKey))?.lastSeenAt).toBe(at('2026-07-31T09:00:00Z'));
  });

  it('lets an out-of-order record widen the sighting without rewriting the belief', async () => {
    const result = await harness.store.observe({
      kind: 'ticket',
      naturalKey,
      fields: ticketFields({ status: 'In Progress', statusCategory: 'in_progress' }),
      observedAt: at('2026-07-29T10:00:00Z'),
      evidence: null,
    });

    expect(result.outcome).toBe('superseded');
    const stored = await harness.store.read('ticket', naturalKey);
    expect(stored?.fields['status']).toBe('Done');
    expect(stored?.version).toBe(2);
    expect(stored?.firstSeenAt).toBe(at('2026-07-29T10:00:00Z'));
  });
});

describe('every entity family', () => {
  it.each(NAMED_ENTITIES.map((definition) => [definition.kind, definition] as const))(
    '%s round-trips its tracked fields through the database unchanged',
    async (kind, definition) => {
      // A value per column type, so a `timestamptz` that lost precision or a jsonb
      // that came back reordered shows up as a changed field on the second pass.
      const fields = Object.fromEntries(
        definition.trackedFields.map((field) => {
          if (definition.instantFields.includes(field)) return [field, at('2026-06-15T12:34:56Z')];
          return [field, sampleFor(kind, field)];
        }),
      );

      const first = await harness.otherStore.observe({
        kind,
        naturalKey: `probe-${kind}`,
        fields,
        observedAt: at('2026-06-15T12:34:56Z'),
        evidence: null,
      });
      const second = await harness.otherStore.observe({
        kind,
        naturalKey: `probe-${kind}`,
        fields,
        observedAt: at('2026-06-15T12:34:56Z'),
        evidence: null,
      });

      expect(first.outcome).toBe('created');
      expect(second.outcome, `${entityTableName(kind)} reported a phantom change`).toBe('unchanged');
      expect(second.changedFields).toEqual([]);
    },
  );

  it('keeps the two tenants entirely apart', async () => {
    expect(await harness.store.read('ticket', 'probe-ticket')).toBeNull();
    expect(await harness.otherStore.read('ticket', 'CHK-701')).toBeNull();
  });
});

/**
 * The Feature criterion: a Feature persists with its parent Project and gathers
 * its child Tickets.
 */
describe('a Feature and its children', () => {
  beforeAll(async () => {
    await harness.store.observe({
      kind: 'project',
      naturalKey: 'CHK',
      fields: { name: 'Checkout', teamKey: 'checkout', methodology: 'scrum', defaultBranch: 'main' },
      observedAt: at('2026-07-01T09:00:00Z'),
      evidence: null,
    });

    await harness.store.observe({
      kind: 'feature',
      naturalKey: 'CHK-700',
      fields: {
        projectKey: 'CHK',
        title: 'Declined-card retry behaviour',
        status: 'In Progress',
        statusCategory: 'in_progress',
      },
      observedAt: at('2026-07-02T09:00:00Z'),
      evidence: { kind: 'issue', label: 'CHK-700', sourceKey: 'primary-tracker', sourceRecordId: 'issue-CHK-700' },
    });

    for (const itemKey of ['CHK-711', 'CHK-710']) {
      await harness.store.observe({
        kind: 'ticket',
        naturalKey: itemKey,
        fields: ticketFields({ itemKey, featureKey: 'CHK-700' }),
        observedAt: at('2026-07-03T09:00:00Z'),
        evidence: null,
      });
    }
  });

  it('persists the Feature against the Project that owns it', async () => {
    const feature = await harness.store.read('feature', 'CHK-700');
    const project = await harness.store.read('project', String(feature?.fields['projectKey']));

    expect(feature).not.toBeNull();
    expect(project?.naturalKey).toBe('CHK');
    expect(project?.fields['name']).toBe('Checkout');
  });

  it('gathers its child Tickets, in a documented order rather than row order', async () => {
    const snapshot = await buildKnowledgeSnapshot(harness.store, {
      scope: { kind: 'team', teamKey: 'checkout' },
      instant: at('2026-07-31T08:00:00Z'),
      timezone: TEST_TIMEZONE,
      window: windowOf('2026-07-30T00:00:00Z', '2026-07-31T00:00:00Z'),
    });

    expect(ticketsOfFeature(snapshot, 'CHK-700').map((ticket) => ticket.fields['itemKey'])).toEqual([
      'CHK-710',
      'CHK-711',
    ]);
  });
});

/**
 * The elapsed-fact criterion, stated exactly as the acceptance criteria do: a
 * blocker first seen six days before the instant reports `age_days = 6`.
 */
describe('elapsed facts', () => {
  const instant = at('2026-07-30T08:15:00Z');
  const sixDaysEarlier = addExactDays(instant, -6);

  beforeAll(async () => {
    await harness.store.observe({
      kind: 'blocker',
      naturalKey: 'ticket:CHK-701:tracker_blocked',
      fields: blockerFields(),
      observedAt: sixDaysEarlier,
      evidence: null,
    });
    // Seen again today: still blocked, so `last_seen_at` advances and the age grows.
    await harness.store.observe({
      kind: 'blocker',
      naturalKey: 'ticket:CHK-701:tracker_blocked',
      fields: blockerFields(),
      observedAt: instant,
      evidence: null,
    });
  });

  it('returns age_days = 6 for a blocker first seen six days before the instant', async () => {
    const blocker = await harness.store.read('blocker', 'ticket:CHK-701:tracker_blocked');
    if (blocker === null) throw new Error('the blocker was not stored');

    expect(blocker.firstSeenAt).toBe(sixDaysEarlier);
    expect(ageInDays(blocker.firstSeenAt, instant)).toBe(6);
    expect(elapsedFactsFor(blocker, instant, TEST_TIMEZONE).ageDays).toBe(6);
  });

  it('counts exact days, so the number does not jump at local midnight', async () => {
    const blocker = await harness.store.read('blocker', 'ticket:CHK-701:tracker_blocked');
    if (blocker === null) throw new Error('the blocker was not stored');

    // One millisecond short of seven days is still day 6.
    expect(ageInDays(blocker.firstSeenAt, (instant + MILLIS_PER_DAY - 1) as typeof instant)).toBe(6);
    expect(ageInDays(blocker.firstSeenAt, (instant + MILLIS_PER_DAY) as typeof instant)).toBe(7);
  });

  it('renders a fourteen-day presence trail whose filled ticks are the days it was known', async () => {
    const blocker = await harness.store.read('blocker', 'ticket:CHK-701:tracker_blocked');
    if (blocker === null) throw new Error('the blocker was not stored');

    const facts = elapsedFactsFor(blocker, instant, TEST_TIMEZONE);

    expect(facts.trail).toHaveLength(14);
    // Present for the last seven civil days, absent for the seven before that.
    expect(facts.trail.filter(Boolean)).toHaveLength(7);
    expect(facts.trail.slice(-7).every(Boolean)).toBe(true);
    expect(facts.trail.slice(0, 7).some(Boolean)).toBe(false);
    expect(facts.staleDays).toBe(0);
    expect(facts.seenToday).toBe(true);
  });
});

/** A representative value per column, keyed loosely so a new column still gets one. */
function sampleFor(kind: string, field: string): string | number | boolean | null | readonly string[] | Record<string, unknown> {
  if (/Count$|^displayNumber$|Points$|^version$/.test(field)) return 3;
  if (/^is[A-Z]|^active$|^flaggedBlocked$|^afterSprintStart$/.test(field)) return true;
  if (/Keys$|Ids$|^labels$|^artifactKinds$|^witnessRefs$|^sourceKeys$/.test(field)) return ['beta', 'alpha'];
  if (field === 'evidence') {
    return [{ kind: 'issue', label: 'X-1', sourceKey: 'primary-tracker', sourceRecordId: 'issue-X-1' }] as never;
  }
  if (field === 'extracted') return { note: 'unparsed' };
  if (field === 'authorUserId') return null;
  return `${kind}.${field}`;
}
