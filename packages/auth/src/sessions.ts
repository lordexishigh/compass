import { MILLIS_PER_DAY, addMillis, type Instant } from '@compass/clock';
import type { SessionRow } from '@compass/db';

/**
 * The session lifecycle, as arithmetic over instants.
 *
 * Nothing here reads a clock: every function takes `now` as a parameter, the same
 * rule the analysis core lives under, and for the same reason — a test that cannot
 * choose "now" cannot assert that a session expires after fourteen idle days
 * without waiting fourteen days.
 *
 * ## The two deadlines
 *
 * **Absolute — 30 days.** Frozen at `issued_at` and never extended. A session that
 * has been used every day for a month still ends, which is what stops a long-lived
 * browser tab from becoming a permanent credential.
 *
 * **Idle — 14 days.** Measured from `last_used_at`, which advances on every
 * authenticated request. A laptop left shut for a fortnight comes back signed out.
 *
 * The effective deadline is whichever comes first, and `sessionDeadline` is the one
 * place that comparison is made. The idle deadline is *derived* rather than stored:
 * a stored second deadline would be a second source of truth that a missed write
 * could silently push out.
 *
 * ## Rotation
 *
 * A session identifier is never reused and never edited. On a privilege change the
 * old row is revoked and a new secret is issued, so the previously-handed-out cookie
 * stops working — and because the revoked row stays on disk, a test can prove that
 * it stopped rather than infer it.
 */

export const SESSION_ABSOLUTE_TTL_DAYS = 30;
export const SESSION_IDLE_TTL_DAYS = 14;

export const SESSION_ABSOLUTE_TTL_MILLIS = SESSION_ABSOLUTE_TTL_DAYS * MILLIS_PER_DAY;
export const SESSION_IDLE_TTL_MILLIS = SESSION_IDLE_TTL_DAYS * MILLIS_PER_DAY;

/** The absolute deadline written to the row at creation. */
export const sessionAbsoluteExpiry = (issuedAt: Instant): Instant =>
  addMillis(issuedAt, SESSION_ABSOLUTE_TTL_MILLIS);

/** The idle deadline, derived from the last use rather than stored. */
export const sessionIdleExpiry = (lastUsedAt: Instant): Instant => addMillis(lastUsedAt, SESSION_IDLE_TTL_MILLIS);

/** Whichever deadline comes first. This is the one the product enforces. */
export const sessionDeadline = (session: Pick<SessionRow, 'expiresAt' | 'lastUsedAt'>): Instant => {
  const idle = sessionIdleExpiry(session.lastUsedAt);
  return idle < session.expiresAt ? idle : session.expiresAt;
};

/**
 * Why a session cannot be used, or null when it can.
 *
 * `idle` and `expired` are separate answers because the sentence the person reads
 * differs: "you have not used Compass in two weeks" is a different fact about the
 * world than "this session was opened a month ago".
 */
export type SessionRejection = 'not_found' | 'revoked' | 'expired' | 'idle';

export function sessionRejection(session: SessionRow | null, now: Instant): SessionRejection | null {
  if (session === null) return 'not_found';
  if (session.revokedAt !== null) return 'revoked';
  if (now >= session.expiresAt) return 'expired';
  if (now >= sessionIdleExpiry(session.lastUsedAt)) return 'idle';
  return null;
}

export function describeSessionRejection(rejection: SessionRejection): string {
  switch (rejection) {
    case 'revoked':
      return 'This session was ended — by a sign-out, by a role change, or by an owner. Sign in again.';
    case 'expired':
      return `Sessions end ${SESSION_ABSOLUTE_TTL_DAYS} days after they begin, however often they are used. Sign in again.`;
    case 'idle':
      return `Sessions end after ${SESSION_IDLE_TTL_DAYS} days without use. Sign in again.`;
    case 'not_found':
      return 'No session. Sign in to read a report scoped to your teams.';
  }
}

/**
 * Why a session was rotated.
 *
 * A closed set, because these strings land in `sessions.revoked_reason` and in the
 * audit log, and a free-text reason would make "show me every session ended by a
 * role change" a text search.
 */
export const SESSION_REVOKE_REASONS = [
  'sign_out',
  'sign_out_all_devices',
  'role_change',
  'seat_revoked',
  'password_changed',
] as const;

export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/**
 * Whether `last_used_at` is worth a write on this request.
 *
 * Every authenticated request could advance it, but that would be one UPDATE per
 * request forever to move a fourteen-day deadline by milliseconds. Advancing it only
 * when it is more than an hour stale keeps the deadline honest to within an hour and
 * turns the write into roughly one per hour per session.
 */
export const SESSION_TOUCH_INTERVAL_MILLIS = 60 * 60 * 1000;

export const shouldTouchSession = (session: Pick<SessionRow, 'lastUsedAt'>, now: Instant): boolean =>
  now - session.lastUsedAt >= SESSION_TOUCH_INTERVAL_MILLIS;
