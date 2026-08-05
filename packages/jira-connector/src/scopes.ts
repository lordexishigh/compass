/**
 * The read-only OAuth scope set, in one place, because it is shown to a manager verbatim.
 *
 * ## Why this is a module and not a string in the connect page
 *
 * Same reason as the code host's: two copies of the scope list — one in the authorize URL and one in
 * the JSX — is the shape where the screen and the request drift apart, and the drift is invisible. The
 * page keeps promising read-only after somebody adds a write scope to the request. So the list is
 * declared once, the authorize URL is *built* from it, and the connect screen renders the same array.
 *
 * ## Why these four, and no more
 *
 * Each is here because a specific part of the report cannot be computed without it:
 *
 *  - `read:jira-work` — issues, their changelogs and their projects. This is Progress, Blockers and
 *    every tracker key the report quotes.
 *  - `read:jira-user` — display names for the assignee and reporter, so an identity can be offered for
 *    matching rather than shown as an opaque account id.
 *  - `read:board-scope:jira-software` — which boards belong to a selected project, which is the only
 *    way to reach that project's sprints without enumerating the whole site.
 *  - `read:sprint:jira-software` — the sprints themselves: dates, state and goal, which is what sprint
 *    reconciliation compares a day's movement against.
 *
 * There is no `write:jira-work`, no `manage:jira-project`, no `manage:jira-configuration` and no
 * webhook scope. Compass reads; it never transitions an issue, edits a field, comments, or installs a
 * hook.
 */

export interface JiraScope {
  /** The scope exactly as Atlassian names it, which is what the consent screen will show. */
  readonly scope: string;
  /** `read` everywhere. Declared per entry so a write scope is impossible to add quietly. */
  readonly access: 'read';
  /** One sentence a manager can evaluate: what breaks without it. */
  readonly because: string;
}

export const JIRA_SCOPES: readonly JiraScope[] = Object.freeze([
  Object.freeze({
    scope: 'read:jira-work',
    access: 'read',
    because:
      'Reads issues, their status history and the projects they belong to. This is what Progress and ' +
      'Blockers are computed from, and every tracker key the report quotes.',
  }),
  Object.freeze({
    scope: 'read:jira-user',
    access: 'read',
    because:
      'Reads the display name and address of an assignee or reporter, so an identity can be offered ' +
      'for matching. Unclaimed identities wait in a queue; Compass never guesses who somebody is.',
  }),
  Object.freeze({
    scope: 'read:board-scope:jira-software',
    access: 'read',
    because:
      'Reads which boards belong to a selected project. Without it the only route to a sprint is ' +
      'enumerating every board on the site, which is exactly the unscoped read Compass refuses.',
  }),
  Object.freeze({
    scope: 'read:sprint:jira-software',
    access: 'read',
    because:
      'Reads sprint dates, state and goal. Without it a day of movement cannot be reconciled against ' +
      'what the team committed to, and scope added mid-sprint becomes invisible.',
  }),
]);

/**
 * The refresh scope, held apart from the four above on purpose.
 *
 * `offline_access` is not a permission over anybody's data — it grants a refresh token so a connection
 * survives the one-hour access-token lifetime without a manager re-consenting every morning. Keeping it
 * out of `JIRA_SCOPES` is what lets `access: 'read'` be asserted over that whole list with no exception
 * carved into the assertion, and the connect screen states this one separately for the same reason: a
 * consent screen that lumps "stay connected" in with "read your issues" is a screen that has blurred
 * the only distinction a reader cares about.
 */
export const JIRA_OFFLINE_SCOPE = 'offline_access';

/**
 * Scopes Compass must never request, asserted rather than merely omitted.
 *
 * An omission is not a guarantee — the next person to touch the authorize URL has no way to know that
 * `write:jira-work` was left out on purpose. This list is what the contract suite holds the requested
 * set against, so adding any of them fails the build.
 */
export const FORBIDDEN_JIRA_SCOPES: readonly string[] = Object.freeze([
  'write:jira-work',
  'delete:jira-work',
  'manage:jira-project',
  'manage:jira-configuration',
  'manage:jira-webhook',
  'manage:jira-data-provider',
  'write:board-scope:jira-software',
  'write:sprint:jira-software',
  'delete:sprint:jira-software',
  'write:issue:jira',
  'write:comment:jira',
]);

/** The space-separated `scope` value the authorize URL carries, built from the list above. */
export const jiraScopeQuery = (scopes: readonly JiraScope[] = JIRA_SCOPES): string =>
  [...scopes.map((entry) => entry.scope), JIRA_OFFLINE_SCOPE].join(' ');

/**
 * The consent URL a manager is sent to — Atlassian's OAuth 2.0 (3LO) authorize endpoint.
 *
 * `state` is the caller's CSRF token; this function does not invent one, because a token generated
 * where it cannot be stored is a token nobody can verify on the way back.
 *
 * `prompt=consent` is deliberate: without it Atlassian will silently re-approve a returning manager,
 * and the scope list this module exists to display would never be shown again after the first install.
 */
export function jiraAuthorizeUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly JiraScope[];
}): string {
  const query = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: input.clientId,
    scope: jiraScopeQuery(input.scopes ?? JIRA_SCOPES),
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `https://auth.atlassian.com/authorize?${query.toString()}`;
}
