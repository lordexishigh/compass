import { randomUUID } from 'node:crypto';

import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  createShareLink,
  listShareLinkAccess,
  listTeamScopes,
  orgScope,
  organizations,
  replaceTeamScopes,
  reports,
  revokeShareLink,
  memberships,
  users,
} from '@compass/db';
import { createTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SHARE_LINK_STATUS, hashShareToken, mintShareToken, shareLinkVerdict } from '@compass/delivery';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { saveSubscription } from '../lib/subscription-source';

/**
 * Share links and the subscription defaults, against a real migrated database.
 *
 * The route itself is exercised through the same functions it calls — `findShareLinkByTokenHash`,
 * `shareLinkVerdict`, `recordShareLinkAccess` — because the interesting behaviour is the
 * *combination*: a revoked link must answer 410 on the very next request, an expired one must do so
 * against an injected instant rather than the wall clock, and every outcome must leave an access row
 * behind including the refusals.
 */

const ORG = '55555555-5555-4555-8555-555555555555';
const USER = '66666666-6666-4666-8666-666666666666';
const MEMBERSHIP = '77777777-7777-4777-8777-777777777777';
const REPORT = '88888888-8888-4888-8888-888888888888';

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-03T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORG));

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  await database.db
    .insert(organizations)
    .values({
      id: ORG,
      organizationId: ORG,
      name: 'Acme',
      slug: 'acme-share',
      timezone: 'Europe/London',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .onConflictDoNothing()
    .execute();

  await scoped()
    .insertInto(users, {
      id: USER,
      email: 'priya@acme.example',
      displayName: 'Priya Raman',
      passwordHash: null,
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(memberships, {
      id: MEMBERSHIP,
      userId: USER,
      role: 'manager',
      status: 'active',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(reports, {
      id: REPORT,
      scopeKind: 'team',
      scopeKey: 'platform',
      schemaVersion: 1,
      reportInstant: asDate('2026-08-03T06:00:00Z'),
      reportDate: '2026-08-03',
      timezone: 'Europe/London',
      windowStart: asDate('2026-08-02T00:00:00Z'),
      windowEnd: asDate('2026-08-03T00:00:00Z'),
      contentHash: 'b'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: 'The whole report.',
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'complete',
      ingestRunId: null,
      generatedAt: asDate('2026-08-03T06:00:00Z'),
    })
    .execute();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

const newLink = async (overrides: { readonly expiresAt?: Instant | null; readonly audience?: 'org_members' | 'public' } = {}) => {
  const minted = mintShareToken();
  const link = await createShareLink(
    scoped(),
    {
      id: randomUUID(),
      reportId: REPORT,
      tokenHash: minted.tokenHash,
      audience: overrides.audience ?? 'org_members',
      expiresAt: overrides.expiresAt ?? null,
      createdByUserId: USER,
    },
    NOW,
  );
  return { link, token: minted.token };
};

describe('a revoked share link', () => {
  it('answers 410 on the very next request', async () => {
    const { link } = await newLink();

    // Live first, so the revocation is the only thing that changed.
    expect(
      shareLinkVerdict(
        { revokedAt: link.revokedAt, expiresAt: link.expiresAt, audience: link.audience },
        { now: NOW, signedIn: true },
      ),
    ).toBe('served');

    await revokeShareLink(scoped(), link.id, at('2026-08-03T10:00:00Z'));

    const { findShareLinkByTokenHash } = await import('@compass/db');
    const reread = await findShareLinkByTokenHash(scoped(), link.tokenHash);
    expect(reread?.revokedAt, 'revocation must actually persist').not.toBeNull();

    const verdict = shareLinkVerdict(
      { revokedAt: reread?.revokedAt ?? null, expiresAt: reread?.expiresAt ?? null, audience: 'org_members' },
      { now: at('2026-08-03T11:00:00Z'), signedIn: true },
    );

    expect(verdict).toBe('revoked');
    expect(SHARE_LINK_STATUS[verdict]).toBe(410);
  });

  it('keeps the row, so the access log still points at something', async () => {
    const { link } = await newLink();
    await revokeShareLink(scoped(), link.id, NOW);

    const { findShareLinkById } = await import('@compass/db');
    expect(await findShareLinkById(scoped(), link.id)).not.toBeNull();
  });
});

describe('an expired share link', () => {
  it('answers 410 once the injected instant passes its expiry', async () => {
    const expiresAt = at('2026-08-10T09:00:00Z');
    const { link } = await newLink({ expiresAt });

    // Before: served. The clock is injected, so this needs no waiting and no wall clock.
    expect(
      shareLinkVerdict(
        { revokedAt: null, expiresAt: link.expiresAt, audience: link.audience },
        { now: at('2026-08-09T09:00:00Z'), signedIn: true },
      ),
    ).toBe('served');

    // Exactly at the expiry it is already gone — half-open, like every other span in the product.
    const verdict = shareLinkVerdict(
      { revokedAt: null, expiresAt: link.expiresAt, audience: link.audience },
      { now: expiresAt, signedIn: true },
    );

    expect(verdict).toBe('expired');
    expect(SHARE_LINK_STATUS[verdict]).toBe(410);
  });

  it('never expires when no expiry was chosen', async () => {
    const { link } = await newLink({ expiresAt: null });

    expect(
      shareLinkVerdict(
        { revokedAt: null, expiresAt: link.expiresAt, audience: link.audience },
        { now: at('2030-01-01T00:00:00Z'), signedIn: true },
      ),
    ).toBe('served');
  });
});

describe('the audience default', () => {
  it('refuses an anonymous reader, because a hard-to-guess URL is not an authorization decision', async () => {
    const { link } = await newLink();

    expect(link.audience).toBe('org_members');
    expect(
      shareLinkVerdict(
        { revokedAt: null, expiresAt: null, audience: link.audience },
        { now: NOW, signedIn: false },
      ),
    ).toBe('forbidden');
    expect(SHARE_LINK_STATUS.forbidden).toBe(403);
  });

  it('serves an explicitly public link to anybody', async () => {
    const { link } = await newLink({ audience: 'public' });

    expect(
      shareLinkVerdict(
        { revokedAt: null, expiresAt: null, audience: link.audience },
        { now: NOW, signedIn: false },
      ),
    ).toBe('served');
  });
});

describe('the access log', () => {
  it('records a refusal as well as a success', async () => {
    const { link } = await newLink();
    const { recordShareLinkAccess } = await import('@compass/db');

    for (const outcome of ['served', 'revoked', 'forbidden'] as const) {
      await recordShareLinkAccess(
        scoped(),
        {
          id: randomUUID(),
          shareLinkId: link.id,
          outcome,
          ipPrefix: '203.0.113.0/24',
          userAgent: 'Mozilla/5.0',
          userId: outcome === 'forbidden' ? null : USER,
        },
        NOW,
      );
    }

    const rows = await listShareLinkAccess(scoped(), link.id);

    // "Somebody tried a revoked link forty times last night" is the fact this table exists for,
    // and a log of successes only could not state it.
    expect(rows.map((row) => row.outcome).sort()).toEqual(['forbidden', 'revoked', 'served']);
    expect(rows.every((row) => row.ipPrefix === '203.0.113.0/24')).toBe(true);
  });

  it('records an unmatched token with no link to point at', async () => {
    const { recordShareLinkAccess } = await import('@compass/db');

    // A token-guessing sweep looks exactly like this, and there is no row to attach it to.
    await recordShareLinkAccess(
      scoped(),
      {
        id: randomUUID(),
        shareLinkId: null,
        outcome: 'not_found',
        ipPrefix: '198.51.100.0/24',
        userAgent: 'curl/8.0',
        userId: null,
      },
      NOW,
    );

    expect(SHARE_LINK_STATUS.not_found).toBe(404);
  });
});

describe('the token a share link is found by', () => {
  it('is matched by digest, never by the token itself', async () => {
    const { link, token } = await newLink();
    const { findShareLinkByTokenHash } = await import('@compass/db');

    expect(await findShareLinkByTokenHash(scoped(), hashShareToken(token))).not.toBeNull();
    // The plaintext is not what is stored, so looking it up directly finds nothing.
    expect(await findShareLinkByTokenHash(scoped(), token)).toBeNull();
    expect(link.tokenHash).not.toBe(token);
  });
});

describe('the scope a new subscription defaults to', () => {
  it('is the team report for a manager scoped to one team', async () => {
    await replaceTeamScopes(scoped(), MEMBERSHIP, ['platform'], NOW);
    expect(await listTeamScopes(scoped(), MEMBERSHIP)).toEqual(['platform']);

    const created = await saveSubscription(
      scoped(),
      {
        userId: USER,
        membershipId: MEMBERSHIP,
        channel: 'email',
        target: 'priya@acme.example',
        sendTime: '07:30',
        timezone: 'Europe/London',
      },
      { newId: () => randomUUID(), at: NOW },
    );

    expect(created.teamKeys).toEqual(['platform']);
    expect(created.subscription.scope).toBe('team');
  });

  it('is the merged report for a manager scoped to two teams', async () => {
    // Read through the real roster table, so the default follows a person being moved between
    // teams rather than a list the caller happened to pass.
    await replaceTeamScopes(scoped(), MEMBERSHIP, ['platform', 'checkout'], NOW);

    const created = await saveSubscription(
      scoped(),
      {
        userId: USER,
        membershipId: MEMBERSHIP,
        channel: 'slack',
        target: '#platform-daily',
        sendTime: '08:45',
        timezone: 'America/New_York',
      },
      { newId: () => randomUUID(), at: NOW },
    );

    expect(created.teamKeys).toEqual(['checkout', 'platform']);
    expect(created.subscription.scope).toBe('merged');
  });

  it('mints an unsubscribe token and stores only its digest', async () => {
    // The column is NOT NULL, so a creation path that minted nothing could not write a row at all
    // — and the RFC 8058 button in every email points at whatever this produces.
    const created = await saveSubscription(
      scoped(),
      {
        userId: USER,
        membershipId: MEMBERSHIP,
        channel: 'email',
        target: 'priya@acme.example',
        sendTime: '07:30',
        timezone: 'Europe/London',
      },
      { newId: () => randomUUID(), at: NOW },
    );

    expect(created.unsubscribeToken).toHaveLength(22);
    expect(created.subscription.unsubscribeTokenHash).toBe(hashShareToken(created.unsubscribeToken));
    expect(created.subscription.unsubscribeTokenHash).not.toBe(created.unsubscribeToken);
  });

  it('refuses a bad timezone or send time before writing anything', async () => {
    // The worst failure this feature has is a subscription that looks configured and silently never
    // sends, so the boundary refuses rather than storing it.
    await expect(
      saveSubscription(
        scoped(),
        {
          userId: USER,
          membershipId: MEMBERSHIP,
          channel: 'email',
          target: 'priya@acme.example',
          sendTime: '07:30',
          timezone: 'Middle/Earth',
        },
        { newId: () => randomUUID(), at: NOW },
      ),
    ).rejects.toThrow(/IANA/);

    await expect(
      saveSubscription(
        scoped(),
        {
          userId: USER,
          membershipId: MEMBERSHIP,
          channel: 'email',
          target: 'priya@acme.example',
          sendTime: '7:30',
          timezone: 'Europe/London',
        },
        { newId: () => randomUUID(), at: NOW },
      ),
    ).rejects.toThrow(/HH:MM/);
  });

  it('honours an explicit scope over the roster default', async () => {
    await replaceTeamScopes(scoped(), MEMBERSHIP, ['platform', 'checkout'], NOW);

    const created = await saveSubscription(
      scoped(),
      {
        userId: USER,
        membershipId: MEMBERSHIP,
        channel: 'email',
        target: 'priya@acme.example',
        scope: 'both',
        sendTime: '07:30',
        timezone: 'Europe/London',
      },
      { newId: () => randomUUID(), at: NOW },
    );

    expect(created.subscription.scope).toBe('both');
  });
});
