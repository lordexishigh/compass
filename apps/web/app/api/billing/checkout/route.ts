import {
  NOT_CONFIGURED_STATEMENT,
  TRIAL_DAYS,
  isPlanId,
  planChangeVerdict,
  resolveBillingConfig,
} from '@compass/billing';
import { findBillingSubscription } from '@compass/db';
import type { NextResponse } from 'next/server';

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
 * `POST /api/billing/checkout` — start a Stripe Checkout session.
 *
 * Owner only. The request carries a plan id and *nothing else*: the seat count is read from the
 * organization's own roster, the price id from configuration, and the amount from Stripe's price
 * object. That is the proven pattern for this stack stated as code — never trust an amount, a
 * quantity or a plan price from a request, because a caller who could choose the quantity would
 * choose one.
 *
 * The trial is granted only to an organization that has never had a subscription. Offering
 * `trial_period_days` on every checkout would let somebody cancel and re-subscribe for a fresh
 * fortnight indefinitely.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/billing/checkout';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const config = resolveBillingConfig();
  if (!config.configured) {
    // 503 with the operator-facing sentence, never a crash. Criterion 004.
    return jsonError('billing_not_configured', config.statement, 503);
  }

  // Either encoding: a form from the billing page, or JSON from a script. See `readFormOrJsonObject`.
  const body = await readFormOrJsonObject(request);
  if ('response' in body) return body.response;

  const planId = body.body['planId'];
  if (typeof planId !== 'string' || !isPlanId(planId)) {
    return jsonError(
      'invalid_request',
      '`planId` must be one of the Compass plans. They are declared in packages/billing/src/plans.ts ' +
        'and listed on /pricing.',
      400,
    );
  }

  const priceId = config.priceIds[planId];
  if (priceId === undefined) {
    return jsonError(
      'plan_not_purchasable',
      `The ${planId} plan has no Stripe price configured, so it cannot be bought on this deployment. ` +
        'Set its price id and try again.',
      503,
    );
  }

  try {
    const seats = await seatSummaries(admitted.scoped);
    const verdict = planChangeVerdict({ targetPlanId: planId, seats });
    if (!verdict.allowed) {
      // The same refusal a plan *change* gets, for the same reason: buying a plan the organization is
      // already too large for would take money for something that cannot hold its seats.
      return jsonError('seat_count_exceeds_plan', verdict.reason, 409);
    }

    const existing = await findBillingSubscription(admitted.scoped);
    const gateway = gatewayFor();
    if (gateway === null) return jsonError('billing_not_configured', NOT_CONFIGURED_STATEMENT, 503);

    /**
     * The origin Stripe returns the browser to, taken from the request — deliberately **not** through
     * `baseUrlFor`.
     *
     * `baseUrlFor` refuses to derive an origin from a request, and it is right to: it builds *mailed*
     * links, `POST /api/auth/password-reset` is public, and a caller who could choose the host would
     * choose where somebody else's single-use sign-in token pointed. Using it here made checkout 503
     * with `link_origin_unconfigured` on any deployment without `COMPASS_BASE_URL` — including the
     * zero-config one — which is a real failure and was caught by `billing-routes.test.ts`.
     *
     * A Stripe return URL is not that kind of URL, and the difference is the whole justification:
     *
     *  - the caller is an **authenticated owner**, admitted by `guard` before this line runs, not an
     *    anonymous stranger;
     *  - the URL carries **no token** — it is `/billing`, which requires the session the owner already
     *    holds;
     *  - it returns *that same browser* to the origin it is already on, so an attacker choosing the
     *    host would only be choosing their own.
     *
     * `COMPASS_BASE_URL` still wins when it is set, so a deployment behind a proxy that rewrites Host
     * gets the address its operator declared. Same precedence, and the same reasoning, as `seeOtherPath`.
     */
    const configuredOrigin = process.env['COMPASS_BASE_URL'];
    const origin =
      configuredOrigin !== undefined && configuredOrigin.length > 0
        ? configuredOrigin.replace(/\/$/, '')
        : new URL(request.url).origin;

    const session = await gateway.createCheckoutSession({
      organizationId: admitted.organizationId,
      planId,
      priceId,
      seats: verdict.seatCount,
      customerId: existing?.stripeCustomerId ?? null,
      successUrl: `${origin}/billing?checkout=complete`,
      cancelUrl: `${origin}/billing?checkout=cancelled`,
      // Only an organization that has never subscribed gets the trial. See the note above.
      trialDays: existing === null ? TRIAL_DAYS : null,
      customerEmail: admitted.identity?.user.email ?? null,
    });

    if (!session.ok) {
      return jsonError(
        'checkout_unavailable',
        `Stripe would not open a checkout session: ${session.detail}`,
        502,
      );
    }

    /**
     * A browser gets a 303 to Stripe; a JSON caller gets the URL.
     *
     * This returned only the JSON body, and the flow therefore did not work from the UI at all: the
     * billing page's plan buttons are real `<form method="post">` elements — no client JavaScript, the
     * same posture the report surfaces take — so a 200 with a `url` field left the owner looking at a
     * raw JSON document instead of Stripe Checkout. A 303 is what turns the POST into a GET
     * navigation.
     *
     * The JSON arm is kept rather than replaced. It is what the route tests assert against without a
     * browser, and it is the honest reply to a caller that asked in JSON — answering a `fetch` with a
     * redirect to a third-party payment page is a worse surprise than answering a form with JSON was.
     */
    if (isFormSubmission(request)) return seeOther(session.value.url);

    // The URL only. Nothing about the key, the mode or the price object goes back to the client.
    return jsonOk({ url: session.value.url, seats: verdict.seatCount, planId });
  } catch (error) {
    return failure(error);
  }
}
