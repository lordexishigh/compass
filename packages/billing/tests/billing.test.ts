import {
  DUNNING_GRACE_DAYS,
  NOT_CONFIGURED_STATEMENT,
  PLANS,
  PLAN_IDS,
  READ_ONLY_FORBIDS,
  READ_ONLY_PERMITS,
  STRIPE_ENV_VARS,
  TRIAL_DAYS,
  applyEvent,
  billingModeView,
  billingState,
  dunningDeadlineFrom,
  formatPence,
  formatSeatPrice,
  isDowngrade,
  isUpgrade,
  mayGenerateReports,
  modeForKey,
  monthlyTotalPence,
  parseEventEnvelope,
  parseStripeSignature,
  planById,
  planChangeVerdict,
  resolveBillingConfig,
  StripeGateway,
  trialEndFrom,
  verifyStripeWebhook,
  type SeatSummary,
  type SubscriptionFacts,
} from '@compass/billing';
import { stripeEventBody, stripeSignatureHeader } from '@compass/billing/testkit';
import {
  addExactDays,
  addHours,
  instantFromEpochMillis,
  instantFromIso,
  toEpochMillis,
  type Instant,
} from '@compass/clock';
import { describe, expect, it } from 'vitest';

/**
 * The billing rules, tested against literal facts and an instant.
 *
 * Everything in `@compass/billing` is pure — no database, no network, no clock read — which is what
 * lets a fourteen-day trial expiry be asserted without waiting fourteen days, and a webhook signature
 * be asserted without a Stripe account. The route-level and worker-level behaviour is tested in
 * `apps/web/tests/billing.test.tsx` and `apps/worker/tests/billing.test.ts`.
 */

const NOW = instantFromIso('2026-08-05T09:00:00Z');
const ORG = '11111111-1111-4111-8111-111111111111';

const facts = (overrides: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: 'active',
  planId: 'team',
  seatAllowance: 8,
  trialEndsAt: null,
  currentPeriodEndsAt: instantFromIso('2026-09-01T00:00:00Z'),
  dunningStartedAt: null,
  ...overrides,
});

const seat = (overrides: Partial<SeatSummary> = {}): SeatSummary => ({
  membershipId: 'm-1',
  email: 'someone@example.com',
  displayName: 'Someone',
  role: 'member',
  status: 'active',
  invitedAtMillis: Date.parse('2026-07-01T00:00:00Z'),
  ...overrides,
});

// ---------------------------------------------------------------------------
// 001 — plans and pricing live in one module
// ---------------------------------------------------------------------------

describe('the plan and seat-price definitions are one module', () => {
  it('declares every plan with a seat price, a name and a summary', () => {
    expect(PLANS.map((plan) => plan.id)).toEqual([...PLAN_IDS]);

    for (const plan of PLANS) {
      expect(plan.seatPricePence, `${plan.id} has no seat price`).toBeGreaterThan(0);
      // Minor units, so nothing here can hold a fractional penny.
      expect(Number.isInteger(plan.seatPricePence)).toBe(true);
      expect(plan.name.length).toBeGreaterThan(0);
      expect(plan.summary.length).toBeGreaterThan(0);
      expect(plan.includes.length).toBeGreaterThan(0);
      // The price *id* is configuration; the price is a product decision. Both are named here.
      expect(plan.priceIdEnvVar).toMatch(/^STRIPE_PRICE_/);
    }
  });

  it('orders plans cheapest first, so "upgrade" is a comparison rather than a table', () => {
    const prices = PLANS.map((plan) => plan.seatPricePence);
    expect(prices).toEqual([...prices].sort((left, right) => left - right));

    expect(isUpgrade('starter', 'business')).toBe(true);
    expect(isDowngrade('business', 'starter')).toBe(true);
    expect(isUpgrade('team', 'team')).toBe(false);
  });

  it('multiplies seats by the plan price, in pence', () => {
    expect(monthlyTotalPence('team', 8)).toBe(planById('team').seatPricePence * 8);
    // No seats is no charge, not a negative one.
    expect(monthlyTotalPence('team', 0)).toBe(0);
    expect(monthlyTotalPence('team', -3)).toBe(0);
  });

  it('formats money for a human without inventing a decimal point', () => {
    // Whole pounds print clean; a non-round amount keeps its pence.
    expect(formatPence(1200)).toBe('£12');
    expect(formatPence(1250)).toBe('£12.50');
    expect(formatSeatPrice('team')).toBe('£12 per seat / month');
  });
});

// ---------------------------------------------------------------------------
// 004 — graceful degradation with no key
// ---------------------------------------------------------------------------

describe('with no STRIPE_SECRET_KEY', () => {
  it('reports not-configured rather than throwing', () => {
    const config = resolveBillingConfig({});

    expect(config.configured).toBe(false);
    if (config.configured) throw new Error('unreachable');
    expect(config.missingEnvVar).toBe('STRIPE_SECRET_KEY');
    expect(config.statement).toBe(NOT_CONFIGURED_STATEMENT);
  });

  it('states that everything else still works, because that is the criterion', () => {
    // The sentence a billing screen shows has to say what is *not* broken, or an operator reads it
    // as an outage.
    expect(NOT_CONFIGURED_STATEMENT).toContain('Billing is not configured');
    expect(NOT_CONFIGURED_STATEMENT).toMatch(/report, delivery and configuration screen works/);
    expect(NOT_CONFIGURED_STATEMENT).toContain('STRIPE_SECRET_KEY');
  });

  it('gives the page a view with no mode, no purchasable plans and no secret', () => {
    const view = billingModeView(resolveBillingConfig({}));

    expect(view.configured).toBe(false);
    expect(view.mode).toBeNull();
    expect(view.purchasablePlanIds).toEqual([]);
    expect(view.webhooksVerifiable).toBe(false);
    // Nothing in the view is a credential — it is safe to serialise into a page.
    expect(JSON.stringify(view)).not.toMatch(/sk_(test|live)_/);
  });

  it('treats a blank or whitespace key as absent rather than as a key', () => {
    expect(resolveBillingConfig({ STRIPE_SECRET_KEY: '' }).configured).toBe(false);
    expect(resolveBillingConfig({ STRIPE_SECRET_KEY: '   ' }).configured).toBe(false);
  });

  it('documents every Stripe variable it reads', () => {
    // The list `.env.example` and the docs gate are checked against.
    expect([...STRIPE_ENV_VARS]).toEqual([
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_STARTER',
      'STRIPE_PRICE_TEAM',
      'STRIPE_PRICE_BUSINESS',
    ]);
  });
});

describe('TEST versus LIVE mode', () => {
  it('defaults to test, and only a live key says live', () => {
    expect(modeForKey('sk_test_abc')).toBe('test');
    expect(modeForKey('sk_live_abc')).toBe('live');
    expect(modeForKey('rk_live_abc')).toBe('live');
    // Ambiguous or malformed reports test. Defaulting the other way would let a typo present a test
    // deployment as one that charges real cards.
    expect(modeForKey('nonsense')).toBe('test');
  });

  it('surfaces the mode on the view the billing page reads', () => {
    const view = billingModeView(
      resolveBillingConfig({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_TEAM: 'price_t' }),
    );

    expect(view.mode).toBe('test');
    expect(view.isTestMode).toBe(true);
    // Only the plan with a configured price id can be bought.
    expect(view.purchasablePlanIds).toEqual(['team']);
  });

  it('separates "cannot verify webhooks" from "billing is off"', () => {
    // A deployment can charge while its webhook secret is unset. Folding the two together would
    // hide the whole billing UI from an org that has a working checkout.
    const config = resolveBillingConfig({ STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(config.configured).toBe(true);
    expect(billingModeView(config).webhooksVerifiable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 002 — trials, expiry and dunning
// ---------------------------------------------------------------------------

describe('a trial', () => {
  it('runs for the documented number of days', () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(trialEndFrom(NOW)).toBe(addExactDays(NOW, 14));
  });

  it('keeps full access while it is running, and says how long is left', () => {
    const state = billingState(
      facts({ status: 'trialing', trialEndsAt: addExactDays(NOW, 3) }),
      NOW,
    );

    expect(state.entitlement).toBe('full');
    expect(state.inTrial).toBe(true);
    expect(state.daysRemaining).toBe(3);
    expect(state.notice).toContain('trial ends in 3 days');
  });

  it('restricts to read-only the instant it expires, and explains both halves', () => {
    const trialEndsAt = instantFromIso('2026-08-05T09:00:00Z');
    const state = billingState(facts({ status: 'trialing', trialEndsAt }), NOW);

    expect(state.entitlement).toBe('read_only');
    expect(state.trialExpired).toBe(true);
    // What is limited...
    expect(state.notice).toContain('stopped generating new reports');
    // ...and how to restore it. A restriction with no remedy is the confident polish this refuses.
    expect(state.notice).toContain('Add a payment method');
    // ...and what is *not* lost, so the reader does not think their history is gone.
    expect(state.notice).toContain('stays readable');
  });

  it('is restricted with no job having run, because entitlement is derived', () => {
    // The point of deriving rather than storing: nothing had to flip a flag at midnight.
    const expired = facts({ status: 'trialing', trialEndsAt: instantFromIso('2026-08-01T00:00:00Z') });
    expect(mayGenerateReports(expired, NOW)).toBe(false);
  });

  it('treats a trial with no end instant as running rather than lapsed', () => {
    // The failure direction for "we cannot tell" must not be to lock a paying customer out.
    const state = billingState(facts({ status: 'trialing', trialEndsAt: null }), NOW);
    expect(state.entitlement).toBe('full');
  });
});

describe('dunning', () => {
  it('keeps access until the deadline and states it', () => {
    const state = billingState(facts({ status: 'past_due', dunningStartedAt: NOW }), NOW);

    expect(state.entitlement).toBe('full');
    expect(state.deadline).toBe(dunningDeadlineFrom(NOW));
    expect(state.notice).toContain('A payment failed');
    expect(state.notice).toContain(`within ${DUNNING_GRACE_DAYS} days`);
  });

  it('does not cut access on the first decline', () => {
    // A card expires far more often than a customer leaves.
    const justFailed = facts({ status: 'past_due', dunningStartedAt: NOW });
    expect(mayGenerateReports(justFailed, addHours(NOW, 1))).toBe(true);
  });

  it('restricts once the grace period has passed', () => {
    const startedAt = instantFromIso('2026-07-20T09:00:00Z');
    const state = billingState(facts({ status: 'past_due', dunningStartedAt: startedAt }), NOW);

    expect(state.entitlement).toBe('read_only');
    expect(state.notice).toContain('grace period has passed');
    expect(state.notice).toContain('Update the payment method');
  });

  it('freezes the deadline seven days from the failure', () => {
    expect(dunningDeadlineFrom(NOW)).toBe(addExactDays(NOW, DUNNING_GRACE_DAYS));
    expect(DUNNING_GRACE_DAYS).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 003 — cancellation, and the downgrade that is refused
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('retains access to the end of the paid period', () => {
    const periodEnd = instantFromIso('2026-08-20T00:00:00Z');
    const state = billingState(
      facts({ status: 'canceling', currentPeriodEndsAt: periodEnd }),
      NOW,
    );

    expect(state.entitlement).toBe('full');
    expect(state.notice).toContain('will not renew');
    // Whole days, floored: 09:00 on the 5th to midnight on the 20th is 14 days and 15 hours, and
    // telling a manager "15 days" when the last one is a part-day would overstate what they have.
    expect(state.daysRemaining).toBe(14);
    expect(state.notice).toContain('14 more days');
  });

  it('applies the same restricted state once that period ends', () => {
    const periodEnd = instantFromIso('2026-08-01T00:00:00Z');
    const state = billingState(
      facts({ status: 'canceling', currentPeriodEndsAt: periodEnd }),
      NOW,
    );

    expect(state.entitlement).toBe('read_only');
    // The status reads as fully cancelled once the period is over, not as still cancelling.
    expect(state.status).toBe('canceled');
    expect(state.notice).toContain('Choose a plan to start again');
  });

  it('documents one restricted state, shared by expiry and cancellation', () => {
    const afterTrial = billingState(
      facts({ status: 'trialing', trialEndsAt: instantFromIso('2026-08-01T00:00:00Z') }),
      NOW,
    );
    const afterCancel = billingState(facts({ status: 'canceled' }), NOW);

    // Same entitlement, because a manager in either case needs the same thing: their history, and a
    // way to pay.
    expect(afterTrial.entitlement).toBe(afterCancel.entitlement);
    expect(READ_ONLY_PERMITS.length).toBeGreaterThan(0);
    expect(READ_ONLY_FORBIDS.length).toBeGreaterThan(0);
    // The reading surface is never what is taken away.
    expect(READ_ONLY_PERMITS.join(' ')).toMatch(/Read every report/);
    expect(READ_ONLY_FORBIDS.join(' ')).toMatch(/Generating a new daily report/);
  });
});

describe('a downgrade below the current seat count', () => {
  const twelveSeats = Array.from({ length: 12 }, (_unused, index) =>
    seat({ membershipId: `m-${index}`, email: `dev${index}@example.com` }),
  );

  it('is blocked, and names how many seats must go', () => {
    // Starter covers 8; the org has 12.
    const verdict = planChangeVerdict({ targetPlanId: 'starter', seats: twelveSeats });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.excessSeats).toBe(4);
    expect(verdict.reason).toContain('Starter covers 8 seats and this organization has 12');
    expect(verdict.reason).toContain('Remove 4 seats');
  });

  it('names the seats themselves, not just a number', () => {
    const verdict = planChangeVerdict({ targetPlanId: 'starter', seats: twelveSeats });
    if (verdict.allowed) throw new Error('unreachable');

    expect(verdict.suggestedRemovals).toHaveLength(4);
    // The email is in the sentence, so an owner can act on it without cross-referencing a table.
    expect(verdict.reason).toContain('@example.com');
    // And it is explicitly a suggestion, not an action taken.
    expect(verdict.reason).toContain('nothing is removed until you remove it');
  });

  it('counts pending invitations, because an invitation is a seat about to be occupied', () => {
    const eight = Array.from({ length: 8 }, (_unused, index) =>
      seat({ membershipId: `a-${index}`, status: index < 6 ? 'active' : 'pending' }),
    );
    // Eight billable seats exactly fits Starter.
    expect(planChangeVerdict({ targetPlanId: 'starter', seats: eight }).allowed).toBe(true);

    const nine = [...eight, seat({ membershipId: 'a-9', status: 'pending' })];
    expect(planChangeVerdict({ targetPlanId: 'starter', seats: nine }).allowed).toBe(false);
  });

  it('ignores revoked seats, because that is what revoking is', () => {
    const many = [
      ...Array.from({ length: 8 }, (_unused, index) => seat({ membershipId: `b-${index}` })),
      ...Array.from({ length: 5 }, (_unused, index) =>
        seat({ membershipId: `c-${index}`, status: 'revoked' }),
      ),
    ];

    expect(planChangeVerdict({ targetPlanId: 'starter', seats: many }).allowed).toBe(true);
  });

  it('never suggests removing an owner', () => {
    const withOwners = [
      ...Array.from({ length: 10 }, (_unused, index) => seat({ membershipId: `d-${index}` })),
      seat({ membershipId: 'owner-1', role: 'owner', email: 'owner@example.com' }),
      seat({ membershipId: 'owner-2', role: 'owner', email: 'owner2@example.com' }),
    ];

    const verdict = planChangeVerdict({ targetPlanId: 'starter', seats: withOwners });
    if (verdict.allowed) throw new Error('unreachable');

    // Removing the last owner is refused a layer down, so suggesting one would propose an
    // impossible change.
    expect(verdict.suggestedRemovals.every((candidate) => candidate.role !== 'owner')).toBe(true);
  });

  it('suggests the least privileged and newest first', () => {
    const mixed = [
      ...Array.from({ length: 8 }, (_unused, index) => seat({ membershipId: `e-${index}` })),
      seat({
        membershipId: 'viewer-new',
        role: 'viewer',
        invitedAtMillis: Date.parse('2026-08-01T00:00:00Z'),
      }),
      seat({
        membershipId: 'manager-old',
        role: 'manager',
        invitedAtMillis: Date.parse('2026-01-01T00:00:00Z'),
      }),
    ];

    const verdict = planChangeVerdict({ targetPlanId: 'starter', seats: mixed });
    if (verdict.allowed) throw new Error('unreachable');

    expect(verdict.suggestedRemovals[0]?.membershipId).toBe('viewer-new');
  });

  it('allows an upgrade, and allows a plan with no ceiling', () => {
    expect(planChangeVerdict({ targetPlanId: 'business', seats: twelveSeats }).allowed).toBe(true);
    expect(planById('business').maxSeats).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 003 — webhook signature verification
// ---------------------------------------------------------------------------

describe('webhook signature verification', () => {
  const SECRET = 'whsec_test_secret';
  const BODY = stripeEventBody({ id: 'evt_1', type: 'invoice.paid', object: { id: 'in_1' } });

  const header = (now: Instant = NOW, rawBody = BODY) =>
    stripeSignatureHeader({ secret: SECRET, rawBody, now });

  it('accepts a correctly signed delivery', () => {
    expect(
      verifyStripeWebhook({
        rawBody: BODY,
        signatureHeader: header(),
        webhookSecret: SECRET,
        now: NOW,
      }),
    ).toBe('verified');
  });

  it('refuses a body that changed after signing', () => {
    // The signature is over the raw bytes, so a single altered character invalidates it. This is what
    // a `JSON.parse` then re-serialise would break silently.
    const tampered = BODY.replace('in_1', 'in_2');

    expect(
      verifyStripeWebhook({
        rawBody: tampered,
        signatureHeader: header(),
        webhookSecret: SECRET,
        now: NOW,
      }),
    ).toBe('bad_signature');
  });

  it('refuses a signature made with another secret', () => {
    const wrong = stripeSignatureHeader({ secret: 'whsec_other', rawBody: BODY, now: NOW });

    expect(
      verifyStripeWebhook({ rawBody: BODY, signatureHeader: wrong, webhookSecret: SECRET, now: NOW }),
    ).toBe('bad_signature');
  });

  it('refuses a replay outside the tolerance window, whatever the signature says', () => {
    // The signature never expires on its own, so a captured request would be replayable forever.
    const old = header(instantFromIso('2026-08-05T08:00:00Z'));

    expect(
      verifyStripeWebhook({ rawBody: BODY, signatureHeader: old, webhookSecret: SECRET, now: NOW }),
    ).toBe('stale_timestamp');
  });

  it('refuses a timestamp from the future too', () => {
    const ahead = header(instantFromIso('2026-08-05T10:00:00Z'));

    expect(
      verifyStripeWebhook({ rawBody: BODY, signatureHeader: ahead, webhookSecret: SECRET, now: NOW }),
    ).toBe('stale_timestamp');
  });

  it('fails closed when no signing secret is configured', () => {
    // A security control that failed open on a misconfiguration would look exactly like one working.
    expect(
      verifyStripeWebhook({
        rawBody: BODY,
        signatureHeader: header(),
        webhookSecret: null,
        now: NOW,
      }),
    ).toBe('unconfigured');
  });

  it('reports a missing or malformed header as such', () => {
    for (const candidate of [null, '', 'garbage', 't=123', 'v1=abc']) {
      const verdict = verifyStripeWebhook({
        rawBody: BODY,
        signatureHeader: candidate,
        webhookSecret: SECRET,
        now: NOW,
      });
      expect(verdict, `\`${String(candidate)}\` was not reported as malformed`).toBe(
        'malformed_signature',
      );
    }
  });

  it('accepts a rotation-era header carrying two v1 signatures', () => {
    // Stripe sends both during a signing-secret roll; a verifier reading only the first would fail
    // every delivery for the duration.
    const timestampSeconds = Math.floor(toEpochMillis(NOW) / 1000);
    const valid = stripeSignatureHeader({ secret: SECRET, rawBody: BODY, now: NOW }).split('v1=')[1];
    const both = `t=${timestampSeconds},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${valid}`;

    expect(parseStripeSignature(both)?.signatures).toHaveLength(2);
    expect(
      verifyStripeWebhook({ rawBody: BODY, signatureHeader: both, webhookSecret: SECRET, now: NOW }),
    ).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Events into state changes
// ---------------------------------------------------------------------------

describe('applying a verified event', () => {
  const envelope = (type: string, object: Record<string, unknown>) =>
    parseEventEnvelope(stripeEventBody({ id: 'evt_x', type, object }));

  it('activates the plan and records the customer on checkout completion', () => {
    const applied = applyEvent(
      envelope('checkout.session.completed', {
        id: 'cs_1',
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { compass_organization_id: ORG, compass_plan_id: 'team' },
      }),
      NOW,
    );

    expect(applied?.organizationId).toBe(ORG);
    expect(applied?.patch.status).toBe('active');
    expect(applied?.patch.planId).toBe('team');
    expect(applied?.patch.stripeCustomerId).toBe('cus_1');
    expect(applied?.patch.stripeSubscriptionId).toBe('sub_1');
  });

  it('sets the seat allowance from the subscription quantity', () => {
    const applied = applyEvent(
      envelope('customer.subscription.created', {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        current_period_end: 1_790_000_000,
        items: { data: [{ quantity: 9 }] },
        metadata: { compass_organization_id: ORG, compass_plan_id: 'team' },
      }),
      NOW,
    );

    // Criterion 001: checkout activates the plan *and* sets the seat allowance.
    expect(applied?.patch.seatAllowance).toBe(9);
    expect(applied?.patch.status).toBe('active');
  });

  it('reads cancel_at_period_end as canceling rather than active', () => {
    const applied = applyEvent(
      envelope('customer.subscription.updated', {
        id: 'sub_1',
        status: 'active',
        cancel_at_period_end: true,
        current_period_end: 1_790_000_000,
        metadata: { compass_organization_id: ORG },
      }),
      NOW,
    );

    // Stripe's status alone is not the whole truth here, which is why it is checked first.
    expect(applied?.patch.status).toBe('canceling');
  });

  it('opens a dunning window with a frozen deadline on a failed payment', () => {
    const applied = applyEvent(
      envelope('invoice.payment_failed', {
        id: 'in_1',
        subscription_details: { metadata: { compass_organization_id: ORG } },
      }),
      NOW,
    );

    expect(applied?.patch.status).toBe('past_due');
    expect(applied?.patch.dunningStartedAt).toBe(NOW);
    expect(applied?.patch.dunningDeadline).toBe(dunningDeadlineFrom(NOW));
    // And the owner is emailed — criterion 002.
    expect(applied?.patch.notifyDunning).toBe(true);
  });

  it('closes the dunning window when an invoice is paid', () => {
    const applied = applyEvent(
      envelope('invoice.paid', {
        id: 'in_1',
        subscription_details: { metadata: { compass_organization_id: ORG } },
      }),
      NOW,
    );

    expect(applied?.patch.status).toBe('active');
    // Cleared rather than left, which is how a recovered payment restores access with no second path.
    expect(applied?.patch.dunningStartedAt).toBeNull();
  });

  it('refreshes the period end from the invoice, so a renewal moves the boundary', () => {
    /**
     * The regression this pins.
     *
     * The period end used to be read from `lines.period_end`, which does not exist on a Stripe
     * invoice — `lines` is a list object whose entries are under `data`. It was therefore always
     * `undefined`, and the `?? undefined` turned that into an absent key, so a paid renewal silently
     * stopped refreshing the cancellation boundary. Nothing failed; the date just stopped moving.
     */
    const applied = applyEvent(
      envelope('invoice.paid', {
        id: 'in_1',
        period_end: 1_790_000_000,
        subscription_details: { metadata: { compass_organization_id: ORG } },
      }),
      NOW,
    );

    expect(applied?.patch.currentPeriodEndsAt).toBe(instantFromEpochMillis(1_790_000_000 * 1000));
  });

  it('falls back to the first line’s period when the invoice omits its own', () => {
    const applied = applyEvent(
      envelope('invoice.paid', {
        id: 'in_1',
        lines: { data: [{ period: { start: 1_787_000_000, end: 1_790_000_000 } }] },
        subscription_details: { metadata: { compass_organization_id: ORG } },
      }),
      NOW,
    );

    // `lines.data[0].period.end`, which is where the value actually lives.
    expect(applied?.patch.currentPeriodEndsAt).toBe(instantFromEpochMillis(1_790_000_000 * 1000));
  });

  it('ignores an event type Compass does not act on', () => {
    // Returning null rather than throwing: the route answers 200, because a non-2xx makes Stripe
    // retry an event no version of Compass will handle.
    expect(applyEvent(envelope('customer.created', { id: 'cus_1' }), NOW)).toBeNull();
  });

  it('reports no organization when the event cannot be attributed', () => {
    const applied = applyEvent(envelope('invoice.paid', { id: 'in_1' }), NOW);

    // The route records nothing in this case: there is no state change to make idempotent, and
    // `billing_events.organization_id` is NOT NULL by design.
    expect(applied?.organizationId).toBeNull();
  });

  it('refuses a body that is not a Stripe event', () => {
    expect(() => parseEventEnvelope('not json')).toThrow(/not JSON/);
    expect(() => parseEventEnvelope('{"type":"invoice.paid"}')).toThrow(/no event id/);
  });
});

describe('the Stripe subscription item id', () => {
  /**
   * `items[0][…]` without `items[0][id]` means **add an item**, not change the first one.
   *
   * Both mutating calls were broken by its absence, and only one of them failed loudly: a bare
   * `items[0][quantity]` is an item with no price, which Stripe rejects, so a seat change never
   * applied; a bare `items[0][price]` is a *valid* new item, which Stripe accepts, so the customer
   * was billed on the old price and the new one at once. These assert the id is now sent on both.
   *
   * A recording `fetch` rather than the testkit fake, because the bug is in the encoded form body —
   * the fake never builds one, so only the HTTP client can be asserted against here.
   */
  const recordingFetch = () => {
    const calls: { readonly url: string; readonly body: string }[] = [];

    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: href, body: typeof init?.body === 'string' ? init.body : '' });

      // A GET is the subscription retrieval; anything else is the update being asserted on.
      const isRetrieve = init?.method === undefined || init.method === 'GET';
      const payload = isRetrieve
        ? { id: 'sub_1', items: { data: [{ id: 'si_existing', quantity: 4 }] } }
        : { id: 'sub_1' };

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    return { calls, impl };
  };

  it('is sent alongside the quantity, so a seat change updates rather than appends', async () => {
    const { calls, impl } = recordingFetch();
    const gateway = new StripeGateway({ secretKey: 'sk_test_x', fetchImpl: impl });

    const result = await gateway.updateSeatQuantity({ subscriptionId: 'sub_1', seats: 9 });
    expect(result.ok).toBe(true);

    const update = calls.find((call) => call.body.length > 0);
    expect(update, 'no update was posted').toBeDefined();
    expect(update?.body).toContain('items%5B0%5D%5Bid%5D=si_existing');
    expect(update?.body).toContain('items%5B0%5D%5Bquantity%5D=9');
  });

  it('is sent alongside the new price, so a plan change replaces the billed item', async () => {
    const { calls, impl } = recordingFetch();
    const gateway = new StripeGateway({ secretKey: 'sk_test_x', fetchImpl: impl });

    const result = await gateway.changePlan({
      subscriptionId: 'sub_1',
      planId: 'business',
      priceId: 'price_business',
      seats: 9,
    });
    expect(result.ok).toBe(true);

    const update = calls.find((call) => call.body.length > 0);
    expect(update?.body).toContain('items%5B0%5D%5Bid%5D=si_existing');
    expect(update?.body).toContain('items%5B0%5D%5Bprice%5D=price_business');
  });

  it('reports a subscription with no line item rather than posting a malformed change', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ id: 'sub_1', items: { data: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const gateway = new StripeGateway({ secretKey: 'sk_test_x', fetchImpl: impl });
    const result = await gateway.updateSeatQuantity({ subscriptionId: 'sub_1', seats: 9 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail).toContain('no line item');
  });
});
