/**
 * The read-only scope set, in one place, because it is shown to a manager verbatim.
 *
 * ## Why this is a module and not a string in the connect page
 *
 * Same reason as the code host's and the tracker's: two copies of the scope list — one in the install
 * URL and one in the JSX — is the shape where the screen and the request drift apart, and the drift is
 * invisible. The page keeps promising read-only after somebody adds a write scope to the request. So the
 * list is declared once, the install URL is *built* from it, and the connect screen renders the same
 * array.
 *
 * ## Why these two, and no more
 *
 * Chat is the one artifact family Compass keeps verbatim, so the scope list is the shortest of the three
 * and every entry has to pay for itself:
 *
 *  - `channels:history` — the messages themselves, in the channels a manager named. This is what a
 *    blocker stated in prose ("still waiting on the staging key") is read from.
 *  - `users:read` — the handle and display name behind an author id, so an identity can be offered for
 *    matching rather than shown as `U04QJ7M2XYZ`.
 *
 * There is no `chat:write`, no `channels:manage`, no `groups:history`, no `im:history` and no
 * `mpim:history`. The last three are the ones worth naming explicitly: they are what would let Compass
 * read private channels, direct messages and group messages, and their absence is why
 * `conversations.history` on anything but a public channel fails at the provider rather than relying on
 * Compass to decline it.
 *
 * ## Why there is no `channels:read`
 *
 * `channels:read` would let Compass *enumerate* the workspace's channels, and enumerating channels is
 * precisely the workspace-wide read this connector exists not to do. A manager names the channels; the
 * name Compass shows comes from that naming, not from a directory listing. `tests/contract.test.ts`
 * asserts no `conversations.list` call is ever made, which is the same rule from the other side.
 */

export interface SlackScope {
  /** The scope exactly as Slack names it, which is what the consent screen will show. */
  readonly scope: string;
  /** `read` everywhere. Declared per entry so a write scope is impossible to add quietly. */
  readonly access: 'read';
  /** One sentence a manager can evaluate: what breaks without it. */
  readonly because: string;
}

export const SLACK_SCOPES: readonly SlackScope[] = Object.freeze([
  Object.freeze({
    scope: 'channels:history',
    access: 'read',
    because:
      'Reads the messages in the public channels you name here, and in no others. This is what lets a ' +
      'blocker somebody stated in prose reach Blockers instead of going unnoticed until standup.',
  }),
  Object.freeze({
    scope: 'users:read',
    access: 'read',
    because:
      'Reads the handle and display name behind an author id, so an identity can be offered for ' +
      'matching. Unclaimed identities wait in a queue; Compass never guesses who somebody is.',
  }),
]);

/**
 * Scopes Compass must never request, asserted rather than merely omitted.
 *
 * An omission is not a guarantee — the next person to touch the install URL has no way to know that
 * `im:history` was left out on purpose. This list is what the contract suite holds the requested set
 * against, so adding any of them fails the build.
 *
 * `channels:read` is on it for the reason in the module header: enumerating a workspace's channels is
 * the unscoped read this connector is built to make impossible.
 */
export const FORBIDDEN_SLACK_SCOPES: readonly string[] = Object.freeze([
  'chat:write',
  'chat:write.public',
  'channels:read',
  'channels:write',
  'channels:manage',
  'channels:join',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'files:read',
  'search:read',
  'admin',
  'users:read.email',
]);

/** The comma-separated `scope` value the install URL carries, built from the list above. */
export const slackScopeQuery = (scopes: readonly SlackScope[] = SLACK_SCOPES): string =>
  scopes.map((entry) => entry.scope).join(',');

/**
 * The install URL a manager is sent to — Slack's OAuth v2 authorize endpoint.
 *
 * `state` is the caller's CSRF token; this function does not invent one, because a token generated
 * where it cannot be stored is a token nobody can verify on the way back.
 *
 * The scopes go in `scope` and **not** in `user_scope`: a bot token reads the channels it has been
 * invited to, whereas a user token would read everything the installing person can see — which is the
 * whole workspace, including their direct messages. The distinction is the difference between a
 * channel-scoped connector and a workspace-wide one, so it is stated here rather than left to whoever
 * next edits the query.
 */
export function slackInstallUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly SlackScope[];
}): string {
  const query = new URLSearchParams({
    client_id: input.clientId,
    scope: slackScopeQuery(input.scopes ?? SLACK_SCOPES),
    user_scope: '',
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://slack.com/oauth/v2/authorize?${query.toString()}`;
}
