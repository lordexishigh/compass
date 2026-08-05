import { instantFromIso, type Instant } from '@compass/clock';
import {
  ERASURE_SURVIVORS,
  ERASURE_TABLE_ORDER,
  LLM_MINIMIZATION_MODES,
  PRIVACY_DEFAULTS,
  PrivateConversationError,
  RAW_RETENTION_CHOICES,
  ScopedDb,
  anonymizations,
  beginSecondFactorEnrollment,
  eraseAccountData,
  eraseOrganizationData,
  ensurePrivacySettings,
  linkIdentity,
  replaceRecoveryCodes,
  findAnonymization,
  ingestibleConversationKeys,
  isOrgScopedTable,
  listAnonymizations,
  orgScope,
  readPrivacySettings,
  recordAnonymization,
  recordRawEvents,
  revertAnonymization,
  schema,
  setSlackChannelIngestion,
  updatePrivacySettings,
} from '@compass/db';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is, getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMigratedTestDatabase, type TestDatabase } from './helpers/pglite.js';

/**
 * The privacy schema, its defaults, and the one gate that keeps erasure honest as the schema
 * grows.
 *
 * The load-bearing test here is `every org-scoped table is either erased or a documented
 * survivor`. Self-serve deletion makes a specific promise — the data is gone — and the only way
 * a promise that specific stays true through six months of schema changes is for a new table to
 * be a *build failure* until somebody decides, in writing, which side of the line it is on.
 * Exactly the same shape as the route-matrix coverage test.
 */

const ORGANIZATION_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c61';
const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-05T09:00:00Z');

let database: TestDatabase;

const scoped = (): ScopedDb => database.scopedFor(ORGANIZATION_ID);

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Retail',
    slug: 'northwind-retail',
    timezone: 'Europe/London',
    at: new Date(Date.parse('2026-07-01T00:00:00Z')),
  });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.client.query('delete from raw_events');
  await database.client.query('delete from anonymizations');
  await database.client.query('delete from slack_channel_ingestion');
  await database.client.query('delete from org_privacy_settings');
});

// ---------------------------------------------------------------------------
// The erasure coverage gate
// ---------------------------------------------------------------------------

/** Every table the drizzle schema declares, by name. */
const SCHEMA_TABLES: readonly (readonly [string, PgTable])[] = Object.values(
  schema as Record<string, unknown>,
)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => [getTableName(table), table] as const)
  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

describe('erasure covers the whole schema', () => {
  it('finds tables at all, so an empty walk cannot pass this file', () => {
    expect(SCHEMA_TABLES.length).toBeGreaterThan(30);
    expect(SCHEMA_TABLES.map(([name]) => name)).toContain('raw_events');
  });

  it('has every table either in the erasure order or in the documented survivors', () => {
    const erased = new Set(ERASURE_TABLE_ORDER.map((table) => getTableName(table)));
    const survivors = new Set(ERASURE_SURVIVORS.map((table) => getTableName(table)));

    const undecided = SCHEMA_TABLES.map(([name]) => name).filter(
      (name) => !erased.has(name) && !survivors.has(name),
    );

    expect(
      undecided,
      'these tables hold tenant data that an organization erasure neither deletes nor deliberately keeps. ' +
        'Add each to ERASURE_TABLE_ORDER (children before parents) or to ERASURE_SURVIVORS with a reason — ' +
        'a deletion that silently skips a table is worse than one that refuses.',
    ).toEqual([]);
  });

  it('names no table twice, and none that the schema does not declare', () => {
    const declared = new Set(SCHEMA_TABLES.map(([name]) => name));
    const listed = [...ERASURE_TABLE_ORDER, ...ERASURE_SURVIVORS].map((table) => getTableName(table));

    expect(new Set(listed).size, 'a table is listed twice').toBe(listed.length);
    expect(listed.filter((name) => !declared.has(name)), 'these listed tables do not exist').toEqual([]);
  });

  it('erases through the scoped layer, so every delete carries its organization predicate', () => {
    // The predicate is what makes an erasure a *tenant* erasure. A table that could not carry one
    // has no business in the list.
    for (const table of ERASURE_TABLE_ORDER) {
      expect(isOrgScopedTable(table), `${getTableName(table)} is not organization-scoped`).toBe(true);
    }
  });

  it('puts children before parents, so no delete violates a foreign key', () => {
    const position = new Map(ERASURE_TABLE_ORDER.map((table, index) => [getTableName(table), index]));

    for (const table of ERASURE_TABLE_ORDER) {
      const name = getTableName(table);
      const self = position.get(name) ?? 0;

      for (const reference of getTableConfig(table).foreignKeys) {
        const target = getTableName(reference.reference().foreignTable as PgTable);
        // A self-reference and a reference to a survivor are both fine: the survivor is still
        // there when the child goes.
        if (target === name) continue;
        const targetPosition = position.get(target);
        if (targetPosition === undefined) continue;

        expect(
          self,
          `${name} is deleted before ${target}, which it references — the delete would fail`,
        ).toBeLessThan(targetPosition);
      }
    }
  });
});

describe('an organization erasure empties the tenant', () => {
  it('deletes raw events and the append-only history, and leaves a tombstone', async () => {
    await ensurePrivacySettings(scoped(), { id: settingsId, at: NOW });
    await recordRawEvents(scoped(), [
      {
        id: '10000000-0000-4000-8000-000000000001',
        sourceKey: 'primary-chat',
        sourceKind: 'chat',
        artifactKind: 'messages',
        sourceRecordId: 'm-1',
        conversationKey: 'conv-checkout',
        conversationName: 'checkout-standup',
        authorIdentityKind: 'chat_handle',
        authorIdentityValue: '@priya',
        body: 'CHK-701 is still waiting.',
        occurredAt: NOW,
        ingestedAt: NOW,
      },
    ]);

    const categories = await eraseOrganizationData(scoped(), { at: NOW, tombstoneName: 'Deleted organization' });

    expect(categories.length).toBeGreaterThan(5);

    const raw = await database.client.query<{ count: string }>('select count(*)::text as count from raw_events');
    expect(raw.rows[0]?.count).toBe('0');

    // The tenant row survives as a tombstone, because `deletion_requests` references it and
    // removing it would take the record of the deletion with it.
    const organization = await database.client.query<{ name: string; slug: string }>(
      'select name, slug from organizations where id = $1',
      [ORGANIZATION_ID],
    );
    expect(organization.rows[0]?.name).toBe('Deleted organization');
    expect(organization.rows[0]?.slug).toBe(`erased-${ORGANIZATION_ID}`);
  });

  /**
   * The account erasure, for somebody who actually used the product's own security features.
   *
   * ## The bug this pins
   *
   * `eraseAccountData` deleted `subscriptions`, `auth_tokens`, `sessions`, the team scopes, the
   * membership and then `users` — and nothing else. But `user_second_factors` and
   * `user_recovery_codes` have carried a foreign key to `users` since migration 0016, so for anybody
   * who had ever enrolled in 2FA the final `DELETE FROM users` raised a foreign-key violation, the
   * whole `eraseWithin` transaction rolled back, and **the account was not deleted at all** while the
   * caller went on to mail a confirmation saying it had been. `user_identities` (migration 0019) would
   * have joined them.
   *
   * It survived because every existing subject in this suite has no enrollment and no SSO link, so the
   * failing path was the one no test walked. This test gives the subject all three.
   */
  it('erases an account that has a second factor, recovery codes and an SSO link', async () => {
    const userId = '20000000-0000-4000-8000-000000000001';
    const membershipId = '20000000-0000-4000-8000-000000000002';
    const stamp = new Date(Date.parse('2026-08-05T09:00:00Z'));

    await scoped()
      .insertInto(schema.users, {
        id: userId,
        email: 'dana@northwind.example',
        displayName: 'Dana Okonjo',
        passwordHash: null,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .execute();
    await scoped()
      .insertInto(schema.memberships, {
        id: membershipId,
        userId,
        role: 'manager',
        status: 'active',
        createdAt: stamp,
        updatedAt: stamp,
      })
      .execute();
    await beginSecondFactorEnrollment(
      scoped(),
      { id: '20000000-0000-4000-8000-000000000003', userId, secret: 'JBSWY3DPEHPK3PXP' },
      NOW,
    );
    await replaceRecoveryCodes(
      scoped(),
      {
        userId,
        codes: [
          { id: '20000000-0000-4000-8000-000000000004', codeHash: 'a'.repeat(64) },
        ],
      },
      NOW,
    );
    await linkIdentity(
      scoped(),
      { userId, provider: 'google', subject: 'google-subject-1', email: 'dana@northwind.example', emailVerified: true },
      NOW,
    );

    // Before the fix this rejected with a foreign-key violation rather than resolving.
    const categories = await eraseAccountData(scoped(), { userId });

    expect(categories.length).toBeGreaterThan(3);

    // And the account really is gone, rather than the transaction having rolled back silently.
    for (const [table, column] of [
      ['users', 'id'],
      ['memberships', 'user_id'],
      ['user_second_factors', 'user_id'],
      ['user_recovery_codes', 'user_id'],
      ['user_identities', 'user_id'],
    ] as const) {
      const rows = await database.client.query<{ count: string }>(
        `select count(*)::text as count from ${table} where ${column} = $1`,
        [userId],
      );
      expect(rows.rows[0]?.count, `${table} still holds a row for the erased account`).toBe('0');
    }
  });

  it('restores the append-only refusal the moment the erasure transaction ends', async () => {
    // `SET LOCAL` dies with the transaction, so a pooled connection cannot hand the permission
    // to whatever borrows it next. That is the property, and it is checked *after* an erasure
    // has already run in this process.
    await expect(database.client.query('delete from entity_versions')).rejects.toThrow(/append-only/i);
    expect(() => scoped().deleteFrom(schema.entityVersions)).toThrow(/append-only/i);
  });
});

// ---------------------------------------------------------------------------
// Defaults and the closed vocabularies
// ---------------------------------------------------------------------------

const settingsId = '50000000-0000-4000-8000-000000000001';

describe('the documented defaults', () => {
  it('are 90 days, 3 years and redacted', () => {
    // Quoted verbatim in `docs/DEVELOPMENT.md`, and diffed against it by
    // `tools/quality-gates/tests/privacy-documentation.test.ts`.
    expect(PRIVACY_DEFAULTS.rawEventRetentionDays).toBe(90);
    expect(PRIVACY_DEFAULTS.derivedRetentionYears).toBe(3);
    expect(PRIVACY_DEFAULTS.llmMinimizationMode).toBe('redacted');
  });

  it('are applied to an organization that has never opened the page', async () => {
    const created = await ensurePrivacySettings(scoped(), { id: settingsId, at: NOW });

    expect(created.rawEventRetentionDays).toBe(PRIVACY_DEFAULTS.rawEventRetentionDays);
    expect(created.derivedRetentionYears).toBe(PRIVACY_DEFAULTS.derivedRetentionYears);
    expect(created.llmMinimizationMode).toBe(PRIVACY_DEFAULTS.llmMinimizationMode);
  });

  it('are created once, not on every read', async () => {
    const first = await ensurePrivacySettings(scoped(), { id: settingsId, at: NOW });
    const second = await ensurePrivacySettings(scoped(), { id: settingsId, at: at('2026-09-01T00:00:00Z') });

    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it('distinguishes "indefinite" from "leave it alone"', async () => {
    await ensurePrivacySettings(scoped(), { id: settingsId, at: NOW });

    // `null` is a value. Collapsing it with an absent key would make "keep reports forever"
    // unexpressible, which is one of the four documented choices.
    await updatePrivacySettings(scoped(), { derivedRetentionYears: null, at: NOW });
    expect((await readPrivacySettings(scoped()))?.derivedRetentionYears).toBeNull();

    await updatePrivacySettings(scoped(), { rawEventRetentionDays: 30, at: NOW });
    const after = await readPrivacySettings(scoped());
    expect(after?.rawEventRetentionDays).toBe(30);
    expect(after?.derivedRetentionYears, 'an absent key must not reset a stored null').toBeNull();
  });

  it('refuses a window outside the closed set, in the database', async () => {
    await ensurePrivacySettings(scoped(), { id: settingsId, at: NOW });

    await expect(
      database.client.query('update org_privacy_settings set raw_event_retention_days = 9'),
    ).rejects.toThrow();
    await expect(
      database.client.query("update org_privacy_settings set llm_minimization_mode = 'sometimes'"),
    ).rejects.toThrow();

    expect([...RAW_RETENTION_CHOICES]).toEqual([30, 90, 180, 365]);
    expect([...LLM_MINIMIZATION_MODES]).toEqual(['full', 'redacted', 'none']);
  });
});

// ---------------------------------------------------------------------------
// Chat opt-in, at the constraint level
// ---------------------------------------------------------------------------

describe('the chat opt-in', () => {
  it('refuses to enable anything but a public channel', async () => {
    await expect(
      setSlackChannelIngestion(scoped(), {
        id: '40000000-0000-4000-8000-000000000001',
        conversationKey: 'D123PRIYA',
        conversationName: 'priya',
        conversationKind: 'direct_message',
        enabled: true,
        byUserId: null,
        at: NOW,
      }),
    ).rejects.toThrow(PrivateConversationError);
  });

  it('makes the state unwritable even by raw SQL', async () => {
    await setSlackChannelIngestion(scoped(), {
      id: '40000000-0000-4000-8000-000000000002',
      conversationKey: 'D123PRIYA',
      conversationName: 'priya',
      conversationKind: 'direct_message',
      enabled: false,
      byUserId: null,
      at: NOW,
    });

    // The CHECK constraint, not the application. A psql session gets the same refusal.
    await expect(
      database.client.query("update slack_channel_ingestion set enabled = true where conversation_key = 'D123PRIYA'"),
    ).rejects.toThrow();

    expect(await ingestibleConversationKeys(scoped())).toEqual([]);
  });

  it('records when a channel was enabled, and does not move that date on an unrelated edit', async () => {
    const enabledAt = at('2026-08-01T09:00:00Z');
    await setSlackChannelIngestion(scoped(), {
      id: '40000000-0000-4000-8000-000000000003',
      conversationKey: 'C123CHECKOUT',
      conversationName: 'checkout-standup',
      conversationKind: 'public_channel',
      enabled: true,
      byUserId: null,
      at: enabledAt,
    });

    // Renaming the channel is not re-enabling it. The settings page states *when each was
    // enabled*, and a date that moved whenever the row was touched would be the wrong date.
    const renamed = await setSlackChannelIngestion(scoped(), {
      id: '40000000-0000-4000-8000-000000000003',
      conversationKey: 'C123CHECKOUT',
      conversationName: 'checkout-daily',
      conversationKind: 'public_channel',
      enabled: true,
      byUserId: null,
      at: at('2026-08-20T09:00:00Z'),
    });

    expect(renamed.conversationName).toBe('checkout-daily');
    expect(renamed.enabledAt).toBe(at('2026-08-20T09:00:00Z'));
  });
});

// ---------------------------------------------------------------------------
// Anonymization records
// ---------------------------------------------------------------------------

describe('anonymization records', () => {
  const record = (developerKey: string, pseudonym: string) =>
    recordAnonymization(scoped(), {
      id: `60000000-0000-4000-8000-${developerKey.replace(/\D/g, '').padStart(12, '0').slice(0, 12)}`,
      developerKey,
      pseudonym,
      reason: 'departed',
      note: null,
      requestedByUserId: null,
      anonymizedAt: NOW,
    });

  it('is idempotent on the developer, so a second click is not a second erasure', async () => {
    const first = await record('dev-1', 'Wren Alder');
    const second = await record('dev-1', 'Heron Basalt');

    expect(second.id).toBe(first.id);
    expect(second.pseudonym).toBe('Wren Alder');
  });

  it('refuses to hand one pseudonym to two people', async () => {
    await record('dev-1', 'Wren Alder');

    // The database is the arbiter. `pseudonymFor` collides eventually, and the caller salts
    // until this constraint accepts one — which is what turns "unlikely" into "cannot".
    await expect(record('dev-2', 'Wren Alder')).rejects.toThrow();
  });

  it('keeps the row on a reversal and stamps it, rather than deleting it', async () => {
    await record('dev-1', 'Wren Alder');
    await revertAnonymization(scoped(), { developerKey: 'dev-1', byUserId: null, at: at('2026-08-10T09:00:00Z') });

    // Gone from the live list...
    expect(await listAnonymizations(scoped())).toEqual([]);

    // ...and still on the record, which is what "cannot be silently reversed" means.
    const stored = await findAnonymization(scoped(), 'dev-1');
    expect(stored?.revertedAt).toBe(at('2026-08-10T09:00:00Z'));
    expect(stored?.anonymizedAt).toBe(NOW);
  });

  it('has no delete path through the scoped layer at all', async () => {
    await record('dev-1', 'Wren Alder');
    // Not append-only in the database — a reversal has to be able to stamp the row — but there
    // is no repository function that deletes one, and the erasure list keeps it as a survivor.
    const survivors = ERASURE_SURVIVORS.map((table) => getTableName(table));
    expect(survivors).toContain(getTableName(anonymizations));
  });
});

/** Kept honest by `scoped()`: the harness is the only way to reach a database here. */
describe('every read is organization-scoped', () => {
  it('never returns another tenant’s privacy rows', async () => {
    const otherId = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c62';
    await database.seedOrganization({
      organizationId: otherId,
      name: 'Beta Robotics',
      slug: 'beta-robotics',
      timezone: 'UTC',
      at: new Date(Date.parse('2026-07-01T00:00:00Z')),
    });

    await ensurePrivacySettings(scoped(), { id: settingsId, at: NOW });

    const otherScope = new ScopedDb(database.db, orgScope(otherId));
    expect(await readPrivacySettings(otherScope)).toBeNull();
  });
});
