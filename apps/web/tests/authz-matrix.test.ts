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
  /**
   * The short sign-in address, on the same terms as the endpoint it shares an implementation with.
   *
   * `POST` is the sign-in a verification harness performs against the `login_path` in
   * `.nous/demo_account.json`; `GET` is a 303 to `/account`. Both `ANYONE`, because this is how a
   * session is obtained — requiring one would be circular. Not `demoOnlyPublic`: it discloses nothing
   * about the tenant either way, since a wrong address and a wrong password get one 401 and one
   * sentence.
   */
  '/login': {
    GET: ['public', 'owner', 'manager', 'member', 'viewer'],
    POST: ['public', 'owner', 'manager', 'member', 'viewer'],
  },
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
   * Feedback, and why two of the three are `public` at the matrix level.
   *
   * `/api/feedback` is the web view's own POST, so it is owner and manager: a viewer reads the
   * daily and does not get to change what tomorrow's says. `member` is excluded for the same
   * reason it is excluded from the goal hierarchy — a verdict on a finding is a management act.
   *
   * The other two arrive from clients with **no cookies to send** — a mail client following a
   * link, Slack posting an interaction — so requiring a session here would mean the feature could
   * not exist. They are authorised inside the handler by something *narrower* than a session: a
   * signed token scoped to exactly one item and one action, or Slack's v0 signature plus a stored
   * (Slack user → seat) mapping the role matrix then approves. Neither can read a report, and
   * neither establishes a session — `feedback-routes.test.ts` asserts the absence of `Set-Cookie`
   * on the link route directly, because that is the convenience somebody adds later in good faith.
   */
  /**
   * `GET` is a different subject from the `POST` beside it: the list of submissions about **Compass
   * itself**, which is owner-only. Those are other people's words, sometimes naming a colleague or
   * quoting a customer, and a manager who edits their own team's configuration does not thereby get
   * to read the organization's support inbox.
   */
  '/api/feedback': { GET: ['owner'], POST: ['owner', 'manager'] },

  /**
   * The in-app control's write, `public` on the same terms as `/`.
   *
   * The seeded demonstration report is readable with no session, so the reader who most needs to say
   * "this page is confusing" is the one who has not signed up. A seated-only control would be a
   * control that never hears from them. Narrow by construction: one field in, one row written to a
   * table nothing in the pipeline reads, and a response carrying no organization data — so the most a
   * stranger can do here is tell us something. `demoOnlyPublic`, so it closes with everything else on
   * a real tenant.
   */
  '/api/feedback/app': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },

  /**
   * The time-travel control: owner and manager, because it *writes*.
   *
   * Stepping to a day nobody has generated runs the whole pipeline for that instant and persists the
   * report. A viewer reads the archive; they do not get to add rows to it. `member` is excluded on the
   * same reasoning as `/api/feedback` — regenerating a report is a management act.
   *
   * The matrix is only half the gate. `apps/web/tests/time-travel.test.ts` asserts the other half: the
   * handler refuses any organization not on the simulated clock, so an authorised manager of a live org
   * still cannot move its `now`.
   */
  '/api/time-travel': { POST: ['owner', 'manager'] },
  '/api/feedback/link/[token]': {
    GET: ['public', 'owner', 'manager', 'member', 'viewer'],
    POST: ['public', 'owner', 'manager', 'member', 'viewer'],
  },
  '/api/slack/actions': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },

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
  /**
   * The guided first-report path. Owner and manager, and deliberately not public.
   *
   * Every step on it writes configuration — a team, the two objectives, a roster — and those writes
   * are already owner-or-manager on `/api/roster/*` and `/api/goals`. A screen anyone could read
   * while every button on it answered 403 would be worse than being told to sign in. It is a
   * destination, never an interception: nothing redirects to it.
   */
  '/start': { GET: ['owner', 'manager'] },
  '/seats': { GET: ['owner', 'manager'] },
  '/roster': { GET: ['owner', 'manager'] },
  // What a manager has told Compass to stop saying. Owner and manager, exactly like the roster:
  // a suppression a manager cannot find is indistinguishable from a detector that broke, so the
  // people whose verdicts these are must be able to read them back.
  '/corrections': { GET: ['owner', 'manager'] },

  /**
   * The archive and the two cross-cutting reads, on the same terms as `/`.
   *
   * `ANYONE` with `demoOnlyPublic`: a past report is the same organization data as today's, so it gets the
   * same posture — readable without a session on the demonstration tenant, closed the moment Compass holds
   * somebody's actual blockers. A skip-level pointed at last Tuesday's report must not need a seat, which
   * is the entire use case for the archive existing.
   *
   * ## Why these are *not* `teamScoped`, when `/api/reports/[teamKey]` is
   *
   * Deliberate, and worth stating because it grants a read that route refuses. Three of these are org-level
   * documents by construction:
   *
   * - `/merged` and `/archive/merged/[reportDate]` rank findings *across* teams. Team-scoping them would
   *   mean a manager of two teams sees a "merged" report over one, which is the per-team report with a worse
   *   layout — the page says so and sends them to `/` instead.
   * - `/archive` is an index of dates. It lists which reports exist, which is metadata about the
   *   organization's own cadence rather than any team's findings.
   *
   * `/archive/[reportId]` is the one genuinely per-team read here, and it is the one to revisit first if this
   * posture is ever tightened: an id names one team's report, so it *could* carry a scope check. It does not
   * today because the id is unguessable-by-accident but not a capability — it is derived from
   * `(organization, scope, instant)` — so a scope check there would be real defence rather than theatre. The
   * reason it is not yet enforced is that the archive's whole purpose is a link somebody sends to a
   * skip-level who may hold no seat at all, and on a real tenant that reader already needs a session; the
   * remaining gap is a *seated* reader of one team opening another team's archived report.
   *
   * `/weekly` is per-team and *is* enforced, in the page rather than the matrix: it filters the team list to
   * the caller's own scopes before resolving `?team=`, because the team is a query parameter the matrix
   * never sees. A seat scoped to no existing team is told so rather than shown another team's week.
   */
  '/archive': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/archive/[reportId]': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/archive/merged/[reportDate]': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/merged': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/weekly': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
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

    // Exactly the routes that carry organizational data and are readable without a seat. The archive and
    // the two cross-cutting reads join them for the reason the archive exists at all: a skip-level pointed
    // at last Tuesday's report must not need a seat, and a past report is the same data as today's — so it
    // gets the same posture, and closes on a real tenant along with everything else here.
    expect(demoOnly.sort()).toEqual([
      '/',
      // The in-app feedback write. Public on the demonstration tenant for the same reason `/` is —
      // the reader who most needs to report a problem with the page is the one with no seat — and it
      // returns no organization data, so the grant costs nothing on the read side.
      '/api/feedback/app',
      '/api/goals',
      '/api/goals/[nodeId]',
      '/api/reports/[teamKey]',
      '/archive',
      '/archive/[reportId]',
      '/archive/merged/[reportDate]',
      '/goals',
      '/merged',
      '/weekly',
    ]);
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

    // Enumerated, so adding a team-scoped route is a visible edit here rather than a quiet widening.
    //
    // `/api/feedback` is one because a verdict is about a *finding in one team's report*: a manager
    // scoped to `platform` must not be able to dismiss a risk on the checkout team's report, and the
    // scope check is the only thing that stops them. It is also why the Slack handler asks this same
    // matrix with this same route rather than deciding for itself.
    // `/api/time-travel` joins them because it regenerates *one team's* report: a manager scoped to
    // `platform` must not be able to rewrite the checkout team's daily by naming it in the body.
    expect(teamScoped).toEqual(['/api/reports/[teamKey]', '/api/feedback', '/api/time-travel']);
  });
});
