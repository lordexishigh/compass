import {
  feedbackOffersFor,
  isActionableSection,
  type FeedbackOffer,
  type SectionKey,
} from '@compass/analysis';
import type { Instant } from '@compass/clock';
import {
  findSubscriptionById,
  hasBeenSent,
  recordDeliveryAttempt,
  type ScopedDb,
  type StoredReportBundle,
  type StoredSubscription,
} from '@compass/db';
import {
  deliveryIdempotencyKey,
  dueDeliveries,
  feedbackLinkUrl,
  mintFeedbackToken,
  renderEmail,
  renderSlackMessages,
  scopesFor,
  type DeliveryOutcome,
  type EmailItemActions,
  type EmailTransport,
  type ScheduledDelivery,
  type SlackItemActions,
  type SlackTransport,
} from '@compass/delivery';
import type { RenderedReport } from '@compass/renderers';
import { z } from 'zod';

/**
 * Delivering one scheduled report to one channel.
 *
 * ## Retries, and why the limit is five
 *
 * `DELIVERY_RETRY_LIMIT` is 5 with exponential backoff (`retryBackoff: true`), so pg-boss spaces
 * the attempts over roughly half an hour rather than hammering a provider that is down. Five is
 * chosen against what the failures actually are: a Resend or Slack outage is usually minutes, and
 * a report is worth less with every hour it is late — a daily that arrives at 16:00 is not a
 * daily. After the fifth attempt the `delivery_log` rows are the record, and an operator can read
 * exactly what the provider said on each one. Documented in `docs/DEVELOPMENT.md` § Delivery.
 *
 * ## Why a duplicate cannot send twice
 *
 * Three independent mechanisms, because the queue alone is not enough:
 *
 *  1. A pg-boss `singletonKey` of (subscription, date, scope) collapses a duplicate *while the
 *     job is live*.
 *  2. `hasBeenSent` is checked before the provider is called, so a job that was drained and
 *     re-enqueued after the queue forgot the key declines to send rather than sending and then
 *     failing to record it.
 *  3. The partial unique index over `status = 'sent'` refuses a second successful row even if two
 *     workers race past step 2 at the same moment. That is the only one of the three that holds
 *     under genuine concurrency, which is why it lives in the database and not here.
 *
 * ## Nothing throws out of this handler except a malformed payload
 *
 * A missing report is a `deferred` row and a return. A missing provider key is the transport's own
 * `skipped` outcome, recorded and moved past. Both are ordinary documented states, and throwing
 * for either would take out the tick for every other subscriber in the organization. A *failed*
 * send does throw, deliberately — that is how pg-boss counts the attempt and applies the backoff —
 * but only after its `delivery_log` row is already written, so the throw costs no information.
 */

/** Five attempts with exponential backoff. See the note above for why five. */
export const DELIVERY_RETRY_LIMIT = 5;

export const DeliverPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  subscriptionId: z.uuid(),
  /** `YYYY-MM-DD`: the civil date of the scheduled send in the subscription's own zone. */
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scopeKind: z.enum(['team', 'merged']),
  scopeKey: z.string().min(1),
});

export type DeliverPayload = z.infer<typeof DeliverPayloadSchema>;

/**
 * The queue options every delivery job is enqueued with.
 *
 * The `singletonKey` is the same string the provider's idempotency header uses, so the queue and
 * Resend cannot disagree about what "the same send" means.
 */
export const deliveryJobOptions = (delivery: ScheduledDelivery) => ({
  singletonKey: deliveryIdempotencyKey(delivery),
  retryLimit: DELIVERY_RETRY_LIMIT,
  retryBackoff: true,
});

export interface DeliveryDependencies {
  /** Resolves the tenant-scoped handle for an organization. */
  readonly scopedFor: (organizationId: string) => ScopedDb;
  /** The report for (organization, scope, civil date), or null when none exists yet. */
  readonly loadReport: (
    scoped: ScopedDb,
    scope: { readonly scopeKind: string; readonly scopeKey: string },
    reportDate: string,
  ) => Promise<StoredReportBundle | null>;
  /** Turns a persisted bundle into the rendered form both channels read. */
  readonly renderStored: (bundle: StoredReportBundle) => RenderedReport;
  readonly email: EmailTransport;
  readonly slack: SlackTransport;
  /** Absolute origin for the report link. */
  readonly baseUrl: string;
  /** Builds the one-click unsubscribe URL from the subscription's own token digest. */
  readonly unsubscribeUrlFor: (subscription: StoredSubscription) => string;
  /**
   * The HMAC secret the email's feedback links are signed under, or undefined.
   *
   * Undefined is a supported state, not a misconfiguration to be worked around: the email then
   * carries no action links at all. Signing with a default key would put forgeable dismissal links
   * in every inbox, which is strictly worse than a report with no buttons.
   */
  readonly feedbackLinkSecret?: string | undefined;
  readonly newId: () => string;
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
}

export type DeliveryResultStatus =
  | 'sent'
  | 'failed'
  | 'deferred'
  | 'skipped'
  | 'unsubscribed'
  | 'already_sent';

/** What the handler did, so a caller and a test can assert without reading the log. */
export interface DeliveryResult {
  readonly status: DeliveryResultStatus;
  readonly detail: string;
}

export class InvalidDeliveryPayloadError extends Error {
  constructor(detail: string) {
    super(`Job \`report.deliver\` received a payload it cannot act on: ${detail}`);
    this.name = 'InvalidDeliveryPayloadError';
  }
}

/**
 * Delivers one (subscription, date, scope), recording an attempt whatever happens.
 *
 * `attempt` comes from pg-boss's own retry count so the log reflects the real sequence rather than
 * counting rows. A malformed payload is the one thing that throws unconditionally: it is a
 * programming error upstream, and there is no subscription to write a row against.
 */
export async function handleReportDeliver(
  dependencies: DeliveryDependencies,
  rawPayload: unknown,
  now: Instant,
  attempt = 1,
): Promise<DeliveryResult> {
  const parsed = DeliverPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new InvalidDeliveryPayloadError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; '),
    );
  }

  const payload = parsed.data;
  const scoped = dependencies.scopedFor(payload.organizationId);

  /**
   * The identity of this send, as exactly the four fields that define it.
   *
   * Built explicitly rather than by passing the payload through: the payload also carries
   * `organizationId`, and handing the transport a wider object would invite a future reader to
   * think the organization is part of the idempotency key when the scoping already covers it.
   */
  const delivery: ScheduledDelivery = {
    subscriptionId: payload.subscriptionId,
    deliveryDate: payload.deliveryDate,
    scopeKind: payload.scopeKind,
    scopeKey: payload.scopeKey,
  };

  const subscription = await findSubscriptionById(scoped, payload.subscriptionId);
  if (subscription === null) {
    // Nothing to deliver and nothing to log against. Not an error: a subscription can be removed
    // between the tick that enqueued this and the job running.
    const detail = `Subscription ${payload.subscriptionId} no longer exists, so nothing was delivered.`;
    dependencies.logger.warn(`[compass] ${detail}`);
    return { status: 'skipped', detail };
  }

  const record = async (
    status: 'sent' | 'failed' | 'deferred' | 'skipped' | 'unsubscribed',
    outcome: {
      readonly reportId: string | null;
      readonly providerMessageId: string | null;
      readonly error: string | null;
      readonly detail: string;
    },
  ): Promise<void> => {
    await recordDeliveryAttempt(
      scoped,
      {
        id: dependencies.newId(),
        subscriptionId: subscription.id,
        reportId: outcome.reportId,
        deliveryDate: payload.deliveryDate,
        scopeKind: payload.scopeKind,
        scopeKey: payload.scopeKey,
        channel: subscription.channel,
        target: subscription.target,
        attempt,
        status,
        providerMessageId: outcome.providerMessageId,
        error: outcome.error,
        detail: outcome.detail,
      },
      now,
    );
  };

  // Switched off between scheduling and sending. Recorded rather than silently dropped, so the log
  // explains why the daily stopped arriving.
  if (!subscription.active) {
    const detail = 'The subscription was switched off before this send, so nothing was delivered.';
    await record('unsubscribed', { reportId: null, providerMessageId: null, error: null, detail });
    return { status: 'unsubscribed', detail };
  }

  // The pre-send check. The partial unique index is the real guarantee; this stops the provider
  // being called at all by a job the queue no longer remembers running.
  if (await hasBeenSent(scoped, delivery)) {
    const detail = 'Already delivered for this date and scope, so this duplicate job sent nothing.';
    dependencies.logger.info(`[compass] ${detail} (${deliveryIdempotencyKey(delivery)})`);
    return { status: 'already_sent', detail };
  }

  const bundle = await dependencies.loadReport(
    scoped,
    { scopeKind: payload.scopeKind, scopeKey: payload.scopeKey },
    payload.deliveryDate,
  );

  // Defer rather than send an empty message. An absent report means generation has not run yet,
  // and "here is nothing" is worse than "this arrived late".
  if (bundle === null) {
    const detail =
      `No report exists yet for ${payload.scopeKind}:${payload.scopeKey} on ${payload.deliveryDate}, so nothing was ` +
      'sent. A later tick delivers it once generation has run.';
    await record('deferred', { reportId: null, providerMessageId: null, error: null, detail });
    return { status: 'deferred', detail };
  }

  const outcome = await sendThrough(dependencies, subscription, bundle, delivery, now);

  await record(outcome.status === 'sent' ? 'sent' : outcome.status === 'skipped' ? 'skipped' : 'failed', {
    reportId: bundle.report.id,
    providerMessageId: outcome.providerMessageId,
    error: outcome.error,
    detail: outcome.detail,
  });

  if (outcome.status === 'skipped') {
    // A missing provider key: documented, not a fault, and not worth retrying five times.
    dependencies.logger.warn(`[compass] ${outcome.detail}`);
    return { status: 'skipped', detail: outcome.detail };
  }

  if (outcome.status === 'failed') {
    // Thrown so pg-boss counts the attempt and applies the backoff. The row is already written.
    throw new Error(outcome.error ?? outcome.detail);
  }

  dependencies.logger.info(`[compass] ${outcome.detail}`);
  return { status: 'sent', detail: outcome.detail };
}

/**
 * The feedback affordances one stored report offers, per item.
 *
 * The *set* of actions comes from `feedbackOffersFor` in the analysis core, so the email, Slack and
 * the web page cannot disagree about what a manager may say about a given finding. What differs per
 * channel is only how the action is carried: a signed single-purpose URL in mail, a Block Kit button
 * value in Slack, a form POST on the page.
 */
export function itemOffersFor(
  bundle: StoredReportBundle,
): readonly {
  readonly itemStableId: string;
  readonly headline: string;
  readonly offers: readonly FeedbackOffer[];
}[] {
  const entries: { itemStableId: string; headline: string; offers: readonly FeedbackOffer[] }[] = [];

  for (const section of bundle.sections) {
    if (!isActionableSection(section.sectionKey as SectionKey)) continue;
    for (const item of section.items) {
      const offers = feedbackOffersFor(section.sectionKey as SectionKey, {
        entityRef: item.causeEntityRef,
        causeKind: item.causeKind,
        causeDiscriminator: item.causeDiscriminator,
      });
      if (offers.length === 0) continue;
      entries.push({ itemStableId: item.stableId, headline: item.headline, offers });
    }
  }

  return entries;
}

/**
 * The email's signed action links, or none at all.
 *
 * Returns an empty list when `COMPASS_FEEDBACK_LINK_SECRET` is unset, and that is the whole
 * fail-closed posture: Compass will not sign a dismissal link with a default key, because an HMAC
 * under a known secret is not a signature and the link would let anyone dismiss anyone's risk. The
 * email then simply carries no buttons — the report itself still arrives in full.
 */
export function emailItemActionsFor(
  bundle: StoredReportBundle,
  input: { readonly baseUrl: string; readonly now: Instant; readonly secret: string | undefined },
): readonly EmailItemActions[] {
  if (input.secret === undefined || input.secret.length === 0) return [];

  return itemOffersFor(bundle).map((entry) => ({
    itemStableId: entry.itemStableId,
    headline: entry.headline,
    actions: entry.offers.map((offer) => ({
      action: offer.action,
      label: offer.label,
      url: feedbackLinkUrl(
        input.baseUrl,
        mintFeedbackToken(
          {
            organizationId: bundle.report.organizationId,
            itemStableId: entry.itemStableId,
            action: offer.action,
          },
          input.now,
          input.secret,
        ).token,
      ),
    })),
  }));
}

/** The same offers as Slack buttons. No secret needed: a Slack action is authorized by signature. */
export function slackItemActionsFor(bundle: StoredReportBundle): readonly SlackItemActions[] {
  return itemOffersFor(bundle).map((entry) => ({
    itemStableId: entry.itemStableId,
    headline: entry.headline,
    actions: entry.offers.map((offer) => ({ action: offer.action, label: offer.label })),
  }));
}

/** Renders for the subscription's channel and hands it to that channel's transport. */
async function sendThrough(
  dependencies: DeliveryDependencies,
  subscription: StoredSubscription,
  bundle: StoredReportBundle,
  delivery: ScheduledDelivery,
  /** The job's own instant, from the worker's one clock. The link's 30 days start here. */
  now: Instant,
): Promise<DeliveryOutcome> {
  const report = dependencies.renderStored(bundle);
  const reportUrl = `${dependencies.baseUrl.replace(/\/+$/, '')}/`;

  if (subscription.channel === 'email') {
    const rendered = renderEmail(report, {
      reportUrl,
      unsubscribeUrl: dependencies.unsubscribeUrlFor(subscription),
      recipient: subscription.target,
      itemActions: emailItemActionsFor(bundle, {
        baseUrl: dependencies.baseUrl,
        now,
        secret: dependencies.feedbackLinkSecret,
      }),
    });
    return dependencies.email.send({ to: subscription.target, rendered, delivery });
  }

  const messages = renderSlackMessages(report, { reportUrl, itemActions: slackItemActionsFor(bundle) });
  return dependencies.slack.send({ target: subscription.target }, messages);
}

/**
 * Every delivery due at `now`, as job payloads.
 *
 * The tick's whole job: take the active subscriptions, ask the scheduler which are due, and expand
 * each into the scopes it covers. Team keys come from the roster and are passed in by the caller —
 * nothing here holds a copy of who is on which team.
 */
export function deliveryJobsDue(
  subscriptions: readonly StoredSubscription[],
  teamKeysFor: (subscription: StoredSubscription) => readonly string[],
  now: Instant,
  organizationId: string,
  options: { readonly lookbackDays?: number } = {},
): readonly DeliverPayload[] {
  const due = dueDeliveries(
    subscriptions.map((subscription) => ({
      id: subscription.id,
      channel: subscription.channel,
      scope: subscription.scope,
      sendTime: subscription.sendTime,
      timezone: subscription.timezone,
      active: subscription.active,
    })),
    now,
    options,
  );

  const byId = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
  const jobs: DeliverPayload[] = [];

  for (const entry of due) {
    const subscription = byId.get(entry.subscriptionId);
    if (subscription === undefined) continue;

    for (const scope of scopesFor(entry.scope, teamKeysFor(subscription))) {
      jobs.push({
        organizationId,
        subscriptionId: entry.subscriptionId,
        deliveryDate: entry.deliveryDate,
        scopeKind: scope.scopeKind,
        scopeKey: scope.scopeKey,
      });
    }
  }

  return jobs;
}
