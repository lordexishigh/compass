import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIONS,
  MATRIX_ROUTES,
  PRINCIPALS,
  ROLE_MATRIX,
  STATUS_FOR_DENIAL,
  authorize,
  describeDenial,
  findRouteRule,
  isPublicRoute,
  teamScopeAllows,
  type Action,
  type Principal,
} from '@compass/auth';
import { describe, expect, it } from 'vitest';

/**
 * The role matrix, held to the acceptance criteria.
 *
 * Three separate claims are proved here and they are separate on purpose:
 *
 *  1. **Every (role × route × action) triple decides the way it is meant to.** The
 *     expectation is written out below as a second, independent statement of the intent, so
 *     a careless edit to `ROLE_MATRIX` fails rather than redefining the intent along with
 *     the table.
 *  2. **Every API route on disk has an entry.** Enumerated from the filesystem, so a new
 *     `route.ts` is a build failure until it declares who may call it.
 *  3. **Deny is the default at every step** — unknown route, undeclared verb, unlisted
 *     principal, inactive seat, wrong team.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every route the App Router actually serves under `app/api`, spelled the way the
 * filesystem spells it.
 *
 * Derived rather than listed: a hand-maintained list here would be a third place to forget
 * a route, which is the failure this test exists to prevent.
 */
function apiRoutesOnDisk(): readonly string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== 'route.ts' && entry.name !== 'route.tsx') continue;

      // `app/api/goals/[nodeId]/route.ts` -> `/api/goals/[nodeId]`
      const segments = relative(join(WEB_ROOT, 'app'), dirname(full)).split(sep);
      found.push(`/${segments.join('/')}`);
    }
  };

  walk(join(WEB_ROOT, 'app', 'api'));
  return found.sort();
}

/**
 * The intent, restated.
 *
 * `allow[route][action]` is the set of principals that must be permitted. Anything absent
 * must be refused. This is deliberately a second source: if it were derived from
 * `ROLE_MATRIX` the test would only assert that the table equals itself.
 */
const EXPECTED: Readonly<Record<string, Partial<Record<Action, readonly Principal[]>>>> = {
  '/': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/health': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/reports/[teamKey]': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },

  '/api/auth/register': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/login': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/logout': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/session': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/sessions': {
    GET: ['owner', 'manager', 'member', 'viewer'],
    DELETE: ['owner', 'manager', 'member', 'viewer'],
  },
  '/api/auth/magic-link': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/magic-link/consume': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/password-reset': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/password-reset/consume': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },

  '/api/seats': { GET: ['owner', 'manager'], POST: ['owner'] },
  '/api/seats/[membershipId]': { GET: ['owner', 'manager'], PATCH: ['owner'], DELETE: ['owner'] },
  '/api/seats/[membershipId]/invite': { POST: ['owner'] },
  '/api/seats/accept': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },

  '/api/goals': { GET: ['public', 'owner', 'manager', 'member', 'viewer'], POST: ['owner', 'manager'] },
  '/api/goals/[nodeId]': {
    GET: ['public', 'owner', 'manager', 'member', 'viewer'],
    PATCH: ['owner', 'manager'],
    DELETE: ['owner', 'manager'],
  },

  '/api/audit': { GET: ['owner'] },

  /**
   * Delivery and share links: token-authorised rather than session-authorised.
   *
   * `public` here is deliberate and is not a hole. A one-click unsubscribe arrives from a mail
   * client with no cookies, and the token can only switch off one person's daily — reversibly,
   * since the row is kept. A share link is meant to be openable from an address somebody was
   * sent, and the route enforces its own audience rule on top of this: `org_members` by default,
   * so an anonymous reader is still refused unless the link was explicitly made public.
   */
  '/api/delivery/unsubscribe': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/share/[token]': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },

  /**
   * Configuration and the identity roster: owner *and* manager on every verb.
   *
   * Restated here as intent rather than copied as fact. The widening to managers is
   * deliberate — team scoping is the basis of every aggregate and a bad identity merge
   * corrupts attribution in every downstream report, so the person who reads the report must
   * be able to fix the configuration behind it rather than filing a request while the wrong
   * name stays in tomorrow's report. Every write is audited with its actor either way.
   *
   * Members and viewers are absent from every row, which is the half worth stating: reading a
   * report does not make somebody an editor of the roster it is computed from. `public` is
   * absent too, and unlike `/` and `/api/goals` these rows carry no `demoOnlyPublic` escape —
   * the demonstration tenant's configuration is not world-writable.
   */
  '/api/roster': { GET: ['owner', 'manager'] },
  '/api/roster/teams': { POST: ['owner', 'manager'], PATCH: ['owner', 'manager'], PUT: ['owner', 'manager'] },
  '/api/roster/sources': { PATCH: ['owner', 'manager'] },
  '/api/roster/identities': { POST: ['owner', 'manager'], DELETE: ['owner', 'manager'] },
  '/api/roster/merges': { POST: ['owner', 'manager'], DELETE: ['owner', 'manager'] },
  '/api/roster/absences': { POST: ['owner', 'manager'], PATCH: ['owner', 'manager'] },

  '/goals': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/account': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/account/invite': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/account/reset': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/seats': { GET: ['owner', 'manager'] },
  '/roster': { GET: ['owner', 'manager'] },
};

/**
 * A principal that would satisfy every check *other* than the matrix.
 *
 * Team scopes cover both teams and the seat is active, so a denial in the triples below is
 * always the matrix's decision and never a scope or status accident.
 */
const unconstrained = (principal: Principal, route: string) =>
  ({
    route,
    principal,
    seatActive: true,
    teamKey: 'platform',
    teamScopes: ['platform', 'payments'],
    demoOrganization: true,
  }) as const;

// ---------------------------------------------------------------------------
// 1. Every route has an entry
// ---------------------------------------------------------------------------

describe('every API route has an entry in the matrix', () => {
  it('finds the routes on disk at all, so an empty walk cannot pass this file', () => {
    const routes = apiRoutesOnDisk();

    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain('/api/auth/login');
    // The dynamic-segment spelling has to match the matrix's, or the diff below would
    // fail for a reason that has nothing to do with access.
    expect(routes).toContain('/api/goals/[nodeId]');
  });

  it('has no route on disk that the matrix does not describe', () => {
    const undeclared = apiRoutesOnDisk().filter((route) => findRouteRule(route) === null);

    expect(
      undeclared,
      'these routes serve requests with no entry in ROLE_MATRIX, so nothing decides who may call them',
    ).toEqual([]);
  });

  it('has no API entry in the matrix that no route serves', () => {
    // The other direction. A stale entry is not a security hole, but it is a lie about
    // the product's surface, and it makes the matrix untrustworthy to read.
    const onDisk = new Set(apiRoutesOnDisk());
    const stale = MATRIX_ROUTES.filter((route) => route.startsWith('/api/') && !onDisk.has(route));

    expect(stale, 'these matrix entries name routes that do not exist').toEqual([]);
  });

  it('declares at least one action for every entry', () => {
    for (const rule of ROLE_MATRIX) {
      const declared = ACTIONS.filter((action) => (rule.allow[action]?.length ?? 0) > 0);
      expect(declared.length, `${rule.route} permits nothing at all`).toBeGreaterThan(0);
    }
  });

  it('gives every entry a summary, because the table is meant to be read', () => {
    for (const rule of ROLE_MATRIX) {
      expect(rule.summary.length, `${rule.route} has no summary`).toBeGreaterThan(10);
    }
  });

  it('is the same set of routes the expectation table names', () => {
    // Guards the parametrized walk below: without this, deleting a row from EXPECTED
    // would silently stop testing that route.
    expect(Object.keys(EXPECTED).sort()).toEqual([...MATRIX_ROUTES]);
  });
});

// ---------------------------------------------------------------------------
// 2. The parametrized walk
// ---------------------------------------------------------------------------

const TRIPLES: readonly { readonly route: string; readonly action: Action; readonly principal: Principal }[] =
  MATRIX_ROUTES.flatMap((route) =>
    ACTIONS.flatMap((action) => PRINCIPALS.map((principal) => ({ route, action, principal }))),
  );

describe('every (principal × route × action) triple decides as intended', () => {
  it('walks a triple for every combination, not a sample', () => {
    expect(TRIPLES.length).toBe(MATRIX_ROUTES.length * ACTIONS.length * PRINCIPALS.length);
  });

  it.each(TRIPLES)('$principal $action $route', ({ route, action, principal }) => {
    const expected = EXPECTED[route]?.[action] ?? [];
    const shouldAllow = expected.includes(principal);

    const decision = authorize({ ...unconstrained(principal, route), action });

    expect(
      decision.allowed,
      shouldAllow
        ? `${principal} should be allowed ${action} ${route}`
        : `${principal} must NOT be allowed ${action} ${route}`,
    ).toBe(shouldAllow);

    if (!decision.allowed) {
      // The refusal has to be attributable, or a 403 is indistinguishable from a bug.
      expect(STATUS_FOR_DENIAL[decision.reason]).toBeGreaterThanOrEqual(401);
      expect(describeDenial(decision.reason).length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Deny by default
// ---------------------------------------------------------------------------

describe('deny is the default at every step', () => {
  it('refuses a route the matrix has never heard of, for every principal', () => {
    for (const principal of PRINCIPALS) {
      const decision = authorize({ route: '/api/not-a-route', action: 'GET', principal, seatActive: true });

      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false ? decision.reason : null).toBe('no_such_route');
    }
  });

  it('refuses an undeclared verb even for an owner', () => {
    // `/api/audit` declares GET and nothing else. An owner is refused DELETE, which is
    // what makes "no route may prune the audit log" structural.
    const decision = authorize({ ...unconstrained('owner', '/api/audit'), action: 'DELETE' });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : null).toBe('method_not_allowed');
  });

  it('refuses a pending or revoked seat even on a route its role permits', () => {
    const decision = authorize({
      route: '/api/seats',
      action: 'GET',
      principal: 'owner',
      seatActive: false,
      demoOrganization: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : null).toBe('seat_not_active');
  });

  it('answers 401 for an anonymous request to a seated route, and 403 for the wrong role', () => {
    const anonymous = authorize({ route: '/api/seats', action: 'GET', principal: 'public' });
    const wrongRole = authorize({ ...unconstrained('viewer', '/api/seats'), action: 'GET' });

    expect(anonymous.allowed === false ? anonymous.reason : null).toBe('authentication_required');
    expect(wrongRole.allowed === false ? wrongRole.reason : null).toBe('role_not_permitted');
    expect(STATUS_FOR_DENIAL['authentication_required']).toBe(401);
    expect(STATUS_FOR_DENIAL['role_not_permitted']).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 4. The public demo entry
// ---------------------------------------------------------------------------

describe('the seeded demo report route stays publicly readable', () => {
  it('carries an explicit public entry for `/`', () => {
    const rule = findRouteRule('/');

    expect(rule, 'the report route is not in the matrix at all').not.toBeNull();
    expect(rule?.allow.GET).toContain('public');
    expect(isPublicRoute(rule!)).toBe(true);
  });

  it('allows an anonymous GET of `/` in the demonstration tenant', () => {
    const decision = authorize({ route: '/', action: 'GET', principal: 'public', demoOrganization: true });

    expect(decision.allowed).toBe(true);
  });

  it('confines that public read to the demonstration tenant', () => {
    // A real customer's blockers and risks are not a landing page. Same route, same
    // matrix, one different input.
    const decision = authorize({ route: '/', action: 'GET', principal: 'public', demoOrganization: false });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : null).toBe('authentication_required');
  });

  it('marks every route whose public grant is demo-only', () => {
    const demoOnly = ROLE_MATRIX.filter((rule) => rule.demoOnlyPublic === true).map((rule) => rule.route);

    // Exactly the routes that carry organizational data and are readable without a seat.
    expect(demoOnly.sort()).toEqual(['/', '/api/goals', '/api/goals/[nodeId]', '/api/reports/[teamKey]', '/goals']);
  });

  it('keeps `/api/health` public in every tenant, because the container calls it', () => {
    const rule = findRouteRule('/api/health');

    expect(rule?.demoOnlyPublic).toBeUndefined();
    expect(authorize({ route: '/api/health', action: 'GET', principal: 'public', demoOrganization: false }).allowed).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Team scoping
// ---------------------------------------------------------------------------

describe('team scoping', () => {
  it('refuses a manager scoped to team A asking for team B', () => {
    const decision = authorize({
      route: '/api/reports/[teamKey]',
      action: 'GET',
      principal: 'manager',
      seatActive: true,
      teamKey: 'payments',
      teamScopes: ['platform'],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false ? decision.reason : null).toBe('team_out_of_scope');
    expect(STATUS_FOR_DENIAL['team_out_of_scope']).toBe(403);
  });

  it('allows the same manager their own team', () => {
    const decision = authorize({
      route: '/api/reports/[teamKey]',
      action: 'GET',
      principal: 'manager',
      seatActive: true,
      teamKey: 'platform',
      teamScopes: ['platform'],
    });

    expect(decision.allowed).toBe(true);
  });

  it('treats an owner as unscoped, because an owner locked out has no way back in', () => {
    expect(teamScopeAllows('owner', 'payments', [])).toBe(true);

    const decision = authorize({
      route: '/api/reports/[teamKey]',
      action: 'GET',
      principal: 'owner',
      seatActive: true,
      teamKey: 'payments',
      teamScopes: [],
    });
    expect(decision.allowed).toBe(true);
  });

  it('treats every other role with no scope row as reading nothing', () => {
    // The safe direction for the failure to fall: a manager whose scopes were never set
    // reads nothing rather than everything.
    for (const principal of ['manager', 'member', 'viewer'] as const) {
      expect(teamScopeAllows(principal, 'platform', []), principal).toBe(false);
      expect(teamScopeAllows(principal, null, []), `${principal} with no team named`).toBe(false);
    }
  });

  it('says which team was refused, without confirming that team B has a report', () => {
    const sentence = describeDenial('team_out_of_scope', { teamKey: 'payments' });

    expect(sentence).toContain('payments');
    expect(sentence.toLowerCase()).not.toContain('does not exist');
    expect(sentence.toLowerCase()).not.toContain('no report');
  });

  it('only applies the scope check to routes that are about one team', () => {
    const teamScoped = ROLE_MATRIX.filter((rule) => rule.teamScoped === true).map((rule) => rule.route);

    expect(teamScoped).toEqual(['/api/reports/[teamKey]']);
  });
});
