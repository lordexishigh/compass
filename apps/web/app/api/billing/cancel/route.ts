import { NOT_CONFIGURED_STATEMENT, resolveBillingConfig } from '@compass/billing';
import { findBillingSubscription, upsertBillingSubscription } from '@compass/db';
import { toIso } from '@compass/clock';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, isFormSubmission, jsonError, jsonOk, seeOther } from '../../../../lib/auth/http';
import { gatewayFor } from '../../../../lib/billing-source';

/**
 * `POST /api/billing/cancel` — cancel at the end of the paid period.
 *
 * Criterion 003: cancellation retains access until the end of the paid period, and then applies the
 * documented restricted state. Both halves are here, and neither needs a scheduled job:
 *
 *  - **Retained access** — Stripe is asked for `cancel_at_period_end`, not for a delete. A delete
 *    would end the subscription immediately and refund nothing, which is worse for the customer than
 *    the thing they asked for.
 *  - **The restriction afterwards** — the row's status becomes `canceling` and
 *    `billingState(facts, now)` returns `full` until `currentPeriodEndsAt` and `read_only` after it.
 *    So the boundary is arithmetic on every read rather than a job that has to fire at midnight.
 *
 * There is deliberately no "cancel immediately". An owner who wants that can stop paying and let the
 * period lapse; a button that threw away days already paid for would be a button Compass had to
 * apologise for.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/billing/cancel';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const config = resolveBillingConfig();
  if (!config.configured) return jsonError('billing_not_configured', config.statement, 503);

  try {
    const existing = await findBillingSubscription(admitted.scoped);
    if (existing === null || existing.stripeSubscriptionId === null) {
      return jsonError(
        'no_subscription',
        'This organization has no Stripe subscription, so there is nothing to cancel.',
        409,
      );
    }

    const gateway = gatewayFor();
    if (gateway === null) return jsonError('billing_not_configured', NOT_CONFIGURED_STATEMENT, 503);

    const cancelled = await gateway.cancelAtPeriodEnd({
      subscriptionId: existing.stripeSubscriptionId,
    });

    if (!cancelled.ok) {
      return jsonError(
        'cancellation_failed',
        `Stripe would not record the cancellation: ${cancelled.detail}`,
        502,
      );
    }

    /**
     * `canceling`, and the period end Stripe reported.
     *
     * Stripe's own `current_period_end` is preferred over anything Compass already held: it is the
     * authority on what has been paid for, and using a stale local value could restrict an
     * organization a day early. Falling back to the stored value when Stripe returned none keeps the
     * entitlement boundary defined rather than null.
     */
    await upsertBillingSubscription(
      admitted.scoped,
      {
        id: existing.id,
        write: {
          status: 'canceling',
          ...(cancelled.value.endsAt === null
            ? {}
            : { currentPeriodEndsAt: cancelled.value.endsAt }),
        },
      },
      admitted.now,
    );

    const endsAt = cancelled.value.endsAt ?? existing.currentPeriodEndsAt;

    /**
     * The owner lands back on the billing page, which now reads `canceling`.
     *
     * This returned only JSON, so pressing "Cancel at period end" recorded the cancellation correctly
     * and then showed the owner a raw JSON document — the one moment in the product where somebody is
     * most likely to want reassurance about what they just did, answered with a machine payload. The
     * page's own notice states the retained-access period from the row this just wrote.
     */
    if (isFormSubmission(request)) {
      return seeOther(new URL('/billing?cancelled=1', request.url).toString());
    }

    return jsonOk({
      status: 'canceling',
      endsAt: endsAt === null ? null : toIso(endsAt),
      detail:
        endsAt === null
          ? 'Cancelled. Compass keeps working to the end of the period you have paid for.'
          : `Cancelled. Compass keeps generating reports until ${toIso(endsAt)}, then keeps your ` +
            'history readable and your data exportable.',
    });
  } catch (error) {
    return failure(error);
  }
}
