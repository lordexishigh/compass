import { composeSubprocessorChangeMail, type AuthMailer } from '@compass/auth';
import { addExactDays, formatCivilDate, toIso, type Instant } from '@compass/clock';
import {
  recordNoticeSent,
  subscribersAwaitingNotice,
  type ScopedDb,
  type StoredNoticeSubscriber,
} from '@compass/db';
import {
  SUBPROCESSOR_NOTICE_DAYS,
  describeSubprocessorChanges,
  subprocessorDigest,
} from '@compass/trust';

/**
 * The 30-day subprocessor change notice.
 *
 * ## What makes this a real obligation rather than a page that claims one
 *
 * `/trust/subprocessors` promises at least {SUBPROCESSOR_NOTICE_DAYS} days' warning before the list
 * changes. That promise is only kept if something notices the change and mails the people who asked —
 * so this job compares the digest of the *published* list against the digest each subscriber was last
 * told, and mails the difference. Both halves read the same array from `@compass/trust`, so the page and
 * the notice cannot disagree about what the list is.
 *
 * ## Why the change is detected by content, not by somebody remembering
 *
 * A human step — "when you add a subprocessor, remember to email the list" — is the step that gets
 * skipped in the release where it matters. The digest is derived from the array, so editing the array
 * *is* the trigger. There is nothing to remember and nothing to forget.
 *
 * ## The thirty days
 *
 * The notice states an effective date of `now + {SUBPROCESSOR_NOTICE_DAYS} days`, taken from the injected
 * clock. So the advance notice is structural: the date in the email is derived from when the email is
 * sent, and cannot be closer than the commitment. `now` is a parameter rather than a clock read for the
 * usual reason — it is what lets the test assert the thirty days by choosing an instant instead of
 * waiting a month.
 *
 * ## Ordering, and why the row is written after the send
 *
 * `recordNoticeSent` runs *after* the transport returns. A mail transport that throws therefore leaves the
 * subscriber's digest unchanged and the next run tries again; the opposite order would mark somebody as
 * notified about a change they were never told about, which is precisely the failure this job exists to
 * prevent.
 */

/**
 * Daily, at 04:41 UTC.
 *
 * Daily rather than hourly because the obligation is measured in days — a notice sent at 04:00 instead of
 * 03:00 is indistinguishable to the recipient — and because the job is a no-op on every day the list has
 * not changed. Off the hour for the reason the nightly scan is: everything in the world fires at :00.
 */
export const SUBPROCESSOR_NOTICE_CRON = '41 4 * * *';

export interface TrustNoticeDependencies {
  readonly scopedFor: (organizationId: string) => ScopedDb;
  readonly mailer: AuthMailer;
  /** Absolute origin, so the mailed links reach this deployment. */
  readonly baseUrl: string;
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface TrustNoticeOutcome {
  /** Addresses actually mailed. */
  readonly notified: readonly string[];
  /** Subscribers considered — confirmed, and behind the published digest. */
  readonly considered: number;
  /** The effective date stated in every notice this run sent. */
  readonly effectiveAtIso: string;
}

/** The unsubscribe link for one subscriber. The token itself is not stored, so the *hash* is the id here. */
const unsubscribeLinkFor = (baseUrl: string, subscriber: StoredNoticeSubscriber): string =>
  // The subscriber holds the token from their confirmation mail; this link carries the same route and
  // action. It is deliberately not a second secret: one token per subscription, doing both jobs.
  `${baseUrl}/api/trust/subprocessor-notices/confirm?action=unsubscribe&token=${subscriber.unsubscribeTokenHash}`;

/**
 * Sends the notice to everybody who is behind, and records what they were told.
 *
 * Returns the outcome rather than logging only, so the test asserts on values instead of on a captured
 * stream. Nothing here throws on a transport failure: one broken address must not stop the other
 * subscribers being told.
 */
export async function handleSubprocessorNotice(
  dependencies: TrustNoticeDependencies,
  input: { readonly organizationId: string; readonly now: Instant },
): Promise<TrustNoticeOutcome> {
  const scoped = dependencies.scopedFor(input.organizationId);
  const currentDigest = subprocessorDigest();

  const pending = await subscribersAwaitingNotice(scoped, currentDigest);
  const effectiveAt = addExactDays(input.now, SUBPROCESSOR_NOTICE_DAYS);
  const effectiveLabel = formatCivilDate(effectiveAt, 'UTC');
  const notified: string[] = [];

  for (const subscriber of pending) {
    const changes = describeSubprocessorChanges(subscriber.lastNoticedDigest, currentDigest);

    /**
     * Nothing describable to say, so nothing is sent — but the digest is still advanced.
     *
     * This is the case where a subscriber's stored digest predates the format, or where the only
     * difference is one the description cannot articulate. Mailing "the list changed, we cannot say how"
     * would be worse than silence, and *not* advancing the digest would retry it forever on every tick.
     */
    if (changes.length === 0) {
      await recordNoticeSent(scoped, { id: subscriber.id, digest: currentDigest }, input.now);
      continue;
    }

    try {
      await dependencies.mailer.send(
        composeSubprocessorChangeMail({
          to: subscriber.email,
          changes,
          effectiveLabel,
          noticeDays: SUBPROCESSOR_NOTICE_DAYS,
          link: `${dependencies.baseUrl}/trust/subprocessors`,
          unsubscribeLink: unsubscribeLinkFor(dependencies.baseUrl, subscriber),
        }),
      );

      // Only after the send. See the header.
      await recordNoticeSent(scoped, { id: subscriber.id, digest: currentDigest }, input.now);
      notified.push(subscriber.email);
    } catch (error) {
      // One address that will not accept mail must not stop the rest being told, and it must not be
      // marked notified either — the next run retries it.
      dependencies.logger.warn(
        `[compass] a subprocessor change notice could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (notified.length > 0) {
    dependencies.logger.info(
      `[compass] sent ${notified.length} subprocessor change notice${notified.length === 1 ? '' : 's'}, ` +
        `effective ${effectiveLabel}`,
    );
  }

  return { notified, considered: pending.length, effectiveAtIso: toIso(effectiveAt) };
}
