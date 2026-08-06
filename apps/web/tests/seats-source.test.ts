import { MILLIS_PER_DAY, addMillis, instantFromIso, type Instant } from '@compass/clock';
import { TOKEN_TTL_MILLIS } from '@compass/auth';
import type { SeatRow } from '@compass/db';
import { describe, expect, it } from 'vitest';

import { inviteStanding, lastActivePhrase, toSeatViews } from '../lib/seats-source';

/**
 * The sentences the members screen states about time.
 *
 * `lib/seats-source.ts` is a pure function of `(seats, now)` precisely so this suite can
 * exist: "this invitation expired" is a claim about a boundary, and a component that read
 * the clock itself could only be tested for it by waiting a fortnight.
 *
 * The boundary is the part worth pinning. `acceptInvite` refuses a token when
 * `now >= expiresAt`, so the screen has to agree at exactly that instant — a screen that
 * still said "expires today" while the link was already being refused would send someone
 * to a door that has just been locked.
 */

const T0 = instantFromIso('2026-08-06T09:00:00Z');

const seatRow = (over: Partial<SeatRow> = {}): SeatRow => ({
  id: 'm-1',
  userId: 'u-1',
  role: 'member',
  status: 'active',
  createdAt: T0,
  updatedAt: T0,
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  hasPassword: true,
  teamKeys: ['platform'],
  lastActiveAt: T0,
  inviteExpiresAt: null,
  ...over,
});

describe('last-active, in the product’s voice', () => {
  it('says never signed in rather than leaving a blank', () => {
    // The expected answer for every pending invitation. A blank cell here would read as
    // missing data about a person, which is a different and worse claim.
    expect(lastActivePhrase(null, T0)).toBe('never signed in');
  });

  it('counts whole days, and names the first two', () => {
    expect(lastActivePhrase(T0, T0)).toBe('last active today');
    expect(lastActivePhrase(addMillis(T0, -MILLIS_PER_DAY), T0)).toBe('last active yesterday');
    expect(lastActivePhrase(addMillis(T0, -6 * MILLIS_PER_DAY), T0)).toBe('last active 6 days ago');
  });

  it('does not round a partial day up into a whole one', () => {
    // 23 hours ago is still today. Rounding it to "yesterday" would make the figure
    // disagree with the date beside it for an hour every day.
    const almost = addMillis(T0, -(MILLIS_PER_DAY - 1));
    expect(lastActivePhrase(almost, T0)).toBe('last active today');
  });

  it('treats a session used in the future as today rather than as negative days', () => {
    // Clock skew between the app and the database is real and small. It must not produce
    // "last active -1 days ago".
    expect(lastActivePhrase(addMillis(T0, 30_000), T0)).toBe('last active today');
  });
});

describe('what a pending seat’s invitation is doing', () => {
  const pending = (inviteExpiresAt: Instant | null): SeatRow =>
    seatRow({ status: 'pending', lastActiveAt: null, inviteExpiresAt });

  it('is silent for a seat that is not pending', () => {
    expect(inviteStanding(seatRow({ status: 'active' }), T0)).toBeNull();
    expect(inviteStanding(seatRow({ status: 'revoked' }), T0)).toBeNull();
  });

  it('states the deadline while the link still works', () => {
    const standing = inviteStanding(pending(addMillis(T0, TOKEN_TTL_MILLIS.invite)), T0);

    expect(standing?.state).toBe('live');
    expect(standing?.phrase).toBe('invitation expires 2026-08-20');
  });

  it('flips to expired at the same instant the token is refused, not a day later', () => {
    const expiresAt = addMillis(T0, TOKEN_TTL_MILLIS.invite);

    // One millisecond before: still redeemable, and the screen says so.
    expect(inviteStanding(pending(expiresAt), addMillis(expiresAt, -1))?.state).toBe('live');

    // Exactly at the deadline: `tokenRejection` returns 'expired' here, so this must too.
    const atDeadline = inviteStanding(pending(expiresAt), expiresAt);
    expect(atDeadline?.state).toBe('expired');
    expect(atDeadline?.phrase).toContain('can no longer be redeemed');
    expect(atDeadline?.phrase).toContain('resend');
  });

  it('offers the remedy when there is no outstanding invitation at all', () => {
    const standing = inviteStanding(pending(null), T0);

    expect(standing?.state).toBe('none');
    expect(standing?.phrase).toContain('resend');
  });
});

describe('the view the members screen renders', () => {
  it('marks the reader’s own seat and nobody else’s', () => {
    const views = toSeatViews({
      seats: [seatRow({ id: 'm-1', userId: 'u-1' }), seatRow({ id: 'm-2', userId: 'u-2' })],
      now: T0,
      viewerUserId: 'u-2',
    });

    expect(views.map((view) => view.isYou)).toEqual([false, true]);
  });

  it('marks nobody when the reader is unidentified', () => {
    const views = toSeatViews({ seats: [seatRow()], now: T0, viewerUserId: null });
    expect(views[0]?.isYou).toBe(false);
  });

  it('gives every seat a last-active sentence, pending ones included', () => {
    const views = toSeatViews({
      seats: [
        seatRow({ id: 'm-1' }),
        seatRow({ id: 'm-2', status: 'pending', lastActiveAt: null, inviteExpiresAt: addMillis(T0, MILLIS_PER_DAY) }),
      ],
      now: T0,
      viewerUserId: null,
    });

    // Never null: the screen has no blank state for this, by design.
    expect(views.every((view) => view.lastActiveLabel.length > 0)).toBe(true);
    expect(views[1]?.lastActiveLabel).toBe('never signed in');
    expect(views[1]?.inviteState).toBe('live');
    expect(views[0]?.inviteState).toBeNull();
  });
});
