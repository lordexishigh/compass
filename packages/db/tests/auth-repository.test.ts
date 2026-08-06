import { instantFromIso, type Instant } from '@compass/clock';
import {
  APPEND_ONLY_TABLE_NAMES,
  AppendOnlyTableError,
  appendAuditLogEntry,
  auditLogEntries,
  authTokens,
  consumeAuthToken,
  ensureMembership,
  ensureUser,
  findAuthTokenByHash,
  findSessionByTokenHash,
  insertAuthToken,
  insertSession,
  listAuditLogEntries,
  listSeats,
  listTeamScopes,
  membershipTeamScopes,
  normalizeEmail,
  replaceTeamScopes,
  revokeAllSessionsForUser,
  revokeAuthTokens,
  touchSession,
  type ScopedDb,
} from '@compass/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

/**
 * The identity tables, against a real PostgreSQL 17.
 *
 * Two things can only be proved here and not in a source scan: that the database itself
 * refuses to rewrite the audit log, and that a scope really does keep one tenant's seats
 * out of another's queries.
 */

const ORG_A = '11111111-1111-4111-8111-1111111111a7';
const ORG_B = '22222222-2222-4222-8222-2222222222b7';

const at = (iso: string): Instant => instantFromIso(iso);
const T0 = at('2026-07-31T09:00:00Z');

let database: TestDatabase;
let a: ScopedDb;
let b: ScopedDb;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  for (const [id, name] of [
    [ORG_A, 'Acme Platform'],
    [ORG_B, 'Beta Robotics'],
  ] as const) {
    await database.seedOrganization({
      organizationId: id,
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      timezone: 'Europe/London',
      at: new Date(T0),
    });
  }

  a = database.scopedFor(ORG_A);
  b = database.scopedFor(ORG_B);
});

afterAll(async () => {
  await database.close();
});

describe('migration 0005 landed the identity schema', () => {
  it('added the token-digest column and its uniqueness constraint to sessions', async () => {
    const columns = await database.client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'sessions' order by column_name`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row.is_nullable]));

    expect(byName.get('token_hash'), 'a credential column must be NOT NULL').toBe('NO');
    expect(byName.has('revoked_reason')).toBe(true);
    expect(byName.has('rotated_from_session_id')).toBe(true);

    const constraints = await database.client.query<{ constraint_name: string }>(
      `select constraint_name from information_schema.table_constraints
        where table_schema = 'public' and table_name = 'sessions' and constraint_type = 'UNIQUE'`,
    );
    expect(constraints.rows.map((row) => row.constraint_name)).toContain('sessions_org_token_hash_key');
  });

  it('created the two new tables with an organization_id apiece', async () => {
    for (const table of ['auth_tokens', 'membership_team_scopes']) {
      const columns = await database.client.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name = 'organization_id'`,
        [table],
      );
      expect(columns.rows[0]?.is_nullable, `${table}.organization_id`).toBe('NO');
    }
  });

  it('keeps the token tables mutable, because consuming and revoking are updates', () => {
    // Stated as an assertion rather than left implicit: putting `auth_tokens` in the
    // append-only list would make single-use enforcement impossible, since spending a
    // token *is* an UPDATE.
    expect(APPEND_ONLY_TABLE_NAMES as readonly string[]).not.toContain('auth_tokens');
    expect(APPEND_ONLY_TABLE_NAMES as readonly string[]).not.toContain('membership_team_scopes');
    expect(APPEND_ONLY_TABLE_NAMES as readonly string[]).not.toContain('sessions');
  });
});

describe('the audit log is append-only, in three independent places', () => {
  const person = async (scoped: ScopedDb, email: string) => {
    const user = await ensureUser(scoped, {
      email,
      displayName: email,
      passwordHash: null,
      at: T0,
    });
    const membership = await ensureMembership(scoped, {
      userId: user.id,
      role: 'owner',
      status: 'active',
      at: T0,
    });
    return { user, membership };
  };

  it('is in the append-only list at all', () => {
    expect(APPEND_ONLY_TABLE_NAMES as readonly string[]).toContain('audit_log_entries');
  });

  it('refuses an UPDATE, a DELETE and a TRUNCATE in the database itself', async () => {
    const { user, membership } = await person(a, 'audit-probe@example.com');
    await appendAuditLogEntry(a, {
      actorUserId: user.id,
      action: 'seat.role_changed',
      targetKind: 'membership',
      targetId: membership.id,
      before: { role: 'viewer' },
      after: { role: 'owner' },
      occurredAt: T0,
    });

    await expect(
      database.client.query(`update audit_log_entries set action = 'tampered'`),
      'the database accepted an UPDATE on the audit log',
    ).rejects.toThrow(/append-only/i);

    await expect(
      database.client.query('delete from audit_log_entries'),
      'the database accepted a DELETE on the audit log',
    ).rejects.toThrow(/append-only/i);

    await expect(
      database.client.query('truncate table audit_log_entries'),
      'the database accepted a TRUNCATE on the audit log',
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses the same mutation one layer up, so neither guard is the only one', () => {
    expect(() => a.updateIn(auditLogEntries, { action: 'tampered' })).toThrow(AppendOnlyTableError);
    expect(() => a.deleteFrom(auditLogEntries)).toThrow(AppendOnlyTableError);
  });

  it('records actor, action, target, before/after and the instant', async () => {
    const { user, membership } = await person(a, 'audit-shape@example.com');

    const written = await appendAuditLogEntry(a, {
      actorUserId: user.id,
      action: 'seat.team_scopes_changed',
      targetKind: 'membership',
      targetId: membership.id,
      before: { teamKeys: ['platform'] },
      after: { teamKeys: ['platform', 'payments'] },
      occurredAt: at('2026-07-31T10:15:00Z'),
    });

    const entries = await listAuditLogEntries(a, { targetId: membership.id });
    const entry = entries.find((row) => row.id === written.id);

    expect(entry).toBeDefined();
    expect(entry?.actorUserId).toBe(user.id);
    expect(entry?.action).toBe('seat.team_scopes_changed');
    expect(entry?.targetKind).toBe('membership');
    expect(entry?.before).toEqual({ teamKeys: ['platform'] });
    expect(entry?.after).toEqual({ teamKeys: ['platform', 'payments'] });
    expect(entry?.occurredAt).toBe(at('2026-07-31T10:15:00Z'));
  });

  it('accepts a system act with no actor, because a boot script is not a person', async () => {
    const { membership } = await person(a, 'audit-system@example.com');

    const written = await appendAuditLogEntry(a, {
      actorUserId: null,
      action: 'seat.invited',
      targetKind: 'membership',
      targetId: membership.id,
      before: null,
      after: { via: 'bootstrap' },
      occurredAt: T0,
    });

    const entries = await listAuditLogEntries(a, { targetId: membership.id });
    expect(entries.some((row) => row.id === written.id && row.actorUserId === null)).toBe(true);
  });

  it('lands a replayed write on the same row instead of double-counting it', async () => {
    const { user, membership } = await person(a, 'audit-replay@example.com');
    const input = {
      actorUserId: user.id,
      action: 'seat.role_changed' as const,
      targetKind: 'membership' as const,
      targetId: membership.id,
      before: { role: 'member' },
      after: { role: 'manager' },
      occurredAt: at('2026-07-31T11:00:00Z'),
    };

    await appendAuditLogEntry(a, input);
    await appendAuditLogEntry(a, input);

    const entries = await listAuditLogEntries(a, { targetId: membership.id });
    expect(entries.filter((row) => row.action === 'seat.role_changed')).toHaveLength(1);
  });
});

describe('every identity read is confined to its organization', () => {
  it('never returns another tenant’s seats, sessions, scopes or audit rows', async () => {
    const user = await ensureUser(a, {
      email: 'isolated@example.com',
      displayName: 'Isolated',
      passwordHash: null,
      at: T0,
    });
    const membership = await ensureMembership(a, {
      userId: user.id,
      role: 'manager',
      status: 'active',
      at: T0,
    });
    await replaceTeamScopes(a, membership.id, ['platform'], T0);
    await insertSession(a, {
      userId: user.id,
      tokenHash: 'a'.repeat(64),
      issuedAt: T0,
      expiresAt: at('2026-08-30T09:00:00Z'),
    });
    await insertAuthToken(a, {
      purpose: 'invite',
      userId: user.id,
      tokenHash: 'b'.repeat(64),
      issuedAt: T0,
      expiresAt: at('2026-08-07T09:00:00Z'),
    });

    // Every read, through the other tenant's scope.
    expect((await listSeats(b)).map((seat) => seat.email)).not.toContain('isolated@example.com');
    expect(await findSessionByTokenHash(b, 'a'.repeat(64))).toBeNull();
    expect(await findAuthTokenByHash(b, 'b'.repeat(64))).toBeNull();
    expect(await listTeamScopes(b, membership.id)).toEqual([]);

    // And through its own, so the assertions above are not passing because nothing was
    // written at all.
    expect((await listSeats(a)).map((seat) => seat.email)).toContain('isolated@example.com');
    expect(await findSessionByTokenHash(a, 'a'.repeat(64))).not.toBeNull();
    expect(await listTeamScopes(a, membership.id)).toEqual(['platform']);
  });

  it('stamps every inserted identity row with the scope’s organization', async () => {
    for (const table of ['sessions', 'auth_tokens', 'membership_team_scopes'] as const) {
      const rows = await database.client.query<{ organization_id: string }>(
        `select distinct organization_id from "${table}"`,
      );
      expect(rows.rows.map((row) => row.organization_id), table).toEqual([ORG_A]);
    }
  });

  it('puts the organization predicate in the emitted SQL for the new tables', () => {
    for (const table of [authTokens, membershipTeamScopes]) {
      const { sql, params } = a.selectFrom(table).toSQL();

      expect(sql).toContain('"organization_id"');
      expect(params).toContain(ORG_A);
    }
  });
});

describe('single-use tokens', () => {
  it('is spent by one UPDATE, so a double click cannot spend it twice', async () => {
    const user = await ensureUser(a, {
      email: 'token-race@example.com',
      displayName: 'Token Race',
      passwordHash: null,
      at: T0,
    });
    const token = await insertAuthToken(a, {
      purpose: 'password_reset',
      userId: user.id,
      tokenHash: 'c'.repeat(64),
      issuedAt: T0,
      expiresAt: at('2026-07-31T10:00:00Z'),
    });

    // Both attempts issued together, as two clicks on one mailed link would arrive.
    const [first, second] = await Promise.all([
      consumeAuthToken(a, token.id, at('2026-07-31T09:05:00Z')),
      consumeAuthToken(a, token.id, at('2026-07-31T09:05:00Z')),
    ]);

    expect([first, second].filter(Boolean), 'exactly one attempt may spend the token').toHaveLength(1);
  });

  it('refuses to spend a token that was revoked', async () => {
    const user = await ensureUser(a, {
      email: 'token-revoked@example.com',
      displayName: 'Token Revoked',
      passwordHash: null,
      at: T0,
    });
    const token = await insertAuthToken(a, {
      purpose: 'invite',
      userId: user.id,
      tokenHash: 'd'.repeat(64),
      issuedAt: T0,
      expiresAt: at('2026-08-07T09:00:00Z'),
    });

    expect(await revokeAuthTokens(a, user.id, 'invite', at('2026-07-31T09:10:00Z'))).toBe(1);
    expect(await consumeAuthToken(a, token.id, at('2026-07-31T09:15:00Z'))).toBe(false);
  });
});

describe('sessions', () => {
  it('revokes every live session for one user and leaves the rest alone', async () => {
    const mine = await ensureUser(a, {
      email: 'sessions-mine@example.com',
      displayName: 'Mine',
      passwordHash: null,
      at: T0,
    });
    const theirs = await ensureUser(a, {
      email: 'sessions-theirs@example.com',
      displayName: 'Theirs',
      passwordHash: null,
      at: T0,
    });

    for (const [index, userId] of [mine.id, mine.id, theirs.id].entries()) {
      await insertSession(a, {
        userId,
        tokenHash: `${index}`.repeat(64),
        issuedAt: T0,
        expiresAt: at('2026-08-30T09:00:00Z'),
      });
    }

    expect(await revokeAllSessionsForUser(a, mine.id, 'sign_out_all_devices', at('2026-07-31T09:30:00Z'))).toBe(2);
    // Idempotent: a second call finds nothing live.
    expect(await revokeAllSessionsForUser(a, mine.id, 'sign_out_all_devices', at('2026-07-31T09:31:00Z'))).toBe(0);

    const stillLive = await findSessionByTokenHash(a, '2'.repeat(64));
    expect(stillLive?.revokedAt, 'the other user must be untouched').toBeNull();
  });
});

/**
 * `lastActiveAt` on a seat — the "last-active" column the members screen states.
 *
 * Derived rather than stored, so what has to be proved is the derivation: the newest
 * sighting wins, a person who has never signed in reads as null rather than as an epoch
 * date, and revoking a session does not erase the fact that they were here. That last one
 * is the interesting case — an owner rotating a colleague's sessions after a role change
 * must not make that colleague's last-active jump backwards to "never".
 */
describe('a seat’s last-active', () => {
  const seatFor = async (email: string) => (await listSeats(a)).find((seat) => seat.email === email) ?? null;

  it('is null for somebody who has never signed in', async () => {
    const user = await ensureUser(a, {
      email: 'never-here@example.com',
      displayName: 'Never Here',
      passwordHash: null,
      at: T0,
    });
    await ensureMembership(a, { userId: user.id, role: 'viewer', status: 'pending', at: T0 });

    expect((await seatFor('never-here@example.com'))?.lastActiveAt).toBeNull();
  });

  it('is the newest sighting across every session, revoked ones included', async () => {
    const user = await ensureUser(a, {
      email: 'active@example.com',
      displayName: 'Active',
      passwordHash: null,
      at: T0,
    });
    await ensureMembership(a, { userId: user.id, role: 'member', status: 'active', at: T0 });

    // Two browsers. The older one is inserted second, so a reduction that simply took the
    // last row rather than the greatest would fail here.
    await insertSession(a, {
      userId: user.id,
      tokenHash: 'c'.repeat(64),
      issuedAt: T0,
      expiresAt: at('2026-08-30T09:00:00Z'),
    });
    await touchSession(a, (await findSessionByTokenHash(a, 'c'.repeat(64)))!.id, at('2026-08-02T14:00:00Z'));

    await insertSession(a, {
      userId: user.id,
      tokenHash: 'd'.repeat(64),
      issuedAt: at('2026-08-01T08:00:00Z'),
      expiresAt: at('2026-08-31T08:00:00Z'),
    });

    expect((await seatFor('active@example.com'))?.lastActiveAt).toBe(at('2026-08-02T14:00:00Z'));

    // Signing out does not un-happen the sighting.
    await revokeAllSessionsForUser(a, user.id, 'sign_out_all_devices', at('2026-08-03T09:00:00Z'));
    expect((await seatFor('active@example.com'))?.lastActiveAt).toBe(at('2026-08-02T14:00:00Z'));
  });
});

describe('email canonicalisation', () => {
  it('lower-cases and trims, and does nothing else', () => {
    expect(normalizeEmail('  Priya@Example.COM ')).toBe('priya@example.com');
    // Dots and +tags are preserved: some providers treat them as distinct addresses, and
    // merging them would let an invitation reach a mailbox the inviter did not name.
    expect(normalizeEmail('first.last+compass@example.com')).toBe('first.last+compass@example.com');
  });

  it('makes one address one seat, whatever it was typed as', async () => {
    const first = await ensureUser(a, {
      email: 'Canonical@Example.com',
      displayName: 'First',
      passwordHash: null,
      at: T0,
    });
    const second = await ensureUser(a, {
      email: 'canonical@example.com',
      displayName: 'Second',
      passwordHash: null,
      at: T0,
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName, 'an existing name must not be overwritten').toBe('First');
  });
});
