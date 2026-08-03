import { MILLIS_PER_HOUR, MILLIS_PER_MINUTE, type Instant } from '@compass/clock';

/**
 * Rate limiting: the four documented limits, and a limiter that never reads a clock.
 *
 * ## Why this is a pure function of (history, now)
 *
 * `packages/auth` is under the `compass/no-system-clock` build gate, and this is the module
 * that makes the gate worth having. A limiter that called `Date.now()` could only be tested
 * by *waiting* — a test for "the window resets after fifteen minutes" would either take
 * fifteen minutes or be written against a mocked global, and neither of those is a test of
 * the reset. Every function here takes `now: Instant`, so the suites step time by
 * arithmetic and assert the threshold, the refusal and the reset in milliseconds.
 *
 * ## Fixed windows, not token buckets
 *
 * A fixed window is what the acceptance criteria describe ("10 attempts per 15 minutes",
 * "5 per hour per org") and it is what an operator can reason about when somebody rings up
 * locked out: the window has a start, the count is against it, and `Retry-After` is the
 * remainder. A token bucket would smooth the boundary at the cost of nobody — including us
 * — being able to say when a caller gets in again.
 *
 * The consequence is honest and documented: a caller can spend a full allowance at the end
 * of one window and again at the start of the next. For an auth endpoint that means at worst
 * 20 attempts across a moment, against a floor of 12 characters of Argon2id-hashed password,
 * which is not the attack these limits exist to blunt.
 *
 * ## What this module does not do
 *
 * It holds no state and knows nothing about HTTP. The state lives in the process that owns
 * the request edge (`apps/web/lib/rate-limit.ts`), which is also where 429 and `Retry-After`
 * are written, and where the lockout notification is sent. Keeping the arithmetic here means
 * the *policy* is one exported table that a test can enumerate, rather than four numbers
 * spread across four route handlers.
 */

/** The limited surfaces. Named rather than free-form, so a route cannot invent a fifth. */
export const RATE_LIMITED_ACTIONS = ['auth_attempt', 'report_regeneration', 'feedback_write', 'share_link_read'] as const;

export type RateLimitedAction = (typeof RATE_LIMITED_ACTIONS)[number];

/** What a limit is counted against. Part of the policy, because it decides who a burst hurts. */
export type RateLimitSubject = 'ip' | 'account' | 'organization' | 'user' | 'token';

export interface RateLimitPolicy {
  readonly action: RateLimitedAction;
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowMillis: number;
  /** The subjects this action is counted against — every one of them, independently. */
  readonly subjects: readonly RateLimitSubject[];
  /** True when exceeding the limit escalates into a lockout rather than just refusing. */
  readonly locksOut: boolean;
  /** One line, for the documentation gate and for the sentence a refused caller reads. */
  readonly summary: string;
}

/**
 * The four limits, stated once.
 *
 * `docs/ENGINEERING.md` quotes these numbers and
 * `tools/quality-gates/tests/security-posture.test.ts` diffs the prose against this table,
 * so the documentation cannot drift from the enforcement.
 *
 *  - **auth 10 per 15 minutes, per IP *and* per account.** Both subjects, because they stop
 *    different things: per-IP stops one machine working through a password list, per-account
 *    stops a distributed attempt against one known address. Exceeding it escalates (below).
 *  - **manual report regeneration 5 per hour per organization.** Not per user: a regeneration
 *    runs the whole pipeline and writes a report, so the cost is the tenant's however many
 *    managers ask for it. Five is enough to correct a bad day's report and iterate on it.
 *  - **feedback writes 60 per minute per user.** One per second sustained. A manager clicking
 *    through a report cannot reach this; a script can, and a script writing feedback is
 *    rewriting what tomorrow's report says.
 *  - **share links 120 per minute per token.** Per *token*, not per IP, because a share link
 *    is the one credential Compass hands out that may legitimately be opened by many people
 *    from many networks — a per-IP limit would be no limit at all, and a per-token limit is
 *    what makes a leaked link enumerable-once rather than a free API key.
 */
export const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitedAction, RateLimitPolicy>> = Object.freeze({
  auth_attempt: {
    action: 'auth_attempt',
    limit: 10,
    windowMillis: 15 * MILLIS_PER_MINUTE,
    subjects: ['ip', 'account'],
    locksOut: true,
    summary: 'Sign-in, magic-link and password-reset attempts: 10 per 15 minutes, per IP and per account.',
  },
  report_regeneration: {
    action: 'report_regeneration',
    limit: 5,
    windowMillis: MILLIS_PER_HOUR,
    subjects: ['organization'],
    locksOut: false,
    summary: 'Manual report regeneration: 5 per hour per organization.',
  },
  feedback_write: {
    action: 'feedback_write',
    limit: 60,
    windowMillis: MILLIS_PER_MINUTE,
    subjects: ['user'],
    locksOut: false,
    summary: 'Feedback writes: 60 per minute per user.',
  },
  share_link_read: {
    action: 'share_link_read',
    limit: 120,
    windowMillis: MILLIS_PER_MINUTE,
    subjects: ['token'],
    locksOut: false,
    summary: 'Share-link reads: 120 per minute per token.',
  },
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * One counter. Immutable: `countAttempt` returns the next state rather than mutating,
 * so the arithmetic is testable without a store and the store is a plain Map of these.
 */
export interface RateLimitWindow {
  readonly windowStart: Instant;
  readonly count: number;
  /** How many windows in a row have been exhausted. Only `locksOut` actions grow this. */
  readonly strikes: number;
  /** When the subject may try again. Null unless a lockout is in force. */
  readonly lockedUntil: Instant | null;
}

export const emptyWindow = (now: Instant): RateLimitWindow =>
  Object.freeze({ windowStart: now, count: 0, strikes: 0, lockedUntil: null });

/**
 * How long a lockout lasts after the *n*th exhausted window: 1, 2, 4, 8… minutes, capped.
 *
 * The penalty is served **after** the exhausted window ends rather than from the moment of
 * exhaustion. That ordering is deliberate: a lockout timed from "now" would be *shorter* than
 * the plain fifteen-minute window reset for the first four strikes, so earning a lockout would
 * let a caller back in sooner than not earning one. Serving the window and then the penalty
 * makes the ladder monotonic — every strike waits strictly longer than the last.
 *
 * Exponential and capped at an hour. Uncapped doubling reaches a week by the thirteenth
 * strike, which stops being a rate limit and becomes an unrecoverable account state that only
 * an operator with database access can undo — so the cap is part of the policy, not an
 * omission. An hour is long enough that an automated attempt is worthless and short enough
 * that a person who genuinely forgot their password has a way back without a support ticket.
 */
export const LOCKOUT_BASE_MILLIS = MILLIS_PER_MINUTE;
export const LOCKOUT_MAX_MILLIS = MILLIS_PER_HOUR;

export function lockoutDurationFor(strikes: number): number {
  if (strikes <= 0) return 0;
  // 2^(strikes-1) minutes, computed so a large strike count cannot overflow into Infinity.
  const doublings = Math.min(strikes - 1, 20);
  return Math.min(LOCKOUT_BASE_MILLIS * 2 ** doublings, LOCKOUT_MAX_MILLIS);
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** The state to store, whether the attempt was allowed or refused. */
  readonly window: RateLimitWindow;
  /** Attempts left in this window after this one. Zero when refused. */
  readonly remaining: number;
  /** Seconds to put in `Retry-After`. Always at least 1 when refused — never 0. */
  readonly retryAfterSeconds: number;
  /** True on the transition into a lockout: the request that earns it, not every one after. */
  readonly lockoutBegan: boolean;
  /** How many consecutive windows have now been exhausted. */
  readonly strikes: number;
}

/**
 * Counts one attempt against a window and says whether it may proceed.
 *
 * Three states, in the order they are checked:
 *
 *  1. **Locked out.** Refused without counting, so hammering a locked account does not extend
 *     the lockout — the escalation is per exhausted *window*, not per request. Extending on
 *     every attempt would mean an attacker could keep somebody else's account locked forever
 *     by continuing to fail against it.
 *  2. **The window has elapsed.** A fresh window, and `strikes` is cleared: a subject that
 *     went a whole window without exhausting it is not on an escalation ladder any more.
 *  3. **Inside the window.** Counted; refused once the count would exceed the limit.
 */
export function countAttempt(input: {
  readonly policy: RateLimitPolicy;
  readonly window: RateLimitWindow | undefined;
  readonly now: Instant;
}): RateLimitDecision {
  const { policy, now } = input;
  const existing = input.window ?? emptyWindow(now);

  if (existing.lockedUntil !== null && now < existing.lockedUntil) {
    return {
      allowed: false,
      window: existing,
      remaining: 0,
      retryAfterSeconds: secondsUntil(now, existing.lockedUntil),
      lockoutBegan: false,
      strikes: existing.strikes,
    };
  }

  const windowElapsed = now - existing.windowStart >= policy.windowMillis;
  // A lockout that has run out resets the window too: the point of serving the lockout is
  // getting the allowance back, and leaving the old exhausted count in place would refuse
  // the very next request.
  const lockoutServed = existing.lockedUntil !== null && now >= existing.lockedUntil;

  const base: RateLimitWindow =
    windowElapsed || lockoutServed
      ? { windowStart: now, count: 0, strikes: lockoutServed ? existing.strikes : 0, lockedUntil: null }
      : existing;

  if (base.count < policy.limit) {
    const next: RateLimitWindow = { ...base, count: base.count + 1 };
    return {
      allowed: true,
      window: Object.freeze(next),
      remaining: policy.limit - next.count,
      retryAfterSeconds: 0,
      lockoutBegan: false,
      strikes: next.strikes,
    };
  }

  // Exhausted. For a locking action this is the moment the ladder advances.
  const strikes = policy.locksOut ? base.strikes + 1 : base.strikes;
  const lockedUntil = policy.locksOut ? ((base.windowStart + policy.windowMillis + lockoutDurationFor(strikes)) as Instant) : null;
  const retryAt = lockedUntil ?? ((base.windowStart + policy.windowMillis) as Instant);

  return {
    allowed: false,
    window: Object.freeze({ ...base, strikes, lockedUntil }),
    remaining: 0,
    retryAfterSeconds: secondsUntil(now, retryAt),
    lockoutBegan: policy.locksOut && base.lockedUntil === null,
    strikes,
  };
}

/**
 * `Retry-After`, in whole seconds, never below 1.
 *
 * A `Retry-After: 0` is an instruction to retry immediately, which is the opposite of what a
 * 429 means — and a well-behaved client would obey it and spin. Rounded up for the same
 * reason: telling a caller to come back in 4 seconds when the window has 4.6 left means their
 * next request is also refused, and a client that trusted the header would conclude the
 * header is a lie.
 */
export function secondsUntil(now: Instant, deadline: Instant): number {
  return Math.max(1, Math.ceil((deadline - now) / 1000));
}

/**
 * The sentence a refused caller reads.
 *
 * Names the limit and when they get in again, because "too many requests" tells somebody who
 * has just mistyped their password twice nothing about whether they are locked out or whether
 * the product is broken. A locked-out sign-in additionally says that the owner has been
 * told — otherwise the mail arriving is a mystery to the person it is about.
 */
export function describeRateLimit(input: {
  readonly policy: RateLimitPolicy;
  readonly retryAfterSeconds: number;
  readonly lockedOut: boolean;
}): string {
  const wait = describeWait(input.retryAfterSeconds);
  if (input.lockedOut) {
    return (
      `Too many sign-in attempts. This account and this address are locked for ${wait}, and the lockout doubles each ` +
      'time it is hit again. An owner of the organization has been notified. If this was you, use "email me a link" ' +
      'instead — a mailed sign-in link is not affected by this limit.'
    );
  }
  return `${input.policy.summary} Try again in ${wait}.`;
}

const describeWait = (seconds: number): string => {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
};
