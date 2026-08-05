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
export type AuthMailPurpose =
  | AuthTokenPurpose
  | 'lockout_notice'
  /**
   * The two deletion messages, for the same reason `lockout_notice` is here: they are
   * Compass telling a person something about their own account, and a separate port would
   * mean a deployment could configure mail for sign-in and silently drop the message that
   * says "your data is being deleted, here is how to stop it".
   *
   * `deletion_undo` carries the undo link and goes out the moment deletion is requested.
   * `deletion_confirmation` carries no link — there is nothing left to click — and
   * enumerates what was deleted.
   */
  | 'deletion_undo'
  | 'deletion_confirmation'
  /**
   * The failed-payment notice, for the same reason again.
   *
   * A dunning email is Compass telling the owner something about their own organization, on the one
   * transport a deployment configures. It carries no token: the link goes to `/billing`, which requires
   * the session the owner already has, because a "fix your card" link that authenticated on its own
   * would be a payment-method-change credential sitting in an inbox.
   */
  | 'dunning_notice'
  /**
   * The two subprocessor-notice messages, and the one case in this union where the recipient is *not*
   * an account holder.
   *
   * Compass publishes a 30-day advance-notice commitment on `/trust/subprocessors`, and the person who
   * most needs it is a data protection officer evaluating the product who has no seat and never will.
   * They are here rather than on a separate transport for the reason every other purpose is: a
   * deployment configures one mailer, and a second one would mean an operator could configure sign-in
   * mail and silently drop the notice they had contractually promised to send.
   *
   * `subprocessor_notice_confirmation` carries a confirmation link, because an address nobody confirmed
   * is an address somebody else may have typed. `subprocessor_change_notice` carries the unsubscribe
   * link and the date the change takes effect.
   */
  | 'subprocessor_notice_confirmation'
  | 'subprocessor_change_notice'
  /**
   * The SCIM provisioning token, and the one purpose in this union that carries a *credential*.
   *
   * ## Why it is mailed rather than returned by the API that creates it
   *
   * A bearer token has to reach the administrator somehow, and the obvious channel — the response body
   * of `POST /api/enterprise/identity` — is closed by design. `compass/no-secret-disclosure` refuses a
   * credential in any response, and `tools/quality-gates/tests/security-posture.test.ts` additionally
   * asserts that **no file anywhere disables that rule**, precisely so the next person cannot decide
   * their case is the exception. That gate is right even about this case, and the reasoning is worth
   * stating rather than worked around:
   *
   *  - a token in a response body is in the browser's memory, in any proxy that terminated TLS, and in
   *    whatever the operator's console had open — and this one can create and remove seats;
   *  - the screen that would display it is the screen an administrator is most likely to be
   *    screen-sharing, because they are configuring an integration with somebody from IT on a call.
   *
   * Mail is the channel this product already uses to deliver a one-time secret — a magic link and a
   * password-reset link are both credentials in an inbox — so this is the established idiom rather than
   * a new one. It also gives the token an audit trail that a response body does not: the delivery is a
   * message to a named address.
   *
   * Only the SHA-256 is stored, so this message is the one and only time the value exists outside the
   * identity provider's configuration.
   */
  | 'scim_token';

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
 * The two deletion messages, composed in one place so their two senders agree.
 *
 * The undo notice is sent by the web edge the moment deletion is requested; the
 * confirmation is sent by the worker once the purge has run, up to thirty days later.
 * Different processes, weeks apart — which is exactly the situation where two copies of
 * the wording drift and a person is told a category was deleted that was not.
 *
 * ## What the undo notice deliberately does
 *
 * It states the deadline as a date the reader can check, offers the export *before* the
 * purge rather than after (after is too late by construction), and puts the undo link on
 * its own line so every mail client makes it clickable. It does not ask the reader to
 * confirm they meant it: they already did that in the product, and a second confirmation
 * would make the first one meaningless.
 */
export function composeDeletionUndoMail(input: {
  readonly to: string;
  readonly organizationName: string;
  readonly subjectKind: 'account' | 'organization';
  readonly undoLink: string;
  readonly exportLink: string;
  /** The grace deadline, already formatted in the reader's own zone by the caller. */
  readonly graceEndsOn: string;
  readonly hardDeleteBy: string;
}): AuthMailMessage {
  const what =
    input.subjectKind === 'organization'
      ? `the whole of ${input.organizationName} on Compass`
      : `your Compass account in ${input.organizationName}`;

  return {
    to: input.to,
    purpose: 'deletion_undo',
    link: input.undoLink,
    subject:
      input.subjectKind === 'organization'
        ? `${input.organizationName} is scheduled for deletion — you have until ${input.graceEndsOn}`
        : `Your Compass account is scheduled for deletion — you have until ${input.graceEndsOn}`,
    body: [
      `Somebody asked Compass to delete ${what}.`,
      '',
      `Nothing has been deleted yet. You have until ${input.graceEndsOn} to change your mind, and until then`,
      'everything works exactly as it did. Open this to cancel:',
      '',
      input.undoLink,
      '',
      'Take a copy first if you want one. This downloads everything Compass holds, as JSON:',
      '',
      input.exportLink,
      '',
      `After ${input.graceEndsOn} the deletion runs and cannot be undone. It will have finished by`,
      `${input.hardDeleteBy}, and Compass will send one more message listing exactly what was deleted.`,
    ].join('\n'),
  };
}

/**
 * The confirmation, sent once the purge has actually run.
 *
 * `categories` comes from the erasure itself rather than from a constant beside this
 * function, so the message cannot claim a category the code did not touch. That is the
 * whole reason `deletion_requests.deleted_categories` is a column: the email is generated
 * from what happened, not from what was meant to happen.
 */
export function composeDeletionConfirmationMail(input: {
  readonly to: string;
  readonly organizationName: string;
  readonly subjectKind: 'account' | 'organization';
  readonly categories: readonly string[];
  readonly completedOn: string;
  /** Anything deliberately kept, stated plainly. Empty when nothing was. */
  readonly retained?: readonly string[];
}): AuthMailMessage {
  const what =
    input.subjectKind === 'organization'
      ? `${input.organizationName} has been deleted from Compass.`
      : `Your Compass account in ${input.organizationName} has been deleted.`;

  const retained = input.retained ?? [];

  return {
    to: input.to,
    purpose: 'deletion_confirmation',
    // No link: there is nothing left to open. The field is on the message for the token
    // flows, and an empty string is the honest value rather than a URL to a dead page.
    link: '',
    subject:
      input.subjectKind === 'organization'
        ? `${input.organizationName} has been deleted from Compass`
        : 'Your Compass account has been deleted',
    body: [
      what,
      `Completed ${input.completedOn}. This is what was deleted:`,
      '',
      ...input.categories.map((category) => `  - ${category}`),
      ...(retained.length === 0
        ? []
        : [
            '',
            'Compass has kept the following, and this is why:',
            '',
            ...retained.map((entry) => `  - ${entry}`),
          ]),
      '',
      'Nothing further is required from you, and this address will not be contacted again.',
    ].join('\n'),
  };
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

/**
 * The message an owner gets when a payment fails.
 *
 * Criterion 002 asks for the failed payment to be notified **by email** and for the deadline to be
 * stated in-app. The in-app half is `billingState`'s notice on `/billing`; this is the other half, and
 * it deliberately states the *same* deadline from the same stored instant rather than recomputing one —
 * two places computing a deadline is how an owner comes to be told two different dates.
 *
 * ## What it does not do
 *
 * No card details, no amount taken from a request, and no link that could change a payment method
 * without a session. The link is `/billing`, which the owner reaches with the session they already
 * have; anything self-authenticating in an inbox would be a payment-method credential.
 *
 * It also does not threaten more than is true. Access is *not* cut when a payment fails — Compass keeps
 * generating until the deadline, because a card expires far more often than a customer leaves — so the
 * mail says what actually happens and when, which is the only version an owner can plan around.
 */
export function composeDunningMail(input: {
  readonly to: string;
  readonly organizationName: string;
  /** The deadline, already formatted for a human by the caller that owns the timezone. */
  readonly deadlineLabel: string | null;
  /** Where the owner goes to fix it: the billing page, behind their own session. */
  readonly link: string;
}): AuthMailMessage {
  return {
    to: input.to,
    purpose: 'dunning_notice',
    link: input.link,
    subject: `Payment failed for ${input.organizationName} — Compass`,
    body: [
      `A payment for ${input.organizationName} did not go through.`,
      '',
      input.deadlineLabel === null
        ? 'Compass is still generating and delivering your daily report. Update the payment method to keep it that way.'
        : `Compass is still generating and delivering your daily report, and will keep doing so until ` +
          `${input.deadlineLabel}. If the payment has not succeeded by then, Compass stops writing new ` +
          'reports — every report it has already written stays readable and your data stays exportable.',
      '',
      'You are being told because you own this organization. Nothing has been cancelled and no data has been',
      'deleted. The usual cause is an expired card.',
      '',
      input.link,
    ].join('\n'),
  };
}

/**
 * The confirmation an address gets when it asks for subprocessor change notices.
 *
 * ## Why a confirmation at all, for a list with nothing to send
 *
 * The endpoint is public — it has to be, because the audience is people without accounts — so anybody
 * could type somebody else's address into it. Without a confirmation step, the first thing that address
 * would receive from Compass is a notice it never asked for, which is indistinguishable from Compass
 * having leaked it. So the row is stored unconfirmed and is never sent a notice until the link below is
 * followed.
 *
 * The mail deliberately promises how little it will send: one confirmation, then nothing until the list
 * actually changes. A subscription that turns out to be a newsletter is the reason people do not
 * subscribe to things that matter.
 */
export function composeSubprocessorConfirmationMail(input: {
  readonly to: string;
  /** The absolute confirmation URL, carrying the token. Built by the caller. */
  readonly link: string;
  readonly noticeDays: number;
}): AuthMailMessage {
  return {
    to: input.to,
    purpose: 'subprocessor_notice_confirmation',
    link: input.link,
    subject: 'Confirm your Compass subprocessor change notices',
    body: [
      'Somebody — we hope you — asked to be told before Compass changes the list of companies that',
      'process data on its behalf.',
      '',
      `Confirm below and Compass will email you at least ${input.noticeDays} days before it adds a`,
      'subprocessor, removes one, or changes what any of them receives. That is the only thing this list',
      'is used for: there is no newsletter and nothing else to send.',
      '',
      'If this was not you, ignore this email. Nothing has been subscribed — Compass does not send the',
      'notice to an address that has not confirmed, precisely so that somebody typing your address',
      'cannot sign you up to mail from us.',
      '',
      input.link,
    ].join('\n'),
  };
}

/**
 * The 30-day advance notice itself.
 *
 * `effectiveLabel` is the date the change takes effect, already formatted by the caller that owns the
 * timezone — the same division `composeDunningMail` uses. The body states *what* changed rather than
 * only that something did, because a notice that requires the reader to go and diff a web page has not
 * given them 30 days of anything useful.
 */
export function composeSubprocessorChangeMail(input: {
  readonly to: string;
  /** One line per change, already phrased: "Added: Acme (error tracking, EU)". */
  readonly changes: readonly string[];
  readonly effectiveLabel: string;
  readonly noticeDays: number;
  /** Where the current list lives. */
  readonly link: string;
  /** One-click unsubscribe, carrying the token. */
  readonly unsubscribeLink: string;
}): AuthMailMessage {
  return {
    to: input.to,
    purpose: 'subprocessor_change_notice',
    link: input.link,
    subject: `Compass is changing its subprocessor list on ${input.effectiveLabel}`,
    body: [
      `Compass is changing the list of companies that process data on its behalf. The change takes`,
      `effect on ${input.effectiveLabel}, which is at least ${input.noticeDays} days from today — you are`,
      'being told in advance so you have time to object, ask a question, or stop using the product.',
      '',
      'What is changing:',
      ...input.changes.map((change) => `  - ${change}`),
      '',
      'The full current list, with the data category and processing region for each entry:',
      input.link,
      '',
      `To stop receiving these notices: ${input.unsubscribeLink}`,
    ].join('\n'),
  };
}

/**
 * The SCIM provisioning token, to the owner who asked for it.
 *
 * The module header on `scim_token` explains why this is a message rather than a response body. Two
 * things about the shape of it:
 *
 *  - **The token is in the body and not in a link.** There is nothing to click: the value is pasted into
 *    an identity provider's console. Putting it in a URL would additionally leave it in whatever the
 *    mail client turned into a preview.
 *  - **The message says what to do if it was not expected.** A provisioning token that arrives unasked
 *    means somebody with owner access issued one, which is exactly the moment the owner should look at
 *    the audit log — so the message points there rather than only congratulating them.
 */
export function composeScimTokenMail(input: {
  readonly to: string;
  readonly organizationName: string;
  /** What the operator called this token, so a rotation can be told apart from a first issue. */
  readonly label: string;
  /** The token itself. This message is the only place it will ever appear. */
  readonly token: string;
  /** The SCIM base URL to configure alongside it. */
  readonly scimUrl: string;
  /** Where to go to revoke it — the enterprise screen. */
  readonly link: string;
}): AuthMailMessage {
  return {
    to: input.to,
    purpose: 'scim_token',
    link: input.link,
    subject: `SCIM provisioning token for ${input.organizationName}`,
    body: [
      `A SCIM provisioning token was issued for ${input.organizationName}, labelled "${input.label}".`,
      '',
      'Paste this into your identity provider’s SCIM configuration:',
      '',
      `  SCIM base URL:  ${input.scimUrl}`,
      `  Bearer token:   ${input.token}`,
      '',
      'This is the only copy. Compass stores only a SHA-256 of the token, so it cannot be shown or',
      'recovered again — if it is lost, issue a new one and revoke this one.',
      '',
      'The token can create and remove seats in this organization, so treat it as a password. Revoke it',
      `from the enterprise screen the moment it is no longer needed: ${input.link}`,
      '',
      'If you did not ask for this, somebody with owner access to your organization did. The audit log',
      'records who issued it and when.',
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
