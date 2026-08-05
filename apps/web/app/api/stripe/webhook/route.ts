import {
  MalformedEventError,
  STRIPE_SIGNATURE_HEADER,
  applyEvent,
  parseEventEnvelope,
  resolveBillingConfig,
  verifyStripeWebhook,
} from '@compass/billing';
import { applyBillingEventOnce } from '@compass/db';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { database } from '../../../../lib/database';

/**
 * `POST /api/stripe/webhook` — Stripe's subscription and invoice events.
 *
 * ## The raw body, and why nothing may consume it first
 *
 * `await request.text()` is the first thing that touches the body, and the verified bytes are the
 * bytes that get parsed. Reading it as JSON and re-serialising would hash a document Stripe never
 * sent: `JSON.parse` then `JSON.stringify` is not byte-preserving, and the failure mode is a
 * signature that mismatches for reasons nobody can see in a diff. `runtime = 'nodejs'` is required
 * too — the verification uses `node:crypto`, which the edge runtime does not provide — and
 * `dynamic = 'force-dynamic'` stops Next caching a POST route's response.
 *
 * ## Exactly one state change per event, under redelivery *and* under concurrency
 *
 * Stripe redelivers on a timeout, on a deploy, on a 500, and it redelivers events that already
 * succeeded. `applyBillingEventOnce` inserts the event id behind a UNIQUE index and applies the
 * subscription change **in the same transaction**, so the second delivery's insert conflicts and the
 * transaction commits nothing. The guarantee is in the database rather than in a check here, because
 * two simultaneous redeliveries would both pass a check.
 *
 * ## Which failures answer what
 *
 * - **Unverified** — 401, and nothing is read. With no `STRIPE_WEBHOOK_SECRET` set, *every* delivery
 *   is refused: a security control that fails open on a misconfiguration looks exactly like one that
 *   is working.
 * - **Verified but unhandled type** — 200. Stripe retries a non-2xx, and an event no version of
 *   Compass acts on would otherwise retry until it expired.
 * - **Verified but unattributable** — 200, and nothing is recorded. There is no state change to make
 *   idempotent, and `billing_events.organization_id` is NOT NULL by design: inventing a placeholder
 *   tenant to satisfy the column would file one organization's billing event inside another's
 *   isolation boundary.
 * - **A real fault applying it** — 500, deliberately, so Stripe retries something that ought to have
 *   worked.
 *
 * ## No log line carries the payload
 *
 * The `billing_events` table is the queryable record — one row per applied event, with the type, the
 * instant and a sentence — which is strictly better than a log line for "what has Stripe told us
 * about this organization". Nothing here logs the event body: an invoice object carries an address
 * and the last four digits of a card.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/stripe/webhook';

/** Accepted, and nothing more. The body says why, for an operator reading Stripe's own delivery log. */
const accepted = (detail: string, applied: boolean): NextResponse =>
  NextResponse.json({ received: true, applied, detail }, { status: 200, headers: { 'cache-control': 'no-store' } });

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const config = resolveBillingConfig();
  if (!config.configured) {
    // Billing is off. A delivery to a deployment with no Stripe key is a misrouted webhook, and
    // saying so is more useful than a 401 that implies a signature problem.
    return NextResponse.json(
      {
        error: 'billing_not_configured',
        detail: config.statement,
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  // First touch of the body, and the only one. Everything below verifies or parses *this* string.
  const rawBody = await request.text();

  const verdict = verifyStripeWebhook({
    rawBody,
    signatureHeader: request.headers.get(STRIPE_SIGNATURE_HEADER),
    webhookSecret: config.webhookSecret,
    now: admitted.now,
  });

  if (verdict !== 'verified') {
    /**
     * One response for every failure, naming none of them.
     *
     * Which check failed — a bad HMAC, a stale timestamp, a malformed header — is a tuning signal for
     * somebody probing the endpoint, so the body says only that the signature did not verify. The
     * status distinguishes the operator's own misconfiguration from a caller's bad request, because
     * that one *is* actionable and is not a signal an attacker can use.
     */
    const unconfigured = verdict === 'unconfigured';
    return NextResponse.json(
      {
        error: unconfigured ? 'webhook_secret_not_configured' : 'signature_not_verified',
        detail: unconfigured
          ? 'No STRIPE_WEBHOOK_SECRET is set, so Compass refuses every delivery rather than trusting ' +
            'a request it cannot verify. Set it to the endpoint signing secret from the Stripe dashboard.'
          : 'The Stripe signature did not verify.',
      },
      { status: unconfigured ? 503 : 401, headers: { 'cache-control': 'no-store' } },
    );
  }

  let envelope;
  try {
    envelope = parseEventEnvelope(rawBody);
  } catch (error) {
    // Verified but unreadable. 400 rather than 500: a retry cannot fix a body that is not an event,
    // and this is the one verified case where Stripe should stop trying.
    return NextResponse.json(
      {
        error: 'malformed_event',
        detail: error instanceof MalformedEventError ? error.message : 'The event could not be read.',
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const applied = applyEvent(envelope, admitted.now);
  if (applied === null) {
    return accepted(`\`${envelope.type}\` is not an event Compass acts on.`, false);
  }

  if (applied.organizationId === null) {
    return accepted(
      `\`${envelope.type}\` carried no Compass organization in its metadata, so there was nothing ` +
        'to apply it to.',
      false,
    );
  }

  try {
    const outcome = await applyBillingEventOnce(
      database(),
      {
        organizationId: applied.organizationId,
        id: randomUUID(),
        stripeEventId: envelope.id,
        stripeEventType: envelope.type,
        detail: applied.detail,
        subscriptionRowId: randomUUID(),
        write: {
          ...(applied.patch.stripeCustomerId === undefined
            ? {}
            : { stripeCustomerId: applied.patch.stripeCustomerId }),
          ...(applied.patch.stripeSubscriptionId === undefined
            ? {}
            : { stripeSubscriptionId: applied.patch.stripeSubscriptionId }),
          ...(applied.patch.status === undefined ? {} : { status: applied.patch.status }),
          ...(applied.patch.planId === undefined ? {} : { planId: applied.patch.planId }),
          ...(applied.patch.seatAllowance === undefined
            ? {}
            : { seatAllowance: applied.patch.seatAllowance }),
          ...(applied.patch.trialEndsAt === undefined ? {} : { trialEndsAt: applied.patch.trialEndsAt }),
          ...(applied.patch.currentPeriodEndsAt === undefined
            ? {}
            : { currentPeriodEndsAt: applied.patch.currentPeriodEndsAt }),
          ...(applied.patch.dunningStartedAt === undefined
            ? {}
            : { dunningStartedAt: applied.patch.dunningStartedAt }),
          ...(applied.patch.dunningDeadline === undefined
            ? {}
            : { dunningDeadlineAt: applied.patch.dunningDeadline }),
        },
      },
      admitted.now,
    );

    return accepted(
      outcome.applied
        ? applied.detail
        : `\`${envelope.id}\` had already been applied, so nothing changed.`,
      outcome.applied,
    );
  } catch (error) {
    // A genuine fault. 500 on purpose: this is the one case where a Stripe retry is the right answer.
    return NextResponse.json(
      {
        error: 'apply_failed',
        detail: `The event verified but could not be applied: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
