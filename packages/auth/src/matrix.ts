import type { MembershipRole } from '@compass/db';

/**
 * The access matrix. One table, and every server-side decision reads it.
 *
 * ## Why a table and not `if` statements
 *
 * A permission expressed as a condition inside a handler is invisible: nobody can
 * enumerate it, no test can iterate it, and a new route ships with whatever its
 * author remembered. So the whole of (principal × route × action) is one exported
 * value here. Two tests hold it to that:
 *
 *  - `apps/web/tests/authz-matrix.test.ts` walks every (role × route × action)
 *    triple and asserts the expected allow or deny — the matrix cannot drift from
 *    the intent without a test failing.
 *  - the same file enumerates `app/api/**\/route.ts` from disk and fails if any
 *    route has no entry here, so a new endpoint is a build failure until it has
 *    declared who may call it.
 *
 * ## The fifth principal
 *
 * `public` is a principal in the same table as the four roles, not a hole punched
 * around it. Compass's zero-config promise is that a clean container serves `/` as a
 * full six-section report with no session — so "no session" has to be something the
 * matrix can *say*, otherwise the promise would have to be implemented by bypassing
 * the matrix, which is exactly how these things get lost.
 *
 * ## `demoOnlyPublic`
 *
 * Public readability is confined to the seeded demonstration tenant. `/` is world
 * readable when the organization being read is the seeded demo org, and requires a
 * seat otherwise: a real customer's blockers and risks are not a landing page. The
 * flag says which routes that applies to, and `authorize` enforces it, so the
 * open-demo behaviour and the closed-tenant behaviour are one code path with one
 * input rather than two implementations.
 */

/** The four seat roles plus the absence of a session. */
export type Principal = 'public' | MembershipRole;

export const PRINCIPALS = ['public', 'owner', 'manager', 'member', 'viewer'] as const satisfies readonly Principal[];

/**
 * Every HTTP verb any Compass route serves.
 *
 * `PUT` earns its place on one route: `/api/roster/teams` sets a team's whole working
 * calendar, which is a replacement rather than a merge — sending three holidays means the
 * calendar has three holidays, not that three were added to whatever was there. A `PATCH`
 * that silently unioned them would make removing a holiday impossible.
 */
export const ACTIONS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

export type Action = (typeof ACTIONS)[number];

export interface RouteRule {
  /**
   * The route, spelled exactly as the App Router spells it on disk — dynamic
   * segments included, `[nodeId]` and not `:nodeId`. The route-coverage test derives
   * the same string from the filesystem and diffs the two, so any other spelling
   * would make the two disagree for a reason that has nothing to do with access.
   */
  readonly route: string;
  /** What this route is for, in one line. Shown by the matrix documentation test. */
  readonly summary: string;
  /**
   * Which principals may perform which action. A verb absent from this map is
   * served to nobody — including an owner — which is what makes adding a verb to a
   * handler without declaring it here a denial rather than a silent grant.
   */
  readonly allow: Partial<Record<Action, readonly Principal[]>>;
  /**
   * True when the route answers about one team, so the request must also clear the
   * team-scope check. A manager scoped to team A asking for team B gets 403 here
   * even though the matrix allows managers the route.
   */
  readonly teamScoped?: boolean;
  /** True when the `public` grants above apply only to the seeded demo tenant. */
  readonly demoOnlyPublic?: boolean;
}

/**
 * What each role can do, stated once in prose so the table below reads as a
 * consequence rather than as a list of arbitrary decisions.
 *
 *  - **owner** — everything. The only role that can move seats, change roles or read
 *    the audit log. There is always at least one.
 *  - **manager** — reads the report for the teams they are scoped to, and edits both the
 *    goal hierarchy and the configuration behind it: teams, membership, working calendars,
 *    tracked repositories and projects, the identity roster and absences. A manager who
 *    cannot correct the objective their work is measured against cannot argue with an
 *    alignment verdict, and one who spots a wrong attribution has to be able to fix it
 *    rather than file a request while the wrong name stays in tomorrow's report. Sees the
 *    seat list (who is on the team) but cannot change it.
 *  - **member** — reads the report for the teams they are scoped to. Does not edit
 *    goals and does not see seats: an engineer reading the team's report is not an
 *    administrator of it.
 *  - **viewer** — reads, and nothing else. The role for a stakeholder outside the
 *    engineering org.
 */
export const ROLE_CAPABILITIES: Readonly<Record<MembershipRole, string>> = {
  owner: 'Everything, including seats, roles, the audit log and configuration.',
  manager:
    'Reads their scoped teams’ reports and edits what they are computed from — the goal hierarchy, teams, ' +
    'membership, working calendars, tracked repositories, the identity roster and absences. Sees the seat list, ' +
    'read-only.',
  member: 'Reads their scoped teams’ reports.',
  viewer: 'Reads their scoped teams’ reports, and nothing else.',
};

const EVERY_SEAT: readonly Principal[] = ['owner', 'manager', 'member', 'viewer'];
const ANYONE: readonly Principal[] = ['public', 'owner', 'manager', 'member', 'viewer'];

export const ROLE_MATRIX: readonly RouteRule[] = [
  // -------------------------------------------------------------------------
  // The report, and the two routes a container needs before it has a user.
  // -------------------------------------------------------------------------
  {
    route: '/',
    summary: "Today's report — six sections, read on a cold container with no session.",
    allow: { GET: ANYONE },
    // The zero-config promise, and the whole reason `public` is in this table.
    demoOnlyPublic: true,
  },
  {
    route: '/api/health',
    summary: 'Readiness: every capability and its condition. Never carries org data.',
    allow: { GET: ANYONE },
  },
  {
    route: '/api/reports/[teamKey]',
    summary: "One team's latest report, as JSON.",
    allow: { GET: ANYONE },
    teamScoped: true,
    demoOnlyPublic: true,
  },

  // -------------------------------------------------------------------------
  // Signing in. Every route here is reachable without a session by definition —
  // it is how a session is obtained.
  // -------------------------------------------------------------------------
  {
    route: '/api/auth/register',
    summary: 'Creates an account and its seat. Open only while the organization has no owner.',
    allow: { POST: ANYONE },
  },
  {
    route: '/api/auth/login',
    summary: 'Email and password in, session cookie out.',
    allow: { POST: ANYONE },
  },
  {
    route: '/api/auth/logout',
    summary: 'Ends this session. Leaves other devices alone.',
    // Public is allowed so that clicking sign-out twice, or with an already-dead
    // cookie, clears the cookie and says so rather than answering 401 to someone
    // who is trying to sign *out*.
    allow: { POST: ANYONE },
  },
  {
    route: '/api/auth/session',
    summary: 'Who this request is. Answers `null` rather than 401 when there is no session.',
    allow: { GET: ANYONE },
  },
  {
    route: '/api/auth/sessions',
    summary: 'This account’s sessions, and "sign out all devices".',
    allow: { GET: EVERY_SEAT, DELETE: EVERY_SEAT },
  },
  {
    route: '/api/auth/magic-link',
    summary: 'Mails a 15-minute single-use sign-in link.',
    allow: { POST: ANYONE },
  },
  {
    route: '/api/auth/magic-link/consume',
    summary: 'Spends a mailed sign-in link and redirects to the report.',
    allow: { GET: ANYONE },
  },
  {
    route: '/api/auth/password-reset',
    summary: 'Mails a 1-hour single-use password-reset link.',
    allow: { POST: ANYONE },
  },
  {
    route: '/api/auth/password-reset/consume',
    summary: 'Spends a reset link and sets the new password.',
    allow: { POST: ANYONE },
  },

  // -------------------------------------------------------------------------
  // Seats. Owner-facing, with one read an owner is not the only one who needs.
  // -------------------------------------------------------------------------
  {
    route: '/api/seats',
    summary: 'The seat list, and inviting a new one.',
    allow: { GET: ['owner', 'manager'], POST: ['owner'] },
  },
  {
    route: '/api/seats/[membershipId]',
    summary: 'One seat: read it, change its role and team scopes, remove it.',
    allow: { GET: ['owner', 'manager'], PATCH: ['owner'], DELETE: ['owner'] },
  },
  {
    route: '/api/seats/[membershipId]/invite',
    summary: 'Resends a pending invitation, revoking the previous token.',
    allow: { POST: ['owner'] },
  },
  {
    route: '/api/seats/accept',
    summary: 'Accepts an invitation: sets a name and a password, activates the seat.',
    allow: { POST: ANYONE },
  },

  // -------------------------------------------------------------------------
  // The goal hierarchy every alignment verdict resolves against.
  // -------------------------------------------------------------------------
  {
    route: '/api/goals',
    summary: 'The goal hierarchy at an instant, and creating a goal.',
    allow: { GET: ANYONE, POST: ['owner', 'manager'] },
    demoOnlyPublic: true,
  },
  {
    route: '/api/goals/[nodeId]',
    summary: "One goal's full revision history; edit and archive both append.",
    allow: { GET: ANYONE, PATCH: ['owner', 'manager'], DELETE: ['owner', 'manager'] },
    demoOnlyPublic: true,
  },

  // -------------------------------------------------------------------------
  // Configuration and the identity roster.
  //
  // Owner *and* manager throughout, which is a deliberate widening: team scoping is the
  // basis of every aggregate and a bad identity merge corrupts attribution in every
  // downstream report, so the person who reads the report has to be able to fix the
  // configuration behind it. Routing that through an owner would mean a manager who spots
  // a wrong attribution files a request instead of correcting it, and the wrong name stays
  // in tomorrow's report. Every write is audited with the actor either way.
  //
  // Members and viewers are refused: reading a report does not make somebody an editor of
  // the roster it is computed from.
  // -------------------------------------------------------------------------
  {
    route: '/api/roster',
    summary: 'The whole configuration: teams, membership, calendars, tracked sources, people, identities, absences.',
    allow: { GET: ['owner', 'manager'] },
  },
  {
    route: '/api/roster/teams',
    summary: 'Create or edit a team, change who is on it, set its working calendar.',
    allow: { POST: ['owner', 'manager'], PATCH: ['owner', 'manager'], PUT: ['owner', 'manager'] },
  },
  {
    route: '/api/roster/sources',
    summary: 'Track or archive a repository or a project. Archiving keeps every prior row.',
    allow: { PATCH: ['owner', 'manager'] },
  },
  {
    route: '/api/roster/identities',
    summary: 'Link an identifier to a person, or unlink it so its artifacts revert to unattributed.',
    allow: { POST: ['owner', 'manager'], DELETE: ['owner', 'manager'] },
  },
  {
    route: '/api/roster/merges',
    summary: 'Merge an unmatched identity into a person, and undo a merge exactly.',
    allow: { POST: ['owner', 'manager'], DELETE: ['owner', 'manager'] },
  },
  {
    route: '/api/roster/absences',
    summary: 'Mark somebody out for a date range, or end an absence early. The sole write path.',
    allow: { POST: ['owner', 'manager'], PATCH: ['owner', 'manager'] },
  },

  // -------------------------------------------------------------------------
  // The audit trail. Owner only, and append-only underneath.
  // -------------------------------------------------------------------------
  {
    route: '/api/audit',
    summary: 'Privileged and destructive acts, with actor, target and before/after.',
    allow: { GET: ['owner'] },
  },

  // -------------------------------------------------------------------------
  // The rendered screens.
  //
  // Listed in the same table as the endpoints so a page and the endpoint behind it
  // cannot disagree about who may read it — which is how a "private" screen ends up
  // rendering data its API refuses.
  // -------------------------------------------------------------------------
  {
    route: '/goals',
    summary: 'The goal hierarchy screen — the chain alignment verdicts resolve against.',
    allow: { GET: ANYONE },
    demoOnlyPublic: true,
  },
  {
    route: '/account',
    summary: 'Sign in, request a link, ask for a reset — or, with a session, this account.',
    allow: { GET: ANYONE },
  },
  {
    route: '/account/invite',
    summary: 'Accept an invitation: choose a name and a password.',
    allow: { GET: ANYONE },
  },
  {
    route: '/account/reset',
    summary: 'Set a new password from a reset link.',
    allow: { GET: ANYONE },
  },
  {
    route: '/seats',
    summary: 'Seat management. Owners change things here; managers read who is on the team.',
    allow: { GET: ['owner', 'manager'] },
  },
  {
    route: '/roster',
    summary: 'Configuration: teams, tracked repositories and projects, the identity roster and absences.',
    allow: { GET: ['owner', 'manager'] },
  },
];

const BY_ROUTE: ReadonlyMap<string, RouteRule> = new Map(ROLE_MATRIX.map((rule) => [rule.route, rule]));

/** Every route the matrix covers, sorted — what the coverage test diffs against. */
export const MATRIX_ROUTES: readonly string[] = ROLE_MATRIX.map((rule) => rule.route).sort();

export const findRouteRule = (route: string): RouteRule | null => BY_ROUTE.get(route) ?? null;

/** True when a route names `public` for any action. */
export const isPublicRoute = (rule: RouteRule): boolean =>
  Object.values(rule.allow).some((principals) => principals?.includes('public') === true);

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Why a request was refused.
 *
 *  - `no_such_route` — the matrix has no entry. Refused, never defaulted open.
 *  - `method_not_allowed` — the route exists but does not serve this verb.
 *  - `authentication_required` — the action needs a seat and there is no session.
 *  - `role_not_permitted` — there is a seat, and this role may not do this.
 *  - `seat_not_active` — a pending or revoked seat.
 *  - `team_out_of_scope` — the role is allowed the route, but not this team.
 */
export type DenialReason =
  | 'no_such_route'
  | 'method_not_allowed'
  | 'authentication_required'
  | 'role_not_permitted'
  | 'seat_not_active'
  | 'team_out_of_scope';

export interface AuthorizeRequest {
  readonly route: string;
  readonly action: Action;
  readonly principal: Principal;
  /** True when the seat is `active`. Ignored for the `public` principal. */
  readonly seatActive?: boolean;
  /** The team the request is about, for a `teamScoped` route. */
  readonly teamKey?: string | null;
  /**
   * The teams this principal may read. An empty list means no scope row was
   * written, which for a non-owner is a denial rather than a wildcard.
   */
  readonly teamScopes?: readonly string[];
  /** True when the organization being read is the seeded demonstration tenant. */
  readonly demoOrganization?: boolean;
}

export type AuthorizeDecision =
  | { readonly allowed: true; readonly rule: RouteRule }
  | { readonly allowed: false; readonly reason: DenialReason; readonly rule: RouteRule | null };

/**
 * Whether every role in the org is allowed a team it has no scope row for.
 *
 * Owners are unscoped: an owner of a three-team organization who was accidentally
 * scoped to zero teams would be locked out of their own product, and an owner can
 * change the scopes anyway, so restricting them would be theatre. Every other role
 * needs the row — a manager whose scopes were never set reads nothing rather than
 * everything, which is the safe direction for the failure to fall.
 */
export const roleIsTeamUnscoped = (principal: Principal): boolean => principal === 'owner';

export function teamScopeAllows(
  principal: Principal,
  teamKey: string | null | undefined,
  teamScopes: readonly string[],
): boolean {
  if (roleIsTeamUnscoped(principal)) return true;
  // A team-scoped route reached without naming a team is answering about "whatever
  // this principal can see", which the caller resolves from the scopes themselves.
  if (teamKey === null || teamKey === undefined || teamKey.length === 0) return teamScopes.length > 0;
  return teamScopes.includes(teamKey);
}

/**
 * The single access decision in Compass.
 *
 * Deny is the default at every step: an unknown route, an undeclared verb and an
 * unlisted principal all refuse. Nothing here reads a request, a cookie, a clock or
 * a database — it is a function of the matrix and five facts, which is what lets the
 * parametrized (role × route × action) test call it directly.
 */
export function authorize(request: AuthorizeRequest): AuthorizeDecision {
  const rule = findRouteRule(request.route);
  if (rule === null) return { allowed: false, reason: 'no_such_route', rule: null };

  const permitted = rule.allow[request.action];
  if (permitted === undefined || permitted.length === 0) {
    return { allowed: false, reason: 'method_not_allowed', rule };
  }

  if (request.principal === 'public') {
    if (!permitted.includes('public')) {
      return { allowed: false, reason: 'authentication_required', rule };
    }
    // Public access to org data exists for the demonstration tenant only.
    if (rule.demoOnlyPublic === true && request.demoOrganization !== true) {
      return { allowed: false, reason: 'authentication_required', rule };
    }
    if (rule.teamScoped === true) {
      // The demo tenant's public reader is not scoped to a team, so a team-scoped
      // public read is allowed for whichever team the demo org is serving. The
      // caller resolves that team; it is not taken from the URL unchecked.
      return { allowed: true, rule };
    }
    return { allowed: true, rule };
  }

  if (!permitted.includes(request.principal)) {
    return { allowed: false, reason: 'role_not_permitted', rule };
  }

  if (request.seatActive === false) {
    return { allowed: false, reason: 'seat_not_active', rule };
  }

  if (rule.teamScoped === true && !teamScopeAllows(request.principal, request.teamKey, request.teamScopes ?? [])) {
    return { allowed: false, reason: 'team_out_of_scope', rule };
  }

  return { allowed: true, rule };
}

/** The HTTP status a denial becomes. 404 is never used to hide a 403. */
export const STATUS_FOR_DENIAL: Readonly<Record<DenialReason, number>> = {
  no_such_route: 404,
  method_not_allowed: 405,
  authentication_required: 401,
  role_not_permitted: 403,
  seat_not_active: 403,
  team_out_of_scope: 403,
};

/**
 * The sentence a refused request carries.
 *
 * Each one says what was refused and what would change it. None of them leaks
 * whether the other team's report exists — "not in your scope" is true whether or
 * not team B has ever generated one.
 */
export function describeDenial(reason: DenialReason, detail: { readonly teamKey?: string | null } = {}): string {
  switch (reason) {
    case 'no_such_route':
      return 'No such route.';
    case 'method_not_allowed':
      return 'This route does not serve that method.';
    case 'authentication_required':
      return 'Sign in to read this. Reports contain the organization’s own data, so they are not public outside the demonstration tenant.';
    case 'role_not_permitted':
      return 'Your role does not permit this. An owner of the organization can change it on the seats screen.';
    case 'seat_not_active':
      return 'Your seat is not active yet. Accept the invitation you were sent, or ask an owner to send another.';
    case 'team_out_of_scope':
      return detail.teamKey === undefined || detail.teamKey === null || detail.teamKey.length === 0
        ? 'You are not scoped to any team, so there is no report to show you. An owner can add a team to your seat.'
        : `You are not scoped to team \`${detail.teamKey}\`. An owner can add it to your seat.`;
  }
}
