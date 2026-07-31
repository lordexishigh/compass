import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Instant } from '@compass/clock';

/**
 * Share-link tokens: unguessable, and not derived from anything.
 *
 * ## Why 128 bits from a CSPRNG and nothing else
 *
 * The obvious shortcut is to derive the token from the report id — a hash, or an HMAC. It is
 * wrong here, and not subtly: report ids in Compass are *themselves* derived, from
 * `(organization, scope, instant)`. So "guess the token" would collapse to "guess which team
 * and which date", and every report the organization has ever generated would have a
 * predictable share URL. `mintShareToken` therefore reads 16 bytes from the system CSPRNG and
 * derives the token from nothing at all — `tests/share-token.test.ts` asserts non-derivation
 * directly by minting many tokens for the same report id and finding no relationship.
 *
 * ## Why only the digest is stored
 *
 * The token is shown once, when the link is created, and only its SHA-256 goes in
 * `share_links.token_hash` — the same rule `auth_tokens` follows. A stolen database backup
 * yields no working links, and a lookup stays an indexed equality read on the digest.
 */

/** 16 bytes = 128 bits, as the criterion requires. */
export const SHARE_TOKEN_BYTES = 16;

/** Base64url of 16 bytes is 22 characters with no padding. */
export const SHARE_TOKEN_LENGTH = 22;

export interface MintedShareToken {
  /** Shown to the manager once. Never stored. */
  readonly token: string;
  /** SHA-256 hex. This is what goes in the database. */
  readonly tokenHash: string;
}

export function mintShareToken(): MintedShareToken {
  // base64url so the token is URL-safe without escaping: a `+` or `/` in a path segment is a
  // link that breaks when something helpfully re-encodes it.
  const token = randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashShareToken(token) };
}

export const hashShareToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Digest comparison in constant time.
 *
 * The lookup is by digest so this is belt-and-braces, but a share token is a bearer credential
 * and comparing bearer credentials with `===` is how timing oracles get built.
 */
export function shareTokenMatches(candidate: string, storedHash: string): boolean {
  const left = Buffer.from(hashShareToken(candidate), 'hex');
  const right = Buffer.from(storedHash, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The expiry options the UI offers. `never` is a real choice and is stored as null. */
export const SHARE_EXPIRY_CHOICES = [7, 30, 90, 'never'] as const;

export type ShareExpiryChoice = (typeof SHARE_EXPIRY_CHOICES)[number];

export const isShareExpiryChoice = (value: unknown): value is ShareExpiryChoice =>
  (SHARE_EXPIRY_CHOICES as readonly unknown[]).includes(value);

/**
 * Why a token was refused, or that it was served.
 *
 * `revoked` and `expired` are distinct even though both end in a refusal, because they are
 * different facts about the link and an access log that conflated them could not tell "somebody
 * took this back" from "this aged out".
 */
export type ShareLinkVerdict = 'served' | 'expired' | 'revoked' | 'forbidden' | 'not_found';

export interface ShareLinkState {
  readonly revokedAt: Instant | null;
  readonly expiresAt: Instant | null;
  readonly audience: 'org_members' | 'public';
}

/**
 * Whether a share link may be served, as a pure function of its row and the request.
 *
 * Revocation is checked before expiry so a link that is both reads as revoked — the deliberate
 * act is the more informative fact. `org_members` is the default audience, so a link that is
 * merely un-guessed still refuses an anonymous reader: a hard-to-guess URL is not an
 * authorization decision.
 */
export function shareLinkVerdict(
  state: ShareLinkState,
  request: { readonly now: Instant; readonly signedIn: boolean },
): ShareLinkVerdict {
  if (state.revokedAt !== null) return 'revoked';
  if (state.expiresAt !== null && request.now >= state.expiresAt) return 'expired';
  if (state.audience === 'org_members' && !request.signedIn) return 'forbidden';
  return 'served';
}

/**
 * The HTTP status a verdict becomes.
 *
 * 410 for a link that existed and is finished — revoked or expired — because "this is gone" is
 * a different and more useful answer than "this was never here". 404 for a token that matches
 * nothing, which also refuses to confirm that any given token *could* have been valid.
 */
export const SHARE_LINK_STATUS: Readonly<Record<ShareLinkVerdict, number>> = {
  served: 200,
  expired: 410,
  revoked: 410,
  forbidden: 403,
  not_found: 404,
};

/**
 * An IP address reduced to a prefix — /24 for IPv4, /48 for IPv6.
 *
 * Enough to tell "one office" from "forty countries", which is the question an operator asks of
 * a share-link access log, without keeping a precise record of where a manager reads their
 * daily from. Returns null for an address it cannot parse rather than storing a guess.
 */
export function ipPrefixOf(address: string | null | undefined): string | null {
  if (address === null || address === undefined) return null;
  const trimmed = address.trim();
  if (trimmed.length === 0) return null;

  // `x-forwarded-for` is a list; the first entry is the client.
  const first = trimmed.split(',')[0]?.trim() ?? '';
  if (first.length === 0) return null;

  if (first.includes(':')) {
    const groups = first.split(':').filter((group) => group.length > 0);
    if (groups.length < 3) return null;
    return `${groups.slice(0, 3).join(':')}::/48`;
  }

  const octets = first.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return null;
  return `${octets.slice(0, 3).join('.')}.0/24`;
}
