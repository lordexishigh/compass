import { instantFromIso, type Instant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_LINK_TTL_DAYS,
  FEEDBACK_LINK_TTL_MILLIS,
  FEEDBACK_TOKEN_VERSION,
  FeedbackLinkSecretMissingError,
  feedbackLinkExpiry,
  feedbackLinkIsStateChanging,
  feedbackLinkUrl,
  feedbackTokenPayload,
  hashFeedbackToken,
  mintFeedbackToken,
  verifyFeedbackToken,
} from '@compass/delivery';

/**
 * Signed email feedback links.
 *
 * Four properties the criterion names, and each one is a refusal of something easier: scoped to one
 * item and one action, expiring after 30 days, single-use for anything that changes state, and never
 * a session. The last is the one nobody would notice breaking, so it is asserted at the route level
 * too (`apps/web/tests/feedback-links.test.ts` checks for the absence of `set-cookie`).
 */

const SECRET = 'a-long-random-string-that-is-not-a-default';
const NOW: Instant = instantFromIso('2026-08-03T06:00:00Z');
const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const ITEM = 'v1:8f2c1a0b3d4e5f60';

const mint = (action = 'dismiss_risk', now: Instant = NOW) =>
  mintFeedbackToken({ organizationId: ORGANIZATION, itemStableId: ITEM, action }, now, SECRET);

describe('a link is scoped to one item and one action', () => {
  it('carries both, and verifies back to exactly them', () => {
    const minted = mint();
    const verified = verifyFeedbackToken(minted.token, NOW, SECRET);

    expect(verified.verdict).toBe('accepted');
    if (verified.verdict !== 'accepted') return;
    expect(verified.claims.itemStableId).toBe(ITEM);
    expect(verified.claims.action).toBe('dismiss_risk');
    expect(verified.claims.organizationId).toBe(ORGANIZATION);
  });

  it('cannot be re-aimed at another action by editing the URL', () => {
    // The signature covers the action, so swapping it invalidates the token rather than widening it.
    const minted = mint('snooze');
    const reaimed = minted.token.replace('.snooze.', '.dismiss_risk.');

    expect(reaimed).not.toBe(minted.token);
    expect(verifyFeedbackToken(reaimed, NOW, SECRET).verdict).toBe('bad_signature');
  });

  it('cannot be re-aimed at another item', () => {
    const minted = mint();
    const reaimed = minted.token.replace(ITEM, 'v1:0000000000000000');

    expect(verifyFeedbackToken(reaimed, NOW, SECRET).verdict).toBe('bad_signature');
  });

  it('length-prefixes the signed fields, so a separator inside one cannot be re-read', () => {
    // `a|b` + `c` must not sign identically to `a` + `b|c`, or a link scoped to one action could be
    // read as a link scoped to another.
    const left = feedbackTokenPayload(
      { organizationId: ORGANIZATION, itemStableId: 'v1:aa', action: 'snooze|x', expiresAt: NOW },
      'n',
    );
    const right = feedbackTokenPayload(
      { organizationId: ORGANIZATION, itemStableId: 'v1:aa|snooze', action: 'x', expiresAt: NOW },
      'n',
    );

    expect(left).not.toBe(right);
  });

  it('signs the version, so bumping it invalidates every live link', () => {
    expect(feedbackTokenPayload({ organizationId: 'o', itemStableId: 'i', action: 'a', expiresAt: NOW }, 'n')).toContain(
      `:${FEEDBACK_TOKEN_VERSION}|`,
    );
    expect(mint().token.startsWith(`${FEEDBACK_TOKEN_VERSION}.`)).toBe(true);
  });
});

describe('a link expires after 30 days', () => {
  it('documents the window as a number', () => {
    expect(FEEDBACK_LINK_TTL_DAYS).toBe(30);
    expect(FEEDBACK_LINK_TTL_MILLIS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(feedbackLinkExpiry(NOW)).toBe(NOW + FEEDBACK_LINK_TTL_MILLIS);
  });

  it('is accepted the instant before and refused at the expiry, half-open', () => {
    const minted = mint();
    const expiry = feedbackLinkExpiry(NOW);

    expect(verifyFeedbackToken(minted.token, (expiry - 1) as Instant, SECRET).verdict).toBe('accepted');
    expect(verifyFeedbackToken(minted.token, expiry, SECRET).verdict).toBe('expired');
    expect(verifyFeedbackToken(minted.token, (expiry + 1) as Instant, SECRET).verdict).toBe('expired');
  });

  it('cannot have its expiry extended by editing the URL', () => {
    // The expiry is inside the signed payload. This is also why the signature is checked *before*
    // the expiry: otherwise the handler would be reasoning about a number the caller supplied.
    const minted = mint();
    const forged = minted.token.replace(String(minted.expiresAt), String(minted.expiresAt + 365 * 86_400_000));

    expect(verifyFeedbackToken(forged, feedbackLinkExpiry(NOW), SECRET).verdict).toBe('bad_signature');
  });
});

describe('the secret is required, and there is no default', () => {
  it('refuses to mint without one', () => {
    expect(() => mintFeedbackToken({ organizationId: ORGANIZATION, itemStableId: ITEM, action: 'snooze' }, NOW, undefined)).toThrow(
      FeedbackLinkSecretMissingError,
    );
    expect(() => mintFeedbackToken({ organizationId: ORGANIZATION, itemStableId: ITEM, action: 'snooze' }, NOW, '')).toThrow(
      FeedbackLinkSecretMissingError,
    );
  });

  it('says so in a sentence naming the variable', () => {
    try {
      mintFeedbackToken({ organizationId: ORGANIZATION, itemStableId: ITEM, action: 'snooze' }, NOW, undefined);
      expect.unreachable('minting without a secret must throw');
    } catch (error) {
      expect((error as FeedbackLinkSecretMissingError).detail).toContain('COMPASS_FEEDBACK_LINK_SECRET');
      expect((error as FeedbackLinkSecretMissingError).detail).toContain('not a signature');
    }
  });

  it('refuses to verify without one, rather than accepting anything', () => {
    const minted = mint();
    expect(verifyFeedbackToken(minted.token, NOW, undefined).verdict).toBe('unconfigured');
  });

  it('refuses a token signed under a different secret', () => {
    const minted = mint();
    expect(verifyFeedbackToken(minted.token, NOW, 'a-different-secret').verdict).toBe('bad_signature');
  });
});

describe('single use', () => {
  it('gives each minted link its own digest, so one email does not burn the next', () => {
    // Without the nonce, "dismiss item X" would sign identically in every email forever, and the
    // single-use record would burn Monday's link and Thursday's with it.
    const first = mint();
    const second = mint();

    expect(first.token).not.toBe(second.token);
    expect(hashFeedbackToken(first.token)).not.toBe(hashFeedbackToken(second.token));
  });

  it('digests the token rather than storing it', () => {
    const minted = mint();
    const digest = hashFeedbackToken(minted.token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(minted.token);
    // The same token always digests the same way, which is what makes the primary key work.
    expect(hashFeedbackToken(minted.token)).toBe(digest);
  });

  it('names which actions spend the link', () => {
    // A read-only link has nothing to spend, and burning it on a mail scanner's prefetch would send
    // the manager's own click to an error page.
    expect(feedbackLinkIsStateChanging('dismiss_risk')).toBe(true);
    expect(feedbackLinkIsStateChanging('snooze')).toBe(true);
    expect(feedbackLinkIsStateChanging('view')).toBe(false);
  });
});

describe('malformed tokens are refused without leaking what they named', () => {
  it('refuses a token of the wrong shape', () => {
    for (const candidate of ['', 'not-a-token', 'f1.only.four.parts.here', `f9.${ORGANIZATION}.i.a.1.n.s`]) {
      const verdict = verifyFeedbackToken(candidate, NOW, SECRET);
      expect(verdict.verdict, candidate).toBe('malformed');
    }
  });

  it('refuses a token with a non-numeric expiry', () => {
    expect(verifyFeedbackToken(`f1.${ORGANIZATION}.${ITEM}.snooze.soon.nonce.sig`, NOW, SECRET).verdict).toBe(
      'malformed',
    );
  });

  it('states each refusal in the product’s own voice, never a code', () => {
    const refusal = verifyFeedbackToken('not-a-token', NOW, SECRET);
    expect(refusal.verdict).not.toBe('accepted');
    if (refusal.verdict === 'accepted') return;
    expect(refusal.detail.length).toBeGreaterThan(20);
    expect(refusal.detail).toContain('Compass');
  });
});

describe('the URL a button points at', () => {
  it('is absolute, escaped and single-purpose', () => {
    const minted = mint();
    const url = feedbackLinkUrl('https://compass.acme.example/', minted.token);

    expect(url).toBe(`https://compass.acme.example/api/feedback/link/${encodeURIComponent(minted.token)}`);
    // One trailing slash or three, the URL is the same: a base URL is configuration and configuration
    // is typed by people.
    expect(feedbackLinkUrl('https://compass.acme.example///', minted.token)).toBe(url);
  });
});
