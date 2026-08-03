import {
  LOCKOUT_BASE_MILLIS,
  LOCKOUT_MAX_MILLIS,
  RATE_LIMITED_ACTIONS,
  RATE_LIMIT_POLICIES,
  countAttempt,
  describeRateLimit,
  emptyWindow,
  lockoutDurationFor,
  secondsUntil,
  type RateLimitWindow,
} from '@compass/auth';
import { MILLIS_PER_HOUR, MILLIS_PER_MINUTE, addMillis, instantFromIso } from '@compass/clock';
import { describe, expect, it } from 'vitest';

/**
 * The four documented limits, and the escalation, asserted by arithmetic.
 *
 * Every instant here is chosen rather than observed, which is the whole reason the limiter takes
 * `now` as a parameter: "the window resets after fifteen minutes" is a claim about a duration, and
 * a test that could only make it by *waiting* fifteen minutes would not be run and so would not be
 * a test. The suite steps time by addition and asserts the threshold, the refusal, the ladder and
 * the reset in milliseconds.
 */

const START = instantFromIso('2026-08-03T09:00:00Z');

/** Spends `count` attempts from a window, returning the last decision and the resulting window. */
function spend(action: (typeof RATE_LIMITED_ACTIONS)[number], count: number, now = START) {
  const policy = RATE_LIMIT_POLICIES[action];
  let window: RateLimitWindow | undefined;
  let last = countAttempt({ policy, window, now });

  for (let index = 0; index < count; index += 1) {
    last = countAttempt({ policy, window, now });
    window = last.window;
  }

  return { last, window: window as RateLimitWindow, policy };
}

describe('the documented limits are the enforced limits', () => {
  it('covers every action the policy table names, so a fifth cannot arrive untested', () => {
    expect([...RATE_LIMITED_ACTIONS].sort()).toEqual([
      'auth_attempt',
      'feedback_write',
      'report_regeneration',
      'share_link_read',
    ]);
    for (const action of RATE_LIMITED_ACTIONS) {
      expect(RATE_LIMIT_POLICIES[action].action, `${action} is filed under the wrong key`).toBe(action);
      expect(RATE_LIMIT_POLICIES[action].summary.length).toBeGreaterThan(20);
      expect(RATE_LIMIT_POLICIES[action].subjects.length).toBeGreaterThan(0);
    }
  });

  it('is 10 auth attempts per 15 minutes, per IP and per account', () => {
    const policy = RATE_LIMIT_POLICIES.auth_attempt;

    expect(policy.limit).toBe(10);
    expect(policy.windowMillis).toBe(15 * MILLIS_PER_MINUTE);
    expect([...policy.subjects].sort()).toEqual(['account', 'ip']);
    expect(policy.locksOut).toBe(true);
  });

  it('is 5 manual regenerations per hour per organization', () => {
    const policy = RATE_LIMIT_POLICIES.report_regeneration;

    expect(policy.limit).toBe(5);
    expect(policy.windowMillis).toBe(MILLIS_PER_HOUR);
    expect(policy.subjects).toEqual(['organization']);
    // A regeneration is expensive, not adversarial. Refusing is enough; locking an organization
    // out of its own reports for an hour would be a worse outcome than the burst.
    expect(policy.locksOut).toBe(false);
  });

  it('is 60 feedback writes per minute per user', () => {
    const policy = RATE_LIMIT_POLICIES.feedback_write;

    expect(policy.limit).toBe(60);
    expect(policy.windowMillis).toBe(MILLIS_PER_MINUTE);
    expect(policy.subjects).toEqual(['user']);
  });

  it('is 120 share-link reads per minute per token', () => {
    const policy = RATE_LIMIT_POLICIES.share_link_read;

    expect(policy.limit).toBe(120);
    expect(policy.windowMillis).toBe(MILLIS_PER_MINUTE);
    // Per token and not per IP: a share link is meant to be opened from many networks.
    expect(policy.subjects).toEqual(['token']);
  });
});

describe('the threshold', () => {
  it.each([...RATE_LIMITED_ACTIONS])('permits exactly %s’s limit and refuses the next one', (action) => {
    const policy = RATE_LIMIT_POLICIES[action];
    const { window } = spend(action, policy.limit);

    expect(window.count).toBe(policy.limit);

    const next = countAttempt({ policy, window, now: START });
    expect(next.allowed, 'the request one past the limit must be refused').toBe(false);
    expect(next.remaining).toBe(0);
  });

  it('counts down the remaining allowance on the way', () => {
    const policy = RATE_LIMIT_POLICIES.report_regeneration;
    const remaining: number[] = [];
    let window: RateLimitWindow | undefined;

    for (let index = 0; index < policy.limit; index += 1) {
      const decision = countAttempt({ policy, window, now: START });
      window = decision.window;
      remaining.push(decision.remaining);
    }

    expect(remaining).toEqual([4, 3, 2, 1, 0]);
  });

  it('refuses with a Retry-After that is never zero, and never rounds down', () => {
    // The window has 500ms left. Rounding down would say "retry in 0 seconds", which a
    // well-behaved client obeys and is refused again.
    const policy = RATE_LIMIT_POLICIES.feedback_write;
    const { window } = spend('feedback_write', policy.limit);
    const almostElapsed = addMillis(START, policy.windowMillis - 500);

    const refused = countAttempt({ policy, window, now: almostElapsed });

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);
    expect(secondsUntil(START, START)).toBe(1);
  });
});

describe('the reset', () => {
  it.each([...RATE_LIMITED_ACTIONS])('gives %s a full allowance once its window has elapsed', (action) => {
    const policy = RATE_LIMIT_POLICIES[action];
    const { window } = spend(action, policy.limit);

    // One millisecond before: still refused.
    const beforeReset = countAttempt({ policy, window, now: addMillis(START, policy.windowMillis - 1) });
    expect(beforeReset.allowed, 'the window must not reset early').toBe(false);

    const afterReset = countAttempt({ policy, window, now: addMillis(START, policy.windowMillis) });
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(policy.limit - 1);
    expect(afterReset.window.count).toBe(1);
  });

  it('clears the strike ladder for a subject that let a whole window pass unexhausted', () => {
    const policy = RATE_LIMIT_POLICIES.auth_attempt;

    // Exhaust once to earn a strike, serve it, then go quiet for a window.
    const first = spend('auth_attempt', policy.limit);
    const struck = countAttempt({ policy, window: first.window, now: START });
    expect(struck.strikes).toBe(1);

    const lockedUntil = struck.window.lockedUntil;
    expect(lockedUntil).not.toBeNull();

    // One attempt after the lockout: allowed, and the ladder is still remembered.
    const afterLockout = countAttempt({ policy, window: struck.window, now: lockedUntil! });
    expect(afterLockout.allowed).toBe(true);
    expect(afterLockout.window.strikes, 'a served lockout keeps the ladder').toBe(1);

    // Then a whole quiet window: the ladder is forgotten.
    const muchLater = addMillis(lockedUntil!, policy.windowMillis);
    const fresh = countAttempt({ policy, window: afterLockout.window, now: muchLater });
    expect(fresh.window.strikes, 'a quiet window clears the ladder').toBe(0);
  });
});

describe('the exponential lockout', () => {
  it('doubles: 1, 2, 4, 8, 16 minutes', () => {
    expect(lockoutDurationFor(1)).toBe(MILLIS_PER_MINUTE);
    expect(lockoutDurationFor(2)).toBe(2 * MILLIS_PER_MINUTE);
    expect(lockoutDurationFor(3)).toBe(4 * MILLIS_PER_MINUTE);
    expect(lockoutDurationFor(4)).toBe(8 * MILLIS_PER_MINUTE);
    expect(lockoutDurationFor(5)).toBe(16 * MILLIS_PER_MINUTE);
    expect(lockoutDurationFor(0), 'no strikes is no lockout').toBe(0);
  });

  it('caps at an hour rather than doubling to a week', () => {
    // Uncapped, the thirteenth strike would be over two days and the account would need an
    // operator with database access to recover. The cap is policy, not an oversight.
    expect(lockoutDurationFor(20)).toBe(LOCKOUT_MAX_MILLIS);
    expect(lockoutDurationFor(1000)).toBe(LOCKOUT_MAX_MILLIS);
    expect(LOCKOUT_BASE_MILLIS).toBe(MILLIS_PER_MINUTE);
  });

  it('escalates across consecutive exhausted windows, each wait strictly longer than the last', () => {
    const policy = RATE_LIMIT_POLICIES.auth_attempt;
    let window: RateLimitWindow = emptyWindow(START);
    let now = START;
    const waits: number[] = [];

    for (let strike = 1; strike <= 4; strike += 1) {
      // Spend the allowance inside the current window.
      for (let index = 0; index < policy.limit; index += 1) {
        const decision = countAttempt({ policy, window, now });
        expect(decision.allowed, `attempt ${index + 1} of strike ${strike} should be allowed`).toBe(true);
        window = decision.window;
      }

      const refused = countAttempt({ policy, window, now });
      expect(refused.allowed).toBe(false);
      expect(refused.strikes).toBe(strike);
      expect(refused.lockoutBegan, 'each new lockout is a transition').toBe(true);
      window = refused.window;
      waits.push(window.lockedUntil! - now);

      // Serve the lockout, then start the next round at the instant it lifts.
      now = window.lockedUntil!;
    }

    // Monotonic, and the *increments* double: the constant window remainder is shared by all four,
    // so what grows between them is the penalty itself.
    for (let index = 1; index < waits.length; index += 1) {
      expect(waits[index]!, `strike ${index + 1} must wait longer than strike ${index}`).toBeGreaterThan(
        waits[index - 1]!,
      );
    }
    const increments = waits.slice(1).map((wait, index) => wait - waits[index]!);
    expect(increments).toEqual([MILLIS_PER_MINUTE, 2 * MILLIS_PER_MINUTE, 4 * MILLIS_PER_MINUTE]);
  });

  it('does not extend a live lockout when the caller keeps hammering', () => {
    // Otherwise an attacker could hold somebody else's account locked forever by continuing to
    // fail against it. The ladder advances per exhausted *window*, not per request.
    const policy = RATE_LIMIT_POLICIES.auth_attempt;
    const { window } = spend('auth_attempt', policy.limit);
    const locked = countAttempt({ policy, window, now: START });
    const deadline = locked.window.lockedUntil!;

    let current = locked.window;
    for (let index = 0; index < 50; index += 1) {
      const decision = countAttempt({ policy, window: current, now: addMillis(START, index) });
      expect(decision.allowed).toBe(false);
      expect(decision.lockoutBegan, 'only the earning request is a transition').toBe(false);
      expect(decision.window.lockedUntil, 'the deadline must not move').toBe(deadline);
      expect(decision.strikes).toBe(1);
      current = decision.window;
    }
  });

  it('never locks out an action whose policy does not lock out', () => {
    for (const action of RATE_LIMITED_ACTIONS) {
      const policy = RATE_LIMIT_POLICIES[action];
      if (policy.locksOut) continue;

      const { window } = spend(action, policy.limit);
      const refused = countAttempt({ policy, window, now: START });

      expect(refused.allowed).toBe(false);
      expect(refused.window.lockedUntil, `${action} must not lock out`).toBeNull();
      expect(refused.strikes).toBe(0);
      // The wait is just the window remainder.
      expect(refused.retryAfterSeconds).toBe(Math.ceil(policy.windowMillis / 1000));
    }
  });
});

describe('the sentence a refused caller reads', () => {
  it('names the limit and the wait for an ordinary refusal', () => {
    const sentence = describeRateLimit({
      policy: RATE_LIMIT_POLICIES.report_regeneration,
      retryAfterSeconds: 1800,
      lockedOut: false,
    });

    expect(sentence).toContain('5 per hour per organization');
    expect(sentence).toContain('30 minutes');
  });

  it('says a lockout is a lockout, and names the way back in', () => {
    const sentence = describeRateLimit({
      policy: RATE_LIMIT_POLICIES.auth_attempt,
      retryAfterSeconds: 960,
      lockedOut: true,
    });

    expect(sentence).toContain('locked');
    expect(sentence).toContain('16 minutes');
    // A person locked out has to be told what to do, or the product reads as broken.
    expect(sentence).toContain('email me a link');
    expect(sentence).toContain('owner');
  });

  it('pluralises a one-second wait correctly, because it is the one a person sees most', () => {
    const sentence = describeRateLimit({
      policy: RATE_LIMIT_POLICIES.feedback_write,
      retryAfterSeconds: 1,
      lockedOut: false,
    });

    expect(sentence).toContain('1 second.');
    expect(sentence).not.toContain('1 seconds');
  });
});
