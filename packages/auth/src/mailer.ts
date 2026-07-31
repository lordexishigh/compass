import type { AuthTokenPurpose } from '@compass/db';

import { TOKEN_TTL_LABEL } from './secrets.js';

/**
 * The outbound mail port.
 *
 * Three flows have to put a link in front of a person: a magic-link sign-in, a
 * password reset and a seat invitation. Which transport carries them is a
 * deployment concern that `alpha-delivery-email-and-slack` owns, so this is a port
 * with a fake and a console transport, in the same shape as `@compass/connector-port`
 * — the flows are written against the interface, the transport is chosen at the
 * process edge, and the tests use `RecordingMailer` and assert on real messages
 * rather than on a spy.
 *
 * The port is deliberately narrow: one method, one message shape, no templates, no
 * attachments, no HTML. The body text is composed here so every deployment sends the
 * same words and so a test can assert the link and the stated lifetime are both in
 * the message a person would actually receive.
 */

export interface AuthMailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. The link appears on its own line so a mail client makes it clickable. */
  readonly body: string;
  readonly purpose: AuthTokenPurpose;
  /** The absolute URL that was mailed. Kept separate so a test need not parse the body. */
  readonly link: string;
}

export interface AuthMailer {
  send(message: AuthMailMessage): Promise<void>;
}

/** Composes the message for each kind of link. One place, so the wording is one wording. */
export function composeAuthMail(input: {
  readonly purpose: AuthTokenPurpose;
  readonly to: string;
  readonly link: string;
  readonly organizationName: string;
  readonly invitedByName?: string | null;
}): AuthMailMessage {
  const lifetime = TOKEN_TTL_LABEL[input.purpose];

  switch (input.purpose) {
    case 'magic_link':
      return {
        to: input.to,
        purpose: input.purpose,
        link: input.link,
        subject: `Sign in to Compass — ${input.organizationName}`,
        body: [
          `Open this to sign in to ${input.organizationName}:`,
          '',
          input.link,
          '',
          `The link works once and expires in ${lifetime}. If you did not ask for it, nothing has happened to`,
          'your account and you can ignore this message.',
        ].join('\n'),
      };

    case 'password_reset':
      return {
        to: input.to,
        purpose: input.purpose,
        link: input.link,
        subject: `Reset your Compass password — ${input.organizationName}`,
        body: [
          'Open this to choose a new password:',
          '',
          input.link,
          '',
          `The link works once and expires in ${lifetime}. Your current password still works until you use it.`,
          'If you did not ask for a reset, ignore this message.',
        ].join('\n'),
      };

    case 'invite': {
      const inviter =
        input.invitedByName === undefined || input.invitedByName === null || input.invitedByName.length === 0
          ? 'An owner'
          : input.invitedByName;
      return {
        to: input.to,
        purpose: input.purpose,
        link: input.link,
        subject: `${inviter} invited you to Compass — ${input.organizationName}`,
        body: [
          `${inviter} has given you a seat in ${input.organizationName} on Compass.`,
          '',
          'Open this to choose a name and a password:',
          '',
          input.link,
          '',
          `The invitation works once and expires in ${lifetime}. An owner can send another if it lapses.`,
        ].join('\n'),
      };
    }
  }
}

/**
 * A mailer that keeps what it was asked to send.
 *
 * Used by the tests, and by a deployment with no mail transport configured — where
 * dropping the message silently would be worse than holding it in memory and saying
 * so on the readiness endpoint.
 */
export class RecordingMailer implements AuthMailer {
  readonly #sent: AuthMailMessage[] = [];

  async send(message: AuthMailMessage): Promise<void> {
    this.#sent.push(message);
  }

  get sent(): readonly AuthMailMessage[] {
    return this.#sent;
  }

  /** The most recent message to one address, for a test that just sent one. */
  lastTo(email: string): AuthMailMessage | null {
    const lower = email.trim().toLowerCase();
    for (let index = this.#sent.length - 1; index >= 0; index -= 1) {
      const message = this.#sent[index];
      if (message !== undefined && message.to.trim().toLowerCase() === lower) return message;
    }
    return null;
  }

  clear(): void {
    this.#sent.length = 0;
  }
}

/**
 * Writes the message to the process log, and keeps it.
 *
 * This is the default transport, and it is honest about what it is: on a laptop or
 * in `docker compose up` there is no SMTP credential, and a sign-in link nobody can
 * reach would make the whole flow untestable by hand. So the link is printed where
 * the operator can copy it, and `/api/health` states that mail is going to the log
 * rather than to an inbox.
 */
export class ConsoleMailer extends RecordingMailer {
  override async send(message: AuthMailMessage): Promise<void> {
    await super.send(message);
    console.info(
      `[compass] mail not configured — ${message.purpose} for ${message.to} would have said:\n${message.body}\n`,
    );
  }
}
