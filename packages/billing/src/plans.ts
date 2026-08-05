/**
 * The plans, the seat price and the trial length — stated once, for the whole product.
 *
 * This module is the single source of truth the acceptance criterion asks for. The checkout
 * path, the webhook handler, the billing page and the public pricing page all read *these*
 * values; no price, currency or seat count is written into JSX anywhere.
 *
 * ## Why prices live in code and price *ids* live in the environment
 *
 * Two different kinds of fact. "A seat costs £12 a month on Team" is a product decision, it
 * belongs in review, and the pricing page has to be able to print it with no network call and
 * no Stripe key — so it is a constant here. `price_1234…` is a per-account identifier that
 * differs between one deployment's test mode and another's live mode, so it is configuration
 * and is read from the environment by `config.ts`.
 *
 * Keeping them apart is what makes the pricing page renderable on a deployment with no Stripe
 * configured at all, which criterion 004 requires.
 *
 * ## Money is in minor units, always
 *
 * `seatPricePence` rather than `seatPrice`, because Stripe's API is in minor units and a
 * floating-point pound is the classic way to charge somebody £11.999999. Nothing in this
 * package holds a fractional currency amount; `formatSeatPrice` is the only place a decimal
 * point is produced, and it produces a *string* for a human to read.
 */

/** The three plan ids. A fourth is a compile error until it is declared here. */
export const PLAN_IDS = ['starter', 'team', 'business'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);

/** GBP, in minor units, matching the currency Stripe is asked to charge in. */
export const BILLING_CURRENCY = 'gbp';

/**
 * How long a new organization has before payment is required.
 *
 * 14 days rather than 30: Compass produces a report every morning, so a fortnight is fourteen
 * of the actual thing being evaluated — long enough to see the continuity features that need
 * history ("day 6"), short enough that the decision does not go stale.
 */
export const TRIAL_DAYS = 14;

/**
 * How long an owner has to fix a failed payment before access is restricted.
 *
 * Stripe's own smart retries run over roughly two weeks; this is deliberately shorter than
 * that would allow, because the useful part of dunning is the *deadline a human is told*, and
 * "sometime in the next fortnight" is not one. See `docs/BILLING.md`.
 */
export const DUNNING_GRACE_DAYS = 7;

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** One sentence, in the product's voice, for the pricing page. */
  readonly summary: string;
  /** Per seat, per month, in pence. */
  readonly seatPricePence: number;
  /**
   * The largest number of seats this plan may hold, or null for no ceiling.
   *
   * This is what makes a downgrade refusable: moving to a plan whose ceiling is below the
   * organization's current seat count is blocked, and the block names the seats to remove.
   */
  readonly maxSeats: number | null;
  /** How many teams the plan covers. Compass is built for one to three. */
  readonly maxTeams: number | null;
  /** Named capabilities, for the pricing table. Prose, not feature flags. */
  readonly includes: readonly string[];
  /** The environment variable holding this plan's Stripe price id. */
  readonly priceIdEnvVar: string;
}

/**
 * The plan table.
 *
 * Ordered cheapest first, and every surface that lists plans iterates this array rather than
 * hard-coding an order, so the pricing page and the billing page cannot disagree about which
 * plan is an upgrade.
 */
export const PLANS: readonly Plan[] = Object.freeze([
  Object.freeze({
    id: 'starter' as const,
    name: 'Starter',
    summary: 'One team, one daily report, the full evidence chain.',
    seatPricePence: 800,
    maxSeats: 8,
    maxTeams: 1,
    includes: Object.freeze([
      'One team',
      'The six-section daily report',
      'Evidence chain on every claim',
      'Email delivery',
      '3 years of report history',
    ]),
    priceIdEnvVar: 'STRIPE_PRICE_STARTER',
  }),
  Object.freeze({
    id: 'team' as const,
    name: 'Team',
    summary: 'Up to three teams, the merged cross-team report, and Slack.',
    seatPricePence: 1200,
    maxSeats: 24,
    maxTeams: 3,
    includes: Object.freeze([
      'Up to three teams',
      'The merged cross-team report',
      'Slack delivery and one-click feedback',
      'Manager Memos',
      'Weekly digest',
    ]),
    priceIdEnvVar: 'STRIPE_PRICE_TEAM',
  }),
  Object.freeze({
    id: 'business' as const,
    name: 'Business',
    summary: 'No team ceiling, live connectors, and the calibration audit.',
    seatPricePence: 1800,
    maxSeats: null,
    maxTeams: null,
    includes: Object.freeze([
      'Unlimited teams',
      'GitHub and Jira connectors',
      'Process calibration audit',
      'Share links with expiry',
      'Priority support',
    ]),
    priceIdEnvVar: 'STRIPE_PRICE_BUSINESS',
  }),
]);

/** The plan a new organization is put on when its trial starts. */
export const DEFAULT_PLAN_ID: PlanId = 'team';

export class UnknownPlanError extends Error {
  constructor(planId: string) {
    super(
      `\`${planId}\` is not a Compass plan. The plans are ${PLANS.map((plan) => plan.id).join(', ')}, ` +
        'declared in packages/billing/src/plans.ts.',
    );
    this.name = 'UnknownPlanError';
  }
}

/** The plan, or a throw. Callers holding a `PlanId` never need the null-check. */
export function planById(planId: PlanId): Plan {
  const found = PLANS.find((plan) => plan.id === planId);
  if (found === undefined) throw new UnknownPlanError(planId);
  return found;
}

/** The plan, or null — for a value off a webhook or a URL that has not been validated yet. */
export const findPlan = (planId: string): Plan | null =>
  PLANS.find((plan) => plan.id === planId) ?? null;

/** Cheapest-first position, so "is this an upgrade" is one comparison rather than a table. */
export const planRank = (planId: PlanId): number => PLANS.findIndex((plan) => plan.id === planId);

export const isUpgrade = (from: PlanId, to: PlanId): boolean => planRank(to) > planRank(from);
export const isDowngrade = (from: PlanId, to: PlanId): boolean => planRank(to) < planRank(from);

/** What a given seat count costs per month on a plan, in pence. */
export const monthlyTotalPence = (planId: PlanId, seats: number): number =>
  planById(planId).seatPricePence * Math.max(0, Math.trunc(seats));

/**
 * A money string for a human, from minor units.
 *
 * The one place a decimal point appears. `Intl.NumberFormat` rather than a hand-rolled
 * `toFixed(2)` with a `£` glued on, so the currency symbol and separators are the ones the
 * currency actually uses.
 */
export const formatPence = (pence: number, currency: string = BILLING_CURRENCY): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currency.toUpperCase(),
    // Whole pounds print as "£12" rather than "£12.00": the pricing page is typography, and a
    // trailing ".00" on every row is noise. A non-round amount still shows its pence.
    minimumFractionDigits: pence % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(pence / 100);

/** "£12 per seat / month", the phrase the pricing page and the billing page share. */
export const formatSeatPrice = (planId: PlanId): string =>
  `${formatPence(planById(planId).seatPricePence)} per seat / month`;
