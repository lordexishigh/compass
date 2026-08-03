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
  /**
   * The short sign-in address, published to a verification harness.
   *
   * `POST /login` is the same sign-in as `POST /api/auth/login` — one implementation in
   * `lib/auth/login.ts` — reached by the address written into `.nous/demo_account.json`.
   * `GET` is a 303 to `/account`, so a person who types it in a browser lands on the screen
   * that has the form and the demonstration credentials on it.
   *
   * `ANYONE` on both verbs, for the same reason every row in this block is: it is how a
   * session is obtained, so requiring one would be circular. It carries no `demoOnlyPublic`
   * flag because it discloses nothing about the tenant either way — a wrong address and a
   * wrong password get one 401 and one sentence.
   */
  {
    route: '/login',
    summary: 'The short sign-in address: POST credentials, or GET to reach the form.',
    allow: { GET: ANYONE, POST: ANYONE },
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
  // Delivery and share links.
  //
  // Both are `public` in the matrix, and in both cases what authorises the request is a token
  // rather than a session — which is the only workable answer for each:
  //
  //  - a one-click unsubscribe arrives from a *mail client*, which has no cookies, and RFC 8058
  //    requires it to be a POST so that a link scanner cannot unsubscribe somebody by previewing
  //    the message;
  //  - a share link is meant to be openable by a colleague who was sent an address.
  //
  // Neither is a hole. The unsubscribe token can only switch off one person's daily, reversibly.
  // The share route enforces its own audience rule — `org_members` by default — so a `public`
  // matrix entry still refuses an anonymous reader unless the link was deliberately made public,
  // and every attempt is written to `share_link_access` either way.
  // -------------------------------------------------------------------------
  {
    route: '/api/delivery/unsubscribe',
    summary: 'RFC 8058 one-click unsubscribe. Token-authorised, idempotent, POST only.',
    allow: { POST: ANYONE },
  },
  {
    route: '/api/share/[token]',
    summary: 'A shared report permalink. Org-members-only by default; every access is logged.',
    allow: { GET: ANYONE },
  },

  // -------------------------------------------------------------------------
  // Feedback: the manager's verdict on a finding, from three channels.
  //
  // `/api/feedback` is the web view's own POST and requires a seat that may act — a viewer
  // reads the report and does not get to change what tomorrow's says. The other two are
  // `ANYONE` at the matrix level and authorised *inside* the handler by something stronger
  // than a session: a signed single-purpose token in the mail case, and Slack's v0 signature
  // plus a stored (slack user → seat) mapping in the Slack case. Both arrive from clients that
  // have no cookies to send, so requiring a session here would mean the feature could not
  // exist; both are narrower than a session once admitted, because a feedback token authorises
  // exactly one action on exactly one item and nothing else.
  /**
   * One path, two very different things, and the asymmetry is worth stating rather than tidying.
   *
   * `POST` is a manager's verdict on a finding — the report page's own buttons. `GET` is the list of
   * submissions about **Compass itself** (`app_feedback`), and it is owner-only: those messages are
   * other people's words about the product, sometimes naming a person or a customer, and a manager
   * of one team has no business reading the org's support inbox. Owner is also the role that is
   * team-unscoped, so the `teamScoped` flag below — which exists for the POST — cannot accidentally
   * refuse the read.
   *
   * The submission itself is `POST /api/feedback/app`, a separate route, because `POST` here is
   * already taken by the verdict and one verb on one path cannot mean two things without the
   * handler guessing from the body which was meant.
   */
  {
    route: '/api/feedback',
    summary:
      "GET: every submission about Compass itself, newest first, owner only. POST: a manager's verdict on one finding.",
    allow: { GET: ['owner'], POST: ['owner', 'manager'] },
    teamScoped: true,
  },
  /**
   * The in-app feedback control's own endpoint.
   *
   * `ANYONE`, with `demoOnlyPublic`, which is the same posture as `/` and for the same reason: the
   * seeded demonstration report is readable with no session, so the reader who most needs to say
   * "this page is confusing" is the one who has not signed up yet. Refusing them would mean the
   * feature does not exist on the surface it is most needed. On a real tenant it closes along with
   * everything else marked demo-only, and a seat is then required.
   *
   * It is not a hole. The route accepts one field, writes one row to a table nothing in the pipeline
   * reads, and returns no organization data of any kind — so the worst a stranger can do with it is
   * tell us something.
   */
  {
    route: '/api/feedback/app',
    summary: 'Submits one message about Compass itself. Writes a row nothing in the pipeline reads.',
    allow: { POST: ANYONE },
    demoOnlyPublic: true,
  },
  {
    route: '/api/feedback/link/[token]',
    summary: 'Spends a signed, single-purpose feedback link from an email. Never starts a session.',
    allow: { GET: ANYONE, POST: ANYONE },
  },
  {
    route: '/api/slack/actions',
    summary: 'Slack Block Kit interactions. Verified by v0 signature, then mapped to a seat.',
    allow: { POST: ANYONE },
  },

  /**
   * Inbound provider webhooks: GitHub, Slack and Jira, on one route.
   *
   * `ANYONE`, and it is the clearest case in the table of why that word does not mean "open". A
   * webhook arrives from a provider's own infrastructure with no cookie it could possibly send, so a
   * session requirement here would mean the feature cannot exist. What authorises it instead is
   * strictly *narrower* than a session: an HMAC over the raw bytes under a secret only Compass and
   * the provider hold, compared in constant time, inside a five-minute replay window for the two
   * schemes that carry a timestamp. A caller without the secret is refused 401 before the body is
   * parsed.
   *
   * No `demoOnlyPublic`, unlike `/api/feedback/app`: the flag confines a *public read of tenant
   * data* to the demonstration tenant, and this route reads nothing and returns nothing about the
   * organization. It answers "accepted" or "not verified", and a verified delivery is only ever an
   * acknowledgement — Compass reads its sources by pulling a window on a schedule, so a webhook is
   * a hint and never a record.
   */
  {
    route: '/api/webhooks/[provider]',
    summary: 'Inbound GitHub, Slack and Jira webhooks. Signature-verified before the body is parsed.',
    allow: { POST: ANYONE },
  },

  /**
   * The simulated-clock time-travel control.
   *
   * Owner and manager, and team-scoped, because it *writes*: stepping to a day nobody has generated
   * runs the whole pipeline for that instant and persists the report. A viewer reads the archive; they
   * do not get to add rows to it.
   *
   * The matrix is only half the gate. Time travel is meaningful — and harmless — exactly on the
   * simulated clock, so the handler additionally refuses any organization that is not running on the
   * seeded substrate. That check is server-side on purpose: a live organization's `now` is the actual
   * present, and a client-only guard would let a crafted POST regenerate its daily for a day that has
   * not happened.
   */
  {
    route: '/api/time-travel',
    summary: 'Steps `now` across the seeded history and regenerates through the real pipeline.',
    allow: { POST: ['owner', 'manager'] },
    teamScoped: true,
  },

  // -------------------------------------------------------------------------
  // Privacy: retention, anonymization, chat opt-in, deletion and the export.
  //
  // The split between owner-only and owner-plus-manager is not arbitrary. A setting that
  // decides what Compass *keeps or sends* is the organization's own posture and belongs to
  // an owner: retention windows, the narration mode, deleting the tenant, downloading the
  // whole export. The two acts a manager needs are the two that are about the team in front
  // of them — withdrawing a departed colleague's name from tomorrow's report, and turning a
  // channel's ingestion on or off — and routing either through an owner would mean the wrong
  // name stayed in the report, or a team went unread, while a request sat in a queue.
  //
  // Members and viewers are absent from every row here, and `/me` is the reason that is not
  // a gap: the one privacy surface a member needs is their own, and it is theirs by right.
  // -------------------------------------------------------------------------
  {
    route: '/api/privacy/settings',
    summary: 'The retention windows and the narration mode. Owner only: it is the organization’s posture.',
    allow: { PATCH: ['owner'] },
  },
  {
    route: '/api/privacy/anonymize',
    summary: 'Withdraw a person’s name from future reports, or restore it. Both acts are audited.',
    allow: { POST: ['owner', 'manager'], DELETE: ['owner', 'manager'] },
  },
  {
    route: '/api/privacy/channels',
    summary: 'Turn chat ingestion on or off for one named public channel. Never a DM, never private.',
    allow: { PATCH: ['owner', 'manager'] },
  },
  {
    /**
     * Every seat may ask, and the handler decides *what* they may ask for.
     *
     * `account` is any seat's own account; `organization` is owner-only and the handler
     * enforces that separately, because the matrix decides who may call a route and not
     * which body they may send. The subject id is never read from the request — it is the
     * caller's own user id — so a manager cannot delete a colleague's account with a curl.
     */
    route: '/api/privacy/deletion',
    summary: 'Request deletion of your own account, or — for an owner — of the whole organization.',
    allow: { POST: EVERY_SEAT },
  },
  {
    /**
     * `public`, and narrower than a session rather than wider.
     *
     * The undo link arrives from a mail client with no cookies, and the whole point of the
     * message is that it works when the account holder cannot sign in — a pending deletion
     * may be exactly why they cannot. What authorises it is a 32-byte token mailed once,
     * stored as a digest, good for one act on one request until the grace period ends.
     */
    route: '/api/privacy/deletion/undo',
    summary: 'Spends a mailed undo link and cancels a pending deletion. POST only, never a session.',
    allow: { POST: ANYONE },
  },
  {
    route: '/api/privacy/export',
    summary: 'Everything Compass holds, as one JSON file. Audited, because a full copy leaving is an act.',
    allow: { GET: ['owner'] },
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
  /**
   * The evidence page every superscript marker lands on.
   *
   * This entry was **missing** until `apps/web/tests/two-org-isolation.test.ts` began enumerating
   * page routes as well as endpoints: the coverage test had only ever walked `app/api`, so a screen
   * that renders one organization's commits, pull requests and Jira issues had no row here and
   * nothing in the matrix decided who could read it. Worth recording plainly, because it is exactly
   * the failure the "fail the build when a route has no entry" rule exists to catch, and the rule
   * only caught it once its enumeration matched the routes the app actually serves.
   *
   * `ANYONE` with `demoOnlyPublic`, on the same terms as `/` and the archive, and for the same
   * reason: a receipt is only useful if the reader of the claim can open it, so it gets exactly the
   * posture of the report the claim is in — readable without a seat on the demonstration tenant,
   * closed the moment Compass holds a real organization's work. It is a read with no verb but GET,
   * so nothing here can be written through it.
   */
  {
    route: '/artifact/[kind]/[artifactId]',
    summary: 'One artifact — commit, PR, review, ticket — as the receipt behind a claim.',
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
  /**
   * The guided first-report path, for an organization that is not the demonstration tenant.
   *
   * Owner and manager, and deliberately *not* `public`. Every step on it is a write to the
   * configuration — declare a team, enter the two objectives, import a roster — and the
   * matrix already says those writes are owner-or-manager on `/api/roster/*` and
   * `/api/goals`. A screen that anyone could read while every button on it answered 403
   * would be a worse experience than being told plainly to sign in.
   *
   * It is a destination, never an interception: nothing redirects to it, and `/` does not
   * consult it. A new organization is *offered* this path from the report route when the
   * report has nothing to describe yet; a seeded one never sees it.
   */
  {
    route: '/start',
    summary: 'The four-step path from a new organization to its first report.',
    allow: { GET: ['owner', 'manager'] },
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
  {
    /**
     * The privacy screen. Owner and manager, matching the two routes a manager may call.
     *
     * A manager who can turn a channel's ingestion off but cannot see which channels are on
     * is being asked to administer something they cannot read. The owner-only *controls* on
     * the page — the retention windows, the narration mode, deleting the organization — are
     * refused by their own routes, and the page renders them as stated facts rather than as
     * editable fields for anyone else.
     */
    route: '/privacy',
    summary: 'What Compass keeps, what it reads, whose name it prints, and how to end all of it.',
    allow: { GET: ['owner', 'manager'] },
  },
  {
    /**
     * "What does Compass say about me". Every seat, and no approval.
     *
     * The whole point is that a member opens it and it works. There is no request to make,
     * no queue and nobody to ask — a transparency page you have to be granted is not one.
     * It is not `demoOnlyPublic` and not `ANYONE`: the answer is computed from the reader's
     * own session, so an anonymous reader has no question for it to answer.
     */
    route: '/me',
    summary: 'Everything Compass stores about you, and every report line that names you.',
    allow: { GET: EVERY_SEAT },
  },
  {
    /**
     * The undo landing page, reached from an email.
     *
     * `ANYONE`, on the same terms as `/api/privacy/deletion/undo`: it exists to be opened by
     * somebody who may not be able to sign in, and it holds no organization data — it reads
     * a token out of the query string, posts it, and prints the outcome.
     */
    route: '/account/deletion',
    summary: 'Cancels a pending deletion from a mailed link. Holds no data of its own.',
    allow: { GET: ANYONE },
  },
  {
    route: '/corrections',
    summary: 'What a manager has corrected: suppressed findings, corrected off-goal flags, live snoozes.',
    allow: { GET: ['owner', 'manager'] },
  },
  /**
   * The archive and the two cross-cutting reads, on the same terms as the report itself.
   *
   * `ANYONE` with `demoOnlyPublic`, exactly like `/`: a past report is the same organization data as
   * today's, so it gets the same posture — readable without a session on the demonstration tenant, and
   * closed the moment Compass is holding somebody's actual blockers. A skip-level pointed at last
   * Tuesday's report must not need a seat to read it, which is the entire use case.
   */
  {
    route: '/archive',
    summary: 'Every stored report by date and team. Renders rows, never a regeneration.',
    allow: { GET: ANYONE },
    demoOnlyPublic: true,
  },
  {
    route: '/archive/[reportId]',
    summary: 'One archived report, permalinked, rendered exactly as stored including its fallback flag.',
    allow: { GET: ANYONE },
    demoOnlyPublic: true,
  },
  {
    route: '/archive/merged/[reportDate]',
    summary: "One date's merged cross-team view, re-derived from that date's stored per-team reports.",
    allow: { GET: ANYONE },
    demoOnlyPublic: true,
  },
  {
    route: '/merged',
    summary: "Today's merged cross-team report: ranked by action impact, inside a 400-word budget.",
    allow: { GET: ANYONE },
    demoOnlyPublic: true,
  },
  {
    route: '/weekly',
    summary: 'The weekly digest: six topics, prose only, undefined topics stated rather than zeroed.',
    allow: { GET: ANYONE },
    demoOnlyPublic: true,
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
