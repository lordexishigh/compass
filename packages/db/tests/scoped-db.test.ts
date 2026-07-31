import { eq } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CrossOrgWriteError,
  MissingOrgScopeError,
  ScopedDb,
  UnscopedTableError,
  createScopedDb,
  orgScope,
  organizations,
  users,
  type CompassDatabase,
  type OrgScope,
} from '@compass/db';

import { createTestDatabase, type TestDatabase } from './helpers/pglite.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

let database: TestDatabase;
let db: CompassDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  // Migrated, so the isolation suite below can round-trip real rows rather than
  // only inspecting the SQL the layer would have sent.
  await database.migrate();
});

afterAll(async () => {
  await database.close();
});

describe('org scope', () => {
  it('refuses to be built from nothing', () => {
    expect(() => orgScope(undefined)).toThrow(MissingOrgScopeError);
    expect(() => orgScope(null)).toThrow(MissingOrgScopeError);
    expect(() => orgScope('')).toThrow(MissingOrgScopeError);
    expect(() => orgScope('   ')).toThrow(MissingOrgScopeError);
    expect(() => orgScope(42)).toThrow(MissingOrgScopeError);
  });

  it('refuses an id that is not an organization id', () => {
    expect(() => orgScope('acme')).toThrow(MissingOrgScopeError);
    expect(() => orgScope('11111111-1111-4111-8111')).toThrow(MissingOrgScopeError);
  });

  it('is frozen once built', () => {
    expect(Object.isFrozen(orgScope(ORG_A))).toBe(true);
  });
});

describe('constructing a query without a scope', () => {
  it('throws at call time rather than returning an unscoped builder', () => {
    const scoped = createScopedDb(db);

    expect(() => scoped(undefined as unknown as OrgScope)).toThrow(MissingOrgScopeError);
    expect(() => scoped({} as OrgScope)).toThrow(MissingOrgScopeError);
    expect(() => scoped({ organizationId: '' } as OrgScope)).toThrow(MissingOrgScopeError);
    expect(() => new ScopedDb(db, null as unknown as OrgScope)).toThrow(MissingOrgScopeError);
  });

  it('rejects a table that carries no organization_id', () => {
    const orphan = pgTable('orphan_rows', { id: uuid('id').primaryKey(), body: text('body').notNull() });
    const scoped = new ScopedDb(db, orgScope(ORG_A));

    // @ts-expect-error the table is deliberately not org-scoped
    expect(() => scoped.selectFrom(orphan)).toThrow(UnscopedTableError);
  });
});

describe('every query carries the organization predicate', () => {
  const scopedFor = (organizationId: string) => new ScopedDb(db, orgScope(organizationId));

  it('adds it to selects', () => {
    const { sql, params } = scopedFor(ORG_A).selectFrom(users).toSQL();

    expect(sql).toContain('"organization_id" = $1');
    expect(params).toContain(ORG_A);
  });

  it('keeps it when the caller adds their own predicate', () => {
    const { sql, params } = scopedFor(ORG_A).selectFrom(users, eq(users.email, 'priya@example.com')).toSQL();

    expect(sql).toContain('"organization_id" = $1');
    expect(sql).toContain('"email" = $2');
    expect(params).toEqual([ORG_A, 'priya@example.com']);
  });

  it('adds it to updates and deletes', () => {
    const update = scopedFor(ORG_B).updateIn(users, { displayName: 'Priya' }).toSQL();
    const remove = scopedFor(ORG_B).deleteFrom(users).toSQL();

    expect(update.sql).toContain('"organization_id" = $2');
    expect(update.params).toContain(ORG_B);
    expect(remove.sql).toContain('"organization_id" = $1');
    expect(remove.params).toContain(ORG_B);
  });

  it('fills the organization in on insert so a caller cannot omit it', () => {
    const { params } = scopedFor(ORG_A)
      .insertInto(users, {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'priya@example.com',
        displayName: 'Priya Raman',
        passwordHash: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })
      .toSQL();

    expect(params).toContain(ORG_A);
  });

  it('refuses to write a row owned by another organization', () => {
    expect(() =>
      scopedFor(ORG_A).insertInto(users, {
        id: '44444444-4444-4444-8444-444444444444',
        // @ts-expect-error `ScopedInsert` omits this column, so TypeScript already
        // refuses it. A plain-JavaScript caller can still smuggle it in, which is
        // what `CrossOrgWriteError` exists to catch — that is the path under test.
        organizationId: ORG_B,
        email: 'marcus@example.com',
        displayName: 'Marcus Hale',
        passwordHash: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    ).toThrow(CrossOrgWriteError);
  });

  it('exposes the predicate for callers composing their own SQL', () => {
    const scoped = scopedFor(ORG_A);

    expect(scoped.organizationId).toBe(ORG_A);
    expect(scoped.organizationPredicate(users)).toBeDefined();
  });
});

/**
 * The SQL assertions above prove the predicate is *emitted*. These prove it
 * *works*: two tenants' rows in one real database, read back through the layer.
 *
 * The distinction matters because drizzle's query builders are lazy thenables —
 * a test that never awaits proves nothing about what the database returns.
 */
describe('a scoped query returns only the rows its organization owns', () => {
  const scopedFor = (organizationId: string) => new ScopedDb(db, orgScope(organizationId));
  const epoch = new Date(0);

  const seedOrganization = async (id: string, slug: string): Promise<void> => {
    await scopedFor(id).insertInto(organizations, {
      id,
      name: `Organization ${slug}`,
      slug,
      timezone: 'Europe/London',
      createdAt: epoch,
      updatedAt: epoch,
    });
  };

  const seedUser = async (organizationId: string, id: string, email: string): Promise<void> => {
    await scopedFor(organizationId).insertInto(users, {
      id,
      email,
      displayName: email,
      passwordHash: null,
      createdAt: epoch,
      updatedAt: epoch,
    });
  };

  const USER_A = '0a000000-0000-4000-8000-000000000001';
  const USER_B = '0b000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    await seedOrganization(ORG_A, 'org-a');
    await seedOrganization(ORG_B, 'org-b');
    await seedUser(ORG_A, USER_A, 'priya@example.com');
    await seedUser(ORG_B, USER_B, 'marcus@example.com');
  });

  it('reads back only its own rows when awaited', async () => {
    const forA = await scopedFor(ORG_A).selectFrom(users);
    const forB = await scopedFor(ORG_B).selectFrom(users);

    expect(forA.map((row) => row.email)).toEqual(['priya@example.com']);
    expect(forB.map((row) => row.email)).toEqual(['marcus@example.com']);
  });

  it('cannot reach another tenant even with a predicate naming that tenant’s row', async () => {
    const rows = await scopedFor(ORG_A).selectFrom(users, eq(users.id, USER_B));

    expect(rows).toEqual([]);
  });

  it('writes the scope’s organization onto inserted rows', async () => {
    const [row] = await scopedFor(ORG_A).selectFrom(users, eq(users.id, USER_A));

    expect(row?.organizationId).toBe(ORG_A);
  });

  it('confines an update to the scope', async () => {
    await scopedFor(ORG_A).updateIn(users, { displayName: 'Priya Raman' });

    const [inScope] = await scopedFor(ORG_A).selectFrom(users, eq(users.id, USER_A));
    const [untouched] = await scopedFor(ORG_B).selectFrom(users, eq(users.id, USER_B));

    expect(inScope?.displayName).toBe('Priya Raman');
    expect(untouched?.displayName).toBe('marcus@example.com');
  });

  it('confines a delete to the scope', async () => {
    // An unscoped `delete from users` would empty both tenants. This one must not.
    await scopedFor(ORG_A).deleteFrom(users);

    expect(await scopedFor(ORG_A).selectFrom(users)).toEqual([]);
    expect((await scopedFor(ORG_B).selectFrom(users)).map((row) => row.email)).toEqual(['marcus@example.com']);
  });
});
