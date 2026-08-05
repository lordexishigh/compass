import { PLANS, TRIAL_DAYS, formatPence } from '@compass/billing';

/**
 * `/pricing` — the plan table, read from the same module checkout reads.
 *
 * ## Why this page imports `@compass/billing` and hard-codes nothing
 *
 * Criterion 001: "the plan and seat-price definitions live in one documented module that the pricing
 * page also reads." Every figure below comes from `PLANS`, so a price change is one edit in
 * `packages/billing/src/plans.ts` and this page follows — and the alternative, a marketing page with
 * its own copy of the numbers, is the one that eventually charges somebody a price they were not
 * shown.
 *
 * ## It needs no Stripe key
 *
 * Deliberately. The plan *prices* are constants in code because they are a product decision; only the
 * Stripe *price ids* are configuration. So this page renders identically on a deployment with billing
 * switched off, which is what makes it publishable before anybody has configured a payment provider.
 * It is public in every tenant, not only the demonstration one, because it carries no organizational
 * data at all — see the `/pricing` row in `ROLE_MATRIX`.
 */
export const metadata = {
  title: 'Pricing — Compass',
};

export default function PricingPage() {
  return (
    <main id="pricing" className="mx-auto max-w-[68ch] px-4 py-10">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">Pricing</h1>
        <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink">
          One price per seat, per month. Every plan includes the whole six-section daily report and the
          evidence chain behind every claim — the plans differ in how many teams they cover and which
          connectors they reach, never in whether the reasoning is shown.
        </p>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink-faint">
          Every plan starts with a {TRIAL_DAYS}-day trial. No card is required to begin, and Compass
          writes a report every morning of it — a fortnight is fourteen of the actual thing you are
          evaluating.
        </p>
      </header>

      <ul className="mt-8 space-y-6">
        {PLANS.map((plan) => (
          <li
            key={plan.id}
            data-testid="pricing-plan"
            data-plan={plan.id}
            className="rounded-[12px] border border-rule-strong p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[17px] font-medium text-ink-strong">{plan.name}</h2>
              <p className="font-mono text-[13px] tabular-nums text-ink">
                {/*
                  The figure and the unit together, from the plan table. `formatPence` is the only
                  place in the product that turns minor units into a decimal point.
                */}
                <span data-testid="seat-price">{formatPence(plan.seatPricePence)}</span>
                <span className="text-ink-faint"> per seat / month</span>
              </p>
            </div>

            <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">{plan.summary}</p>

            <p className="mt-2 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
              {plan.maxTeams === null ? 'Unlimited teams' : `${plan.maxTeams} team${plan.maxTeams === 1 ? '' : 's'}`}
              {' · '}
              {plan.maxSeats === null ? 'no seat ceiling' : `up to ${plan.maxSeats} seats`}
            </p>

            <ul className="mt-3 space-y-1 text-[14px] leading-relaxed text-ink">
              {plan.includes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <section aria-labelledby="seats-heading" className="mt-10 border-t border-rule pt-6">
        <h2 id="seats-heading" className="text-[15px] font-medium text-ink-strong">
          What counts as a seat
        </h2>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">
          Anybody who can sign in: owners, managers, members and viewers. A pending invitation counts
          too, because it is a seat about to be occupied — Compass would rather tell you that up front
          than let the allowance be exceeded by people arriving.
        </p>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-ink">
          Developers whose work Compass reads are <em>not</em> seats. A team of eight whose manager is
          the only reader is one seat.
        </p>
      </section>

      <p className="mt-8 text-[13px] leading-relaxed text-ink-faint">
        <a href="/billing" className="tertiary-action">
          Manage your plan
        </a>
      </p>
    </main>
  );
}
