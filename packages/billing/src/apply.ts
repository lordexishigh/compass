import { instantFromEpochMillis, type Instant } from '@compass/clock';

import { findPlan, type PlanId } from './plans.js';
import { dunningDeadlineFrom, type SubscriptionStatus } from './state.js';
import { isHandledEventType, type StripeEventEnvelope } from './webhook.js';

/**
 * What one verified event changes, as a value.
 *
 * ## Why this is a pure function and not a set of database writes
 *
 * The webhook route's job is transactional: record the event id, apply the change, commit. The
 * decision about *what* the change is has no business being interleaved with that — so it is a
 * function from `(envelope) → SubscriptionPatch | null`, which makes every mapping in this file
 * testable without a database and makes the route a thin, obviously-correct wrapper.
 *
 * It is also what lets the idempotency test be honest: replaying an event twice must produce one
 * state change, and proving that needs the change to be an inspectable value rather than a side
 * effect.
 *
 * ## Nothing is trusted from the client
 *
 * Every field is read off the Stripe object in the verified payload. Compass never takes a plan, a
 * seat count, an amount or a status from a request parameter — the proven-pattern note for this
 * stack says so, and the checkout route follows it by putting only an organization id in metadata
 * and reading everything else back from Stripe.
 */

/** A field-by-field change to an organization's subscription. Absent fields are left alone. */
export interface SubscriptionPatch {
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly status?: SubscriptionStatus;
  readonly planId?: PlanId;
  readonly seatAllowance?: number;
  readonly trialEndsAt?: Instant | null;
  readonly currentPeriodEndsAt?: Instant | null;
  readonly dunningStartedAt?: Instant | null;
  /** True when this event should send the owner a dunning email. */
  readonly notifyDunning?: boolean;
  /** The deadline that email and the in-app banner state. */
  readonly dunningDeadline?: Instant | null;
}

export interface AppliedEvent {
  readonly eventType: string;
  readonly patch: SubscriptionPatch;
  /** The organization the event is about, read from Stripe metadata. Null when unattributable. */
  readonly organizationId: string | null;
  /** One sentence for the structured log and the audit entry. */
  readonly detail: string;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const seconds = (value: unknown): Instant | null =>
  typeof value === 'number' && Number.isFinite(value) ? instantFromEpochMillis(value * 1000) : null;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The `period` object of an invoice's first line, or an empty record.
 *
 * `lines` is a Stripe *list* object: the entries are under `lines.data`, and each carries its own
 * `period: { start, end }`. Reading `lines.period_end` — as this file previously did — is always
 * `undefined`, which is the quiet kind of wrong that a nullish-coalesce then hides completely.
 */
const firstLinePeriod = (object: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const data = asRecord(object['lines'])['data'];
  return Array.isArray(data) ? asRecord(asRecord(data[0])['period']) : {};
};

/** Compass puts exactly one thing in Stripe metadata, and this reads it back. */
export const ORGANIZATION_METADATA_KEY = 'compass_organization_id';
export const PLAN_METADATA_KEY = 'compass_plan_id';

const organizationFrom = (object: Readonly<Record<string, unknown>>): string | null => {
  const direct = text(asRecord(object['metadata'])[ORGANIZATION_METADATA_KEY]);
  if (direct !== null) return direct;
  // A subscription event carries the metadata Compass set at checkout; an invoice event carries the
  // subscription's. Both are looked at rather than only the first, because Stripe does not copy
  // metadata between objects.
  return text(asRecord(asRecord(object['subscription_details'])['metadata'])[ORGANIZATION_METADATA_KEY]);
};

/**
 * The plan a Stripe subscription is on.
 *
 * Read from metadata rather than by mapping the price id back to a plan. A price id is per-account
 * configuration that differs between deployments, so a reverse lookup would need the environment
 * and would silently fail on a deployment whose price ids had been rotated. The plan id Compass
 * chose at checkout is a fact about Compass, so Compass stores it.
 */
const planFrom = (object: Readonly<Record<string, unknown>>): PlanId | null => {
  const fromMetadata = text(asRecord(object['metadata'])[PLAN_METADATA_KEY]);
  return fromMetadata === null ? null : (findPlan(fromMetadata)?.id ?? null);
};

/** Seat count, from the subscription's first line item quantity. */
const seatsFrom = (object: Readonly<Record<string, unknown>>): number | null => {
  const items = asRecord(object['items'])['data'];
  if (!Array.isArray(items) || items.length === 0) return null;
  const quantity = asRecord(items[0])['quantity'];
  return typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0
    ? Math.trunc(quantity)
    : null;
};

/**
 * Stripe's own status string, narrowed to what Compass models.
 *
 * `incomplete`, `incomplete_expired`, `unpaid` and `paused` all collapse onto a state Compass
 * already has a documented meaning for, rather than adding statuses with no explanation attached.
 * `cancel_at_period_end` is the one case where Stripe's status (`active`) is not the whole truth,
 * so it is checked first.
 */
export function statusFromStripe(object: Readonly<Record<string, unknown>>): SubscriptionStatus | null {
  const raw = text(object['status']);
  if (raw === null) return null;

  if (raw === 'active' && object['cancel_at_period_end'] === true) return 'canceling';

  switch (raw) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    // An `incomplete` subscription has never been paid — the customer abandoned the card step — and
    // a `paused` one is not generating. Neither entitles anything, and `canceled` is the state whose
    // documented restriction fits.
    case 'incomplete':
    case 'paused':
      return 'canceled';
    default:
      return null;
  }
}

/**
 * Read a subscription object into a patch. Shared by the three `customer.subscription.*` events and
 * by `checkout.session.completed`, so all four agree about what a subscription object means.
 */
function patchFromSubscription(object: Readonly<Record<string, unknown>>): SubscriptionPatch {
  const status = statusFromStripe(object);
  const planId = planFrom(object);
  const seats = seatsFrom(object);
  const subscriptionId = text(object['id']);
  const customerId = text(object['customer']);

  return {
    ...(subscriptionId === null ? {} : { stripeSubscriptionId: subscriptionId }),
    ...(customerId === null ? {} : { stripeCustomerId: customerId }),
    ...(status === null ? {} : { status }),
    ...(planId === null ? {} : { planId }),
    ...(seats === null ? {} : { seatAllowance: seats }),
    trialEndsAt: seconds(object['trial_end']),
    currentPeriodEndsAt: seconds(object['current_period_end']),
    // A subscription that is not past_due has no open dunning window. Clearing it here is what makes
    // a recovered payment restore access without a second code path.
    ...(status === 'past_due' ? {} : { dunningStartedAt: null, dunningDeadline: null }),
  };
}

/**
 * Turn a verified event into the change it implies, or null for one Compass does not act on.
 *
 * Returning null rather than throwing for an unhandled type is deliberate: the route answers 200 and
 * records nothing, because a non-2xx makes Stripe retry an event no version of Compass will ever
 * handle.
 */
export function applyEvent(envelope: StripeEventEnvelope, now: Instant): AppliedEvent | null {
  if (!isHandledEventType(envelope.type)) return null;

  const object = envelope.data;
  const organizationId = organizationFrom(object);

  switch (envelope.type) {
    case 'checkout.session.completed': {
      /**
       * Checkout finished. The seat allowance and the plan are set here.
       *
       * The session carries the organization in metadata (Compass put it there) and the customer and
       * subscription ids Stripe created. It does *not* reliably carry the line item quantity, so the
       * seat allowance is taken from the `customer.subscription.created` event that accompanies it —
       * which is why this patch sets `active` and leaves seats to that event. Stripe sends both.
       */
      const customerId = text(object['customer']);
      const subscriptionId = text(object['subscription']);
      const planId = planFrom(object);

      return {
        eventType: envelope.type,
        organizationId,
        detail: 'Checkout completed, so the plan is active.',
        patch: {
          ...(customerId === null ? {} : { stripeCustomerId: customerId }),
          ...(subscriptionId === null ? {} : { stripeSubscriptionId: subscriptionId }),
          ...(planId === null ? {} : { planId }),
          status: 'active',
          dunningStartedAt: null,
          dunningDeadline: null,
        },
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return {
        eventType: envelope.type,
        organizationId,
        detail: `The subscription is now ${statusFromStripe(object) ?? 'in an unread state'}.`,
        patch: patchFromSubscription(object),
      };

    case 'customer.subscription.deleted':
      return {
        eventType: envelope.type,
        organizationId,
        detail: 'The subscription was deleted at Stripe, so access is restricted.',
        patch: {
          status: 'canceled',
          currentPeriodEndsAt: seconds(object['ended_at']) ?? seconds(object['current_period_end']),
          dunningStartedAt: null,
          dunningDeadline: null,
        },
      };

    case 'invoice.paid':
      return {
        eventType: envelope.type,
        organizationId,
        detail: 'An invoice was paid, so the dunning window is closed.',
        patch: {
          status: 'active',
          /**
           * The invoice's own `period_end`, with the first line's period as the fallback.
           *
           * This read was wrong in a way that could not fail loudly: `lines.period_end` does not
           * exist on a Stripe invoice — the list object has `data`, and the period lives at
           * `lines.data[0].period.end` — so it was always `undefined`, and `?? undefined` turned
           * that into an absent key. The patch therefore stopped refreshing
           * `currentPeriodEndsAt` on every renewal, and the only symptom would have been a
           * cancellation boundary frozen at whatever the last subscription event happened to say.
           *
           * Top level first because that is the invoice's own billing period; the line's period is
           * the same value on an ordinary subscription invoice and is the safety net for a shape
           * that omits it.
           */
          currentPeriodEndsAt:
            seconds(object['period_end']) ?? seconds(firstLinePeriod(object)['end']) ?? undefined,
          dunningStartedAt: null,
          dunningDeadline: null,
        },
      };

    case 'invoice.payment_failed': {
      /**
       * Dunning opens, and the deadline is frozen onto the row now.
       *
       * `now` rather than the invoice's own timestamp: the deadline is a promise made to the owner
       * from the moment Compass learned about the failure, and computing it from a Stripe timestamp
       * would silently shorten the window when a delivery is retried hours later.
       */
      return {
        eventType: envelope.type,
        organizationId,
        detail: 'A payment failed, so dunning has started.',
        patch: {
          status: 'past_due',
          dunningStartedAt: now,
          dunningDeadline: dunningDeadlineFrom(now),
          notifyDunning: true,
        },
      };
    }
  }
}
