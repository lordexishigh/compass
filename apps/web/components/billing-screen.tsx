import type { BillingView, PlanCardView } from '../lib/billing-source';

/**
 * The billing screen: a document, not a dashboard.
 *
 * Same posture as the report and `/privacy` — one reading column, prose that has already done the
 * thinking, and receipts in mono. There are no tiles and no gauge: what an owner needs to know is
 * *which plan, how many seats, what state, and what to do next*, and each of those is a sentence.
 *
 * Colour stays rationed to the product's two meanings. Emerald marks verified positive fact (the plan
 * is active, an invoice is paid); teal marks the manager's own authorship (the plan they chose).
 * Nothing here colour-codes bad news: a failed payment is carried by weight, a rule and the
 * `stated-absence` voice, exactly as a missing source is on the report. An amber "PAST DUE" pill
 * would be the twitchy telemetry this product exists to replace.
 */

/** The one place the mode badge is rendered, so test and live cannot diverge in styling. */
function ModeBadge({ view }: { readonly view: BillingView }) {
  if (!view.mode.configured) return null;

  return (
    <span
      data-testid="billing-mode"
      data-mode={view.mode.mode}
      className="rounded-[8px] border border-rule-strong px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide text-ink-faint"
    >
      {/*
        Stated rather than implied. An owner looking at a page that says "£96 / month" has to be able
        to tell at a glance whether a real card would be charged, and `sk_test_`-derived mode is the
        only honest source for that — see `modeForKey`.
      */}
      Stripe {view.mode.mode} mode
      {view.mode.isTestMode ? ' — no real payment is taken' : ''}
    </span>
  );
}

/**
 * The not-configured state, as a first-class stated fact.
 *
 * Not a greyed-out form and not a skeleton: criterion 004 asks for the billing screens to *explain*,
 * and the explanation has to include that nothing else is affected — an operator who reads "billing
 * is not configured" and infers an outage has been told the wrong thing.
 */
function NotConfigured({ view }: { readonly view: BillingView }) {
  return (
    <section aria-labelledby="billing-unconfigured-heading" className="mt-8">
      <h2 id="billing-unconfigured-heading" className="text-[15px] font-medium text-ink-strong">
        Billing is not configured
      </h2>
      <p className="stated-absence mt-2 max-w-prose text-[14px] leading-relaxed">
        {view.mode.statement}
      </p>
      {view.mode.missingEnvVar !== null && (
        <p className="mt-2 font-mono text-[12px] text-ink-faint">
          set <span className="data-token">{view.mode.missingEnvVar}</span> to enable it
        </p>
      )}
    </section>
  );
}

/** The payment-state notice: trial countdown, dunning deadline, cancellation, restriction. */
function StateNotice({ view }: { readonly view: BillingView }) {
  if (view.state.notice === null) return null;

  const restricted = view.state.entitlement === 'read_only';

  return (
    <section
      aria-labelledby="billing-state-heading"
      data-testid="billing-notice"
      data-entitlement={view.state.entitlement}
      className="mt-6 border-l-2 border-rule-strong pl-4"
    >
      <h2 id="billing-state-heading" className="text-[13px] font-medium uppercase tracking-wide text-ink-faint">
        {restricted ? 'Compass is restricted' : 'What happens next'}
      </h2>
      <p className={`mt-2 max-w-prose text-[14px] leading-relaxed ${restricted ? 'stated-absence' : 'text-ink'}`}>
        {view.state.notice}
      </p>
      {view.dunningDeadlineIso !== null && (
        <p className="mt-1 font-mono text-[12px] tabular-nums text-ink-faint">
          deadline <span className="data-token">{view.dunningDeadlineIso}</span>
        </p>
      )}

      {/*
        What read-only actually means, listed rather than left to the reader's imagination. Criterion
        002 asks the restricted state to "explain what is limited and how to restore it", and a
        sentence alone cannot carry four permits and four prohibitions.
      */}
      {restricted && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Still available</h3>
            <ul className="mt-1 space-y-1 text-[13px] leading-relaxed text-ink">
              {view.readOnlyPermits.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Paused</h3>
            <ul className="mt-1 space-y-1 text-[13px] leading-relaxed text-ink-faint">
              {view.readOnlyForbids.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function PlanCard({ plan }: { readonly plan: PlanCardView }) {
  const unavailable = plan.blockedReason !== null || !plan.purchasable;

  return (
    <li
      data-testid="plan-card"
      data-plan={plan.id}
      data-current={plan.isCurrent ? 'true' : 'false'}
      data-blocked={plan.blockedReason === null ? 'false' : 'true'}
      className={[
        'rounded-[12px] border p-4',
        // Teal marks the manager's own authorship — the plan they chose.
        plan.isCurrent ? 'border-authored' : 'border-rule-strong',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-medium text-ink-strong">{plan.name}</h3>
        <span className="font-mono text-[12px] tabular-nums text-ink">{plan.seatPriceLabel}</span>
      </div>

      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink">{plan.summary}</p>

      <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
        {plan.maxSeatsLabel} · at your seat count, {plan.monthlyTotalLabel} / month
      </p>

      <ul className="mt-3 space-y-1 text-[13px] leading-relaxed text-ink">
        {plan.includes.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      {plan.isCurrent && (
        <p className="mt-3 font-mono text-[11px] uppercase tracking-wide text-authored-text">
          your current plan
        </p>
      )}

      {/*
        The refusal, shown *before* anybody presses anything.
        Criterion 003 requires a downgrade below the seat count to be blocked and to name the seats.
        Rendering the reason on the card means the owner reads it while deciding, rather than as a
        rebuke after submitting — and the sentence comes from `planChangeVerdict`, so this page, the
        plan route and the checkout route cannot give three different answers.
      */}
      {plan.blockedReason !== null && (
        <p data-testid="plan-blocked" className="stated-absence mt-3 max-w-prose text-[13px] leading-relaxed">
          {plan.blockedReason}
        </p>
      )}

      {!plan.purchasable && plan.blockedReason === null && !plan.isCurrent && (
        <p className="stated-absence mt-3 text-[13px] leading-relaxed">
          This plan has no Stripe price configured on this deployment, so it cannot be selected.
        </p>
      )}

      {/*
        A real form, posting to the endpoint the view resolved.
        `plan.actionPath` is `/api/billing/checkout` for a first purchase and `/api/billing/plan` for a
        change to a subscription that already exists — the component picks nothing, because which act
        this is depends on the organization's Stripe state rather than on anything the card knows. Both
        routes answer a form submission with a 303, so the browser navigates (to Stripe, or back here)
        instead of landing on a JSON document.
      */}
      {!unavailable && !plan.isCurrent && (
        <form action={plan.actionPath} method="post" className="mt-3">
          <input type="hidden" name="planId" value={plan.id} />
          <button type="submit" className="primary-action" data-testid="plan-submit" data-action={plan.actionPath}>
            {plan.actionLabel}
          </button>
        </form>
      )}
    </li>
  );
}

function Invoices({ view }: { readonly view: BillingView }) {
  return (
    <section aria-labelledby="invoices-heading" className="mt-10">
      <h2 id="invoices-heading" className="text-[15px] font-medium text-ink-strong">
        Invoices
      </h2>

      {view.invoicesUnavailable !== null ? (
        // A stated failure, never an empty table that reads as "you have no invoices".
        <p data-testid="invoices-unavailable" className="stated-absence mt-2 max-w-prose text-[13px] leading-relaxed">
          {view.invoicesUnavailable}
        </p>
      ) : view.invoices.length === 0 ? (
        <p className="stated-absence mt-2 max-w-prose text-[13px] leading-relaxed">
          {view.hasStripeCustomer
            ? 'No invoice has been issued yet. The first one arrives at the end of this billing period.'
            : 'No invoices: this organization has never been charged.'}
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <caption className="sr-only">
              Invoices for this organization, newest first, with a link to each document.
            </caption>
            <thead>
              <tr className="border-b border-rule-strong">
                <th scope="col" className="py-1 pr-4 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                  Invoice
                </th>
                <th scope="col" className="py-1 pr-4 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                  Issued
                </th>
                <th scope="col" className="py-1 pr-4 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                  Period
                </th>
                <th scope="col" className="py-1 pr-4 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                  Amount
                </th>
                <th scope="col" className="py-1 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {view.invoices.map((invoice) => (
                <tr key={invoice.id} data-testid="invoice-row" className="border-b border-rule">
                  <td className="py-1.5 pr-4">
                    {/*
                      The download link points at Stripe's own hosted document. Compass never proxies
                      invoice bytes: the URL is short-lived and account-scoped, and re-serving it
                      would make Compass a cache of somebody's billing history.
                    */}
                    {invoice.pdfUrl === null ? (
                      <span className="data-token">{invoice.number}</span>
                    ) : (
                      <a className="data-token underline decoration-rule-strong" href={invoice.pdfUrl}>
                        {invoice.number}
                        <span className="sr-only"> — download PDF</span>
                      </a>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 font-mono tabular-nums text-ink-faint">
                    {invoice.issuedLabel.slice(0, 10)}
                  </td>
                  <td className="py-1.5 pr-4 font-mono tabular-nums text-ink-faint">
                    {invoice.periodLabel ?? '—'}
                  </td>
                  <td className="py-1.5 pr-4 font-mono tabular-nums text-ink">{invoice.amountLabel}</td>
                  <td className="py-1.5 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
                    {invoice.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function BillingScreen({ view }: { readonly view: BillingView }) {
  return (
    <main id="billing" className="mx-auto max-w-[68ch] px-4 py-10">
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">Plan and billing</h1>
          <ModeBadge view={view} />
        </div>

        {view.mode.configured ? (
          <p className="mt-3 max-w-prose text-[14px] leading-relaxed text-ink">
            {view.currentPlanId === null
              ? 'This organization has no plan yet.'
              : `You are on ${view.plans.find((plan) => plan.id === view.currentPlanId)?.name ?? view.currentPlanId}.`}{' '}
            <span className="font-mono tabular-nums">{view.seatCount}</span> seats are in use
            {view.seatAllowance === null
              ? ''
              : `, of ${view.seatAllowance} paid for`}
            {view.monthlyTotalLabel === null ? '' : `, which is ${view.monthlyTotalLabel} a month`}.
          </p>
        ) : null}

        {view.overAllowance && (
          <p data-testid="over-allowance" className="stated-absence mt-2 max-w-prose text-[13px] leading-relaxed">
            More seats are in use than the plan is paid for, so the next invoice will be larger than
            the figure above. Compass states this rather than adjusting quietly.
          </p>
        )}
      </header>

      {view.mode.configured ? (
        <>
          <StateNotice view={view} />

          <section aria-labelledby="plans-heading" className="mt-10">
            <h2 id="plans-heading" className="text-[15px] font-medium text-ink-strong">
              Plans
            </h2>
            <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-faint">
              Every price is per seat, per month, and counts pending invitations — an invitation is a
              seat about to be occupied.
            </p>
            <ul className="mt-4 space-y-4">
              {view.plans.map((plan) => (
                <PlanCard key={plan.id} plan={plan} />
              ))}
            </ul>
          </section>

          <Invoices view={view} />

          {/*
            Offered only while there is something to cancel.
            `canceling` is excluded as well as `canceled`: the button used to stay live after a
            successful cancellation, and a second press would call `cancelAtPeriodEnd` again on a
            subscription already cancelled. The state notice above already says when access ends, so
            what replaces the button is the sentence a reader actually wants.
          */}
          {view.currentPlanId !== null &&
            view.state.status !== 'canceled' &&
            view.state.status !== 'canceling' && (
              <section aria-labelledby="cancel-heading" className="mt-10 border-t border-rule pt-6">
                <h2 id="cancel-heading" className="text-[15px] font-medium text-ink-strong">
                  Cancel
                </h2>
                <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink">
                  Cancelling keeps Compass working to the end of the period you have already paid for.
                  After that your reports stay readable and your data stays exportable; Compass stops
                  writing new ones.
                </p>
                <form action="/api/billing/cancel" method="post" className="mt-3">
                  <button type="submit" className="tertiary-action" data-testid="cancel-submit">
                    Cancel at period end
                  </button>
                </form>
              </section>
            )}
        </>
      ) : (
        <NotConfigured view={view} />
      )}
    </main>
  );
}
