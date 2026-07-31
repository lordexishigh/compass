import { instantFromIso } from '@compass/clock';
import {
  SHARE_LINK_STATUS,
  SHARE_TOKEN_BYTES,
  hashShareToken,
  ipPrefixOf,
  isShareExpiryChoice,
  mintShareToken,
  shareLinkVerdict,
  shareTokenMatches,
} from '@compass/delivery';
import { describe, expect, it } from 'vitest';

/**
 * Share-link tokens.
 *
 * The criterion is unusually specific — "tokens are 128 bits from a CSPRNG" and "tokens are not
 * derived from report ids" — and the second half is the one worth testing hard. Deriving a token
 * from the report id would be a reasonable-looking mistake with a severe consequence: report ids
 * in Compass are themselves derived from `(organization, scope, instant)`, so a derived token
 * would collapse "guess the token" into "guess the team and the date".
 */

const at = (iso: string) => instantFromIso(iso);

describe('a minted share token', () => {
  it('carries 128 bits of entropy', () => {
    const { token } = mintShareToken();

    // base64url of 16 bytes: 22 characters, no padding.
    expect(SHARE_TOKEN_BYTES).toBe(16);
    expect(token).toHaveLength(22);
    expect(Buffer.from(token, 'base64url')).toHaveLength(16);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('is different every time, with no collisions across a large sample', () => {
    const tokens = new Set(Array.from({ length: 5_000 }, () => mintShareToken().token));

    // A generator seeded from a report id, a counter or a clock would collide or correlate here.
    expect(tokens.size).toBe(5_000);
  });

  it('uses the whole alphabet, as a CSPRNG would', () => {
    // A weak or truncated generator tends to leave characters unused. Not a proof of
    // randomness, but it fails loudly for the mistakes that actually happen.
    const sample = Array.from({ length: 500 }, () => mintShareToken().token).join('');
    const distinct = new Set(sample).size;

    expect(distinct).toBeGreaterThan(50);
  });

  it('is not derived from the report id, or from anything else', () => {
    // The direct test of non-derivation: mint many tokens "for" one report and show that
    // nothing about the report reaches the token. A derived implementation returns the same
    // token every time, or a token containing the id, or one recoverable from it.
    const reportId = '9f1c1e2a-0000-4000-8000-000000000001';
    const minted = Array.from({ length: 200 }, () => mintShareToken());

    expect(new Set(minted.map((entry) => entry.token)).size).toBe(200);
    for (const { token, tokenHash } of minted) {
      expect(token).not.toContain(reportId);
      expect(token).not.toContain(reportId.replace(/-/g, ''));
      expect(tokenHash).not.toBe(hashShareToken(reportId));
    }
  });

  it('stores only the digest, and the digest is a SHA-256 of the token', () => {
    const { token, tokenHash } = mintShareToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashShareToken(token));
    expect(tokenHash).not.toContain(token);
  });

  it('matches its own digest and nothing else', () => {
    const { token, tokenHash } = mintShareToken();
    const other = mintShareToken();

    expect(shareTokenMatches(token, tokenHash)).toBe(true);
    expect(shareTokenMatches(other.token, tokenHash)).toBe(false);
    // A malformed digest must be a mismatch rather than a throw: it arrives from a URL.
    expect(shareTokenMatches(token, 'not-a-digest')).toBe(false);
  });
});

describe('whether a share link may be served', () => {
  const now = at('2026-08-03T09:00:00Z');
  const base = { revokedAt: null, expiresAt: null, audience: 'org_members' } as const;

  it('serves a live link to a signed-in reader', () => {
    expect(shareLinkVerdict(base, { now, signedIn: true })).toBe('served');
  });

  it('defaults to org members only, refusing an anonymous reader', () => {
    // A hard-to-guess URL is not an authorization decision, and the org's blockers are not a
    // landing page.
    expect(shareLinkVerdict(base, { now, signedIn: false })).toBe('forbidden');
  });

  it('serves an explicitly public link to anybody', () => {
    expect(shareLinkVerdict({ ...base, audience: 'public' }, { now, signedIn: false })).toBe('served');
  });

  it('refuses an expired link, and expiry is half-open', () => {
    const expiresAt = at('2026-08-03T09:00:00Z');

    // Exactly at the expiry instant it is already gone — the same half-open rule every other
    // span in the product follows.
    expect(shareLinkVerdict({ ...base, expiresAt }, { now, signedIn: true })).toBe('expired');
    expect(
      shareLinkVerdict({ ...base, expiresAt: at('2026-08-03T09:00:00.001Z') }, { now, signedIn: true }),
    ).toBe('served');
  });

  it('refuses a revoked link, and says revoked rather than expired when it is both', () => {
    const state = { ...base, revokedAt: at('2026-08-02T00:00:00Z'), expiresAt: at('2026-08-01T00:00:00Z') };

    // The deliberate act is the more informative fact for whoever is asking why.
    expect(shareLinkVerdict(state, { now, signedIn: true })).toBe('revoked');
  });

  it('answers 410 for a link that is finished and 404 for one that never existed', () => {
    // "This is gone" and "this was never here" are different answers, and the second must not
    // confirm that any given token could have been valid.
    expect(SHARE_LINK_STATUS.revoked).toBe(410);
    expect(SHARE_LINK_STATUS.expired).toBe(410);
    expect(SHARE_LINK_STATUS.not_found).toBe(404);
    expect(SHARE_LINK_STATUS.forbidden).toBe(403);
    expect(SHARE_LINK_STATUS.served).toBe(200);
  });
});

describe('the expiry choices', () => {
  it('offers 7, 30, 90 days and never', () => {
    expect(isShareExpiryChoice(7)).toBe(true);
    expect(isShareExpiryChoice(30)).toBe(true);
    expect(isShareExpiryChoice(90)).toBe(true);
    expect(isShareExpiryChoice('never')).toBe(true);
    expect(isShareExpiryChoice(1)).toBe(false);
    expect(isShareExpiryChoice('forever')).toBe(false);
  });
});

describe('the IP prefix an access row records', () => {
  it('truncates IPv4 to /24 and a full IPv6 to /48', () => {
    // Enough to tell one office from forty countries, without keeping a precise record of
    // where a manager reads their daily from.
    expect(ipPrefixOf('203.0.113.42')).toBe('203.0.113.0/24');
    expect(ipPrefixOf('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::/48');
  });

  it('expands `::` before slicing, so the network it names is the real one', () => {
    // The bug this replaced dropped the empty groups and took the first three, turning
    // `2001:db8::abcd` into `2001:db8:abcd::/48` — a network the client is demonstrably not
    // on, written into an audit log as though it were fact.
    expect(ipPrefixOf('2001:db8::abcd')).toBe('2001:db8:0::/48');
    expect(ipPrefixOf('2001:db8::')).toBe('2001:db8:0::/48');
    expect(ipPrefixOf('2001::1')).toBe('2001:0:0::/48');
    expect(ipPrefixOf('::1')).toBe('0:0:0::/48');
    expect(ipPrefixOf('fe80::1234:5678:9abc:def0')).toBe('fe80:0:0::/48');
  });

  it('treats an IPv4-mapped address as the IPv4 client it is', () => {
    // A /48 of a mapped address describes nothing real, and returning null lost the one
    // address a dual-stack proxy actually forwards.
    expect(ipPrefixOf('::ffff:203.0.113.7')).toBe('203.0.113.0/24');
    expect(ipPrefixOf('::ffff:203.0.113.7, 70.41.3.18')).toBe('203.0.113.0/24');
  });

  it('takes the client from a forwarded-for list', () => {
    expect(ipPrefixOf('203.0.113.42, 70.41.3.18, 150.172.238.178')).toBe('203.0.113.0/24');
  });

  it('records nothing rather than a guess for an address it cannot parse', () => {
    expect(ipPrefixOf(null)).toBeNull();
    expect(ipPrefixOf(undefined)).toBeNull();
    expect(ipPrefixOf('')).toBeNull();
    expect(ipPrefixOf('not-an-address')).toBeNull();
    expect(ipPrefixOf('999.1.1')).toBeNull();
    expect(ipPrefixOf('300.1.1.1'), 'an octet over 255 is not an address').toBeNull();
    expect(ipPrefixOf('2001:db8::abcd::1'), 'two `::` runs is not an address').toBeNull();
    expect(ipPrefixOf('2001:db8:85a3'), 'a short address with no `::` is not one').toBeNull();
    expect(ipPrefixOf('2001:zzzz::1')).toBeNull();
  });
});
