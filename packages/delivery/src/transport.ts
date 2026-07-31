import type { RenderedEmail } from './email.js';
import { safeHeaderValue } from './email.js';
import type { SlackMessage } from './slack.js';

/**
 * The two transports, as ports.
 *
 * Ports rather than direct SDK calls, for the same reason the connector layer has one: the
 * worker's delivery handler must be testable without a network, and the fakes in
 * `testkit/` have to be indistinguishable from the real thing to everything above them.
 *
 * ## A missing key is a *stated outcome*, not an exception
 *
 * Both `send` methods answer with a `DeliveryOutcome` and neither throws for a missing key. A
 * deployment with no `RESEND_API_KEY` is an ordinary, documented state — the whole product runs
 * without one — so the transport reports `skipped` with a sentence naming the variable, the
 * worker writes that to `delivery_log`, and the process carries on. A throw here would take out
 * the worker for every other subscription in the organization.
 */

export type DeliveryOutcomeStatus = 'sent' | 'failed' | 'skipped';

export interface DeliveryOutcome {
  readonly status: DeliveryOutcomeStatus;
  /** The provider's own message id, when it accepted one. */
  readonly providerMessageId: string | null;
  /** The provider's error, verbatim, for an operator. Null on success. */
  readonly error: string | null;
  /** One sentence in the product's voice — what an operator reads first. */
  readonly detail: string;
}

export interface EmailMessage {
  readonly to: string;
  readonly rendered: RenderedEmail;
}

export interface EmailTransport {
  readonly transportId: string;
  /** True when the transport is configured enough to deliver. */
  readonly configured: boolean;
  send(message: EmailMessage): Promise<DeliveryOutcome>;
}

export interface SlackTarget {
  /** A user id (`U…`) for a DM, or `#channel` / a channel id for a channel. */
  readonly target: string;
}

export interface SlackTransport {
  readonly transportId: string;
  readonly configured: boolean;
  send(target: SlackTarget, messages: readonly SlackMessage[]): Promise<DeliveryOutcome>;
}

export const RESEND_API_KEY_ENV_VAR = 'RESEND_API_KEY';
export const RESEND_FROM_ENV_VAR = 'COMPASS_EMAIL_FROM';
export const SLACK_BOT_TOKEN_ENV_VAR = 'SLACK_BOT_TOKEN';

const skipped = (detail: string): DeliveryOutcome => ({
  status: 'skipped',
  providerMessageId: null,
  error: null,
  detail,
});

const failed = (error: string, detail: string): DeliveryOutcome => ({
  status: 'failed',
  providerMessageId: null,
  error,
  detail,
});

/**
 * Email over Resend's HTTP API.
 *
 * `fetch` rather than the `resend` SDK: the call is one POST with a JSON body, the SDK would be
 * a dependency carrying its own transitive tree for that, and the worker already has to handle
 * the failure modes itself to write a `delivery_log` row.
 *
 * SPF, DKIM and DMARC are domain configuration rather than code — they are set on the sending
 * domain in Resend and in DNS, and `docs/DEVELOPMENT.md` documents the three records. What this
 * transport must not do is undermine them, which is why `from` comes from configuration and
 * never from a request.
 */
export class ResendEmailTransport implements EmailTransport {
  readonly transportId = 'resend';
  readonly #apiKey: string | undefined;
  readonly #from: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: {
    readonly apiKey?: string | undefined;
    readonly from?: string | undefined;
    readonly fetchImpl?: typeof fetch;
  } = {}) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return (this.#apiKey ?? '').length > 0 && (this.#from ?? '').length > 0;
  }

  async send(message: EmailMessage): Promise<DeliveryOutcome> {
    if ((this.#apiKey ?? '').length === 0) {
      return skipped(
        `No ${RESEND_API_KEY_ENV_VAR} is set, so email delivery is unavailable and nothing was sent. The report ` +
          'itself was generated and is readable in Compass.',
      );
    }
    if ((this.#from ?? '').length === 0) {
      return skipped(
        `No ${RESEND_FROM_ENV_VAR} is set, so Compass has no verified sending address to deliver from. Set it to an ` +
          'address on the domain whose SPF, DKIM and DMARC records you configured in Resend.',
      );
    }

    try {
      const response = await this.#fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey ?? ''}`,
          'content-type': 'application/json',
          // Resend deduplicates on this, which makes a retried POST safe at the provider as
          // well as in `delivery_log`.
          'idempotency-key': message.rendered.subject,
        },
        body: JSON.stringify({
          from: safeHeaderValue(this.#from ?? ''),
          to: [safeHeaderValue(message.to)],
          subject: message.rendered.subject,
          html: message.rendered.html,
          text: message.rendered.text,
          headers: message.rendered.headers,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return failed(
          `Resend answered ${response.status}: ${detail.slice(0, 500)}`,
          `Resend refused the message with ${response.status}. The attempt is recorded and will be retried.`,
        );
      }

      const body = (await response.json().catch(() => ({}))) as { readonly id?: string };
      return {
        status: 'sent',
        providerMessageId: body.id ?? null,
        error: null,
        detail: `Delivered to ${message.to} through Resend.`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failed(reason, `Resend could not be reached: ${reason}. The attempt is recorded and will be retried.`);
    }
  }
}

/**
 * Slack over `chat.postMessage`.
 *
 * A DM and a channel are the same call: Slack resolves a user id to a DM conversation, so the
 * subscription's `target` goes straight into `channel` either way and there is no branch here
 * that could treat the two differently.
 *
 * A report that needed more than 50 blocks arrives as several messages, posted in order and
 * stopping at the first failure — a half-posted report is stated as a failure rather than
 * reported as a success.
 */
export class SlackApiTransport implements SlackTransport {
  readonly transportId = 'slack';
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly botToken?: string | undefined; readonly fetchImpl?: typeof fetch } = {}) {
    this.#token = options.botToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return (this.#token ?? '').length > 0;
  }

  async send(target: SlackTarget, messages: readonly SlackMessage[]): Promise<DeliveryOutcome> {
    if (!this.configured) {
      return skipped(
        `No ${SLACK_BOT_TOKEN_ENV_VAR} is set, so Slack delivery is unavailable and nothing was posted. The report ` +
          'itself was generated and is readable in Compass.',
      );
    }

    let lastMessageId: string | null = null;

    for (const [index, message] of messages.entries()) {
      try {
        const response = await this.#fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#token ?? ''}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel: target.target,
            text: message.text,
            blocks: message.blocks,
            // The report is the message. An unfurled link preview competing with it is noise.
            unfurl_links: false,
            unfurl_media: false,
          }),
        });

        // Slack answers 200 with `ok: false` for application errors, so the status alone is
        // not the outcome.
        const body = (await response.json().catch(() => ({}))) as {
          readonly ok?: boolean;
          readonly error?: string;
          readonly ts?: string;
        };

        if (!response.ok || body.ok !== true) {
          const reason = body.error ?? `HTTP ${response.status}`;
          return failed(
            `Slack answered ${reason}`,
            index === 0
              ? `Slack refused the message: ${reason}. The attempt is recorded and will be retried.`
              : `Slack accepted part ${index} of ${messages.length} and then refused: ${reason}. The attempt is ` +
                'recorded and will be retried.',
          );
        }

        lastMessageId = body.ts ?? lastMessageId;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return failed(reason, `Slack could not be reached: ${reason}. The attempt is recorded and will be retried.`);
      }
    }

    return {
      status: 'sent',
      providerMessageId: lastMessageId,
      error: null,
      detail:
        messages.length === 1
          ? `Posted to ${target.target}.`
          : `Posted to ${target.target} as ${messages.length} messages, in order.`,
    };
  }
}
