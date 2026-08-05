import { PLANS, type PlanId } from './plans.js';

/**
 * Whether billing is configured, answered as a value rather than a throw.
 *
 * ## The rule this module exists to enforce
 *
 * `STRIPE_SECRET_KEY` absent is a **supported state**, not a misconfiguration. Compass with no
 * Stripe key generates reports, delivers them, and lets an owner configure everything — the
 * billing screens say "billing is not configured" and every other surface is untouched. That is
 * criterion 004, and it is the same posture `RESEND_API_KEY` and `ANTHROPIC_API_KEY` already
 * take.
 *
 * Two things make it hold rather than merely being intended:
 *
 * 1. **The environment is read inside the function, never at module scope.** A
 *    `const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)` at the top of a module throws
 *    at *import* time, which takes down every page that transitively imports it — a 500 on the
 *    report, not just on the billing page. Nothing here is evaluated until somebody asks.
 * 2. **The result is a discriminated union.** `configured: false` is a value the caller has to
 *    handle, so a missing key cannot be forgotten into a null-dereference. Same shape the
 *    connector-port coverage result uses.
 *
 * ## TEST versus LIVE
 *
 * Derived from the key prefix, because that is the only thing that *is* the truth — a separate
 * `STRIPE_MODE` variable could disagree with the key, and then the badge on the billing page
 * would be a lie about which account is being charged. `sk_live_` is live; everything else,
 * including an ambiguous or malformed key, is reported as test. Defaulting the *other* way would
 * mean a typo silently presented a test deployment as live.
 */

export const STRIPE_SECRET_KEY_ENV_VAR = 'STRIPE_SECRET_KEY';
export const STRIPE_WEBHOOK_SECRET_ENV_VAR = 'STRIPE_WEBHOOK_SECRET';

/** Every Stripe variable Compass reads, for the docs gate and `.env.example`. */
export const STRIPE_ENV_VARS: readonly string[] = Object.freeze([
  STRIPE_SECRET_KEY_ENV_VAR,
  STRIPE_WEBHOOK_SECRET_ENV_VAR,
  ...PLANS.map((plan) => plan.priceIdEnvVar),
]);

export type BillingMode = 'test' | 'live';

/** The sentence every billing surface shows when there is no key. One wording, one place. */
export const NOT_CONFIGURED_STATEMENT =
  'Billing is not configured. Compass is running without a payment provider, so there is no plan, ' +
  'no invoice and nothing to pay — every report, delivery and configuration screen works exactly as ' +
  'it does on a paid deployment. An operator can enable billing by setting STRIPE_SECRET_KEY.';

export interface ConfiguredBilling {
  readonly configured: true;
  readonly mode: BillingMode;
  /**
   * The secret key. Never rendered, never logged, never returned by an API — the
   * `compass/no-secret-disclosure` lint rule fails the build if it reaches a response body.
   */
  readonly secretKey: string;
  /**
   * The webhook signing secret, or null.
   *
   * Null is a real and separate state: checkout works while webhooks cannot be verified, and the
   * webhook route must refuse every delivery rather than trust an unverified one. Folding it into
   * `configured: false` would wrongly hide the whole billing UI on a deployment that can charge.
   */
  readonly webhookSecret: string | null;
  /** Stripe price id per plan. A plan with no configured price cannot be checked out. */
  readonly priceIds: Readonly<Partial<Record<PlanId, string>>>;
}

export interface UnconfiguredBilling {
  readonly configured: false;
  /** Which variable is missing, so the operator is told the fix and not just the symptom. */
  readonly missingEnvVar: string;
  readonly statement: string;
}

export type BillingConfig = ConfiguredBilling | UnconfiguredBilling;

export type EnvironmentLike = Readonly<Record<string, string | undefined>>;

const trimmed = (value: string | undefined): string => (value ?? '').trim();

/**
 * TEST unless the key says live.
 *
 * Exported so the billing page's badge and any test can ask the question without building a whole
 * config, and so the defaulting rule is stated in exactly one place.
 */
export const modeForKey = (secretKey: string): BillingMode =>
  secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_') ? 'live' : 'test';

/**
 * Resolve billing configuration from the environment.
 *
 * `environment` is a parameter with a default rather than a direct `process.env` read, for the
 * same reason `now` is a parameter everywhere else in Compass: a test sets the state it wants
 * instead of mutating the host process, and a vitest run cannot pick up a developer's real key.
 */
export function resolveBillingConfig(environment: EnvironmentLike = process.env): BillingConfig {
  const secretKey = trimmed(environment[STRIPE_SECRET_KEY_ENV_VAR]);

  if (secretKey.length === 0) {
    return {
      configured: false,
      missingEnvVar: STRIPE_SECRET_KEY_ENV_VAR,
      statement: NOT_CONFIGURED_STATEMENT,
    };
  }

  const priceIds: Partial<Record<PlanId, string>> = {};
  for (const plan of PLANS) {
    const priceId = trimmed(environment[plan.priceIdEnvVar]);
    if (priceId.length > 0) priceIds[plan.id] = priceId;
  }

  const webhookSecret = trimmed(environment[STRIPE_WEBHOOK_SECRET_ENV_VAR]);

  return {
    configured: true,
    mode: modeForKey(secretKey),
    secretKey,
    webhookSecret: webhookSecret.length === 0 ? null : webhookSecret,
    priceIds: Object.freeze(priceIds),
  };
}

/** Whether billing is available at all, for a caller that needs only the boolean. */
export const billingConfigured = (environment: EnvironmentLike = process.env): boolean =>
  resolveBillingConfig(environment).configured;

/**
 * What the billing page shows about the provider, with no secret in it.
 *
 * The return of this function is safe to serialise into a page or an API response: it carries the
 * mode and which plans are purchasable, and never the key. That is deliberate — a "masked" key
 * still confirms existence, length and prefix, which is why nothing here returns one.
 */
export interface BillingModeView {
  readonly configured: boolean;
  readonly mode: BillingMode | null;
  /** True in test mode, so the page can carry the "no real money" banner. */
  readonly isTestMode: boolean;
  /** Plans that have a Stripe price id and can therefore be checked out. */
  readonly purchasablePlanIds: readonly PlanId[];
  readonly webhooksVerifiable: boolean;
  /** Null when configured; the operator-facing sentence when not. */
  readonly statement: string | null;
  readonly missingEnvVar: string | null;
}

export function billingModeView(config: BillingConfig): BillingModeView {
  if (!config.configured) {
    return {
      configured: false,
      mode: null,
      isTestMode: false,
      purchasablePlanIds: [],
      webhooksVerifiable: false,
      statement: config.statement,
      missingEnvVar: config.missingEnvVar,
    };
  }

  return {
    configured: true,
    mode: config.mode,
    isTestMode: config.mode === 'test',
    purchasablePlanIds: PLANS.filter((plan) => config.priceIds[plan.id] !== undefined).map(
      (plan) => plan.id,
    ),
    webhooksVerifiable: config.webhookSecret !== null,
    statement: null,
    missingEnvVar: null,
  };
}
