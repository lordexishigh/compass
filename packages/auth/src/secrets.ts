import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { MILLIS_PER_DAY, MILLIS_PER_HOUR, MILLIS_PER_MINUTE, addMillis, type Instant } from '@compass/clock';

import type { AuthTokenPurpose } from '@compass/db';

/**
 * Bearer secrets: session cookies and the three kinds of mailed link.
 *
 * One rule governs all four, and it is the reason this file exists rather than
 * each flow rolling its own: **the secret is generated once, handed out once, and
 * only its digest is ever stored.** A database dump therefore yields no working
 * link and no working session. Lookup is by digest, which is also why the digest is
 * the column carrying the unique constraint.
 *
 * SHA-256 and not Argon2id, on purpose. A password is low-entropy and human-chosen,
 * so its digest has to be *slow* or it can be brute-forced from a dump. These
 * secrets are 32 bytes from the OS CSPRNG — 256 bits — so there is nothing to brute
 * force, and making the lookup slow would only mean every authenticated request
 * paid 50 ms of Argon2id before it could read a row.
 */

/** 32 bytes, base64url. ~43 characters, safe in a URL and in a cookie. */
export const SECRET_BYTES = 32;

export interface IssuedSecret {
  /** Handed to the browser or put in the mailed link. Never stored. */
  readonly secret: string;
  /** Stored. The only representation that touches the database. */
  readonly digest: string;
}

export function issueSecret(): IssuedSecret {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { secret, digest: digestSecret(secret) };
}

/** SHA-256, hex. The one function that turns a presented secret into a lookup key. */
export function digestSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two digests.
 *
 * The lookup is by digest, so in the ordinary path the database has already done
 * the comparison — but a caller that has both values in hand (verifying a token it
 * just read) must not compare them with `===`, which returns on the first differing
 * byte and leaks the length of the shared prefix.
 */
export function digestsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Documented lifetimes
// ---------------------------------------------------------------------------

/**
 * How long each kind of link lives, and why each number is what it is.
 *
 * Every one of these is a number in code, referenced by the flows rather than
 * repeated in them, and restated in `docs/ARCHITECTURE.md` under "Sessions, tokens
 * and the four-role matrix".
 *
 *  - **magic link — 15 minutes.** It is a full sign-in credential sitting in an
 *    inbox. Short enough that a shoulder-surfed notification is stale by the time
 *    anyone acts on it, long enough to survive a slow mail relay.
 *  - **password reset — 1 hour.** Longer, because the person asking is often not
 *    at their desk and a reset that has expired by the time they read the mail is
 *    a support ticket. Still single-use, and issuing a new one revokes the old.
 *  - **seat invite — 14 days.** A person being invited to an organization may be on
 *    leave, and a fortnight covers one. An owner can resend, which revokes the
 *    previous token and issues a new fourteen-day one, so the long window never
 *    means an *unrevokable* one — and past it the link is refused as `expired`
 *    rather than quietly still working.
 */
export const TOKEN_TTL_MILLIS: Readonly<Record<AuthTokenPurpose, number>> = {
  magic_link: 15 * MILLIS_PER_MINUTE,
  password_reset: MILLIS_PER_HOUR,
  invite: 14 * MILLIS_PER_DAY,
};

/**
 * Human wording for each lifetime, for the sentence the product actually shows.
 *
 * Every screen and every response body that states a lifetime reads it from here.
 * Three of them used to spell the invite window out — "expires in seven days" in the
 * seat screen, in the empty state and in `/api/seats`'s success message — so changing
 * the number changed the behaviour and left the product telling people otherwise.
 */
export const TOKEN_TTL_LABEL: Readonly<Record<AuthTokenPurpose, string>> = {
  magic_link: '15 minutes',
  password_reset: '1 hour',
  invite: '14 days',
};

export const tokenExpiryFor = (purpose: AuthTokenPurpose, issuedAt: Instant): Instant =>
  addMillis(issuedAt, TOKEN_TTL_MILLIS[purpose]);

/**
 * Why a presented token cannot be used. Null means it can.
 *
 * A closed set rather than free text, so a route can decide the status code and the
 * UI can decide the sentence without parsing a message. Every one of them is stated
 * to the person rather than collapsed into "invalid link": "you have already used
 * this" and "an owner took this invitation back" need different next steps.
 */
export type TokenRejection = 'not_found' | 'expired' | 'already_used' | 'revoked' | 'wrong_purpose';

export interface PresentedToken {
  readonly purpose: AuthTokenPurpose;
  readonly expiresAt: Instant;
  readonly consumedAt: Instant | null;
  readonly revokedAt: Instant | null;
}

export function tokenRejection(
  token: PresentedToken | null,
  expectedPurpose: AuthTokenPurpose,
  now: Instant,
): TokenRejection | null {
  if (token === null) return 'not_found';
  if (token.purpose !== expectedPurpose) return 'wrong_purpose';
  if (token.revokedAt !== null) return 'revoked';
  if (token.consumedAt !== null) return 'already_used';
  if (now >= token.expiresAt) return 'expired';
  return null;
}

/** The sentence a person reads when their link does not work. */
export function describeTokenRejection(rejection: TokenRejection, purpose: AuthTokenPurpose): string {
  const lifetime = TOKEN_TTL_LABEL[purpose];
  switch (rejection) {
    case 'already_used':
      return 'This link has already been used. Each one works exactly once — request a new one.';
    case 'expired':
      return `This link has expired. They last ${lifetime} from the moment they are sent — request a new one.`;
    case 'revoked':
      return 'This link was withdrawn before it was used. Ask an owner of the organization to send another.';
    case 'wrong_purpose':
      return 'This link is for something else. Follow the one from the message you were expecting.';
    case 'not_found':
      return 'This link is not one Compass issued. Check that the whole address was copied, then request a new one.';
  }
}
