import { instantFromEpochMillis, type Instant } from '@compass/clock';

import { ORGANIZATION_METADATA_KEY, PLAN_METADATA_KEY } from './apply.js';
import { BILLING_CURRENCY, type PlanId } from './plans.js';

/**
 * The billing provider, as a port.
 *
 * Same shape and the same reasoning as `EmailTransport` in `@compass/delivery`: one narrow interface,
 * an HTTP implementation for production, and a recording fake in `testkit/` that is
 * indistinguishable to everything above it. The whole checkout, invoice and plan-change path is
 * therefore exercised in tests as the production code path with the network removed — no mocked
 * module, no intercepted global `fetch`.
 *
 * ## Why `fetch` and not the Stripe SDK
 *
 * Four calls. The SDK is a large dependency whose value is breadth Compass does not use, and it
 * brings its own HTTP agent and runtime assumptions into a package that otherwise depends on nothing
 * but `@compass/clock`. The REST API is stable, form-encoded and documented, and every response this
 * module reads is narrowed field by field rather than trusted wholesale. Stated as an assumption in
 * the task summary because it is a reversible decision somebody may want to revisit.
 *
 * Every method returns a discriminated result rather than throwing on a provider error: a failed
 * Stripe call must render as a sentence on the billing page, not as a 500 on it.
 */

export interface CheckoutSessionRequest {
  readonly organizationId: string;
  readonly planId: PlanId;
  /** The Stripe price id for that plan, resolved from configuration by the caller. */
  readonly priceId: string;
  /** Seats to bill for — the organization's current billable seat count. */
  readonly seats: number;
  /** An existing Stripe customer to attach to, or null to let Stripe create one. */
  readonly customerId: string | null;
  /** Where Stripe returns the owner. Absolute origins, built by the caller. */
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Days of trial to grant, or null for none. */
  readonly trialDays: number | null;
  /** The owner's address, so Stripe does not ask for something Compass already knows. */
  readonly customerEmail: string | null;
}

export interface CheckoutSession {
  readonly id: string;
  /** Where to send the browser. */
  readonly url: string;
}

export interface InvoiceSummary {
  readonly id: string;
  /** Stripe's human invoice number, e.g. `ABCD1234-0001`. Null on a draft. */
  readonly number: string | null;
  readonly status: string;
  readonly currency: string;
  readonly amountDuePence: number;
  readonly amountPaidPence: number;
  readonly createdAt: Instant;
  readonly periodStart: Instant | null;
  readonly periodEnd: Instant | null;
  /**
   * Stripe-hosted PDF. Compass never proxies invoice bytes: the link is short-lived and
   * account-scoped, and re-serving it would make Compass a cache of somebody's billing history.
   */
  readonly pdfUrl: string | null;
  readonly hostedUrl: string | null;
}

export type GatewayResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

export interface BillingGateway {
  readonly gatewayId: string;
  createCheckoutSession(request: CheckoutSessionRequest): Promise<GatewayResult<CheckoutSession>>;
  /** Change the seat quantity on an existing subscription. Stripe prorates. */
  updateSeatQuantity(input: {
    readonly subscriptionId: string;
    readonly seats: number;
  }): Promise<GatewayResult<{ readonly seats: number }>>;
  /** Move an existing subscription to another plan's price, with proration. */
  changePlan(input: {
    readonly subscriptionId: string;
    readonly planId: PlanId;
    readonly priceId: string;
    readonly seats: number;
  }): Promise<GatewayResult<{ readonly planId: PlanId }>>;
  /** Cancel at period end, so access is retained for what has been paid for. */
  cancelAtPeriodEnd(input: {
    readonly subscriptionId: string;
  }): Promise<GatewayResult<{ readonly endsAt: Instant | null }>>;
  listInvoices(input: {
    readonly customerId: string;
    readonly limit?: number;
  }): Promise<GatewayResult<readonly InvoiceSummary[]>>;
}

// ---------------------------------------------------------------------------
// The HTTP implementation
// ---------------------------------------------------------------------------

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const pence = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;

const instant = (value: unknown): Instant | null =>
  typeof value === 'number' && Number.isFinite(value) ? instantFromEpochMillis(value * 1000) : null;

/**
 * Form encoding with Stripe's bracket convention for nested fields.
 *
 * `items[0][price]=price_123`. Written out rather than taken from a library because it is six lines
 * and because the alternative — building a nested object and hoping a serialiser matches Stripe's
 * dialect — is the kind of dependency that fails on the one field that matters.
 */
export function encodeForm(fields: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  return params.toString();
}

export interface StripeGatewayOptions {
  readonly secretKey: string;
  /** Injected for tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly apiBase?: string;
}

export class StripeGateway implements BillingGateway {
  readonly gatewayId = 'stripe';
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: StripeGatewayOptions) {
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#base = options.apiBase ?? STRIPE_API_BASE;
  }

  /**
   * One POST, one narrowing, one result.
   *
   * `idempotencyKey` is passed through on every mutating call. Stripe deduplicates on it for 24
   * hours, which is what stops a double-submitted checkout form creating two subscriptions — and it
   * is derived from the identity of the *act* by the caller, never from rendered content, following
   * the same rule delivery's idempotency key follows.
   */
  async #post<T>(
    path: string,
    body: string,
    narrow: (payload: Readonly<Record<string, unknown>>) => T,
    idempotencyKey?: string,
  ): Promise<GatewayResult<T>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method: 'POST',
        headers: {
          // A Bearer token. Stripe documents both this and Basic auth with the secret as the
          // username; Bearer is the simpler of the two and needs no base64 step.
          authorization: `Bearer ${this.#secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        body,
      });
    } catch (cause) {
      return {
        ok: false,
        detail: `Stripe could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    return this.#read(response, narrow);
  }

  async #get<T>(
    path: string,
    narrow: (payload: Readonly<Record<string, unknown>>) => T,
  ): Promise<GatewayResult<T>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        headers: { authorization: `Bearer ${this.#secretKey}` },
      });
    } catch (cause) {
      return {
        ok: false,
        detail: `Stripe could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    return this.#read(response, narrow);
  }

  async #read<T>(
    response: Response,
    narrow: (payload: Readonly<Record<string, unknown>>) => T,
  ): Promise<GatewayResult<T>> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, detail: `Stripe answered ${response.status} with a body that is not JSON.` };
    }

    if (!response.ok) {
      // Stripe's own message, which is written for a developer and is the useful half of a 400.
      const message = text(asRecord(asRecord(payload)['error'])['message']);
      return {
        ok: false,
        detail: message ?? `Stripe answered ${response.status}.`,
      };
    }

    return { ok: true, value: narrow(asRecord(payload)) };
  }

  async createCheckoutSession(
    request: CheckoutSessionRequest,
  ): Promise<GatewayResult<CheckoutSession>> {
    const body = encodeForm({
      mode: 'subscription',
      'line_items[0][price]': request.priceId,
      'line_items[0][quantity]': request.seats,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      currency: BILLING_CURRENCY,
      ...(request.customerId === null
        ? { ...(request.customerEmail === null ? {} : { customer_email: request.customerEmail }) }
        : { customer: request.customerId }),
      ...(request.trialDays === null
        ? {}
        : { 'subscription_data[trial_period_days]': request.trialDays }),
      // The organization goes on the *subscription*, not only the session: every later
      // `customer.subscription.*` and invoice event has to be attributable, and Stripe does not copy
      // session metadata onto the subscription for you.
      [`metadata[${ORGANIZATION_METADATA_KEY}]`]: request.organizationId,
      [`metadata[${PLAN_METADATA_KEY}]`]: request.planId,
      [`subscription_data[metadata][${ORGANIZATION_METADATA_KEY}]`]: request.organizationId,
      [`subscription_data[metadata][${PLAN_METADATA_KEY}]`]: request.planId,
    });

    return this.#post(
      '/checkout/sessions',
      body,
      (payload) => ({
        id: text(payload['id']) ?? '',
        url: text(payload['url']) ?? '',
      }),
      // The identity of the act: this organization, this plan, this seat count. A double-submit is
      // the same act and must not create a second session.
      `compass:checkout:${request.organizationId}:${request.planId}:${request.seats}`,
    );
  }

  /**
   * The id of the subscription's existing line item.
   *
   * ## Why every mutating subscription call has to go through this first
   *
   * `items[0][…]` without `items[0][id]` does not mean "change the first item" — it means **add an
   * item**. So the two calls below were each broken in their own way and neither failed loudly:
   * a bare `items[0][quantity]` is a new item with no price, which Stripe rejects, so the seat
   * change never applied; a bare `items[0][price]` is a valid new item, which Stripe *accepts*, so
   * the customer ended up billed on the old price and the new one at once. The second is the worse
   * bug precisely because it succeeds.
   *
   * Retrieved rather than stored beside `stripe_subscription_id`. One extra GET on a rare
   * owner-initiated action is cheap, and the item id is Stripe's to change — a copy in Compass's
   * database would be a second source of truth that is wrong exactly when it matters, on a
   * subscription somebody edited in the Stripe dashboard.
   */
  async #firstItemId(subscriptionId: string): Promise<GatewayResult<string>> {
    const retrieved = await this.#get(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      (payload) => {
        const data = asRecord(payload['items'])['data'];
        return Array.isArray(data) ? text(asRecord(data[0])['id']) : null;
      },
    );

    if (!retrieved.ok) return retrieved;
    if (retrieved.value === null) {
      return {
        ok: false,
        detail:
          `Stripe subscription ${subscriptionId} has no line item, so there is nothing to change. ` +
          'This is a subscription Compass did not create, or one that has already been deleted.',
      };
    }

    return { ok: true, value: retrieved.value };
  }

  async updateSeatQuantity(input: {
    readonly subscriptionId: string;
    readonly seats: number;
  }): Promise<GatewayResult<{ readonly seats: number }>> {
    const itemId = await this.#firstItemId(input.subscriptionId);
    if (!itemId.ok) return itemId;

    const body = encodeForm({
      // The id is what makes this an update of the existing item rather than a second one.
      'items[0][id]': itemId.value,
      'items[0][quantity]': input.seats,
      // Prorate the difference and invoice it now rather than silently at the next cycle, so the
      // billing page's total and the customer's next invoice agree.
      proration_behavior: 'always_invoice',
    });

    return this.#post(
      `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      body,
      () => ({ seats: input.seats }),
      `compass:seats:${input.subscriptionId}:${input.seats}`,
    );
  }

  async changePlan(input: {
    readonly subscriptionId: string;
    readonly planId: PlanId;
    readonly priceId: string;
    readonly seats: number;
  }): Promise<GatewayResult<{ readonly planId: PlanId }>> {
    const itemId = await this.#firstItemId(input.subscriptionId);
    if (!itemId.ok) return itemId;

    const body = encodeForm({
      // Without this the new price is *appended* and the customer is billed on both.
      'items[0][id]': itemId.value,
      'items[0][price]': input.priceId,
      'items[0][quantity]': input.seats,
      proration_behavior: 'always_invoice',
      [`metadata[${PLAN_METADATA_KEY}]`]: input.planId,
    });

    return this.#post(
      `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      body,
      () => ({ planId: input.planId }),
      `compass:plan:${input.subscriptionId}:${input.planId}:${input.seats}`,
    );
  }

  async cancelAtPeriodEnd(input: {
    readonly subscriptionId: string;
  }): Promise<GatewayResult<{ readonly endsAt: Instant | null }>> {
    // `cancel_at_period_end` rather than DELETE: criterion 003 requires access to the end of the
    // paid period, and a delete would end it immediately and refund nothing.
    const body = encodeForm({ cancel_at_period_end: true });

    return this.#post(
      `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      body,
      (payload) => ({ endsAt: instant(payload['current_period_end']) }),
      `compass:cancel:${input.subscriptionId}`,
    );
  }

  async listInvoices(input: {
    readonly customerId: string;
    readonly limit?: number;
  }): Promise<GatewayResult<readonly InvoiceSummary[]>> {
    const query = new URLSearchParams({
      customer: input.customerId,
      limit: String(input.limit ?? 24),
    });

    return this.#get(`/invoices?${query.toString()}`, (payload) => {
      const data = payload['data'];
      if (!Array.isArray(data)) return [];
      return data.map((entry) => readInvoice(asRecord(entry)));
    });
  }
}

/** Exported so the fake and the HTTP client narrow an invoice identically. */
export function readInvoice(object: Readonly<Record<string, unknown>>): InvoiceSummary {
  const lines = asRecord(asRecord(object['lines'])['data']);
  const firstLine = Array.isArray(asRecord(object['lines'])['data'])
    ? asRecord((asRecord(object['lines'])['data'] as unknown[])[0])
    : lines;
  const period = asRecord(firstLine['period']);

  return {
    id: text(object['id']) ?? '',
    number: text(object['number']),
    status: text(object['status']) ?? 'unknown',
    currency: text(object['currency']) ?? BILLING_CURRENCY,
    amountDuePence: pence(object['amount_due']),
    amountPaidPence: pence(object['amount_paid']),
    createdAt: instant(object['created']) ?? instantFromEpochMillis(0),
    periodStart: instant(period['start']),
    periodEnd: instant(period['end']),
    pdfUrl: text(object['invoice_pdf']),
    hostedUrl: text(object['hosted_invoice_url']),
  };
}
