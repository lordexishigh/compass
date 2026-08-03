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

/**
 * What a piece of auth mail is for.
 *
 * The three token purposes, plus one message that carries no token: the lockout notice sent to
 * an owner when an account is locked by the rate limiter. It is a fourth *purpose* rather than a
 * fourth *port* because it is the same act — Compass telling a person something about their own
 * account by email — and a second mailer would mean a deployment could configure one transport
 * and silently drop the other. `AuthTokenPurpose` stays the narrower type on
 * `composeAuthMail`, so a token flow still cannot ask for a purpose there is no token for.
 */
export type AuthMailPurpose = AuthTokenPurpose | 'lockout_notice';

export interface AuthMailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. The link appears on its own line so a mail client makes it clickable. */
  readonly body: string;
  readonly purpose: AuthMailPurpose;
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
 * The message an owner gets when the rate limiter locks an account.
 *
 * ## Why the owner and not only the account holder
 *
 * A lockout is the visible end of a sustained failed-sign-in run against a named address, and the
 * person best placed to act on it is usually not the person whose address it was: they may be on
 * leave, or the address may be under attack precisely because it is not being watched. So the
 * owner is told, and the mail names the address so they can decide whether it is a colleague who
 * has forgotten a password or a list being worked through.
 *
 * ## What it deliberately does not say
 *
 * No password, no token, no IP address in full — `ipPrefix` is what the share-link log keeps and
 * this keeps the same discipline. And no link that unlocks anything: a "restore access" link in an
 * email would be a bypass of the lockout, mailed to an inbox, and the lockout would then be worth
 * exactly as much as that inbox. The way back in is waiting, or a mailed sign-in link, which is a
 * credential the person has to already control.
 */
export function composeLockoutMail(input: {
  readonly to: string;
  readonly organizationName: string;
  /** The account the attempts were against. Named so the owner can judge it. */
  readonly subjectEmail: string;
  /** How long this lockout lasts, already in words. */
  readonly lockedFor: string;
  /** Which consecutive lockout this is. Says whether it is a mistake or a campaign. */
  readonly strikes: number;
  /** Where an owner goes to look — the account screen, not an unlock link. */
  readonly link: string;
}): AuthMailMessage {
  const campaign =
    input.strikes > 1
      ? `This is the ${ordinal(input.strikes)} consecutive lockout on this account, and each one lasts longer than the last.`
      : 'This is the first lockout on this account.';

  return {
    to: input.to,
    purpose: 'lockout_notice',
    link: input.link,
    subject: `Sign-in attempts blocked for ${input.subjectEmail} — ${input.organizationName}`,
    body: [
      `Compass has stopped accepting sign-in attempts for ${input.subjectEmail} in ${input.organizationName}.`,
      '',
      `The rate limit was exceeded, so the account is locked for ${input.lockedFor}. ${campaign}`,
      '',
      'You are being told because you own this organization. Nothing has been changed and no password has been reset.',
      'If this is a colleague who has forgotten their password, they can use "email me a link" instead — a mailed',
      'sign-in link is not affected by this limit. If it is not a colleague, the account is already closed to the',
      'attempts and there is nothing you need to do to keep it closed.',
      '',
      input.link,
    ].join('\n'),
  };
}

const ordinal = (value: number): string => {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][value % 10] ?? 'th');
  return `${value}${suffix}`;
};

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
