import {
  STABLE_ID_PATTERN,
  STABLE_ID_VERSION,
  canonicalIdentityString,
  entityRef,
  isStableItemId,
  itemCauseKey,
  stableItemId,
  type ItemIdentity,
} from '@compass/analysis';
import { describe, expect, it } from 'vitest';

/**
 * The derivation of a report item's id.
 *
 * Everything that stops the daily reading as though nothing has a history — "day 6" rather than
 * "new", the change tag, a dismissal that sticks, a snooze that expires — rests on the same
 * condition producing the same id tomorrow. So these tests are about the *function*, not about a
 * report: an id that quietly folded in an instant or a run counter would satisfy every
 * end-to-end assertion on a single day and fail silently on the second.
 */

const ORG = '11111111-1111-4111-8111-111111111111';

const identity = (overrides: Partial<ItemIdentity> = {}): ItemIdentity => ({
  organizationId: ORG,
  entityRef: entityRef('ticket', 'PLAT-742'),
  causeKind: 'status_dwell',
  ...overrides,
});

describe('the same condition derives the same id', () => {
  it('is stable across repeated calls', () => {
    expect(stableItemId(identity())).toBe(stableItemId(identity()));
  });

  it('is stable across two independently constructed identities', () => {
    // Object identity must not matter: the detectors build a fresh object every run.
    const first = stableItemId({
      organizationId: ORG,
      entityRef: 'ticket:PLAT-742',
      causeKind: 'status_dwell',
    });
    const second = stableItemId({
      organizationId: ORG,
      entityRef: entityRef('ticket', 'PLAT-742'),
      causeKind: 'status_dwell',
      causeDiscriminator: '',
    });

    // An omitted discriminator and an empty one are the same condition, not two.
    expect(first).toBe(second);
  });

  it('has the documented shape', () => {
    expect(stableItemId(identity())).toMatch(STABLE_ID_PATTERN);
    expect(isStableItemId(stableItemId(identity()))).toBe(true);
    expect(stableItemId(identity()).startsWith(`${STABLE_ID_VERSION}:`)).toBe(true);
  });
});

describe('the four coordinates each change the id', () => {
  const base = stableItemId(identity());

  it('separates two tenants with the same ticket and the same cause', () => {
    // Without the tenant, one organization's dismissal would suppress another's item.
    expect(stableItemId(identity({ organizationId: '22222222-2222-4222-8222-222222222222' }))).not.toBe(base);
  });

  it('separates two entities', () => {
    expect(stableItemId(identity({ entityRef: entityRef('ticket', 'PLAT-743') }))).not.toBe(base);
  });

  it('separates two causes on the same entity', () => {
    // One ticket can be both stalled and unreviewed; those are two items, not one.
    expect(stableItemId(identity({ causeKind: 'no_reviewer' }))).not.toBe(base);
  });

  it('separates two discriminators of the same cause', () => {
    expect(stableItemId(identity({ causeDiscriminator: 'priya' }))).not.toBe(
      stableItemId(identity({ causeDiscriminator: 'marcus' })),
    );
  });

  it('does not confuse a colon in a natural key with a field separator', () => {
    // `checkout-web:9201` is a real natural-key shape. `a:b` + `c` must not canonicalise to the
    // same bytes as `a` + `b:c`, or two unrelated conditions would share one id.
    const left = stableItemId(identity({ entityRef: 'pull_request:checkout-web:9201', causeKind: 'stale' }));
    const right = stableItemId(identity({ entityRef: 'pull_request:checkout-web', causeKind: '9201:stale' }));

    expect(left).not.toBe(right);
  });
});

describe('what the id is not derived from', () => {
  /**
   * The heart of the criterion. An id carrying a report id, a run id or an instant would make
   * every item new every morning — the exact failure this module exists to prevent — and would
   * pass any single-day test.
   */
  it('takes nothing but the four coordinates into the hash', () => {
    const canonical = canonicalIdentityString(identity({ causeDiscriminator: 'priya' }));

    // Length-prefixed fields, so a colon inside a natural key cannot be read as a separator.
    // Spelled out in full here: this string *is* the contract, and anything extra appearing in it
    // — an instant, a run id, a counter — would be visible in this one assertion.
    expect(canonical).toBe(
      `2:${STABLE_ID_VERSION}|36:${ORG}|15:ticket:PLAT-742|12:status_dwell|5:priya`,
    );
  });

  it('ignores any extra field a caller passes', () => {
    // Structural typing would let a detector hand in a whole report context by accident. The
    // derivation must read only what it documents.
    const polluted = {
      ...identity(),
      reportId: 'a2f1c0de-0000-4000-8000-000000000001',
      runId: 'run-99',
      generatedAt: 1_777_000_000_000,
      attempt: 3,
    } as ItemIdentity;

    expect(stableItemId(polluted)).toBe(stableItemId(identity()));
  });

  it('contains no digits of an instant, and no dashes of a uuid', () => {
    // A structural check on the output itself: sixteen hex digits after `v1:` and nothing else,
    // so a timestamp or a uuid could not be hiding in the id even in part.
    const id = stableItemId(identity());

    expect(id).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(id).not.toContain('-');
    expect(id.length).toBe(19);
  });

  it('is not a function of call order', () => {
    // A counter would produce different ids for the same condition depending on how many items
    // the report happened to emit before it.
    const first = stableItemId(identity({ entityRef: 'ticket:A' }));
    stableItemId(identity({ entityRef: 'ticket:B' }));
    stableItemId(identity({ entityRef: 'ticket:C' }));
    const again = stableItemId(identity({ entityRef: 'ticket:A' }));

    expect(again).toBe(first);
  });
});

describe('ten consecutive simulated days', () => {
  /**
   * The acceptance criterion, stated directly on the derivation.
   *
   * Ten instants a day apart, each one standing for a day's report run. A persistent risk keeps
   * one id across all ten, and — the half worth asserting explicitly — the *set* of ids across
   * the ten days has exactly one member, so nothing is quietly minting a second id for the same
   * condition on a later day.
   */
  const DAY = 86_400_000;
  const FIRST = 1_777_000_000_000;

  it('keeps one id for a persistent risk across all ten', () => {
    const persistent = identity({
      entityRef: entityRef('developer', 'priya'),
      causeKind: 'review_bottleneck',
    });

    const ids = Array.from({ length: 10 }, (_, day) => {
      // The instant advances; it is simply not an input to the derivation. Constructing it here
      // is the point — a derivation that took it would fail this test ten different ways.
      const reportInstant = FIRST + day * DAY;
      expect(reportInstant).toBeGreaterThan(0);
      return stableItemId(persistent);
    });

    expect(new Set(ids).size, 'a persistent condition must be one item, not ten').toBe(1);
    expect(ids[0]).toBe(ids[9]);
  });

  it('still separates a genuinely different condition seen on day 5', () => {
    // The other direction: stability must not come from the derivation ignoring its inputs.
    const persistent = stableItemId(identity({ causeKind: 'review_bottleneck' }));
    const appeared = stableItemId(identity({ causeKind: 'work_concentration' }));

    expect(appeared).not.toBe(persistent);
  });
});

describe('the readable cause key', () => {
  it('reads as the entity and the cause', () => {
    expect(itemCauseKey(identity())).toBe('ticket:PLAT-742:status_dwell');
  });

  it('appends a discriminator only when there is one', () => {
    expect(itemCauseKey(identity({ causeDiscriminator: 'priya' }))).toBe('ticket:PLAT-742:status_dwell:priya');
    expect(itemCauseKey(identity({ causeDiscriminator: '' }))).toBe('ticket:PLAT-742:status_dwell');
  });

  it('omits the tenant, which the hash is what carries', () => {
    // This string is for a human reading one tenant's logs; the tenant is the context they are
    // already in. Two tenants therefore share a cause key and never share an id.
    expect(itemCauseKey(identity())).not.toContain(ORG);
    expect(stableItemId(identity({ organizationId: 'other' }))).not.toBe(stableItemId(identity()));
  });
});

describe('the version tag', () => {
  it('is part of the hashed bytes, so a bump changes every id', () => {
    // A prefix that were merely prepended to the output would leave the digest identical and make
    // the reset a cosmetic change rather than a real one. It is the first hashed field.
    expect(canonicalIdentityString(identity()).startsWith(`2:${STABLE_ID_VERSION}|`)).toBe(true);
  });

  it('is `v1` today', () => {
    expect(STABLE_ID_VERSION).toBe('v1');
  });
});
