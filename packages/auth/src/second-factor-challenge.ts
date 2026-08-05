import { toEpochMillis, type Instant } from '@compass/clock';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The short-lived ticket that carries a half-finished sign-in from the password step to the code step.
 *
 * ## Why the password step cannot just mint the session
 *
 * Because then the second factor would be advisory. If `/api/auth/login` returned a session cookie and
 * *then* asked for a code, everything the cookie authorises is already reachable — the code becomes a
 * screen somebody can navigate away from. So a password alone yields no session at all: it yields this,
 * which authorises exactly one thing, namely presenting a code for one specific user.
 *
 * ## Why it is signed rather than stored
 *
 * This is the same decision `apps/web/lib/connect-source.ts` makes for the OAuth `state`, for the same
 * reasons and in the same shape: `<userId>.<issuedAtMillis>.<hmac>`, compared in constant time, inside a
 * short window. A table would buy single-use semantics, and it is not worth a migration here because
 * replay of *this* value gains an attacker nothing — it is not a credential, it names a user who must
 * still produce a valid TOTP code, and the code's own replay rejection is durable in the database.
 *
 * **There is no fallback secret.** An HMAC under a key committed to the repository is not a signature, so
 * an unset secret disables the challenge rather than defaulting to a known one — and because a sign-in
 * that cannot issue a challenge must not fall back to a session, `verifySecondFactorChallenge` fails
 * closed with `unconfigured` and the login route refuses rather than admitting.
 *
 * ## No clock read
 *
 * `now` is a parameter, as everywhere in Compass and as `compass/no-system-clock` enforces over this
 * package. It is also what lets the expiry test move time instead of sleeping.
 */

export const SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR = 'COMPASS_SECOND_FACTOR_CHALLENGE_SECRET';

/**
 * Five minutes.
 *
 * Long enough to open an authenticator app, read six digits and type them — including on a phone that
 * has to be unlocked first — and short enough that a challenge left in a closed laptop's tab is useless
 * by the time anybody finds it. The magic-link window is fifteen minutes because it arrives by mail and
 * has to survive a delivery delay; this one is handed straight to the browser, so it does not.
 */
export const SECOND_FACTOR_CHALLENGE_TTL_MILLIS = 5 * 60 * 1000;

export type SecondFactorChallengeVerdict =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'unconfigured' | 'malformed' | 'bad_signature' | 'expired' };

const secretFrom = (environment: Readonly<Record<string, string | undefined>>): string | null => {
  const value = (environment[SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR] ?? '').trim();
  return value.length === 0 ? null : value;
};

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

const signaturesMatch = (left: string, right: string): boolean =>
  left.length === right.length && timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

/** Null when the signing secret is unset, which the caller must treat as "cannot sign in". */
export function issueSecondFactorChallenge(input: {
  readonly userId: string;
  readonly now: Instant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string | null {
  const secret = secretFrom(input.environment ?? process.env);
  if (secret === null) return null;

  const payload = `${input.userId}.${toEpochMillis(input.now)}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySecondFactorChallenge(input: {
  readonly challenge: string | null;
  readonly now: Instant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): SecondFactorChallengeVerdict {
  const secret = secretFrom(input.environment ?? process.env);
  if (secret === null) return { ok: false, reason: 'unconfigured' };
  if (input.challenge === null || input.challenge.length === 0) return { ok: false, reason: 'malformed' };

  const parts = input.challenge.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [userId, issuedAtRaw, signature] = parts as [string, string, string];
  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (userId.length === 0 || !Number.isFinite(issuedAt)) return { ok: false, reason: 'malformed' };

  if (!signaturesMatch(signature, sign(secret, `${userId}.${issuedAtRaw}`))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // After the signature, so an expired-but-genuine challenge and a forged one are distinguishable to us
  // and identical to the caller.
  const age = toEpochMillis(input.now) - issuedAt;
  if (age < 0 || age > SECOND_FACTOR_CHALLENGE_TTL_MILLIS) return { ok: false, reason: 'expired' };

  return { ok: true, userId };
}

/** What to tell somebody whose challenge was refused. Never says which of the four it was. */
export const describeChallengeRejection = (
  reason: Exclude<SecondFactorChallengeVerdict, { ok: true }>['reason'],
): string =>
  reason === 'unconfigured'
    ? 'Two-factor sign-in is not configured on this deployment. An administrator has to set ' +
      `${SECOND_FACTOR_CHALLENGE_SECRET_ENV_VAR} before a code can be accepted.`
    : 'That sign-in attempt has expired. Enter your email and password again to get a new code prompt.';
