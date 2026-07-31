import type {
  DeliveryOutcome,
  EmailMessage,
  EmailTransport,
  SlackTarget,
  SlackTransport,
} from '../transport.js';
import type { SlackMessage } from '../slack.js';

/**
 * Recording fakes for the two transports.
 *
 * Same convention as `@compass/narrator`'s and `@compass/connector-port`'s testkits: the fake is
 * indistinguishable from the real transport to everything above it, so the worker's delivery
 * handler under test is the production code path with the network removed.
 *
 * They record rather than assert. A test that wants to check the email body reads
 * `transport.sent[0].rendered.html` and makes its own assertions, which keeps the fake free of
 * opinions about what a correct message looks like.
 */

export class FakeEmailTransport implements EmailTransport {
  readonly transportId = 'fake-email';
  readonly sent: EmailMessage[] = [];
  #outcome: DeliveryOutcome | null = null;
  #configured = true;

  /** Makes the next and every subsequent send answer with this outcome instead of `sent`. */
  answerWith(outcome: DeliveryOutcome): this {
    this.#outcome = outcome;
    return this;
  }

  /** Models a deployment with no `RESEND_API_KEY`. */
  unconfigured(): this {
    this.#configured = false;
    return this;
  }

  get configured(): boolean {
    return this.#configured;
  }

  async send(message: EmailMessage): Promise<DeliveryOutcome> {
    if (!this.#configured) {
      return {
        status: 'skipped',
        providerMessageId: null,
        error: null,
        detail: 'No RESEND_API_KEY is set, so email delivery is unavailable and nothing was sent.',
      };
    }

    this.sent.push(message);
    return (
      this.#outcome ?? {
        status: 'sent',
        providerMessageId: `fake-email-${this.sent.length}`,
        error: null,
        detail: `Delivered to ${message.to}.`,
      }
    );
  }
}

export interface RecordedSlackPost {
  readonly target: SlackTarget;
  readonly messages: readonly SlackMessage[];
}

export class FakeSlackTransport implements SlackTransport {
  readonly transportId = 'fake-slack';
  readonly sent: RecordedSlackPost[] = [];
  #outcome: DeliveryOutcome | null = null;
  #configured = true;

  answerWith(outcome: DeliveryOutcome): this {
    this.#outcome = outcome;
    return this;
  }

  /** Models a deployment with no `SLACK_BOT_TOKEN`. */
  unconfigured(): this {
    this.#configured = false;
    return this;
  }

  get configured(): boolean {
    return this.#configured;
  }

  async send(target: SlackTarget, messages: readonly SlackMessage[]): Promise<DeliveryOutcome> {
    if (!this.#configured) {
      return {
        status: 'skipped',
        providerMessageId: null,
        error: null,
        detail: 'No SLACK_BOT_TOKEN is set, so Slack delivery is unavailable and nothing was posted.',
      };
    }

    this.sent.push({ target, messages });
    return (
      this.#outcome ?? {
        status: 'sent',
        providerMessageId: `fake-slack-${this.sent.length}`,
        error: null,
        detail: `Posted to ${target.target}.`,
      }
    );
  }
}
