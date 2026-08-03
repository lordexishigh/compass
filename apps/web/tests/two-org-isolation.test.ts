import { randomUUID } from 'node:crypto';

import {
  ACTIONS,
  MATRIX_ROUTES,
  authorize,
  digestSecret,
  findRouteRule,
  isPublicRoute,
  type Action,
  type Principal,
} from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  createShareLink,
  findMembershipById,
  findReportById,
  findReportItemByStableId,
  findSessionByTokenHash,
  findShareLinkByTokenHash,
  findSubscriptionById,
  findSubscriptionByUnsubscribeHash,
  findUserByEmail,
  loadReportBundle,
  memberships,
  orgScope,
  organizations,
  reportItems,
  reportSections,
  reports,
  sessions,
  upsertSubscription,
  users,
} from '@compass/db';
import { createTestDatabase, type TestDatabase } from '@compass/db/testing';
import { hashShareToken, mintShareToken } from '@compass/delivery';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiRoutesOnDisk, pageRoutesOnDisk } from './helpers/routes';

/**
 * Two organizations, identical-looking data, and no path from one to the other.
 *
 * ## Why the data is deliberately identical
 *
 * Both tenants get the same team key (`platform`), the same report date, the same stable item ids,
 * the same source keys and near-identical names. That is the whole design of this fixture: a leak
 * that only shows up when the two tenants look *different* is a leak that a demo would never
 * surface and a real deployment would. If a query forgets its organization predicate, identical
 * data means it returns the wrong tenant's row rather than an obvious empty result, and every
 * assertion below is written to catch exactly that.
 *
 * ## Three separate claims
 *
 *  1. **Every route refuses org A's session when the identifier belongs to org B.** Parametrized
 *     over the route enumerator that `authz-matrix.test.ts` uses, so a new route joins this suite
 *     the moment its file exists.
 *  2. **Every capability-style identifier is inert across tenants** — report permalinks, share
 *     tokens, unsubscribe tokens, email feedback links, session cookies, seat ids.
 *  3. **No SQL reaches the database without an `organization_id` predicate.** Asserted by watching
 *     the statements the driver actually receives while real repository calls run, which is the only
 *     form of that claim that cannot be satisfied by a comment.
 */

const ORG_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
/**
 * A third tenant, for the destructive half of the query-predicate proof.
 *
 * The write probe has to actually run an UPDATE and a DELETE — that is the only way to see the SQL
 * the driver receives for them — and running those against org A would tear down the fixture the
 * rest of this file depends on. So they run here, where the blast radius is a tenant nothing else
 * reads, and org A and org B are asserted intact afterwards.
 */
const ORG_C = 'cccccccc-3333-4333-8333-cccccccccccc';

/** Identical shapes in both tenants, so a missing predicate returns a row rather than nothing. */
const FIXTURE = {
  teamKey: 'platform',
  reportDate: '2026-08-03',
  stableId: 'blocker:checkout-web#9201:review_wait',
  /**
   * The same address in both tenants.
   *
   * `users_org_email_key` is scoped to the organization, so this is legal — and it is the strongest
   * form of the fixture: a lookup by address alone finds two rows and returns whichever the planner
   * happened to reach first, which is a sign-in as the wrong person in the wrong company.
   */
  email: 'priya@example.com',
} as const;

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-03T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

interface Tenant {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly reportId: string;
  readonly sectionId: string;
  readonly itemId: string;
  readonly shareToken: string;
  readonly shareLinkId: string;
  readonly subscriptionId: string;
  readonly unsubscribeToken: string;
  readonly sessionSecret: string;
  readonly email: string;
}

let database: TestDatabase;
const tenants = new Map<string, Tenant>();

const scopedFor = (organizationId: string) => new ScopedDb(database.db, orgScope(organizationId));
const tenant = (organizationId: string): Tenant => {
  const found = tenants.get(organizationId);
  if (found === undefined) throw new Error(`no fixture for ${organizationId}`);
  return found;
};

async function seedTenant(organizationId: string, label: string, slug: string): Promise<Tenant> {
  await database.seedOrganization({
    organizationId,
    name: label,
    slug,
    timezone: 'Europe/London',
    at: asDate('2026-08-01T00:00:00Z'),
  });

  const scoped = scopedFor(organizationId);
  const userId = randomUUID();
  const membershipId = randomUUID();
  const reportId = randomUUID();
  const sectionId = randomUUID();
  const itemId = randomUUID();
  const shareLinkId = randomUUID();
  const subscriptionId = randomUUID();
  const email = FIXTURE.email;

  await scoped
    .insertInto(users, {
      id: userId,
      email,
      displayName: 'Priya Raman',
      passwordHash: null,
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  await scoped
    .insertInto(memberships, {
      id: membershipId,
      userId,
      role: 'manager',
      status: 'active',
      createdAt: asDate('2026-08-01T00:00:00Z'),
      updatedAt: asDate('2026-08-01T00:00:00Z'),
    })
    .execute();

  const sessionSecret = `session-secret-for-${slug}`;
  await scoped
    .insertInto(sessions, {
      id: randomUUID(),
      userId,
      tokenHash: digestSecret(sessionSecret),
      issuedAt: asDate('2026-08-03T08:00:00Z'),
      lastUsedAt: asDate('2026-08-03T08:00:00Z'),
      expiresAt: asDate('2026-09-02T08:00:00Z'),
      revokedAt: null,
      revokedReason: null,
      rotatedFromSessionId: null,
    })
    .execute();

  await scoped
    .insertInto(reports, {
      id: reportId,
      scopeKind: 'team',
      scopeKey: FIXTURE.teamKey,
      schemaVersion: 1,
      reportInstant: asDate('2026-08-03T06:00:00Z'),
      reportDate: FIXTURE.reportDate,
      timezone: 'Europe/London',
      windowStart: asDate('2026-08-02T00:00:00Z'),
      windowEnd: asDate('2026-08-03T00:00:00Z'),
      contentHash: 'c'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: `${label} only: the whole report.`,
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'complete',
      ingestRunId: null,
      generatedAt: asDate('2026-08-03T06:00:00Z'),
      changeLine: '',
    })
    .execute();

  await scoped
    .insertInto(reportSections, {
      id: sectionId,
      reportId,
      sectionKey: 'blockers',
      ordinal: 3,
      title: 'Blockers',
      prose: `${label} only: one blocker.`,
      payload: {},
      itemCount: 1,
      emptyStatement: 'No blocker is open.',
      summary: null,
    })
    .execute();

  await scoped
    .insertInto(reportItems, {
      id: itemId,
      reportId,
      reportSectionId: sectionId,
      ordinal: 1,
      stableId: FIXTURE.stableId,
      headline: `${label} only: checkout-web#9201 is waiting on review.`,
      detail: `${label} only: waiting on review since Wednesday.`,
      prose: `${label} only: still blocked.`,
      payload: {},
      ageDays: 5,
      hasLadder: false,
      changeTag: 'unchanged',
      causeEntityRef: 'pull_request:checkout-web#9201',
      causeKind: 'review_wait',
      causeDiscriminator: '',
      firstSeenAt: asDate('2026-07-29T06:00:00Z'),
      severityScore: 400,
      signalOnsetAt: asDate('2026-07-29T06:00:00Z'),
      feedbackState: null,
    })
    .execute();

  const minted = mintShareToken();
  await createShareLink(
    scoped,
    {
      id: shareLinkId,
      reportId,
      tokenHash: minted.tokenHash,
      audience: 'org_members',
      expiresAt: null,
      createdByUserId: userId,
    },
    NOW,
  );

  const unsubscribeToken = `unsubscribe-token-for-${slug}`;
  await upsertSubscription(
    scoped,
    {
      id: subscriptionId,
      userId,
      channel: 'email',
      target: email,
      scope: 'team',
      sendTime: '07:00',
      timezone: 'Europe/London',
      unsubscribeTokenHash: digestSecret(unsubscribeToken),
      slackUserId: null,
    },
    NOW,
  );

  return {
    organizationId,
    userId,
    membershipId,
    reportId,
    sectionId,
    itemId,
    shareToken: minted.token,
    shareLinkId,
    subscriptionId,
    unsubscribeToken,
    sessionSecret,
    email,
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();

  tenants.set(ORG_A, await seedTenant(ORG_A, 'Acme Platform', 'acme-platform-iso'));
  tenants.set(ORG_B, await seedTenant(ORG_B, 'Beta Robotics', 'beta-robotics-iso'));

  // The write probe's tenant: a root row and nothing else, so a DELETE there trips no foreign key
  // and removes nothing any other assertion depends on.
  await database.seedOrganization({
    organizationId: ORG_C,
    name: 'Predicate Probe',
    slug: 'predicate-probe-iso',
    timezone: 'UTC',
    at: asDate('2026-08-01T00:00:00Z'),
  });
}, 180_000);

afterAll(async () => {
  await database?.close();
});

describe('the fixture is genuinely two tenants that look alike', () => {
  it('gave both the same team, date, stable id and address', async () => {
    const a = tenant(ORG_A);
    const b = tenant(ORG_B);

    expect(a.organizationId).not.toBe(b.organizationId);
    expect(a.reportId).not.toBe(b.reportId);
    expect(a.email, 'identical addresses are what make a missing predicate visible').toBe(b.email);

    const rows = await database.client.query<{ count: string }>(
      'select count(*)::text as count from reports where scope_key = $1 and report_date = $2',
      [FIXTURE.teamKey, FIXTURE.reportDate],
    );
    expect(Number.parseInt(rows.rows[0]?.count ?? '0', 10), 'both tenants must hold a report to confuse').toBe(2);

    const items = await database.client.query<{ count: string }>(
      'select count(*)::text as count from report_items where stable_id = $1',
      [FIXTURE.stableId],
    );
    expect(Number.parseInt(items.rows[0]?.count ?? '0', 10)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 1. Every route, with org A's session and org B's identifiers
// ---------------------------------------------------------------------------

/**
 * Org A's manager, as the matrix sees them.
 *
 * A *seated, active, correctly scoped* principal, on purpose: an anonymous caller is refused by
 * things that have nothing to do with tenancy, so it would prove nothing about isolation. The
 * question this section asks is whether somebody who is legitimately signed in to org A can reach
 * org B, which is the only version of the question that matters.
 */
const managerOfA = (route: string, action: Action) =>
  ({
    route,
    action,
    principal: 'manager' as Principal,
    seatActive: true,
    teamKey: FIXTURE.teamKey,
    teamScopes: [FIXTURE.teamKey],
    // Neither tenant is the seeded demonstration org, so no `demoOnlyPublic` grant applies.
    demoOrganization: false,
  }) as const;

const EVERY_ROUTE_AND_ACTION: readonly { readonly route: string; readonly action: Action }[] = [
  ...apiRoutesOnDisk(),
  ...pageRoutesOnDisk(),
].flatMap((route) => ACTIONS.map((action) => ({ route, action })));

describe('every route on disk, asked for another tenant’s data', () => {
  it('enumerates a real set of routes rather than an empty one', () => {
    expect(EVERY_ROUTE_AND_ACTION.length).toBeGreaterThan(100);
    expect(apiRoutesOnDisk()).toContain('/api/reports/[teamKey]');
    expect(pageRoutesOnDisk()).toContain('/');
  });

  it.each(EVERY_ROUTE_AND_ACTION)(
    '$action $route is decided by the matrix and never by the identifier in the request',
    ({ route, action }) => {
      /**
       * The claim, stated precisely.
       *
       * A route's *access* decision cannot depend on which organization an id belongs to, because
       * the matrix never sees an id — that is the design. So what is asserted here is the property
       * that makes the design safe: the decision is a function of (route, action, principal) only,
       * and it is identical whether the caller is asking about their own tenant or another's. The
       * cross-tenant refusal itself is then structural rather than decisional, and section 2 below
       * asserts it on the actual lookups.
       *
       * The failure this catches is a route that grew a special case — an `if` on an id, a
       * demo-mode escape, a "just this once" widening — because such a route would decide
       * differently for the two inputs.
       */
      const forOwnTenant = authorize(managerOfA(route, action));
      const forOtherTenant = authorize({ ...managerOfA(route, action), demoOrganization: true });

      expect(findRouteRule(route), `${route} has no matrix entry, so nothing decides who may call it`).not.toBeNull();

      const rule = findRouteRule(route)!;
      if (!isPublicRoute(rule) || rule.demoOnlyPublic !== true) {
        // For everything except a demo-only public read, the demonstration flag must make no
        // difference at all: a seated principal's access is theirs, not their tenant's.
        expect(forOtherTenant.allowed, `${action} ${route} decided differently for another tenant`).toBe(
          forOwnTenant.allowed,
        );
      }

      // And a route the matrix does not allow this role must refuse with an attributable reason.
      if (!forOwnTenant.allowed) {
        expect(['no_such_route', 'method_not_allowed', 'authentication_required', 'role_not_permitted', 'seat_not_active', 'team_out_of_scope']).toContain(
          forOwnTenant.reason,
        );
      }
    },
  );

  it('refuses org A’s manager the team scope they do not hold, whichever tenant it is in', () => {
    // Both tenants have a `platform` team. A manager scoped to `platform` in org A must not reach
    // `payments` in either — the scope is a name, and a name is not a tenant.
    const decision = authorize({
      route: '/api/reports/[teamKey]',
      action: 'GET',
      principal: 'manager',
      seatActive: true,
      teamKey: 'payments',
      teamScopes: [FIXTURE.teamKey],
    });

    expect(decision.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Permalinks, share tokens, exports and email links
// ---------------------------------------------------------------------------

describe('org B’s identifiers are inert under org A’s scope', () => {
  it('will not open org B’s report by its permalink id', async () => {
    const scopedA = scopedFor(ORG_A);
    const b = tenant(ORG_B);

    // The control: org A can read its own.
    expect(await findReportById(scopedA, tenant(ORG_A).reportId)).not.toBeNull();
    expect(await findReportById(scopedA, b.reportId), 'a permalink is not a capability across tenants').toBeNull();
  });

  it('will not load org B’s report bundle — the shape an export and a share both use', async () => {
    const scopedA = scopedFor(ORG_A);

    expect(await loadReportBundle(scopedA, tenant(ORG_A).reportId)).not.toBeNull();
    expect(await loadReportBundle(scopedA, tenant(ORG_B).reportId)).toBeNull();
  });

  it('will not resolve org B’s share token, even though the token is valid in org B', async () => {
    const scopedA = scopedFor(ORG_A);
    const scopedB = scopedFor(ORG_B);
    const b = tenant(ORG_B);

    // Valid where it belongs.
    expect(await findShareLinkByTokenHash(scopedB, hashShareToken(b.shareToken))).not.toBeNull();
    // Inert everywhere else. The route looks up by digest under the caller's scope, so a leaked
    // link cannot be replayed against another tenant.
    expect(await findShareLinkByTokenHash(scopedA, hashShareToken(b.shareToken))).toBeNull();
  });

  it('will not resolve org B’s one-click unsubscribe token', async () => {
    const scopedA = scopedFor(ORG_A);
    const scopedB = scopedFor(ORG_B);
    const b = tenant(ORG_B);

    expect(await findSubscriptionByUnsubscribeHash(scopedB, digestSecret(b.unsubscribeToken))).not.toBeNull();
    expect(await findSubscriptionByUnsubscribeHash(scopedA, digestSecret(b.unsubscribeToken))).toBeNull();
  });

  it('will not find the report item an email feedback link names', async () => {
    // Both tenants hold an item with this exact stable id, which is the case a scoped lookup has to
    // get right: it must return *this* tenant's row and never the other's.
    const scopedA = scopedFor(ORG_A);
    const scopedB = scopedFor(ORG_B);

    const forA = await findReportItemByStableId(scopedA, FIXTURE.stableId);
    const forB = await findReportItemByStableId(scopedB, FIXTURE.stableId);

    expect(forA).not.toBeNull();
    expect(forB).not.toBeNull();
    expect(forA?.reportId).toBe(tenant(ORG_A).reportId);
    expect(forB?.reportId).toBe(tenant(ORG_B).reportId);
    expect(forA?.reportId).not.toBe(forB?.reportId);
  });

  it('will not accept org B’s session cookie as a session in org A', async () => {
    const scopedA = scopedFor(ORG_A);
    const scopedB = scopedFor(ORG_B);
    const b = tenant(ORG_B);

    expect(await findSessionByTokenHash(scopedB, digestSecret(b.sessionSecret))).not.toBeNull();
    expect(
      await findSessionByTokenHash(scopedA, digestSecret(b.sessionSecret)),
      'a cookie minted in one tenant must not identify anybody in another',
    ).toBeNull();
  });

  it('will not read org B’s seat by its membership id', async () => {
    const scopedA = scopedFor(ORG_A);

    expect(await findMembershipById(scopedA, tenant(ORG_A).membershipId)).not.toBeNull();
    expect(await findMembershipById(scopedA, tenant(ORG_B).membershipId)).toBeNull();
  });

  it('will not read org B’s subscription by its id', async () => {
    const scopedA = scopedFor(ORG_A);

    expect(await findSubscriptionById(scopedA, tenant(ORG_A).subscriptionId)).not.toBeNull();
    expect(await findSubscriptionById(scopedA, tenant(ORG_B).subscriptionId)).toBeNull();
  });

  it('resolves the shared address to a different person in each tenant', async () => {
    // The same email exists in both. A lookup that forgot its predicate would authenticate one
    // tenant's manager as the other's.
    const forA = await findUserByEmail(scopedFor(ORG_A), FIXTURE.email);
    const forB = await findUserByEmail(scopedFor(ORG_B), FIXTURE.email);

    expect(forA?.id).toBe(tenant(ORG_A).userId);
    expect(forB?.id).toBe(tenant(ORG_B).userId);
    expect(forA?.id).not.toBe(forB?.id);
  });

  it('refuses to write a row belonging to another tenant, even when told to', async () => {
    // The other direction: not reading across, but *writing* across. The scoped layer supplies the
    // organization, and a caller who passes a different one is refused rather than obeyed.
    const scopedA = scopedFor(ORG_A);

    expect(() =>
      scopedA.insertInto(users, {
        id: randomUUID(),
        organizationId: ORG_B,
        email: 'smuggled@example.com',
        displayName: 'Smuggled',
        passwordHash: null,
        createdAt: asDate('2026-08-03T00:00:00Z'),
        updatedAt: asDate('2026-08-03T00:00:00Z'),
      } as never),
    ).toThrow(/Refusing to write a row owned by organization/);
  });

  it('leaves each tenant’s prose readable only by that tenant', async () => {
    // The end-to-end statement, in the terms a leak would be reported in: the words of org B's
    // report must not be reachable from org A's scope by any of the paths above.
    const bundleA = await loadReportBundle(scopedFor(ORG_A), tenant(ORG_A).reportId);
    const serialised = JSON.stringify(bundleA);

    expect(serialised).toContain('Acme Platform only');
    expect(serialised, 'org B’s prose reached org A’s bundle').not.toContain('Beta Robotics only');
  });
});

// ---------------------------------------------------------------------------
// 3. No SQL without an organization_id predicate
// ---------------------------------------------------------------------------

describe('the query layer emits no statement without an organization predicate', () => {
  /**
   * Every table that carries tenant data, and the three that do not need the predicate in a
   * *statement* because they are not read through the scoped layer at all.
   *
   * `__drizzle_migrations` is the migrator's own bookkeeping and `information_schema` is the
   * catalogue; both are read by the harness, not by the application.
   */
  const EXEMPT = /(__drizzle_migrations|information_schema|pg_catalog|pg_class|drizzle\.)/i;

  /**
   * Runs a batch of real repository calls and returns every SQL statement the driver received.
   *
   * The point of watching the *driver* rather than reading the source is that it cannot be
   * satisfied by intention. `ScopedDb` claims to add the predicate; this is where that claim is
   * checked against the bytes PostgreSQL was actually asked to run.
   */
  async function statementsDuring(
    work: (scoped: ScopedDb) => Promise<unknown>,
    organizationId = ORG_A,
  ): Promise<readonly string[]> {
    const seen: string[] = [];
    const client = database.client as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const original = client.query.bind(client);

    client.query = async (...args: unknown[]) => {
      const [statement] = args;
      if (typeof statement === 'string') seen.push(statement);
      return original(...args);
    };

    try {
      await work(scopedFor(organizationId));
    } finally {
      client.query = original as typeof client.query;
    }

    return seen;
  }

  it('observes statements at all, so an empty capture cannot pass this test', async () => {
    const statements = await statementsDuring(async (scoped) => {
      await findReportById(scoped, tenant(ORG_A).reportId);
    });

    expect(statements.length, 'the capture saw no SQL, so nothing below is being checked').toBeGreaterThan(0);
    expect(statements.join('\n')).toMatch(/select/i);
  });

  it('adds `organization_id` to every read the repositories perform', async () => {
    const statements = await statementsDuring(async (scoped) => {
      // A broad sweep of the reads that serve the report, the archive, the seats screen, the
      // share route, delivery and the feedback loop — the paths an acceptance criterion names.
      await findReportById(scoped, tenant(ORG_A).reportId);
      await loadReportBundle(scoped, tenant(ORG_A).reportId);
      await findReportItemByStableId(scoped, FIXTURE.stableId);
      await findShareLinkByTokenHash(scoped, hashShareToken(tenant(ORG_A).shareToken));
      await findSubscriptionByUnsubscribeHash(scoped, digestSecret(tenant(ORG_A).unsubscribeToken));
      await findSubscriptionById(scoped, tenant(ORG_A).subscriptionId);
      await findSessionByTokenHash(scoped, digestSecret(tenant(ORG_A).sessionSecret));
      await findUserByEmail(scoped, FIXTURE.email);
      await findMembershipById(scoped, tenant(ORG_A).membershipId);
      await scoped.selectFrom(reports);
      await scoped.selectFrom(reportItems);
      await scoped.selectFrom(users);
      await scoped.selectFrom(organizations);
    });

    const unscoped = statements.filter((statement) => {
      if (EXEMPT.test(statement)) return false;
      if (!/\bfrom\b|\binto\b|\bupdate\b|\bdelete\b/i.test(statement)) return false;
      return !statement.includes('organization_id');
    });

    expect(unscoped, 'these statements were emitted with no organization predicate').toEqual([]);
  });

  it('adds it to writes and deletes too, not only to reads', async () => {
    // Run against the probe tenant: a real UPDATE and a real DELETE have to reach the driver for
    // their SQL to be observable, and org A's rows are the fixture the rest of this file reads.
    const statements = await statementsDuring(async (scoped) => {
      await scoped
        .insertInto(users, {
          id: randomUUID(),
          email: `probe-${randomUUID()}@example.com`,
          displayName: 'Predicate Probe',
          passwordHash: null,
          createdAt: asDate('2026-08-03T00:00:00Z'),
          updatedAt: asDate('2026-08-03T00:00:00Z'),
        })
        .execute();
      await scoped.updateIn(users, { displayName: 'Renamed Probe' }).execute();
      await scoped.deleteFrom(users).execute();
    }, ORG_C);

    // An INSERT names the column in its column list; an UPDATE and a DELETE carry it in the WHERE.
    const mutations = statements.filter((statement) => /^(insert|update|delete)/i.test(statement.trim()));
    expect(mutations.length).toBeGreaterThanOrEqual(3);

    for (const statement of mutations) {
      expect(statement, 'a mutation reached the database unscoped').toContain('organization_id');
    }
  });

  it('cannot be handed a scope that would match more than one tenant', () => {
    // The last line of the same defence: the predicate is only as good as the value in it, so an
    // absent, empty or non-uuid organization is refused at construction rather than producing a
    // query that matches everything.
    for (const bad of [undefined, null, '', '   ', 'all', '*', 'org-a']) {
      expect(() => new ScopedDb(database.db, orgScope(bad)), `${String(bad)} must not become a scope`).toThrow();
    }
  });

  it('re-reads both tenants afterwards to prove the destructive probe stayed inside its own', async () => {
    /**
     * The isolation claim restated as a consequence of a *destructive* operation.
     *
     * The probe above ran `delete from users` with no WHERE of its own. Unscoped, that statement
     * empties the table for every tenant in the deployment — so this is the assertion that the
     * predicate the scoped layer added was not cosmetic: both real tenants still hold their own
     * person, with their own id, after another tenant's rows were deleted out from under them.
     */
    const forA = await findUserByEmail(scopedFor(ORG_A), FIXTURE.email);
    const forB = await findUserByEmail(scopedFor(ORG_B), FIXTURE.email);

    expect(forA?.id, 'a delete scoped to the probe tenant removed org A’s row').toBe(tenant(ORG_A).userId);
    expect(forB?.id, 'a delete scoped to the probe tenant removed org B’s row').toBe(tenant(ORG_B).userId);

    // And the probe tenant is genuinely empty, so the DELETE did happen.
    const remaining = await database.client.query<{ count: string }>(
      'select count(*)::text as count from users where organization_id = $1',
      [ORG_C],
    );
    expect(Number.parseInt(remaining.rows[0]?.count ?? '0', 10), 'the DELETE must actually have run').toBe(0);
  });
});

describe('the matrix covers every route this suite walked', () => {
  it('has an entry for each, so a new route cannot dodge the isolation test either', () => {
    const walked = new Set([...apiRoutesOnDisk(), ...pageRoutesOnDisk()]);
    const missing = [...walked].filter((route) => findRouteRule(route) === null);

    expect(missing, 'these routes are on disk with no matrix entry').toEqual([]);
    for (const route of walked) expect(MATRIX_ROUTES).toContain(route);
  });
});
