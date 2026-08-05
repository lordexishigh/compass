import { NOT_CONFIGURED_STATEMENT, isPlanId, planChangeVerdict, resolveBillingConfig } from '@compass/billing';
import { findBillingSubscription, upsertBillingSubscription } from '@compass/db';
import { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import {
  failure,
  isFormSubmission,
  jsonError,
  jsonOk,
  readFormOrJsonObject,
  seeOther,
} from '../../../../lib/auth/http';
import { gatewayFor, seatSummaries } from '../../../../lib/billing-source';

/**
 * `POST /api/billing/plan` — change plan, with proration.
 *
 * ## The refusal is the interesting half
 *
 * Criterion 003: a downgrade below the current seat count is **blocked**, and the block names which
 * seats must be removed. Compass could accept the change and trim the excess itself; it must not,
 * because the seats are people and choosing which colleague loses access is the owner's decision. So
 * the request is refused with 409 and a sentence that names the count *and* the candidates, which
 * `planChangeVerdict` composes so that this route, the checkout route and the billing page's
 * disabled plan cards all give the same answer.
 *
 * ## Why the row is written here and not left to the webhook
 *
 * The webhook is the authority and will arrive with Stripe's own view moments later, so the local
 * write is optimistic rather than definitive — it exists so the page an owner is redirected back to
 * reflects the change they just made instead of showing the old plan until a callback lands. The
 * webhook's later `customer.subscription.updated` overwrites it with the truth, which is why both
 * paths go through the same `upsertBillingSubscription` and neither invents a status the other cannot
 * produce.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/billing/plan';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const config = resolveBillingConfig();
  if (!config.configured) return jsonError('billing_not_configured', config.statement, 503);

  const body = await readFormOrJsonObject(request);
  if ('response' in body) return body.response;

  const planId = body.body['planId'];
  if (typeof planId !== 'string' || !isPlanId(planId)) {
    return jsonError('invalid_request', '`planId` must be one of the Compass plans.', 400);
  }

  try {
    const existing = await findBillingSubscription(admitted.scoped);
    if (existing?.stripeSubscriptionId === null || existing?.stripeSubscriptionId === undefined) {
      // Nothing to change. Directing the caller at checkout rather than silently creating a
      // subscription: a plan change and a first purchase are different acts with different consent.
      return jsonError(
        'no_subscription',
        'This organization has no Stripe subscription yet, so there is no plan to change. Start a ' +
          'checkout from the billing page instead.',
        409,
      );
    }

    const seats = await seatSummaries(admitted.scoped);
    const verdict = planChangeVerdict({ targetPlanId: planId, seats });

    if (!verdict.allowed) {
      /**
       * A browser goes back to the page that already explains the refusal.
       *
       * `/billing` recomputes the same `planChangeVerdict` for every plan card on load, so the reason
       * and the suggested seats are already rendered beneath the plan the owner just tried — the block
       * is not a message that has to survive a redirect. Sending the browser back there is therefore
       * both simpler and more useful than a 409 JSON document, and `?planChange=blocked` names the
       * plan so the page can draw attention to that card rather than to all three.
       */
      if (isFormSubmission(request)) {
        return seeOther(new URL(`/billing?planChange=blocked&plan=${planId}`, request.url).toString());
      }

      return NextResponse.json(
        {
          error: 'seat_count_exceeds_plan',
          detail: verdict.reason,
          // Structured as well as stated, so the page can list the candidates rather than parsing a
          // sentence. Emails only — no seat is removed by this route under any circumstances.
          excessSeats: verdict.excessSeats,
          suggestedRemovals: verdict.suggestedRemovals.map((seat) => ({
            membershipId: seat.membershipId,
            email: seat.email,
            role: seat.role,
          })),
        },
        { status: 409, headers: { 'cache-control': 'no-store' } },
      );
    }

    const priceId = config.priceIds[planId];
    if (priceId === undefined) {
      return jsonError(
        'plan_not_purchasable',
        `The ${planId} plan has no Stripe price configured on this deployment.`,
        503,
      );
    }

    const gateway = gatewayFor();
    if (gateway === null) return jsonError('billing_not_configured', NOT_CONFIGURED_STATEMENT, 503);

    const changed = await gateway.changePlan({
      subscriptionId: existing.stripeSubscriptionId,
      planId,
      priceId,
      seats: verdict.seatCount,
    });

    if (!changed.ok) {
      return jsonError('plan_change_failed', `Stripe refused the change: ${changed.detail}`, 502);
    }

    /**
     * `existing.id`, with no fallback.
     *
     * This read `existing.id ?? randomUUID()`, which was unreachable and worse than merely dead: the
     * guard above returns 409 unless `existing.stripeSubscriptionId` is a string, so `existing` is a
     * row that was read from the database and its `id` is always present. A `randomUUID()` branch
     * implied a case in which changing a plan mints a *second* subscription row for the organization —
     * which the unique index on `organization_id` would then refuse. Naming a case that cannot happen
     * is how a later reader comes to believe it can.
     */
    await upsertBillingSubscription(
      admitted.scoped,
      { id: existing.id, write: { planId, seatAllowance: verdict.seatCount } },
      admitted.now,
    );

    // The browser lands back on the billing page, which now reads the changed plan.
    if (isFormSubmission(request)) {
      return seeOther(new URL('/billing?planChange=complete', request.url).toString());
    }

    return jsonOk({ planId, seats: verdict.seatCount });
  } catch (error) {
    return failure(error);
  }
}
