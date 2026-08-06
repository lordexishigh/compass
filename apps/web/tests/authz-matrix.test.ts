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

import { allRoutesOnDisk, apiRoutesOnDisk, pageRoutesOnDisk } from './helpers/routes';

/**
 * The role matrix, held to the acceptance criteria.
 *
 * Four separate claims are proved here and they are separate on purpose:
 *
 *  1. **Every (role × route × action) triple decides the way it is meant to.** The
 *     expectation is written out below as a second, independent statement of the intent, so
 *     a careless edit to `ROLE_MATRIX` fails rather than redefining the intent along with
 *     the table.
 *  2. **Every route on disk has an entry** — endpoints *and* rendered screens. Enumerated
 *     from the filesystem, so a new `route.ts` or `page.tsx` is a build failure until it
 *     declares who may call it.
 *  3. **`public` is only ever explicit.** The documented set of public routes is asserted to
 *     be exactly what the matrix says, so public access can never be inferred, defaulted or
 *     acquired by a route that forgot to say otherwise.
 *  4. **Deny is the default at every step** — unknown route, undeclared verb, unlisted
 *     principal, inactive seat, wrong team.
 *
 * ## Why the enumeration moved out of this file
 *
 * `tests/helpers/routes.ts` owns the walk now, because `two-org-isolation.test.ts` needs the
 * same list and a second copy would drift silently — both suites would keep passing while one
 * stopped covering a directory. Moving it also fixed a real gap: the walk here only ever
 * looked under `app/api`, so `/artifact/[kind]/[artifactId]` had served one organization's
 * commits and tickets with no matrix entry at all, and no test could see it.
 */

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
  /**
   * The second factor. `public` on the challenge is the point, not an oversight: the caller has proved
   * a password and been given no session, so requiring one here would be circular. Management needs a
   * seat, and additionally a credential in the body that this table cannot express.
   */
  '/api/auth/2fa/challenge': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/2fa': {
    POST: ['owner', 'manager', 'member', 'viewer'],
    PUT: ['owner', 'manager', 'member', 'viewer'],
    DELETE: ['owner', 'manager', 'member', 'viewer'],
  },
  '/api/auth/2fa/recovery-codes': { POST: ['owner', 'manager', 'member', 'viewer'] },
  /**
   * Single sign-on, restated as intent.
   *
   * `public` on the start *and* the callback. The start grants nothing — no session, no row, one
   * short-lived nonce cookie — and is also how a signed-in person begins a *link*, so a session is
   * optional rather than forbidden. The callback arrives as a top-level navigation from the provider
   * with no cookie it could send, so requiring one would be circular; what authorises it is an
   * HMAC-signed `state` naming the one organization the identity may attach to, plus a nonce cookie
   * binding it to the browser that started the flow.
   *
   * Unlinking needs a seat *and* the current password — the second half is not expressible here and is
   * asserted in `tests/sso-routes.test.ts`.
   */
  '/api/auth/sso/[provider]': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/sso/[provider]/callback': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/sso/unlink': { POST: ['owner', 'manager', 'member', 'viewer'] },
  /**
   * SAML. Both rows `public`, and both for reasons narrower than they look.
   *
   * Metadata is fetched by identity providers from their own infrastructure and pasted into consoles by
   * administrators who have no Compass account yet; it carries an entity id, an ACS URL and two flags,
   * with no organizational data and no credential. The ACS is a form POST from the user's browser
   * redirected there by the provider, and what admits it is a signature over the assertion, an issuer
   * match, an audience match, a validity window and a one-shot replay claim — a bar an authenticated
   * manager cannot clear.
   */
  '/api/auth/saml/metadata': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/auth/saml/acs': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
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
   * Privacy, restated as intent.
   *
   * The line worth stating is where it falls. Anything that decides what Compass *keeps or
   * sends* is owner-only — the retention windows, the narration mode, the whole-organization
   * export. The two acts a manager gets are the two about the team in front of them:
   * withdrawing a departed colleague's name from tomorrow's report, and turning a channel's
   * ingestion on or off. A manager who had to file a request for either would leave the wrong
   * name in the report, or a team unread, for as long as the request sat.
   *
   * `/api/privacy/deletion` is `EVERY_SEAT` and that is not a widening: the *subject* is never
   * read from the body, so a seat can only ever delete their own account, and the handler
   * refuses `subjectKind: 'organization'` to anyone but an owner. `feedback-routes`-style
   * handler-level checks are asserted in `privacy.test.ts`, not here — this table is only
   * about who may reach the route at all.
   *
   * `/api/privacy/deletion/undo` is `public` for the same reason the feedback link is: it
   * arrives from a mail client with no cookies, and it has to work when the account holder
   * cannot sign in — which a pending deletion may be exactly why they cannot.
   */
  '/api/privacy/settings': { PATCH: ['owner'] },
  '/api/privacy/anonymize': { POST: ['owner', 'manager'], DELETE: ['owner', 'manager'] },
  '/api/privacy/channels': { PATCH: ['owner', 'manager'] },
  '/api/privacy/deletion': { POST: ['owner', 'manager', 'member', 'viewer'] },
  '/api/privacy/deletion/undo': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/privacy/export': { GET: ['owner'] },

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
   * Inbound provider webhooks, and why `public` here is the narrowest entry in this table rather
   * than the widest.
   *
   * A delivery arrives from GitHub's or Jira's own infrastructure with no cookie it could send, so a
   * session requirement would mean the feature cannot exist. What admits it instead is an HMAC over
   * the raw bytes under a secret only Compass and the provider hold, compared in constant time,
   * inside a five-minute window — a bar an authenticated *manager* cannot clear. `POST` only: there
   * is nothing to GET here, and the matrix refusing the other four verbs is what makes that
   * structural rather than a property of the handler.
   */
  '/api/webhooks/[provider]': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },

  /**
   * Connecting a data source: owner only, except the cookie-less OAuth return.
   *
   * Reading `/connect` is owner-only as well as writing it, because the page states which sources are
   * connected and when — the shape of the organization's integrations, which is not a manager's concern.
   *
   * One dynamic route serves all three providers, because the handler's logic is identical for all three
   * and every difference between them is configuration. A route per provider is how the fourth one ends up
   * with a subtly different state lifetime, or quietly stops checking the role.
   *
   * `/api/connect/[provider]/callback` names `public` for exactly the reason `/api/webhooks/[provider]` and
   * `/api/stripe/webhook` do: it is a top-level navigation from the provider with no cookie it could send,
   * and what authorises it is narrower than a session — an HMAC-signed `state` this deployment minted,
   * naming the one organization the credential may be stored against *and the one provider flow it belongs
   * to*, inside a ten-minute window and refused entirely when no state secret is set.
   */
  /**
   * The published legal and trust documents, public in every tenant.
   *
   * Same reasoning as `/pricing`: the content is a typed module with no organizational data in it, so a
   * session requirement would make a privacy policy unreadable by the people it is published for. The
   * subscribe endpoint is public for the sharper version of the same argument — the person who most
   * needs 30 days' notice before the subprocessor list changes is a DPO evaluating Compass, who has no
   * account.
   */
  '/legal': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/legal/[slug]': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/trust/subprocessors': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/trust/subprocessor-notices': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/api/trust/subprocessor-notices/confirm': {
    GET: ['public', 'owner', 'manager', 'member', 'viewer'],
  },

  '/connect': { GET: ['owner'] },
  '/api/connect/[provider]/install': { POST: ['owner'] },
  '/api/connect/[provider]/disconnect': { POST: ['owner'] },
  // Per-repository, per-project and per-channel scoping. Owner only for the same reason the install is:
  // widening what Compass reads is exactly as consequential as connecting in the first place.
  '/api/connect/[provider]/scope': { POST: ['owner'] },
  '/api/connect/[provider]/callback': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },

  /**
   * Billing: every write is the owner's, and `/pricing` is the one page public in *every* tenant.
   *
   * Restated here as intent rather than copied as fact. The owner-only line is deliberate and is not
   * the same judgement the roster makes: a plan change moves money, and a *downgrade* decides which
   * colleagues lose access — that is the owner's call by definition, and a manager who could make it
   * could remove seats they do not administer. Reading `/billing` is owner-only too, because the page
   * names an amount, a payment state and an invoice history, none of which is part of a manager's job.
   *
   * `/pricing` carries no organizational data at all — it reads the plan table out of
   * `@compass/billing` and nothing else — so it is public without `demoOnlyPublic`, which exists to
   * confine a public read *of tenant data* to the demonstration org. A pricing page that needed a
   * session would be one nobody could read before signing up.
   *
   * `/api/stripe/webhook` names `public` for exactly the reason `/api/webhooks/[provider]` does: a
   * webhook arrives from Stripe's infrastructure with no cookie it could send, and what authorises it
   * is strictly narrower than a session — an HMAC over the raw bytes inside a five-minute window,
   * refused entirely when no signing secret is set.
   */
  '/pricing': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  '/billing': { GET: ['owner'] },
  '/api/billing/checkout': { POST: ['owner'] },
  '/api/billing/plan': { POST: ['owner'] },
  '/api/billing/cancel': { POST: ['owner'] },
  '/api/stripe/webhook': { POST: ['public', 'owner', 'manager', 'member', 'viewer'] },

  /**
   * Enterprise identity, restated as intent.
   *
   * Owner only on both, and deliberately not a manager: configuring an identity provider decides who can
   * become a member of this organization, and issuing a SCIM token hands a machine the power to create
   * and remove seats. The *plan* gate is not in this table — reading the screen that explains what the
   * Business plan would give you must not require the Business plan.
   *
   * The SCIM rows are `public` on every verb they serve, and that is among the narrowest entries here
   * rather than the widest: a SCIM client is an IdP's backend service with no browser and no cookie, and
   * what admits it is a 256-bit bearer token compared by digest in constant time plus the plan gate.
   * `PUT` and `PATCH` are both declared because providers disagree about which verb a deprovision is,
   * and a verb absent from the map is served to nobody.
   */
  '/enterprise': { GET: ['owner'] },
  '/api/enterprise/identity': { POST: ['owner'], DELETE: ['owner'] },
  '/api/scim/v2/Users': {
    GET: ['public', 'owner', 'manager', 'member', 'viewer'],
    POST: ['public', 'owner', 'manager', 'member', 'viewer'],
  },
  '/api/scim/v2/Users/[scimUserId]': {
    GET: ['public', 'owner', 'manager', 'member', 'viewer'],
    PATCH: ['public', 'owner', 'manager', 'member', 'viewer'],
    PUT: ['public', 'owner', 'manager', 'member', 'viewer'],
    DELETE: ['public', 'owner', 'manager', 'member', 'viewer'],
  },

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

  /**
   * The two privacy screens, and the undo landing page.
   *
   * `/privacy` is owner and manager, matching the two routes a manager may call: a manager who
   * can turn a channel off but cannot see which channels are on is being asked to administer
   * something they cannot read.
   *
   * `/me` is every seat and *not* `public`. The answer is computed from the reader's own
   * session, so there is no question an anonymous reader could be asking — and the criterion
   * that matters is the other one: no manager approval and no admin action, which is satisfied
   * by every seat being on this row.
   *
   * `/account/deletion` is `ANYONE` and carries no `demoOnlyPublic`, because it holds no
   * organization data at all: it reads a token from the query string, posts it, and prints the
   * outcome.
   */
  '/privacy': { GET: ['owner', 'manager'] },
  '/me': { GET: ['owner', 'manager', 'member', 'viewer'] },
  '/account/deletion': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },

  '/goals': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
  /**
   * The evidence page, on the same terms as the report the claim is in.
   *
   * This row was **absent** until the enumeration above began walking page routes as well as
   * endpoints: a screen rendering one organization's commits, pull requests and tickets had no entry
   * in the matrix and nothing decided who could read it. Restated here as intent rather than copied
   * as fact — a receipt is only useful if the reader of the claim can open it, so it gets the posture
   * of the report, not a stricter or looser one of its own.
   */
  '/artifact/[kind]/[artifactId]': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
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
  '/settings/members': { GET: ['owner', 'manager'] },
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
  // Two stored reports side by side. Renders rows and never regenerates, so it grants nothing
  // `/archive/[reportId]` does not already grant twice.
  '/archive/diff': { GET: ['public', 'owner', 'manager', 'member', 'viewer'] },
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

describe('every route has an entry in the matrix', () => {
  it('finds the routes on disk at all, so an empty walk cannot pass this file', () => {
    const routes = apiRoutesOnDisk();

    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain('/api/auth/login');
    // The dynamic-segment spelling has to match the matrix's, or the diff below would
    // fail for a reason that has nothing to do with access.
    expect(routes).toContain('/api/goals/[nodeId]');
  });

  it('finds the rendered screens too, which is where a route once hid', () => {
    const pages = pageRoutesOnDisk();

    // `/` is the report, and its presence here is what proves the page walk reaches the root
    // `page.tsx` rather than only nested ones.
    expect(pages).toContain('/');
    expect(pages).toContain('/account');
    // The route that had no matrix entry until this walk existed.
    expect(pages).toContain('/artifact/[kind]/[artifactId]');
    expect(pages.length).toBeGreaterThan(5);
  });

  it('has no route on disk that the matrix does not describe — endpoint or screen', () => {
    /**
     * The acceptance criterion, and now over the whole surface.
     *
     * A `page.tsx` renders organization data exactly as an endpoint returns it, so a screen with no
     * entry here is the same hole as an endpoint with none. This assertion covering only `app/api`
     * is how `/artifact/[kind]/[artifactId]` shipped unlisted.
     */
    const undeclared = allRoutesOnDisk().filter((route) => findRouteRule(route) === null);

    expect(
      undeclared,
      'these routes serve requests with no entry in ROLE_MATRIX, so nothing decides who may call them',
    ).toEqual([]);
  });

  it('has no entry in the matrix that no route serves', () => {
    // The other direction. A stale entry is not a security hole, but it is a lie about
    // the product's surface, and it makes the matrix untrustworthy to read.
    const onDisk = new Set(allRoutesOnDisk());
    const stale = MATRIX_ROUTES.filter((route) => !onDisk.has(route));

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
      '/archive/diff',
      '/archive/merged/[reportDate]',
      // The receipt behind a claim, on the same terms as the claim.
      '/artifact/[kind]/[artifactId]',
      '/goals',
      '/merged',
      '/weekly',
    ]);
  });

  /**
   * `public` may only ever be an explicit entry, and the set of them is exactly this.
   *
   * The acceptance criterion is "a route may be marked public only via the explicit public entry,
   * and a test asserts exactly the documented set of public routes exists". Both halves are here:
   *
   *  - **Exactly this set.** Enumerated below, so widening the public surface is an edit to this
   *     list that a reviewer reads, rather than one word added to a row nobody diffs.
   *  - **Only explicitly.** `authorize` reaches `public` through one branch — `permitted.includes`
   *    on the row's own `allow` map — so there is no default, no wildcard and no inference. The
   *    assertion below that every unlisted route refuses an anonymous caller is the behavioural
   *    proof of that.
   *
   * `docs/ENGINEERING.md` lists the same set in prose, and
   * `tools/quality-gates/tests/security-posture.test.ts` diffs the two.
   */
  it('has exactly the documented set of routes that name `public` at all', () => {
    const publicRoutes = ROLE_MATRIX.filter(isPublicRoute).map((rule) => rule.route).sort();

    expect(publicRoutes).toEqual([
      // The report and its receipts, world-readable on the demonstration tenant only.
      '/',
      '/archive',
      '/archive/[reportId]',
      '/archive/diff',
      '/archive/merged/[reportDate]',
      '/artifact/[kind]/[artifactId]',
      '/goals',
      '/merged',
      '/weekly',
      '/api/goals',
      '/api/goals/[nodeId]',
      '/api/reports/[teamKey]',
      // How a session is obtained. Public by definition: requiring one would be circular.
      '/account',
      '/account/deletion',
      '/account/invite',
      '/account/reset',
      // The code step of a two-factor sign-in. Reached with no session by construction — the password
      // step deliberately mints none — and authorised by a signed challenge plus a valid code.
      '/api/auth/2fa/challenge',
      // Single sign-on. The start grants nothing and the callback arrives from the provider with no
      // cookie; both are authorised by a signed `state` plus a nonce cookie rather than by a session.
      '/api/auth/sso/[provider]',
      '/api/auth/sso/[provider]/callback',
      // SAML. Metadata is a document with no tenant data in it; the ACS is admitted by a signed,
      // audience-bound, single-use assertion, which is narrower than a session rather than weaker.
      '/api/auth/saml/metadata',
      '/api/auth/saml/acs',
      // SCIM. An identity provider's backend service, admitted by a bearer token an owner issued and
      // can revoke, plus the Business-plan gate.
      '/api/scim/v2/Users',
      '/api/scim/v2/Users/[scimUserId]',
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/magic-link',
      '/api/auth/magic-link/consume',
      '/api/auth/password-reset',
      '/api/auth/password-reset/consume',
      '/api/auth/register',
      '/api/auth/session',
      '/api/seats/accept',
      '/login',
      // The container's own probe. Public in every tenant, and carries no organization data.
      '/api/health',
      // Token-authorised, and each token is narrower than a session: one unsubscribe, one shared
      // report, one verdict on one item, one deletion to undo, one signed provider delivery.
      '/api/delivery/unsubscribe',
      '/api/privacy/deletion/undo',
      '/api/feedback/app',
      '/api/feedback/link/[token]',
      '/api/share/[token]',
      '/api/slack/actions',
      '/api/webhooks/[provider]',
      // Signature-authorised, like the three provider webhooks above and for the same reason.
      '/api/stripe/webhook',
      // The OAuth install return, for all three providers. Cookie-less by nature — a top-level
      // navigation from the provider — and authorised by an HMAC-signed `state` naming the one
      // organization it may store against and the one flow it belongs to, which is narrower than a
      // session rather than weaker than one.
      '/api/connect/[provider]/callback',
      // The public pricing page. Unlike every other entry in this list it is public in a *real*
      // tenant too, because it reads the plan table and nothing about the organization.
      '/pricing',
      // The published legal and trust documents, public in every tenant for the same reason: the
      // content is a typed module and carries no organizational data. The subscribe endpoint is the
      // one public *write*, and it writes one email address behind an emailed confirmation.
      '/legal',
      '/legal/[slug]',
      '/trust/subprocessors',
      '/api/trust/subprocessor-notices',
      '/api/trust/subprocessor-notices/confirm',
    ].sort());
  });

  it('refuses an anonymous caller every route that is not in that set', () => {
    // The behavioural half: `public` is never inferred, so a route that does not name it refuses.
    const publicRoutes = new Set(ROLE_MATRIX.filter(isPublicRoute).map((rule) => rule.route));

    for (const rule of ROLE_MATRIX) {
      if (publicRoutes.has(rule.route)) continue;

      for (const action of ACTIONS) {
        if ((rule.allow[action]?.length ?? 0) === 0) continue;
        const decision = authorize({
          route: rule.route,
          action,
          principal: 'public',
          demoOrganization: true,
        });
        expect(decision.allowed, `${action} ${rule.route} admitted an anonymous caller`).toBe(false);
      }
    }
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

/**
 * Addresses this app used to serve.
 *
 * A route that moves has two failure modes and this covers both. The first is a dead link:
 * `/seats` is in every invitation Compass has ever sent, so it has to keep landing
 * somewhere. The second is subtler — a redirect left pointing at a route that has itself
 * been renamed again sends people to a 404 with no error anywhere, so the destination is
 * checked against `ROLE_MATRIX` rather than spelled out twice.
 */
describe('the routes that moved still land', () => {
  it('redirects /seats to the members screen, permanently', async () => {
    const config = (await import('../next.config')).default;

    expect(typeof config.redirects, 'next.config.ts declares no redirects at all').toBe('function');
    const declared = await config.redirects!();

    const moved = declared.find((entry) => entry.source === '/seats');
    expect(moved, '/seats is in sent invitations and must not 404').toBeDefined();
    expect(moved?.destination).toBe('/settings/members');
    expect(moved?.permanent, 'the move is not coming back, so a 308 is the honest status').toBe(true);
  });

  it('points every redirect at a route the matrix actually authorizes', async () => {
    const config = (await import('../next.config')).default;
    const declared = await config.redirects!();

    for (const entry of declared) {
      expect(
        findRouteRule(entry.destination),
        `${entry.source} redirects to ${entry.destination}, which has no ROLE_MATRIX entry`,
      ).toBeDefined();
    }
  });

  it('leaves no page on disk at an address it also redirects away from', async () => {
    // A `page.tsx` wins over a redirect in Next, so the two together would be a redirect
    // that silently does nothing — and a second screen to keep in step with the first.
    const config = (await import('../next.config')).default;
    const declared = await config.redirects!();
    const pages = new Set(pageRoutesOnDisk());

    for (const entry of declared) {
      expect(pages.has(entry.source), `${entry.source} is both a redirect source and a page`).toBe(false);
    }
  });
});
