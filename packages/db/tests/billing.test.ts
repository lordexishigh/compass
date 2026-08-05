import { instantFromIso } from '@compass/clock';
import {
  ScopedDb,
  applyBillingEventOnce,
  findBillingSubscription,
  listBillingEvents,
  orgScope,
  organizations,
  upsertBillingSubscription,
} from '@compass/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

/**
 * The idempotency guarantee, against a real database.
 *
 * Criterion 003 asks for exactly this and names the test: *"Stripe webhooks verify the signature and
 * are idempotent on redelivery; a test replays the same event twice and asserts one state change."*
 * The signature half is `packages/billing/tests/billing.test.ts`; this is the replay half, and it has
 * to run against a real engine because the guarantee **is** a UNIQUE index — a mocked query builder
 * would happily accept the second insert this test exists to prove is refused.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const AT = instantFromIso('2026-08-05T09:00:00Z');
const LATER = instantFromIso('2026-08-05T09:05:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;

const scoped = (organizationId = ORG) => new ScopedDb(database.db, orgScope(organizationId));

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  for (const [id, name] of [
    [ORG, 'Northwind'],
    [OTHER_ORG, 'Beta Robotics'],
  ] as const) {
    await database.db
      .insert(organizations)
      .values({
        id,
        organizationId: id,
        name,
        slug: name.toLowerCase().replace(/\s+/g, '-'),
        timezone: 'Europe/London',
        createdAt: asDate('2026-07-01T00:00:00Z'),
        updatedAt: asDate('2026-07-01T00:00:00Z'),
      })
      .onConflictDoNothing()
      .execute();
  }
});

afterAll(async () => {
  await database.close();
});

describe('one subscription row per organization', () => {
  it('creates the row on first write and updates it on the second', async () => {
    await upsertBillingSubscription(
      scoped(),
      {
        id: '33333333-3333-4333-8333-333333333333',
        write: { status: 'trialing', planId: 'team', trialEndsAt: instantFromIso('2026-08-19T09:00:00Z') },
      },
      AT,
    );

    const first = await findBillingSubscription(scoped());
    expect(first?.status).toBe('trialing');
    expect(first?.planId).toBe('team');

    // A *different* row id, which is what a second webhook would generate. The unique index on
    // organization_id makes this an update rather than a duplicate.
    await upsertBillingSubscription(
      scoped(),
      { id: '44444444-4444-4444-8444-444444444444', write: { status: 'active', seatAllowance: 9 } },
      LATER,
    );

    const second = await findBillingSubscription(scoped());
    expect(second?.status).toBe('active');
    expect(second?.seatAllowance).toBe(9);
    // The row kept its identity and its original creation instant: "since when has this organization
    // been a customer" stays answerable.
    expect(second?.id).toBe(first?.id);
    expect(second?.createdAt).toBe(AT);
    expect(second?.updatedAt).toBe(LATER);
    // And the fields the second write did not mention were left alone rather than nulled.
    expect(second?.planId).toBe('team');
  });

  it('keeps one organization’s subscription out of another’s reads', async () => {
    await upsertBillingSubscription(
      scoped(OTHER_ORG),
      { id: '55555555-5555-4555-8555-555555555555', write: { status: 'canceled', planId: 'starter' } },
      AT,
    );

    expect((await findBillingSubscription(scoped()))?.planId).toBe('team');
    expect((await findBillingSubscription(scoped(OTHER_ORG)))?.planId).toBe('starter');
  });

  it('writes null through, because clearing a dunning window is a real change', async () => {
    await upsertBillingSubscription(
      scoped(),
      {
        id: '66666666-6666-4666-8666-666666666666',
        write: { status: 'past_due', dunningStartedAt: AT, dunningDeadlineAt: LATER },
      },
      AT,
    );
    expect((await findBillingSubscription(scoped()))?.dunningStartedAt).toBe(AT);

    await upsertBillingSubscription(
      scoped(),
      {
        id: '66666666-6666-4666-8666-666666666666',
        write: { status: 'active', dunningStartedAt: null, dunningDeadlineAt: null },
      },
      LATER,
    );

    // `null` means clear; `undefined` means leave alone. Collapsing the two would make a recovered
    // payment unable to restore access.
    const cleared = await findBillingSubscription(scoped());
    expect(cleared?.dunningStartedAt).toBeNull();
    expect(cleared?.status).toBe('active');
  });
});

describe('replaying the same Stripe event', () => {
  const EVENT_ID = 'evt_replayed_once';

  it('applies it the first time', async () => {
    const outcome = await applyBillingEventOnce(
      database.db,
      {
        organizationId: ORG,
        id: '77777777-7777-4777-8777-777777777777',
        stripeEventId: EVENT_ID,
        stripeEventType: 'customer.subscription.updated',
        detail: 'The subscription is now active.',
        subscriptionRowId: '88888888-8888-4888-8888-888888888888',
        write: { status: 'active', seatAllowance: 12 },
      },
      AT,
    );

    expect(outcome.applied).toBe(true);
    expect((await findBillingSubscription(scoped()))?.seatAllowance).toBe(12);
  });

  it('changes nothing the second time, and says so', async () => {
    /**
     * The assertion the criterion names.
     *
     * The redelivery carries a *different* state — 99 seats — precisely so that "one state change"
     * is provable rather than coincidental: if the second call applied, the seat allowance would move
     * to 99 and this test would fail on the number rather than on a row count.
     */
    const outcome = await applyBillingEventOnce(
      database.db,
      {
        organizationId: ORG,
        id: '99999999-9999-4999-8999-999999999999',
        stripeEventId: EVENT_ID,
        stripeEventType: 'customer.subscription.updated',
        detail: 'A redelivery of the same event.',
        subscriptionRowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        write: { status: 'canceled', seatAllowance: 99 },
      },
      LATER,
    );

    expect(outcome.applied, 'the redelivery must report that it changed nothing').toBe(false);

    const after = await findBillingSubscription(scoped());
    expect(after?.seatAllowance, 'the second delivery changed the subscription').toBe(12);
    expect(after?.status).toBe('active');
  });

  it('records the event exactly once in the ledger', async () => {
    const events = await listBillingEvents(scoped());
    const replays = events.filter((event) => event.stripeEventId === EVENT_ID);

    expect(replays).toHaveLength(1);
    // The first delivery's sentence, not the redelivery's — the ledger records what was applied.
    expect(replays[0]?.detail).toBe('The subscription is now active.');
    expect(replays[0]?.processedAt).toBe(AT);
  });

  it('still applies a genuinely different event', async () => {
    // The constraint must refuse a *replay*, not every subsequent event.
    const outcome = await applyBillingEventOnce(
      database.db,
      {
        organizationId: ORG,
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        stripeEventId: 'evt_a_different_one',
        stripeEventType: 'invoice.payment_failed',
        detail: 'A payment failed, so dunning has started.',
        subscriptionRowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        write: { status: 'past_due', dunningStartedAt: LATER },
      },
      LATER,
    );

    expect(outcome.applied).toBe(true);
    expect((await findBillingSubscription(scoped()))?.status).toBe('past_due');
  });

  it('refuses the same event id even from another organization', async () => {
    /**
     * The unique index is global rather than per `(organization_id, stripe_event_id)`.
     *
     * Stripe event ids are globally unique, so the same id arriving for a second organization means
     * the event has been misattributed — and applying it once per tenant is the opposite of what the
     * constraint is for.
     */
    const outcome = await applyBillingEventOnce(
      database.db,
      {
        organizationId: OTHER_ORG,
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        stripeEventId: EVENT_ID,
        stripeEventType: 'customer.subscription.updated',
        detail: 'The same event id, another tenant.',
        subscriptionRowId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        write: { status: 'active', seatAllowance: 3 },
      },
      LATER,
    );

    expect(outcome.applied).toBe(false);
    // The other organization's own row is untouched by the refused apply.
    expect((await findBillingSubscription(scoped(OTHER_ORG)))?.planId).toBe('starter');
  });

  it('rolls the whole thing back when the state change fails', async () => {
    /**
     * The transaction boundary, proved rather than asserted in a comment.
     *
     * A seat allowance of zero violates `organization_subscriptions_seats_positive_check`, so the
     * subscription write throws *after* the ledger insert has succeeded inside the same transaction.
     * If the two were sequenced rather than transactional, the event id would be left recorded and the
     * redelivery — seeing the ledger row — would decline to fix it. This asserts the ledger row is
     * gone too.
     */
    await expect(
      applyBillingEventOnce(
        database.db,
        {
          organizationId: ORG,
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          stripeEventId: 'evt_that_fails',
          stripeEventType: 'customer.subscription.updated',
          detail: 'A write the database refuses.',
          subscriptionRowId: '10101010-1010-4010-8010-101010101010',
          write: { seatAllowance: 0 },
        },
        LATER,
      ),
    ).rejects.toThrow();

    const events = await listBillingEvents(scoped(), 50);
    expect(
      events.some((event) => event.stripeEventId === 'evt_that_fails'),
      'the ledger kept an event whose state change rolled back',
    ).toBe(false);
  });
});
