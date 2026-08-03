import {
  RATE_LIMIT_POLICIES,
  composeLockoutMail,
  countAttempt,
  describeRateLimit,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitSubject,
  type RateLimitWindow,
  type RateLimitedAction,
} from '@compass/auth';
import type { Instant } from '@compass/clock';
import { listSeats, type ScopedDb } from '@compass/db';
import { NextResponse } from 'next/server';

import { mailer, organizationName } from './auth/guard';
import { NO_STORE } from './auth/http';

/**
 * The request edge's half of rate limiting: the state, the 429, and the lockout notice.
 *
 * `@compass/auth/rate-limit` owns the arithmetic and holds nothing. This owns the counters and
 * the HTTP, which is the split that lets the policy be tested by stepping an instant and the
 * transport be tested by calling a handler.
 *
 * ## In-process counters, stated rather than glossed
 *
 * The store is a `Map` on the process, cached across hot reloads the same way the connection pool
 * and the mailer are. In this deployment that is the whole truth and not a shortcut: Compass runs
 * as exactly two processes — one Next.js app and one worker — and only the app serves requests, so
 * there is one counter for one limiter. It is written down here because the failure mode of
 * *scaling out* is silent: two app replicas would each permit the full allowance, so a horizontal
 * deployment needs a shared store, and the seam for it is `store()` below and nothing else.
 *
 * `docs/ENGINEERING.md` says the same thing in the section that documents the four limits, so an
 * operator reading about the numbers reads about the limitation in the same breath.
 *
 * ## Why the limiter never reads a clock itself
 *
 * `now` is always passed in, from `guard()`'s own instant. That is what lets
 * `tests/rate-limit.test.ts` assert the threshold, the refusal, the escalation and the reset by
 * arithmetic instead of by waiting fifteen minutes, and it is the same rule every other
 * time-dependent layer in Compass lives under.
 */

const STORE_KEY = Symbol.for('compass.web.rate-limit');
type StoreGlobal = typeof globalThis & { [STORE_KEY]?: Map<string, RateLimitWindow> };

function store(): Map<string, RateLimitWindow> {
  const cache = globalThis as StoreGlobal;
  cache[STORE_KEY] ??= new Map<string, RateLimitWindow>();
  return cache[STORE_KEY];
}

/** Empties every counter. Exported for tests, which must not inherit each other's windows. */
export const resetRateLimits = (): void => {
  store().clear();
};

/**
 * Forgets the counters for one action and one set of subjects.
 *
 * Called on a *successful* sign-in, and that is the one design decision in this file worth
 * arguing with. The acceptance criterion says "10 attempts per 15 minutes", and counting every
 * attempt — successful ones included — is the literal reading. It is also the reading that locks
 * out the demonstration harness, which signs in repeatedly against
 * `.nous/demo_account.json`, and any manager who is signed in on a phone, a laptop and a browser
 * they cleared this morning.
 *
 * So every attempt is counted and a correct credential clears the count. The limit still bites
 * exactly where it is meant to: somebody who does not know the password never reaches the clear,
 * so their eleventh guess is refused and their ladder keeps climbing. Somebody who does know it
 * was never the threat.
 */
export function clearRateLimit(
  action: RateLimitedAction,
  subjects: Partial<Record<RateLimitSubject, string | null>>,
): void {
  const counters = store();
  for (const subject of RATE_LIMIT_POLICIES[action].subjects) {
    const value = subjects[subject];
    if (value === undefined || value === null || value.length === 0) continue;
    counters.delete(`${action}|${subject}|${value}`);
  }
}

/**
 * The client's address, as far as it can be trusted.
 *
 * `x-forwarded-for`'s **first** entry is the client as the nearest proxy saw it; the rest are
 * proxies. A caller can forge the whole header, which is why the auth limit counts per account as
 * well as per IP — forging the address defeats the per-IP counter and walks straight into the
 * per-account one. `unknown` is a real bucket rather than a bypass: requests with no forwarded
 * header share one counter, which is the strict reading, not the lenient one.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first !== undefined && first.length > 0) return first;
  return request.headers.get('x-real-ip')?.trim() ?? 'unknown';
}

export interface RateLimitRequest {
  readonly action: RateLimitedAction;
  /** One value per subject the policy counts against. A missing subject is not counted. */
  readonly subjects: Partial<Record<RateLimitSubject, string | null>>;
  readonly now: Instant;
}

export interface RateLimitOutcome {
  readonly allowed: boolean;
  /** Present when refused. Already carries `Retry-After` and the stated sentence. */
  readonly response: NextResponse | null;
  readonly retryAfterSeconds: number;
  /** True on the request that *earns* a lockout, so the notice is sent once. */
  readonly lockoutBegan: boolean;
  readonly strikes: number;
}

/**
 * Counts one request against every subject its policy names, and refuses if any is exhausted.
 *
 * Every subject is counted even when an earlier one has already refused. That is deliberate: with
 * early exit, a caller who exhausted the per-IP counter would stop advancing the per-account one,
 * so an attacker could hold an IP at its limit and keep an account's counter frozen just below
 * its own — which is exactly the state in which the lockout never fires.
 *
 * The refusal reports the *longest* wait among the exhausted subjects, because a `Retry-After`
 * shorter than the real one is a header that lies to a well-behaved client and gets it refused
 * again.
 */
export function checkRateLimit(input: RateLimitRequest): RateLimitOutcome {
  const policy: RateLimitPolicy = RATE_LIMIT_POLICIES[input.action];
  const counters = store();

  let worst: RateLimitDecision | null = null;

  for (const subject of policy.subjects) {
    const value = input.subjects[subject];
    if (value === undefined || value === null || value.length === 0) continue;

    const key = `${input.action}|${subject}|${value}`;
    const decision = countAttempt({ policy, window: counters.get(key), now: input.now });
    counters.set(key, decision.window);

    if (!decision.allowed && (worst === null || decision.retryAfterSeconds > worst.retryAfterSeconds)) {
      worst = decision;
    }
  }

  if (worst === null) {
    return { allowed: true, response: null, retryAfterSeconds: 0, lockoutBegan: false, strikes: 0 };
  }

  const lockedOut = worst.window.lockedUntil !== null;
  return {
    allowed: false,
    response: tooManyRequests({
      policy,
      retryAfterSeconds: worst.retryAfterSeconds,
      lockedOut,
    }),
    retryAfterSeconds: worst.retryAfterSeconds,
    lockoutBegan: worst.lockoutBegan,
    strikes: worst.strikes,
  };
}

/**
 * The 429.
 *
 * `Retry-After` in seconds rather than an HTTP date: both are legal, and the delta form cannot be
 * misread by a client whose clock is wrong — which is the same client most likely to be hammering
 * an endpoint. The body carries the same sentence in the product's voice, because a bare 429 in a
 * browser console tells a manager nothing about whether they are locked out or whether Compass is
 * broken.
 *
 * `error: 'rate_limited'` is a stable machine code, so the sign-in form can distinguish this from
 * a wrong password without parsing prose.
 */
export function tooManyRequests(input: {
  readonly policy: RateLimitPolicy;
  readonly retryAfterSeconds: number;
  readonly lockedOut: boolean;
}): NextResponse {
  return NextResponse.json(
    {
      error: input.lockedOut ? 'account_locked' : 'rate_limited',
      detail: describeRateLimit(input),
      retryAfterSeconds: input.retryAfterSeconds,
    },
    {
      status: 429,
      headers: { ...NO_STORE, 'retry-after': String(input.retryAfterSeconds) },
    },
  );
}

/**
 * Tells the organization's owners that an account has been locked.
 *
 * Sent on the transition only — `lockoutBegan` — so a caller who keeps hammering a locked account
 * cannot use the notification as an outbound mail amplifier pointed at the owners' inboxes. That is
 * not a hypothetical: the request that earns the lockout is by definition the eleventh of a run,
 * and the twelfth through thousandth arrive within the same minute.
 *
 * Every owner is told, not just the first. An organization can have several and the point of the
 * message is that *somebody* who can act reads it; picking one arbitrarily would mean the notice
 * lands in the inbox of whoever happens to sort first.
 *
 * Failure to send is logged and swallowed. A mail transport that is down must not turn a
 * successful rate-limit refusal into a 500 — the account is already locked, which is the part that
 * mattered, and `/api/health` is where a broken mailer is reported.
 */
export async function notifyLockout(input: {
  readonly scoped: ScopedDb;
  readonly subjectEmail: string;
  readonly strikes: number;
  readonly retryAfterSeconds: number;
  readonly accountUrl: string;
}): Promise<readonly string[]> {
  try {
    const seats = await listSeats(input.scoped);
    const owners = seats.filter((seat) => seat.role === 'owner' && seat.status === 'active');
    if (owners.length === 0) return [];

    const name = await organizationName(input.scoped);
    const lockedFor = describeSeconds(input.retryAfterSeconds);
    const sent: string[] = [];

    for (const owner of owners) {
      await mailer().send(
        composeLockoutMail({
          to: owner.email,
          organizationName: name,
          subjectEmail: input.subjectEmail,
          lockedFor,
          strikes: input.strikes,
          link: input.accountUrl,
        }),
      );
      sent.push(owner.email);
    }
    return sent;
  } catch (error) {
    console.error(
      `[compass] could not send a lockout notice for ${input.subjectEmail}: ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return [];
  }
}

const describeSeconds = (seconds: number): string => {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
};
