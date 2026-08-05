import { addExactDays, isAfter, isAtOrAfter, toEpochMillis, type Instant } from '@compass/clock';

import { DUNNING_GRACE_DAYS, TRIAL_DAYS, type PlanId } from './plans.js';

/**
 * What an organization is allowed to do right now, derived from its subscription and the instant.
 *
 * ## Derived, never stored
 *
 * There is no `is_read_only` column. Entitlement is a *function* of `(subscription, now)`, and
 * that is the whole design: a stored flag has to be flipped by a job, and a job that has not run
 * yet — or ran once and crashed — leaves a trial that expired on Tuesday still fully open on
 * Friday. Computing it on read means an expired trial is restricted the instant it expires, on
 * every surface, with no scheduler in the trust path. The worker's job exists to *notify*, not to
 * enforce.
 *
 * It is the same argument `packages/analysis` makes for being pure: the answer depends only on its
 * inputs, so a test picks an instant instead of waiting fourteen days.
 *
 * ## The restricted state, stated once
 *
 * `read_only` is the documented restriction both criterion 002 (trial expiry) and criterion 003
 * (cancellation) point at, and it is deliberately the *same* state for both — a manager whose
 * trial lapsed and one who cancelled need the same thing: their history, readable, and a way to
 * pay. What it permits and forbids is `READ_ONLY_PERMITS` / `READ_ONLY_FORBIDS` below, which
 * `docs/BILLING.md` quotes and a gate diffs.
 */

/** Stripe's subscription statuses Compass stores, plus the two states that precede one. */
export const SUBSCRIPTION_STATUSES = [
  /** No subscription row has ever existed for this organization. */
  'none',
  'trialing',
  'active',
  /** A payment failed and the dunning window is open. */
  'past_due',
  /** Stripe gave up, or the owner cancelled and the paid period has ended. */
  'canceled',
  /** Cancelled but still inside the period already paid for. */
  'canceling',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const isSubscriptionStatus = (value: unknown): value is SubscriptionStatus =>
  typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);

/** Full product, or history-only. Two values on purpose: a third would need a third explanation. */
export type Entitlement = 'full' | 'read_only';

/**
 * The subscription facts entitlement is computed from.
 *
 * Structurally typed rather than imported from `@compass/db`, so this module stays pure and a test
 * can construct one literally. The database row maps onto it one-for-one.
 */
export interface SubscriptionFacts {
  readonly status: SubscriptionStatus;
  readonly planId: PlanId | null;
  /** Seats the plan is paid for. Null before checkout completes. */
  readonly seatAllowance: number | null;
  /** When the trial ends. Null when there is no trial. */
  readonly trialEndsAt: Instant | null;
  /** End of the period already paid for. Null when nothing has been paid. */
  readonly currentPeriodEndsAt: Instant | null;
  /** When the first payment failed, which is what the dunning deadline counts from. */
  readonly dunningStartedAt: Instant | null;
}

/** What a read-only organization can still do. Quoted verbatim by `docs/BILLING.md`. */
export const READ_ONLY_PERMITS: readonly string[] = Object.freeze([
  'Read every report Compass has already written, including the full archive and every evidence chain',
  'Export the organization’s data',
  'Sign in, manage seats and change or cancel the plan',
  'Read and change privacy, retention and deletion settings',
]);

/** What it cannot. Also quoted by the docs, and by the banner the manager reads. */
export const READ_ONLY_FORBIDS: readonly string[] = Object.freeze([
  'Generating a new daily report — the pipeline stops, so no new mornings are added',
  'Email and Slack delivery of the daily',
  'Time travel and on-demand regeneration',
  'Narration — nothing is sent to a language model',
]);

/** The instant a trial that starts now would end. The one place `TRIAL_DAYS` is applied. */
export const trialEndFrom = (startedAt: Instant): Instant => addExactDays(startedAt, TRIAL_DAYS);

/**
 * The instant a dunning window that opened at `failedAt` closes.
 *
 * Frozen onto the row at the moment the payment failed rather than recomputed on read, for the
 * same reason `sessions.expires_at` is: "you have until Friday" is a promise made to a person, not
 * a configuration value that may be edited underneath them.
 */
export const dunningDeadlineFrom = (failedAt: Instant): Instant =>
  addExactDays(failedAt, DUNNING_GRACE_DAYS);

export interface BillingState {
  readonly status: SubscriptionStatus;
  readonly planId: PlanId | null;
  readonly entitlement: Entitlement;
  /** One sentence for the manager, in the product's voice. Null when nothing needs saying. */
  readonly notice: string | null;
  /** The deadline the notice refers to, so the UI can print it in the reader's own zone. */
  readonly deadline: Instant | null;
  /** True while a trial is running and has not expired. */
  readonly inTrial: boolean;
  /** Whole days left in the trial or the dunning window, floored. Null when neither applies. */
  readonly daysRemaining: number | null;
  /** True when the reason for restriction is a lapsed trial rather than a payment problem. */
  readonly trialExpired: boolean;
  readonly seatAllowance: number | null;
}

const wholeDaysBetween = (from: Instant, to: Instant): number =>
  Math.max(0, Math.floor((toEpochMillis(to) - toEpochMillis(from)) / 86_400_000));

/**
 * Entitlement and the sentence explaining it.
 *
 * Every branch returns a `notice` that says what is limited *and* how to restore it, because
 * criterion 002 asks for both and a restriction with no remedy is the "confident polish" this
 * product refuses. The wording is here rather than in the component so the email, the API and the
 * page cannot describe the same state three different ways.
 */
export function billingState(facts: SubscriptionFacts, now: Instant): BillingState {
  const base = {
    status: facts.status,
    planId: facts.planId,
    seatAllowance: facts.seatAllowance,
  } as const;

  switch (facts.status) {
    case 'none':
      return {
        ...base,
        entitlement: 'full',
        notice: null,
        deadline: null,
        inTrial: false,
        daysRemaining: null,
        trialExpired: false,
      };

    case 'trialing': {
      // A trial with no end instant is a data fault, not an expiry. Treated as running rather than
      // as lapsed: the failure direction for "we cannot tell" must not be to lock a paying customer
      // out of the product.
      if (facts.trialEndsAt === null) {
        return {
          ...base,
          entitlement: 'full',
          notice: null,
          deadline: null,
          inTrial: true,
          daysRemaining: null,
          trialExpired: false,
        };
      }

      if (isAtOrAfter(now, facts.trialEndsAt)) {
        return {
          ...base,
          entitlement: 'read_only',
          notice:
            'Your trial has ended, so Compass has stopped generating new reports and stopped ' +
            'delivering them. Everything already written stays readable, and your data stays ' +
            'exportable. Add a payment method to start tomorrow’s report.',
          deadline: facts.trialEndsAt,
          inTrial: false,
          daysRemaining: 0,
          trialExpired: true,
        };
      }

      const daysRemaining = wholeDaysBetween(now, facts.trialEndsAt);
      return {
        ...base,
        entitlement: 'full',
        notice:
          `Your trial ends in ${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'}. ` +
          'Add a payment method to keep tomorrow’s report arriving.',
        deadline: facts.trialEndsAt,
        inTrial: true,
        daysRemaining,
        trialExpired: false,
      };
    }

    case 'active':
      return {
        ...base,
        entitlement: 'full',
        notice: null,
        deadline: facts.currentPeriodEndsAt,
        inTrial: false,
        daysRemaining: null,
        trialExpired: false,
      };

    case 'past_due': {
      /**
       * Dunning: still full access until the deadline, then restricted.
       *
       * Access is *not* cut at the moment the payment fails. A card expires far more often than a
       * customer leaves, and taking the product away on the first decline would punish the common
       * case. The deadline is the thing that has to be stated plainly, which is what `notice`
       * carries.
       */
      const deadline =
        facts.dunningStartedAt === null ? null : dunningDeadlineFrom(facts.dunningStartedAt);

      if (deadline !== null && isAfter(now, deadline)) {
        return {
          ...base,
          entitlement: 'read_only',
          notice:
            'A payment failed and the grace period has passed, so Compass has stopped generating ' +
            'and delivering new reports. Your history and your export stay available. Update the ' +
            'payment method to restore them.',
          deadline,
          inTrial: false,
          daysRemaining: 0,
          trialExpired: false,
        };
      }

      const daysRemaining = deadline === null ? null : wholeDaysBetween(now, deadline);
      return {
        ...base,
        entitlement: 'full',
        notice:
          'A payment failed. ' +
          (daysRemaining === null
            ? 'Update the payment method to keep Compass generating reports.'
            : `Update the payment method within ${daysRemaining} ${
                daysRemaining === 1 ? 'day' : 'days'
              } or Compass will stop generating and delivering new reports.`),
        deadline,
        inTrial: false,
        daysRemaining,
        trialExpired: false,
      };
    }

    case 'canceling': {
      /**
       * Cancelled, and access is retained to the end of the paid period. Criterion 003.
       *
       * The period end is the entitlement boundary, so no job has to run at midnight for the
       * restriction to take effect — the same read-time derivation the trial uses.
       */
      if (facts.currentPeriodEndsAt !== null && isAtOrAfter(now, facts.currentPeriodEndsAt)) {
        return {
          ...base,
          status: 'canceled',
          entitlement: 'read_only',
          notice:
            'Your subscription has ended. Compass has stopped generating and delivering new ' +
            'reports; every report it already wrote stays readable and your data stays exportable. ' +
            'Choose a plan to start again.',
          deadline: facts.currentPeriodEndsAt,
          inTrial: false,
          daysRemaining: 0,
          trialExpired: false,
        };
      }

      const daysRemaining =
        facts.currentPeriodEndsAt === null ? null : wholeDaysBetween(now, facts.currentPeriodEndsAt);
      return {
        ...base,
        entitlement: 'full',
        notice:
          'Your subscription is cancelled and will not renew. ' +
          (daysRemaining === null
            ? 'Compass keeps working until the end of the period you have paid for.'
            : `Compass keeps generating reports for ${daysRemaining} more ${
                daysRemaining === 1 ? 'day' : 'days'
              }, to the end of the period you have paid for.`),
        deadline: facts.currentPeriodEndsAt,
        inTrial: false,
        daysRemaining,
        trialExpired: false,
      };
    }

    case 'canceled':
      return {
        ...base,
        entitlement: 'read_only',
        notice:
          'Your subscription has ended. Compass has stopped generating and delivering new reports; ' +
          'every report it already wrote stays readable and your data stays exportable. Choose a ' +
          'plan to start again.',
        deadline: facts.currentPeriodEndsAt,
        inTrial: false,
        daysRemaining: 0,
        trialExpired: false,
      };
  }
}

/**
 * Whether the pipeline may generate for this organization.
 *
 * The one predicate the worker and the web read path both call, so "restricted" means the same
 * thing to the scheduler as it does to the page. Named for what it permits rather than what it
 * blocks, because the caller is asking permission.
 */
export const mayGenerateReports = (facts: SubscriptionFacts, now: Instant): boolean =>
  billingState(facts, now).entitlement === 'full';

/** The facts of an organization that has never had a subscription row. */
export const NO_SUBSCRIPTION: SubscriptionFacts = Object.freeze({
  status: 'none' as const,
  planId: null,
  seatAllowance: null,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  dunningStartedAt: null,
});
