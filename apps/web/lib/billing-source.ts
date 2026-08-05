import { readSeats } from '@compass/auth';
import {
  NO_SUBSCRIPTION,
  PLANS,
  READ_ONLY_FORBIDS,
  READ_ONLY_PERMITS,
  StripeGateway,
  billableSeatCount,
  billingModeView,
  billingState,
  formatPence,
  isSubscriptionStatus,
  isPlanId,
  monthlyTotalPence,
  planChangeVerdict,
  resolveBillingConfig,
  type BillingGateway,
  type BillingModeView,
  type BillingState,
  type InvoiceSummary,
  type PlanId,
  type SeatSummary,
  type SubscriptionFacts,
} from '@compass/billing';
import { toEpochMillis, toIso, type Instant } from '@compass/clock';
import { findBillingSubscription, type ScopedDb, type StoredBillingSubscription } from '@compass/db';

/**
 * Everything the billing surfaces read, assembled in one place.
 *
 * The rule this module keeps: **no billing screen imports Stripe, and no billing screen decides
 * policy.** The page is a shell over `BillingView`; the plan ceiling comes from
 * `@compass/billing`'s plan table, the entitlement from `billingState`, and whether billing exists at
 * all from `resolveBillingConfig`. That is what lets `/billing` render on a deployment with no
 * `STRIPE_SECRET_KEY` without a single conditional import.
 *
 * It is also why the gateway is constructed *here* and lazily: `new StripeGateway(...)` at module
 * scope in a route would run at import time and take down every page that transitively reaches it,
 * which is exactly the 500 criterion 004 forbids.
 */

/** The subscription row translated into the facts `billingState` needs. */
export function factsFrom(row: StoredBillingSubscription | null): SubscriptionFacts {
  if (row === null) return NO_SUBSCRIPTION;

  return {
    // A status the database somehow holds but the code does not model reads as `none` rather than
    // throwing: a billing page that 500s is worse than one that says there is no subscription.
    status: isSubscriptionStatus(row.status) ? row.status : 'none',
    planId: row.planId !== null && isPlanId(row.planId) ? row.planId : null,
    seatAllowance: row.seatAllowance,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEndsAt: row.currentPeriodEndsAt,
    dunningStartedAt: row.dunningStartedAt,
  };
}

/** Seats in the shape `@compass/billing` reasons about, from the auth layer's rows. */
export async function seatSummaries(scoped: ScopedDb): Promise<readonly SeatSummary[]> {
  const seats = await readSeats(scoped);

  return seats.map((seat) => ({
    // `SeatRow` extends `MembershipRow`, so the membership's own id is `id` — there is no separate
    // `membershipId` field. The billing layer calls it `membershipId` because at that layer a bare
    // `id` would be ambiguous between a seat, a user and a subscription.
    membershipId: seat.id,
    email: seat.email,
    displayName: seat.displayName,
    role: seat.role,
    status: seat.status,
    // The membership row's `createdAt` *is* when the seat was invited: `inviteSeat` writes the row at
    // the moment of invitation, and accepting it updates `status` rather than creating a second row.
    // Converted to epoch millis so the billing layer stays free of the clock package's brand and can
    // be tested with literal numbers.
    invitedAtMillis: toEpochMillis(seat.createdAt),
  }));
}

/** One plan, as the page renders it. */
export interface PlanCardView {
  readonly id: PlanId;
  readonly name: string;
  readonly summary: string;
  readonly seatPriceLabel: string;
  readonly monthlyTotalLabel: string;
  readonly includes: readonly string[];
  readonly maxSeatsLabel: string;
  readonly isCurrent: boolean;
  /** False when this plan cannot be bought — no price id configured, or billing is off. */
  readonly purchasable: boolean;
  /**
   * Why this plan cannot be chosen right now, or null.
   *
   * Resolved for *every* plan on load rather than only after a failed submit, so a downgrade the
   * organization is too large for is shown as unavailable with its reason attached before the owner
   * presses anything. Criterion 003 asks for the block to name the seats; showing it up front is
   * what makes the naming useful rather than a post-hoc scolding.
   */
  readonly blockedReason: string | null;
}

export interface InvoiceRowView {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly amountLabel: string;
  readonly issuedLabel: string;
  readonly periodLabel: string | null;
  /** Stripe-hosted. Null when the invoice has no document yet. */
  readonly pdfUrl: string | null;
  readonly hostedUrl: string | null;
}

export interface BillingView {
  readonly mode: BillingModeView;
  readonly state: BillingState;
  readonly seatCount: number;
  readonly seatAllowance: number | null;
  /** True when more seats are in use than the plan is paid for. */
  readonly overAllowance: boolean;
  readonly plans: readonly PlanCardView[];
  readonly currentPlanId: PlanId | null;
  readonly monthlyTotalLabel: string | null;
  /** ISO instants, formatted by the component in the reader's own zone. */
  readonly trialEndsAtIso: string | null;
  readonly periodEndsAtIso: string | null;
  readonly dunningDeadlineIso: string | null;
  readonly invoices: readonly InvoiceRowView[];
  /** Set when invoices could not be listed — a stated failure, never an empty table. */
  readonly invoicesUnavailable: string | null;
  readonly hasStripeCustomer: boolean;
  /**
   * What the restricted state permits and forbids, carried on the view rather than imported by the
   * component.
   *
   * The lists are `READ_ONLY_PERMITS` / `READ_ONLY_FORBIDS` in `@compass/billing`, which
   * `docs/BILLING.md` also quotes. Passing them through the view keeps the component a shell — it
   * renders what it is given and decides nothing — and means the page, the docs and the state machine
   * cannot describe the restriction three different ways.
   */
  readonly readOnlyPermits: readonly string[];
  readonly readOnlyForbids: readonly string[];
}

const seatCeilingLabel = (maxSeats: number | null): string =>
  maxSeats === null ? 'No seat ceiling' : `Up to ${maxSeats} seats`;

/**
 * The gateway, or null when billing is not configured.
 *
 * Constructed per call rather than cached in a module-level variable: the key is read from the
 * environment inside `resolveBillingConfig`, and a cached client would outlive a key rotation.
 */
export function gatewayFor(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BillingGateway | null {
  const config = resolveBillingConfig(environment);
  return config.configured ? new StripeGateway({ secretKey: config.secretKey }) : null;
}

export interface BuildBillingViewInput {
  readonly scoped: ScopedDb;
  readonly now: Instant;
  /** Injected so a test can supply a fake. Defaults to the real gateway, or none. */
  readonly gateway?: BillingGateway | null;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Assemble the billing page's whole view.
 *
 * Reads the subscription and the seats, computes entitlement, and — only when billing is configured
 * and a Stripe customer exists — lists invoices. The invoice call is the one that can fail on a
 * provider outage, so its failure is a *field* rather than a throw: the page renders the plan and the
 * payment state, and states that the invoice history could not be reached.
 */
export async function buildBillingView(input: BuildBillingViewInput): Promise<BillingView> {
  const environment = input.environment ?? process.env;
  const config = resolveBillingConfig(environment);
  const mode = billingModeView(config);

  const row = await findBillingSubscription(input.scoped);
  const facts = factsFrom(row);
  const state = billingState(facts, input.now);

  const seats = await seatSummaries(input.scoped);
  const seatCount = billableSeatCount(seats);

  const plans: readonly PlanCardView[] = PLANS.map((plan) => {
    const verdict = planChangeVerdict({ targetPlanId: plan.id, seats });
    const isCurrent = state.planId === plan.id;

    return {
      id: plan.id,
      name: plan.name,
      summary: plan.summary,
      seatPriceLabel: `${formatPence(plan.seatPricePence)} per seat / month`,
      monthlyTotalLabel: formatPence(monthlyTotalPence(plan.id, seatCount)),
      includes: plan.includes,
      maxSeatsLabel: seatCeilingLabel(plan.maxSeats),
      isCurrent,
      purchasable: mode.purchasablePlanIds.includes(plan.id),
      // The current plan is never "blocked": an organization that has outgrown its own plan needs to
      // be told to upgrade, not told it cannot stay where it is.
      blockedReason: isCurrent || verdict.allowed ? null : verdict.reason,
    };
  });

  const invoices = await listInvoiceRows({
    gateway: input.gateway === undefined ? gatewayFor(environment) : input.gateway,
    customerId: row?.stripeCustomerId ?? null,
  });

  return {
    mode,
    state,
    seatCount,
    seatAllowance: facts.seatAllowance,
    // Stated rather than silently tolerated: seats in use above what is paid for is the condition
    // that makes the next invoice bigger than the owner expects.
    overAllowance: facts.seatAllowance !== null && seatCount > facts.seatAllowance,
    plans,
    currentPlanId: state.planId,
    monthlyTotalLabel:
      state.planId === null ? null : formatPence(monthlyTotalPence(state.planId, seatCount)),
    trialEndsAtIso: facts.trialEndsAt === null ? null : toIso(facts.trialEndsAt),
    periodEndsAtIso: facts.currentPeriodEndsAt === null ? null : toIso(facts.currentPeriodEndsAt),
    dunningDeadlineIso: state.deadline === null ? null : toIso(state.deadline),
    invoices: invoices.rows,
    invoicesUnavailable: invoices.unavailable,
    hasStripeCustomer: row?.stripeCustomerId !== null && row?.stripeCustomerId !== undefined,
    readOnlyPermits: READ_ONLY_PERMITS,
    readOnlyForbids: READ_ONLY_FORBIDS,
  };
}

async function listInvoiceRows(input: {
  readonly gateway: BillingGateway | null;
  readonly customerId: string | null;
}): Promise<{ readonly rows: readonly InvoiceRowView[]; readonly unavailable: string | null }> {
  // No gateway or no customer is not a failure: an organization that has never checked out has no
  // invoice history, and an empty list with no error is the honest rendering.
  if (input.gateway === null || input.customerId === null) return { rows: [], unavailable: null };

  const result = await input.gateway.listInvoices({ customerId: input.customerId });
  if (!result.ok) {
    return {
      rows: [],
      unavailable:
        `Compass could not reach Stripe to list your invoices: ${result.detail} ` +
        'Your plan and payment state above are from Compass’s own records and are unaffected.',
    };
  }

  return { rows: result.value.map(toInvoiceRow), unavailable: null };
}

const toInvoiceRow = (invoice: InvoiceSummary): InvoiceRowView => ({
  id: invoice.id,
  // Stripe leaves `number` null on a draft. The id is not a friendly label, but it is the truth, and
  // inventing a sequence number would make Compass's list disagree with Stripe's.
  number: invoice.number ?? invoice.id,
  status: invoice.status,
  amountLabel: formatPence(invoice.amountDuePence, invoice.currency),
  issuedLabel: toIso(invoice.createdAt),
  periodLabel:
    invoice.periodStart === null || invoice.periodEnd === null
      ? null
      : `${toIso(invoice.periodStart).slice(0, 10)} → ${toIso(invoice.periodEnd).slice(0, 10)}`,
  pdfUrl: invoice.pdfUrl,
  hostedUrl: invoice.hostedUrl,
});
