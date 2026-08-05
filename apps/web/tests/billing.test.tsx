// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  NOT_CONFIGURED_STATEMENT,
  PLANS,
  READ_ONLY_FORBIDS,
  billingModeView,
  billingState,
  formatPence,
  planChangeVerdict,
  resolveBillingConfig,
  type SeatSummary,
} from '@compass/billing';
import { fakeInvoice } from '@compass/billing/testkit';
import { instantFromIso, toIso } from '@compass/clock';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import PricingPage from '../app/pricing/page';
import { BillingScreen } from '../components/billing-screen';
import type { BillingView } from '../lib/billing-source';

/**
 * The billing surfaces, rendered.
 *
 * `packages/billing/tests` proves the rules and `packages/db/tests/billing.test.ts` proves the
 * idempotency. This file proves the half that only exists once the components run — which is where the
 * acceptance criteria actually live: "the mode is displayed on the billing page", "invoices are listed
 * and downloadable", "billing is not configured on billing screens", "the restricted state explains
 * what is limited and how to restore it".
 *
 * A rule that is right in a view model nobody renders satisfies none of them.
 */

const NOW = instantFromIso('2026-08-05T09:00:00Z');

afterEach(() => {
  document.body.innerHTML = '';
});

const seat = (overrides: Partial<SeatSummary> = {}): SeatSummary => ({
  membershipId: 'm-1',
  email: 'dev@example.com',
  displayName: 'Dev',
  role: 'member',
  status: 'active',
  invitedAtMillis: Date.parse('2026-07-01T00:00:00Z'),
  ...overrides,
});

/** A view built the way `buildBillingView` builds one, without needing a database. */
function view(overrides: Partial<BillingView> = {}): BillingView {
  const config = resolveBillingConfig({
    STRIPE_SECRET_KEY: 'sk_test_abc',
    STRIPE_PRICE_STARTER: 'price_s',
    STRIPE_PRICE_TEAM: 'price_t',
    STRIPE_PRICE_BUSINESS: 'price_b',
  });

  return {
    mode: billingModeView(config),
    state: billingState(
      {
        status: 'active',
        planId: 'team',
        seatAllowance: 8,
        trialEndsAt: null,
        currentPeriodEndsAt: instantFromIso('2026-09-01T00:00:00Z'),
        dunningStartedAt: null,
      },
      NOW,
    ),
    seatCount: 8,
    seatAllowance: 8,
    overAllowance: false,
    plans: PLANS.map((plan) => ({
      id: plan.id,
      name: plan.name,
      summary: plan.summary,
      seatPriceLabel: `${formatPence(plan.seatPricePence)} per seat / month`,
      monthlyTotalLabel: formatPence(plan.seatPricePence * 8),
      includes: plan.includes,
      maxSeatsLabel: plan.maxSeats === null ? 'No seat ceiling' : `Up to ${plan.maxSeats} seats`,
      isCurrent: plan.id === 'team',
      purchasable: true,
      blockedReason: null,
      /**
       * The endpoint and the label the view resolves per card.
       *
       * These are required on `PlanCardView` and were missing here, which broke the suite in two ways
       * at once: `view()` no longer satisfied the interface under `gate-typecheck`, and — because React
       * drops an `undefined` attribute rather than rendering it — `<form action={plan.actionPath}>`
       * emitted no `action` at all, so the form-action assertion read `null`.
       *
       * `/api/billing/checkout` is the right default for this fixture: `buildBillingView` picks the
       * endpoint from whether Stripe already holds a subscription, and the cases that exercise the
       * has-subscription branch override it explicitly rather than inheriting it from here.
       */
      actionPath: '/api/billing/checkout',
      actionLabel: `Choose ${plan.name}`,
    })),
    currentPlanId: 'team',
    monthlyTotalLabel: formatPence(9600),
    trialEndsAtIso: null,
    periodEndsAtIso: '2026-09-01T00:00:00.000Z',
    dunningDeadlineIso: null,
    invoices: [],
    invoicesUnavailable: null,
    hasStripeCustomer: true,
    readOnlyPermits: ['Read every report Compass has already written'],
    readOnlyForbids: [...READ_ONLY_FORBIDS],
    ...overrides,
  };
}

const render = (v: BillingView): string => renderToStaticMarkup(<BillingScreen view={v} />);
const textOf = (markup: string): string => {
  document.body.innerHTML = markup;
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
};

// ---------------------------------------------------------------------------
// 004 — with no Stripe key
// ---------------------------------------------------------------------------

describe('with no STRIPE_SECRET_KEY, the billing screen explains rather than breaks', () => {
  const unconfigured = () =>
    view({ mode: billingModeView(resolveBillingConfig({})), currentPlanId: null });

  it('renders at all, which is the whole criterion', () => {
    // The failure this guards is a module-scope `new Stripe(process.env.STRIPE_SECRET_KEY!)`, which
    // throws at *import* and 500s every page that transitively reaches it.
    expect(() => render(unconfigured())).not.toThrow();
  });

  it('says billing is not configured, and names the variable to set', () => {
    const text = textOf(render(unconfigured()));

    expect(text).toContain('Billing is not configured');
    expect(text).toContain('STRIPE_SECRET_KEY');
  });

  it('states that everything else still works', () => {
    // An operator who reads "billing is not configured" and infers an outage has been told the wrong
    // thing, so the sentence has to carry what is *not* broken.
    expect(textOf(render(unconfigured()))).toContain(
      'every report, delivery and configuration screen works',
    );
    expect(NOT_CONFIGURED_STATEMENT).toContain('every report, delivery and configuration screen works');
  });

  it('offers no plan buttons and no mode badge', () => {
    document.body.innerHTML = render(unconfigured());

    // Nothing to press: a checkout form on a deployment with no provider would 503 on submit.
    expect(document.body.querySelectorAll('form')).toHaveLength(0);
    expect(document.body.querySelector('[data-testid="billing-mode"]')).toBeNull();
  });

  it('leaks no key material into the page', () => {
    const configured = render(view());
    for (const markup of [render(unconfigured()), configured]) {
      expect(markup).not.toMatch(/sk_(test|live)_/);
      expect(markup).not.toMatch(/whsec_/);
    }
  });
});

describe('the pricing page needs no Stripe key', () => {
  it('renders every plan and its seat price from the plans module', () => {
    // Criterion 001: the pricing page reads the same module checkout reads. No price is written into
    // JSX, so this assertion is against `PLANS` rather than against a literal.
    const text = textOf(renderToStaticMarkup(<PricingPage />));

    for (const plan of PLANS) {
      expect(text, `${plan.id} is missing from /pricing`).toContain(plan.name);
      expect(text, `${plan.id}'s price is missing`).toContain(formatPence(plan.seatPricePence));
    }
  });

  it('writes no price into the page source, so the numbers cannot be duplicated', () => {
    /**
     * The other half of "pricing must not duplicate numbers".
     *
     * The assertion above proves the rendered page *contains* what `PLANS` says. It would still pass if
     * somebody had typed the prices into the JSX and they happened to agree today — which is exactly the
     * state that goes wrong later, silently, when one copy is updated for a price change and the other is
     * not. A reader of `/pricing` would then be quoted a figure checkout does not charge.
     *
     * So the page *source* is scanned for the digits. `packages/billing/src/config.ts` is the
     * plan-definition module; the page's job is to read it.
     */
    const source = readFileSync(join(import.meta.dirname, '..', 'app', 'pricing', 'page.tsx'), 'utf8');

    for (const plan of PLANS) {
      /**
       * Matched as a standalone number token rather than as a substring.
       *
       * `800` is a substring of the Tailwind class `text-zinc-800` and of `max-w-[1200px]`, so a plain
       * `not.toContain` here would be a gate that fails the next time somebody restyles the page — which
       * teaches a maintainer to delete it. The boundaries keep it aimed at a literal price.
       */
      const pence = new RegExp(String.raw`(?<![\w-])${plan.seatPricePence}(?![\w-])`);
      const pounds = formatPence(plan.seatPricePence);

      expect(source, `${plan.id}'s price in pence is written into the pricing page`).not.toMatch(pence);
      expect(source, `${plan.id}'s formatted price is written into the pricing page`).not.toContain(pounds);
      expect(source, `${plan.id}'s name is hard-coded rather than read from PLANS`).not.toContain(
        `>${plan.name}<`,
      );
    }

    // And it imports the module, which is the positive form of the same claim.
    expect(source).toMatch(/from '@compass\/billing'/);
  });

  it('explains that a pending invitation counts as a seat', () => {
    // The rule that decides the bill, stated where somebody deciding to buy will read it.
    expect(textOf(renderToStaticMarkup(<PricingPage />))).toContain('pending invitation counts');
  });
});

// ---------------------------------------------------------------------------
// 001 — the mode is displayed
// ---------------------------------------------------------------------------

describe('the Stripe mode is on the billing page', () => {
  it('shows TEST mode, and says no real payment is taken', () => {
    document.body.innerHTML = render(view());

    const badge = document.body.querySelector('[data-testid="billing-mode"]');
    expect(badge, 'the billing page shows no mode badge').not.toBeNull();
    expect(badge?.getAttribute('data-mode')).toBe('test');
    expect(badge?.textContent).toContain('no real payment is taken');
  });

  it('shows LIVE mode without that reassurance', () => {
    const live = view({
      mode: billingModeView(resolveBillingConfig({ STRIPE_SECRET_KEY: 'sk_live_abc' })),
    });
    document.body.innerHTML = render(live);

    const badge = document.body.querySelector('[data-testid="billing-mode"]');
    expect(badge?.getAttribute('data-mode')).toBe('live');
    expect(badge?.textContent).not.toContain('no real payment');
  });

  it('states the seat count and what it costs', () => {
    const text = textOf(render(view()));

    expect(text).toContain('8 seats are in use');
    expect(text).toContain('of 8 paid for');
    expect(text).toContain(formatPence(9600));
  });

  it('states when more seats are in use than are paid for', () => {
    const text = textOf(render(view({ seatCount: 11, seatAllowance: 8, overAllowance: true })));

    // Stated rather than adjusted quietly: this is the condition that makes the next invoice bigger
    // than the owner expects.
    expect(text).toContain('More seats are in use than the plan is paid for');
  });
});

// ---------------------------------------------------------------------------
// 002 — trial expiry and invoices
// ---------------------------------------------------------------------------

describe('an expired trial', () => {
  const expired = () =>
    view({
      state: billingState(
        {
          status: 'trialing',
          planId: 'team',
          seatAllowance: null,
          trialEndsAt: instantFromIso('2026-08-01T00:00:00Z'),
          currentPeriodEndsAt: null,
          dunningStartedAt: null,
        },
        NOW,
      ),
    });

  it('is marked read-only on the page, not just in the view model', () => {
    document.body.innerHTML = render(expired());

    const notice = document.body.querySelector('[data-testid="billing-notice"]');
    expect(notice?.getAttribute('data-entitlement')).toBe('read_only');
    expect(notice?.textContent).toContain('Compass is restricted');
  });

  it('explains what is limited and how to restore it', () => {
    const text = textOf(render(expired()));

    // Criterion 002 asks for both halves.
    expect(text).toContain('stopped generating new reports');
    expect(text).toContain('Add a payment method');
    // And lists the restriction rather than leaving it to the reader's imagination.
    expect(text).toContain('Generating a new daily report');
    expect(text).toContain('Still available');
  });
});

describe('invoices', () => {
  it('lists each one with a download link to Stripe’s own document', () => {
    document.body.innerHTML = render(
      view({
        invoices: [
          {
            id: 'in_1',
            number: 'COMPASS-0001',
            status: 'paid',
            amountLabel: '£96',
            issuedLabel: toIso(fakeInvoice().createdAt),
            periodLabel: '2026-07-01 → 2026-08-01',
            pdfUrl: 'https://stripe.test/invoice/in_1.pdf',
            hostedUrl: 'https://stripe.test/invoice/in_1',
          },
        ],
      }),
    );

    const rows = document.body.querySelectorAll('[data-testid="invoice-row"]');
    expect(rows).toHaveLength(1);

    const link = rows[0]?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://stripe.test/invoice/in_1.pdf');
    // Named for a screen reader, since the visible text is an invoice number.
    expect(link?.textContent).toContain('download PDF');
  });

  it('states a provider failure rather than showing an empty table', () => {
    const text = textOf(
      render(view({ invoicesUnavailable: 'Compass could not reach Stripe to list your invoices: down.' })),
    );

    // An empty table would read as "you have no invoices", which is a different and false claim.
    expect(text).toContain('could not reach Stripe to list your invoices');
  });

  it('distinguishes never-charged from nothing-issued-yet', () => {
    expect(textOf(render(view({ hasStripeCustomer: false })))).toContain('never been charged');
    expect(textOf(render(view({ hasStripeCustomer: true })))).toContain('No invoice has been issued yet');
  });
});

// ---------------------------------------------------------------------------
// 003 — the blocked downgrade, on the page
// ---------------------------------------------------------------------------

describe('a plan the organization is too large for', () => {
  const twelve = Array.from({ length: 12 }, (_unused, index) =>
    seat({ membershipId: `m-${index}`, email: `dev${index}@example.com` }),
  );

  it('is shown as blocked, with the reason and the seats named, before anything is pressed', () => {
    const verdict = planChangeVerdict({ targetPlanId: 'starter', seats: twelve });
    if (verdict.allowed) throw new Error('the fixture should be over the Starter ceiling');

    document.body.innerHTML = render(
      view({
        seatCount: 12,
        plans: view().plans.map((plan) =>
          plan.id === 'starter' ? { ...plan, blockedReason: verdict.reason } : plan,
        ),
      }),
    );

    const starter = document.body.querySelector('[data-plan="starter"]');
    expect(starter?.getAttribute('data-blocked')).toBe('true');

    const blocked = starter?.querySelector('[data-testid="plan-blocked"]');
    expect(blocked?.textContent).toContain('Remove 4 seats');
    // The seats themselves, so the owner can act without cross-referencing a table.
    expect(blocked?.textContent).toContain('@example.com');
    expect(blocked?.textContent).toContain('nothing is removed until you remove it');

    // And there is no button to press: the refusal is structural, not a submit-time scolding.
    expect(starter?.querySelector('form')).toBeNull();
  });

  it('never blocks the plan the organization is already on', () => {
    // An organization that has outgrown its own plan needs to be told to upgrade, not told it cannot
    // stay where it is.
    document.body.innerHTML = render(view({ seatCount: 30 }));

    expect(
      document.body.querySelector('[data-plan="team"]')?.getAttribute('data-blocked'),
    ).toBe('false');
  });

  it('marks a plan with no configured price as unselectable, and says why', () => {
    document.body.innerHTML = render(
      view({
        plans: view().plans.map((plan) =>
          plan.id === 'business' ? { ...plan, purchasable: false } : plan,
        ),
      }),
    );

    const business = document.body.querySelector('[data-plan="business"]');
    expect(business?.textContent).toContain('no Stripe price configured');
    expect(business?.querySelector('form')).toBeNull();
  });

  it('offers a checkout form for a plan that is available', () => {
    document.body.innerHTML = render(view());

    const starter = document.body.querySelector('[data-plan="starter"] form');
    expect(starter?.getAttribute('action')).toBe('/api/billing/checkout');
    expect(starter?.getAttribute('method')).toBe('post');
    expect(starter?.querySelector('input[name="planId"]')?.getAttribute('value')).toBe('starter');
  });
});

/**
 * Which endpoint each card posts to — the defect that made `/api/billing/plan` dead code.
 *
 * Every card used to post to `/api/billing/checkout`, so an owner on Team pressing "Choose Business"
 * opened a *second* Checkout session against the same Stripe customer — two subscriptions and two
 * invoices — rather than a prorated plan change, and the plan route's 409 refusal payload had no
 * caller at all. Asserting the markup's `action` is the only way this stays fixed: both endpoints
 * exist and both return 2xx/3xx, so a wrong one is invisible without checking where the form points.
 */
describe('a plan button posts to the endpoint the act requires', () => {
  const withSubscription = () =>
    view({
      plans: view().plans.map((plan) => ({
        ...plan,
        actionPath: '/api/billing/plan',
        actionLabel: `Change to ${plan.name}`,
      })),
    });

  const withoutSubscription = () =>
    view({
      currentPlanId: null,
      hasStripeCustomer: false,
      plans: view().plans.map((plan) => ({ ...plan, isCurrent: false })),
    });

  it('posts a first purchase to checkout', () => {
    document.body.innerHTML = render(withoutSubscription());

    for (const planId of ['starter', 'team', 'business']) {
      const form = document.body.querySelector(`[data-plan="${planId}"] form`);
      expect(form?.getAttribute('action'), `${planId} posts to the wrong endpoint`).toBe(
        '/api/billing/checkout',
      );
    }
    // And the label says which act it is, before it is pressed.
    expect(textOf(render(withoutSubscription()))).toContain('Choose Business');
  });

  it('posts a change to the plan route once a subscription exists', () => {
    document.body.innerHTML = render(withSubscription());

    // `team` is the current plan and therefore has no button; the other two are changes.
    for (const planId of ['starter', 'business']) {
      const form = document.body.querySelector(`[data-plan="${planId}"] form`);
      expect(form?.getAttribute('action'), `${planId} posts to the wrong endpoint`).toBe(
        '/api/billing/plan',
      );
    }
    expect(textOf(render(withSubscription()))).toContain('Change to Business');
  });

  it('never offers a button for the plan already held', () => {
    document.body.innerHTML = render(withSubscription());
    expect(document.body.querySelector('[data-plan="team"] form')).toBeNull();
  });
});

describe('cancellation is offered while there is something to cancel', () => {
  it('shows the cancel form and says access is retained', () => {
    document.body.innerHTML = render(view());

    const form = document.body.querySelector('form[action="/api/billing/cancel"]');
    expect(form).not.toBeNull();
    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain(
      'keeps Compass working to the end of the period you have already paid for',
    );
  });

  it('offers nothing to cancel once it is already cancelling', () => {
    // The button used to stay live at `canceling`, and a second press called `cancelAtPeriodEnd` again
    // on a subscription already cancelled. The state notice above says when access ends, which is what
    // the reader actually wants in its place.
    const cancelling = view({
      state: billingState(
        {
          status: 'canceling',
          planId: 'team',
          seatAllowance: 8,
          trialEndsAt: null,
          currentPeriodEndsAt: instantFromIso('2026-09-01T00:00:00Z'),
          dunningStartedAt: null,
        },
        NOW,
      ),
    });
    document.body.innerHTML = render(cancelling);

    expect(document.body.querySelector('form[action="/api/billing/cancel"]')).toBeNull();
    // And it still says what happens, so the section does not simply vanish without explanation.
    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain('will not renew');
  });

  it('offers nothing to cancel once it is over', () => {
    const cancelled = view({
      state: billingState(
        {
          status: 'canceled',
          planId: 'team',
          seatAllowance: 8,
          trialEndsAt: null,
          currentPeriodEndsAt: instantFromIso('2026-08-01T00:00:00Z'),
          dunningStartedAt: null,
        },
        NOW,
      ),
    });
    document.body.innerHTML = render(cancelled);

    expect(document.body.querySelector('form[action="/api/billing/cancel"]')).toBeNull();
  });
});
