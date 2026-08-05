import { SystemClock } from '@compass/clock';
import { headers } from 'next/headers';

import { BillingScreen } from '../../components/billing-screen';
import { StatedFailure } from '../../components/stated-failure';
import { pageAccess, scopedFor } from '../../lib/auth/guard';
import { buildBillingView } from '../../lib/billing-source';

/**
 * `/billing` — the plan, the seats it covers, the payment state and the invoice history.
 *
 * Owner only, for the same reason `/privacy`'s retention controls are: this page names an amount, a
 * payment state and an invoice history, and none of that is any part of a manager's job.
 *
 * ## It renders on a deployment with no Stripe key
 *
 * That is criterion 004 and it is the reason the page is a shell over `buildBillingView`. There is no
 * conditional import and no `new Stripe(...)` anywhere in the module graph this page pulls in — the
 * gateway is constructed lazily inside `billing-source`, and with no key it is simply never
 * constructed. So the failure mode is a page that *explains*, rather than a 500 that takes the
 * navigation link down with it.
 *
 * ## Why the whole view is computed server-side
 *
 * Entitlement is `billingState(facts, now)`, and `now` comes from the request edge's clock. Computing
 * it in the browser would mean a manager whose laptop clock was wrong could read a different
 * entitlement than the pipeline enforces — and the trial countdown is exactly the number somebody
 * would notice disagreeing.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Plan and billing — Compass',
};

function Frame({ heading, children }: { readonly heading: string; readonly children: React.ReactNode }) {
  return (
    <main id="billing" className="mx-auto max-w-[68ch] px-4 py-10">
      <h1 className="text-[22px] font-medium tracking-tight text-ink-strong">{heading}</h1>
      <div className="mt-4">{children}</div>
    </main>
  );
}

export default async function BillingPage() {
  const cookieHeader = (await headers()).get('cookie');
  const access = await pageAccess({ route: '/billing', cookieHeader });

  if (access.kind === 'unavailable') {
    return (
      <Frame heading="Compass cannot reach its own records">
        <StatedFailure detail={`${access.detail} Nothing about your plan has changed.`}>
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  if (!access.allowed) {
    return (
      <Frame heading="Not yours to change">
        <StatedFailure
          detail={
            access.reason ??
            'Billing is the owner’s to manage. Your role can read every report and change what Compass ' +
              'says about your team, but not what the organization pays for.'
          }
        >
          <a href="/" className="tertiary-action">
            ← today&apos;s report
          </a>
        </StatedFailure>
      </Frame>
    );
  }

  try {
    const view = await buildBillingView({
      scoped: scopedFor(access.organizationId),
      // The one clock read on this path, at the edge, threaded down — the same arrangement every
      // other page uses.
      now: new SystemClock().now(),
    });

    return <BillingScreen view={view} />;
  } catch (error) {
    /**
     * A stated failure rather than a stack trace.
     *
     * The billing page reads the roster, the subscription row and — when configured — Stripe. The
     * invoice call already degrades to a sentence inside the view, so reaching here means the
     * database itself would not answer, which is the one condition worth showing a whole-page failure
     * for.
     */
    return (
      <Frame heading="Compass could not read your plan">
        <StatedFailure
          detail={`${
            error instanceof Error ? error.message : 'The billing record could not be read.'
          } No plan, seat count or payment method has been changed.`}
        >
          <a href="/api/health" className="tertiary-action">
            system readiness
          </a>
        </StatedFailure>
      </Frame>
    );
  }
}
