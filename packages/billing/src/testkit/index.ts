import { instantFromEpochMillis, type Instant } from '@compass/clock';

import type {
  BillingGateway,
  CheckoutSession,
  CheckoutSessionRequest,
  GatewayResult,
  InvoiceSummary,
} from '../gateway.js';
import { signPayload } from '../webhook.js';
import type { PlanId } from '../plans.js';

/**
 * A recording billing gateway, and a helper that signs a webhook the way Stripe does.
 *
 * Same convention as `@compass/delivery`'s and `@compass/connector-port`'s testkits: the fake is
 * indistinguishable from the real gateway to everything above it, so the route under test is the
 * production code path with the network removed. It records rather than asserts — a test reads
 * `gateway.checkouts[0].seats` and makes its own claim, which keeps the fake free of opinions about
 * what a correct call looks like.
 */

export interface RecordedPlanChange {
  readonly subscriptionId: string;
  readonly planId: PlanId;
  readonly priceId: string;
  readonly seats: number;
}

export class FakeBillingGateway implements BillingGateway {
  readonly gatewayId = 'fake-stripe';

  readonly checkouts: CheckoutSessionRequest[] = [];
  readonly seatUpdates: { readonly subscriptionId: string; readonly seats: number }[] = [];
  readonly planChanges: RecordedPlanChange[] = [];
  readonly cancellations: string[] = [];

  #invoices: readonly InvoiceSummary[] = [];
  #failure: string | null = null;
  #periodEnd: Instant | null = null;

  /** Makes every subsequent call answer with a provider error instead of succeeding. */
  failWith(detail: string): this {
    this.#failure = detail;
    return this;
  }

  withInvoices(invoices: readonly InvoiceSummary[]): this {
    this.#invoices = invoices;
    return this;
  }

  withPeriodEnd(endsAt: Instant): this {
    this.#periodEnd = endsAt;
    return this;
  }

  #guard<T>(value: T): GatewayResult<T> {
    return this.#failure === null ? { ok: true, value } : { ok: false, detail: this.#failure };
  }

  async createCheckoutSession(
    request: CheckoutSessionRequest,
  ): Promise<GatewayResult<CheckoutSession>> {
    // Recorded before the failure check, so a test can assert what *would* have been sent to a
    // provider that then refused.
    this.checkouts.push(request);
    return this.#guard({
      id: `cs_test_${this.checkouts.length}`,
      url: `https://checkout.stripe.test/session/${this.checkouts.length}`,
    });
  }

  async updateSeatQuantity(input: {
    readonly subscriptionId: string;
    readonly seats: number;
  }): Promise<GatewayResult<{ readonly seats: number }>> {
    this.seatUpdates.push(input);
    return this.#guard({ seats: input.seats });
  }

  async changePlan(input: RecordedPlanChange): Promise<GatewayResult<{ readonly planId: PlanId }>> {
    this.planChanges.push(input);
    return this.#guard({ planId: input.planId });
  }

  async cancelAtPeriodEnd(input: {
    readonly subscriptionId: string;
  }): Promise<GatewayResult<{ readonly endsAt: Instant | null }>> {
    this.cancellations.push(input.subscriptionId);
    return this.#guard({ endsAt: this.#periodEnd });
  }

  async listInvoices(): Promise<GatewayResult<readonly InvoiceSummary[]>> {
    return this.#guard(this.#invoices);
  }
}

/** An invoice for a test, with sensible paid defaults. */
export function fakeInvoice(overrides: Partial<InvoiceSummary> = {}): InvoiceSummary {
  return {
    id: 'in_test_1',
    number: 'COMPASS-0001',
    status: 'paid',
    currency: 'gbp',
    amountDuePence: 9600,
    amountPaidPence: 9600,
    createdAt: instantFromEpochMillis(Date.parse('2026-07-01T00:00:00Z')),
    periodStart: instantFromEpochMillis(Date.parse('2026-07-01T00:00:00Z')),
    periodEnd: instantFromEpochMillis(Date.parse('2026-08-01T00:00:00Z')),
    pdfUrl: 'https://stripe.test/invoice/in_test_1.pdf',
    hostedUrl: 'https://stripe.test/invoice/in_test_1',
    ...overrides,
  };
}

/**
 * A correctly-signed `Stripe-Signature` header for a body.
 *
 * The point of putting this in the testkit rather than in one test file: the webhook route's test,
 * the idempotency test and the worker's dunning test all need a *valid* signature, and three
 * hand-rolled HMACs would drift. It signs with the same function the verifier checks against, which
 * is deliberate — the thing under test is the route's handling, not whether HMAC-SHA256 works.
 */
export function stripeSignatureHeader(input: {
  readonly secret: string;
  readonly rawBody: string;
  readonly now: Instant;
}): string {
  const timestampSeconds = Math.floor(
    // Instants are branded numbers of epoch millis; the testkit is allowed to do this arithmetic
    // because it is building a fixture rather than deciding anything.
    (input.now as unknown as number) / 1000,
  );
  return `t=${timestampSeconds},v1=${signPayload(input.secret, timestampSeconds, input.rawBody)}`;
}

/** A minimal Stripe event body, JSON-encoded, for the webhook tests. */
export function stripeEventBody(input: {
  readonly id: string;
  readonly type: string;
  readonly object: Readonly<Record<string, unknown>>;
  readonly livemode?: boolean;
  readonly createdSeconds?: number;
}): string {
  return JSON.stringify({
    id: input.id,
    type: input.type,
    livemode: input.livemode ?? false,
    created: input.createdSeconds ?? 1_780_000_000,
    data: { object: input.object },
  });
}
