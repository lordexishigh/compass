/**
 * @compass/billing — plans, seat pricing, subscription state and the Stripe port.
 *
 * Layer position: beside `@compass/auth`, above `@compass/clock` and nothing else. It holds no
 * database handle and performs no query: the web app and the worker own persistence, exactly as
 * `@compass/narrator` writes no rows and lets the pipeline record its traces. That is what lets the
 * entitlement rules be unit-tested against literal facts and an instant.
 *
 * ## The four things that live here
 *
 * 1. **`plans.ts` — the single source of truth for pricing.** The plan table, the seat price, the
 *    trial length and the dunning grace period. The pricing page, the billing page, the checkout
 *    call and the webhook handler all read it; no price is written into JSX anywhere.
 * 2. **`config.ts` — the graceful-degradation seam.** `resolveBillingConfig` returns
 *    `configured | not-configured` rather than throwing, and reads the environment *inside* the
 *    function, so a deployment with no `STRIPE_SECRET_KEY` renders a stated sentence instead of a
 *    500 on every page that transitively imports billing.
 * 3. **`state.ts` — entitlement, derived and never stored.** `billingState(facts, now)` decides
 *    whether an organization is `full` or `read_only`. There is no `is_read_only` column, because a
 *    stored flag needs a job to flip it and a job that has not run leaves an expired trial open.
 * 4. **`gateway.ts` + `webhook.ts` — the provider, as a port.** One narrow interface with an HTTP
 *    implementation and a recording fake, plus signature verification over the raw bytes.
 */
export {
  BILLING_CURRENCY,
  DEFAULT_PLAN_ID,
  DUNNING_GRACE_DAYS,
  PLAN_IDS,
  PLANS,
  TRIAL_DAYS,
  UnknownPlanError,
  findPlan,
  formatPence,
  formatSeatPrice,
  isDowngrade,
  isPlanId,
  isUpgrade,
  monthlyTotalPence,
  planById,
  planRank,
  type Plan,
  type PlanId,
} from './plans.js';

export {
  NOT_CONFIGURED_STATEMENT,
  STRIPE_ENV_VARS,
  STRIPE_SECRET_KEY_ENV_VAR,
  STRIPE_WEBHOOK_SECRET_ENV_VAR,
  billingConfigured,
  billingModeView,
  modeForKey,
  resolveBillingConfig,
  type BillingConfig,
  type BillingMode,
  type BillingModeView,
  type ConfiguredBilling,
  type EnvironmentLike,
  type UnconfiguredBilling,
} from './config.js';

export {
  NO_SUBSCRIPTION,
  READ_ONLY_FORBIDS,
  READ_ONLY_PERMITS,
  SUBSCRIPTION_STATUSES,
  billingState,
  dunningDeadlineFrom,
  isSubscriptionStatus,
  mayGenerateReports,
  trialEndFrom,
  type BillingState,
  type Entitlement,
  type SubscriptionFacts,
  type SubscriptionStatus,
} from './state.js';

export {
  billableSeatCount,
  planChangeVerdict,
  removalCandidates,
  seatAdditionVerdict,
  seatIsBillable,
  type PlanChangeBlocked,
  type PlanChangeVerdict,
  type SeatSummary,
} from './seats.js';

export {
  HANDLED_EVENT_TYPES,
  MalformedEventError,
  STRIPE_SIGNATURE_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  isHandledEventType,
  parseEventEnvelope,
  parseStripeSignature,
  signPayload,
  signedPayload,
  verifyStripeWebhook,
  type HandledEventType,
  type StripeEventEnvelope,
  type WebhookVerdict,
} from './webhook.js';

export {
  ORGANIZATION_METADATA_KEY,
  PLAN_METADATA_KEY,
  applyEvent,
  statusFromStripe,
  type AppliedEvent,
  type SubscriptionPatch,
} from './apply.js';

export {
  StripeGateway,
  encodeForm,
  readInvoice,
  type BillingGateway,
  type CheckoutSession,
  type CheckoutSessionRequest,
  type GatewayResult,
  type InvoiceSummary,
  type StripeGatewayOptions,
} from './gateway.js';
