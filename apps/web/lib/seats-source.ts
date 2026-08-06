import { MILLIS_PER_DAY, formatCivilDate, toEpochMillis, type Instant } from '@compass/clock';
import type { SeatRow } from '@compass/db';

import type { SeatView } from '../components/seat-manager';

/**
 * Seat rows → the sentences the members screen reads.
 *
 * A pure function of `(seats, now, viewerUserId)`, which is the point: "this invitation
 * expired" and "last active 6 days ago" are both statements about *when*, and a component
 * that read the clock itself could not be tested for either without waiting. `now` arrives
 * from `pageAccess`, which took it from the one sanctioned clock read at the edge.
 *
 * The two dates are computed here rather than in the component for the same reason the
 * report's prose is computed before it is narrated: the screen's job is to set the facts,
 * not to work them out.
 */

/** Everything the screen states about time lives in this zone. */
const DISPLAY_ZONE = 'UTC';

const wholeDaysBetween = (from: Instant, to: Instant): number =>
  Math.floor((toEpochMillis(to) - toEpochMillis(from)) / MILLIS_PER_DAY);

/**
 * "when was this person last here", in the product's voice.
 *
 * Null — never signed in — is a first-class answer rather than a blank cell, because for a
 * pending invitation it is the *expected* answer and rendering it as an absence would read
 * as missing data. Honest degradation over confident polish: the screen says the thing.
 */
export function lastActivePhrase(lastActiveAt: Instant | null, now: Instant): string {
  if (lastActiveAt === null) return 'never signed in';

  const days = wholeDaysBetween(lastActiveAt, now);
  if (days <= 0) return 'last active today';
  if (days === 1) return 'last active yesterday';
  return `last active ${days} days ago`;
}

/**
 * What a pending seat's invitation is doing, or null when the seat is not pending.
 *
 * Three outcomes, and they need different remedies from the reader:
 *
 *  - **live** — sent, not yet accepted, still redeemable. Says when it stops being.
 *  - **expired** — past its fourteen days. `acceptInvite` refuses it as `expired`, so the
 *    screen must not imply that the person can still click the link they were sent.
 *  - **none** — pending with no unconsumed token, which is what a revoked-then-restored
 *    seat looks like. Resending is the way out of all three.
 */
export type InviteState = 'live' | 'expired' | 'none';

export interface InviteStanding {
  readonly state: InviteState;
  readonly phrase: string;
}

export function inviteStanding(seat: SeatRow, now: Instant): InviteStanding | null {
  if (seat.status !== 'pending') return null;

  if (seat.inviteExpiresAt === null) {
    return {
      state: 'none',
      phrase: 'no invitation is outstanding — resend to issue one',
    };
  }

  // The same comparison `tokenRejection` makes, so the sentence and the door agree.
  if (now >= seat.inviteExpiresAt) {
    return {
      state: 'expired',
      phrase: `invitation expired ${formatCivilDate(seat.inviteExpiresAt, DISPLAY_ZONE)} and can no longer be redeemed — resend to issue a new link`,
    };
  }

  return {
    state: 'live',
    phrase: `invitation expires ${formatCivilDate(seat.inviteExpiresAt, DISPLAY_ZONE)}`,
  };
}

export interface SeatViewInput {
  readonly seats: readonly SeatRow[];
  readonly now: Instant;
  /** The reader's own user id, so their row can be marked. Null when unidentified. */
  readonly viewerUserId: string | null;
}

export function toSeatViews(input: SeatViewInput): readonly SeatView[] {
  return input.seats.map((seat) => {
    const standing = inviteStanding(seat, input.now);

    return {
      membershipId: seat.id,
      email: seat.email,
      displayName: seat.displayName,
      role: seat.role,
      status: seat.status,
      hasPassword: seat.hasPassword,
      teamKeys: seat.teamKeys,
      invitedAtLabel: formatCivilDate(seat.createdAt, DISPLAY_ZONE),
      lastActiveLabel: lastActivePhrase(seat.lastActiveAt, input.now),
      inviteState: standing?.state ?? null,
      invitePhrase: standing?.phrase ?? null,
      isYou: seat.userId === input.viewerUserId,
    };
  });
}
