import { RecordingMailer, startSession } from '@compass/auth';
import { FakeBillingGateway } from '@compass/billing/testkit';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  findBillingSubscription,
  memberships,
  orgScope,
  organizationSubscriptions,
  upsertBillingSubscription,
  users,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import { edgeNow } from './helpers/edge-now';

/**
 * The billing routes, executed end to end.
 *
 * `billing.test.tsx` proves the markup — which endpoint each button points at — and this proves what
 * happens when that button is actually pressed. Both halves are needed and neither implies the other:
 * the form was pointing at the right route while the route answered a form submission with a 400, so a
 * suite that checked only the markup was green over a flow that could not be started.
 *
 * ## What is real and what is replaced
 *
 * The handlers are imported unchanged and reach a real migrated PostgreSQL 17 through PGlite. `guard`,
 * `authorize` and the session resolution are the production path, because the whole point of an
 * owner-only write is that the guard decides it. Two seams are replaced:
 *
 *  - `lib/database`'s pool, the same way every other route test in this directory does it;
 *  - `gatewayFor`, so no request leaves the process. `FakeBillingGateway` is the testkit fake and is
 *    indistinguishable to the route, so what runs is the production code path with the network removed.
 *
 * `seatSummaries` is deliberately *not* replaced: the seat count that reaches Stripe is read from the
 * real roster, and stubbing it would skip the rule that decides the bill.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;

const OWNER = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const OWNER_MEMBERSHIP = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const MANAGER = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const MANAGER_MEMBERSHIP = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const SUBSCRIPTION_ROW = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';

const T0: Instant = instantFromIso('2026-08-05T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));
const gateway = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

/**
 * Everything in `billing-source` except the gateway constructor.
 *
 * `importActual` keeps `seatSummaries`, `buildBillingView` and `notifyDunning` real; only the one
 * function that would open a socket is replaced. A blanket mock would have made the seat-count rule
 * untested, which is the rule the whole refusal depends on.
 */
vi.mock('../lib/billing-source', async (importActual) => {
  // Widened rather than typed with an inline `import()`, which `consistent-type-imports` forbids
  // repo-wide. The spread is what matters here, and it is exact whatever the static type says.
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, gatewayFor: () => gateway.current };
});

const sessions: Record<'owner' | 'manager', string> = { owner: '', manager: '' };

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-billing-routes',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  for (const [id, email, name] of [
    [OWNER, 'owner@example.com', 'An Owner'],
    [MANAGER, 'priya@example.com', 'Priya Raman'],
  ] as const) {
    await scoped()
      .insertInto(users, {
        id,
        email,
        displayName: name,
        passwordHash: null,
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  for (const [id, userId, role] of [
    [OWNER_MEMBERSHIP, OWNER, 'owner'],
    [MANAGER_MEMBERSHIP, MANAGER, 'manager'],
  ] as const) {
    await scoped()
      .insertInto(memberships, {
        id,
        userId,
        role,
        status: 'active',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  sessions.owner = (await startSession({ scoped: scoped(), userId: OWNER, now: edgeNow() })).secret;
  sessions.manager = (await startSession({ scoped: scoped(), userId: MANAGER, now: edgeNow() })).secret;
}, 120_000);

afterAll(async () => {
  await database?.close();
});

/**
 * A configured deployment, restored before every test.
 *
 * `resolveBillingConfig` reads the environment *inside* the call, which is what makes this possible at
 * all — a module-scope read would have been captured at import and no test could change it.
 */
beforeEach(() => {
  /**
   * `COMPASS_BASE_URL`, because checkout builds Stripe's return URLs with `baseUrlFor`.
   *
   * That helper refuses to guess an origin from the request — the reset endpoint is public, so a caller
   * who could choose the host would choose where somebody else's token pointed — and answers 503 when
   * it is unset off loopback. Without this stub the tests below got that 503 rather than the one they
   * were about, which is the helper working correctly.
   */
  vi.stubEnv('COMPASS_BASE_URL', 'https://compass.example.com');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_routes');
  vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter');
  vi.stubEnv('STRIPE_PRICE_TEAM', 'price_team');
  vi.stubEnv('STRIPE_PRICE_BUSINESS', 'price_business');
  gateway.current = new FakeBillingGateway();
});

const asFake = (): FakeBillingGateway => gateway.current as FakeBillingGateway;

const formPost = (path: string, fields: Record<string, string>, session = sessions.owner): Request =>
  new Request(`https://compass.example.com${path}`, {
    method: 'POST',
    headers: {
      // Exactly what a browser sends for `<form method="post">` with no `enctype`.
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
    },
    body: new URLSearchParams(fields).toString(),
  });

const jsonPost = (path: string, body: unknown, session = sessions.owner): Request =>
  new Request(`https://compass.example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
    },
    body: JSON.stringify(body),
  });

/** Puts the organization on an active subscription, which is what a plan change needs. */
const giveSubscription = async (): Promise<void> => {
  await upsertBillingSubscription(
    scoped(),
    {
      id: SUBSCRIPTION_ROW,
      write: {
        status: 'active',
        planId: 'team',
        seatAllowance: 8,
        stripeCustomerId: 'cus_routes',
        stripeSubscriptionId: 'sub_routes',
        currentPeriodEndsAt: instantFromIso('2026-09-01T00:00:00Z'),
      },
    },
    T0,
  );
};

const clearSubscription = async (): Promise<void> => {
  await scoped().deleteFrom(organizationSubscriptions).execute();
};

// ---------------------------------------------------------------------------
// Checkout, from a form
// ---------------------------------------------------------------------------

describe('a form-encoded POST to /api/billing/checkout', () => {
  beforeEach(clearSubscription);

  it('answers 303 with Stripe’s session URL, so the browser navigates there', async () => {
    const { POST } = await import('../app/api/billing/checkout/route');
    const response = await POST(formPost('/api/billing/checkout', { planId: 'team' }));

    /**
     * The whole defect this pins.
     *
     * The route read the body with `readJsonObject`, which calls `request.json()` and therefore
     * answered a real form submission with a 400; and on success it returned a 200 JSON body, which
     * would have left the owner looking at `{"url": "..."}` instead of Stripe. 303 specifically:
     * it is what tells the browser to follow with GET.
     */
    expect(response.status).toBe(303);
    // The fake's first session URL, so the assertion is against where the browser is actually sent.
    expect(response.headers.get('location')).toBe('https://checkout.stripe.test/session/1');
    expect(asFake().checkouts).toHaveLength(1);
  });

  it('sends the seat count read from the real roster, not from the request', async () => {
    const { POST } = await import('../app/api/billing/checkout/route');
    // A caller trying to buy one seat for a two-seat organization.
    await POST(formPost('/api/billing/checkout', { planId: 'team', seats: '1' }));

    const [checkout] = asFake().checkouts;
    // Two active seats exist in the fixture, and that is what Stripe is asked for.
    expect(checkout?.seats).toBe(2);
    expect(checkout?.planId).toBe('team');
    expect(checkout?.priceId).toBe('price_team');
  });

  it('still answers JSON to a JSON caller', async () => {
    const { POST } = await import('../app/api/billing/checkout/route');
    const response = await POST(jsonPost('/api/billing/checkout', { planId: 'starter' }));

    // A `fetch` caller would be broken by a redirect to a third-party payment page.
    expect(response.status).toBe(200);
    expect(((await response.json()) as { url: string }).url).toContain('checkout.stripe.test');
  });

  it('refuses a plan that is not a Compass plan', async () => {
    const { POST } = await import('../app/api/billing/checkout/route');
    const response = await POST(formPost('/api/billing/checkout', { planId: 'enterprise' }));

    expect(response.status).toBe(400);
    expect(asFake().checkouts).toHaveLength(0);
  });

  it('refuses a manager, because billing is the owner’s', async () => {
    const { POST } = await import('../app/api/billing/checkout/route');
    const response = await POST(
      formPost('/api/billing/checkout', { planId: 'team' }, sessions.manager),
    );

    expect(response.status).toBe(403);
    expect(asFake().checkouts).toHaveLength(0);
  });

  it('answers 503 with the stated sentence when no key is configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const { POST } = await import('../app/api/billing/checkout/route');
    const response = await POST(formPost('/api/billing/checkout', { planId: 'team' }));

    // Criterion 004: never a crash, always the sentence.
    expect(response.status).toBe(503);
    expect(((await response.json()) as { detail: string }).detail).toContain(
      'Billing is not configured',
    );
  });
});

// ---------------------------------------------------------------------------
// A plan change goes to the plan route and prorates
// ---------------------------------------------------------------------------

describe('a form-encoded POST to /api/billing/plan', () => {
  beforeEach(async () => {
    await clearSubscription();
    await giveSubscription();
  });

  it('changes the plan through the gateway and redirects back to /billing', async () => {
    const { POST } = await import('../app/api/billing/plan/route');
    const response = await POST(formPost('/api/billing/plan', { planId: 'business' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://compass.example.com/billing?planChange=complete',
    );

    // The prorated change, against the existing subscription — not a second checkout session.
    const [change] = asFake().planChanges;
    expect(change?.subscriptionId).toBe('sub_routes');
    expect(change?.planId).toBe('business');
    expect(asFake().checkouts, 'a plan change must not open a checkout session').toHaveLength(0);

    // And the local row reflects it, so the page the owner lands on reads the new plan.
    expect((await findBillingSubscription(scoped()))?.planId).toBe('business');
  });

  it('refuses when there is no subscription to change', async () => {
    await clearSubscription();
    const { POST } = await import('../app/api/billing/plan/route');
    const response = await POST(formPost('/api/billing/plan', { planId: 'business' }));

    // A plan change and a first purchase are different acts with different consent.
    expect(response.status).toBe(409);
    expect(asFake().planChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The dunning email — the half of criterion 002 that was missing
// ---------------------------------------------------------------------------

/**
 * `applyEvent` produced `notifyDunning: true` and nothing consumed it, so a failed payment persisted a
 * deadline and the owner was never told. These assert the consumer, and specifically the two properties
 * that make it usable rather than merely present: it reaches the owners, and it does not repeat.
 */
describe('when a payment fails, the owner is emailed', () => {
  beforeEach(async () => {
    await clearSubscription();
    await upsertBillingSubscription(
      scoped(),
      {
        id: SUBSCRIPTION_ROW,
        write: {
          status: 'past_due',
          planId: 'team',
          seatAllowance: 8,
          stripeCustomerId: 'cus_routes',
          stripeSubscriptionId: 'sub_routes',
          dunningStartedAt: T0,
          dunningDeadlineAt: instantFromIso('2026-08-12T09:00:00Z'),
        },
      },
      T0,
    );
  });

  it('mails every active owner, naming the deadline and where to fix it', async () => {
    const { notifyDunning } = await import('../lib/billing-source');
    const mailbox = new RecordingMailer();

    const sent = await notifyDunning({
      scoped: scoped(),
      now: T0,
      billingUrl: 'https://compass.example.com/billing',
      mailer: mailbox,
    });

    // The owner, and only the owner: a manager cannot act on a payment method.
    expect(sent).toEqual(['owner@example.com']);

    const [message] = mailbox.sent;
    expect(message?.purpose).toBe('dunning_notice');
    expect(message?.subject).toContain('Payment failed');
    // The same deadline the in-app banner states, from the same stored instant.
    expect(message?.body).toContain('2026-08-12');
    // And where to go — behind the session the owner already has, carrying no token.
    expect(message?.link).toBe('https://compass.example.com/billing');
    expect(message?.body).not.toMatch(/token|sk_test_/);
  });

  it('says what actually happens, rather than threatening more than is true', async () => {
    const { notifyDunning } = await import('../lib/billing-source');
    const mailbox = new RecordingMailer();
    await notifyDunning({
      scoped: scoped(),
      now: T0,
      billingUrl: 'https://compass.example.com/billing',
      mailer: mailbox,
    });

    // Access is not cut on the first decline — a card expires far more often than a customer leaves.
    expect(mailbox.sent[0]?.body).toContain('still generating and delivering');
    expect(mailbox.sent[0]?.body).toContain('stays readable');
  });

  it('sends once per window, however many times Stripe retries', async () => {
    const { notifyDunning } = await import('../lib/billing-source');

    const first = new RecordingMailer();
    await notifyDunning({ scoped: scoped(), now: T0, billingUrl: 'https://x.test/billing', mailer: first });
    expect(first.sent).toHaveLength(1);

    // Stripe retries a failed invoice several times, and each retry is another
    // `invoice.payment_failed`. An owner who got four identical emails would filter the fifth.
    const second = new RecordingMailer();
    await notifyDunning({ scoped: scoped(), now: T0, billingUrl: 'https://x.test/billing', mailer: second });
    expect(second.sent).toHaveLength(0);

    // The mark is on the record, which is what made the second call quiet.
    expect((await findBillingSubscription(scoped()))?.dunningNotifiedAt).not.toBeNull();
  });

  it('notifies again after a recovery, because that is a new window', async () => {
    const { notifyDunning } = await import('../lib/billing-source');
    await notifyDunning({
      scoped: scoped(),
      now: T0,
      billingUrl: 'https://x.test/billing',
      mailer: new RecordingMailer(),
    });

    /**
     * A paid invoice clears the window, and the webhook clears `dunningNotifiedAt` with it.
     *
     * If the mark outlived the window, a *second* genuine failure months later would find it set and
     * send nothing — and the owner would never hear about the payment that actually stopped their
     * reports. This is that pairing, asserted.
     */
    await upsertBillingSubscription(
      scoped(),
      {
        id: SUBSCRIPTION_ROW,
        write: { status: 'active', dunningStartedAt: null, dunningDeadlineAt: null, dunningNotifiedAt: null },
      },
      T0,
    );
    await upsertBillingSubscription(
      scoped(),
      { id: SUBSCRIPTION_ROW, write: { status: 'past_due', dunningStartedAt: T0 } },
      T0,
    );

    const later = new RecordingMailer();
    await notifyDunning({ scoped: scoped(), now: T0, billingUrl: 'https://x.test/billing', mailer: later });
    expect(later.sent).toHaveLength(1);
  });

  it('never fails the caller when the transport is broken', async () => {
    const { notifyDunning } = await import('../lib/billing-source');
    const broken = {
      send: () => Promise.reject(new Error('the mail transport is down')),
    };

    // A 500 from the webhook would make Stripe redeliver an event whose state change already committed.
    await expect(
      notifyDunning({
        scoped: scoped(),
        now: T0,
        billingUrl: 'https://x.test/billing',
        mailer: broken,
      }),
    ).resolves.toEqual([]);

    // And the window is left un-notified, so a later retry tries again rather than swallowing the one
    // email that mattered.
    expect((await findBillingSubscription(scoped()))?.dunningNotifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('a form-encoded POST to /api/billing/cancel', () => {
  beforeEach(async () => {
    await clearSubscription();
    await giveSubscription();
  });

  it('cancels at period end and lands the owner back on the billing page', async () => {
    const { POST } = await import('../app/api/billing/cancel/route');
    const response = await POST(formPost('/api/billing/cancel', {}));

    // Not a JSON document: the one moment somebody most wants reassurance about what they just did.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://compass.example.com/billing?cancelled=1');

    expect(asFake().cancellations).toEqual(['sub_routes']);
    // `canceling`, so `billingState` keeps access until the period end and restricts after it.
    expect((await findBillingSubscription(scoped()))?.status).toBe('canceling');
  });

  it('answers JSON to a JSON caller', async () => {
    const { POST } = await import('../app/api/billing/cancel/route');
    const response = await POST(jsonPost('/api/billing/cancel', {}));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe('canceling');
  });
});
