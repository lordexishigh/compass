/**
 * The read-only permission set, in one place, because it is shown to a manager verbatim.
 *
 * ## Why this is a module and not a string in the connect page
 *
 * The acceptance criterion is that "requested scopes are exactly the documented read-only set and are
 * displayed verbatim on the connect screen before consent". Two copies of that list — one in the
 * install URL and one in the JSX — is the shape where the screen and the request drift apart, and the
 * drift is invisible: the page keeps promising read-only after somebody adds a write permission to
 * the request. So the list is declared once, the install URL is *built* from it, and the connect
 * screen renders the same array.
 *
 * ## Why these five and no more
 *
 * Each one is here because a specific part of the report cannot be computed without it, and nothing
 * is here speculatively:
 *
 *  - `contents:read` — commits, branch topology and tags. Branch topology and tags are R3–R5 of the
 *    Completion Ladder; without them a merged pull request cannot be distinguished from a released one.
 *  - `pull_requests:read` — pull requests and their reviews, which is Yesterday and the review
 *    bottleneck in Blockers.
 *  - `issues:read` — issue *references* on pull requests. GitHub is not Compass's tracker, but a pull
 *    request that closes an issue is how work links to a tracker key when the tracker is GitHub.
 *  - `metadata:read` — mandatory for any GitHub App, and the only way to read the default branch.
 *  - `members:read` — the organization roster, so an identity can be offered for matching rather than
 *    guessed at.
 *
 * There is no `contents:write`, no `administration`, no `workflow` and no webhook management. Compass
 * reads; it never pushes a commit, opens a pull request, changes a setting or installs a hook.
 */

export interface GithubScope {
  /** The permission as GitHub names it, which is what the consent screen will show. */
  readonly permission: string;
  /** `read` everywhere. Declared per entry so a write permission is impossible to add quietly. */
  readonly access: 'read';
  /** One sentence a manager can evaluate: what breaks without it. */
  readonly because: string;
}

export const GITHUB_SCOPES: readonly GithubScope[] = Object.freeze([
  Object.freeze({
    permission: 'contents',
    access: 'read',
    because:
      'Reads commits, branch tips and release tags. Without it Compass cannot tell a merged change ' +
      'from a released one, and the completion ladder stops at R2.',
  }),
  Object.freeze({
    permission: 'pull_requests',
    access: 'read',
    because:
      'Reads pull requests and their reviews. This is what Yesterday is built from, and what makes a ' +
      'review bottleneck visible in Blockers.',
  }),
  Object.freeze({
    permission: 'issues',
    access: 'read',
    because:
      'Reads the issue references a pull request carries, so work can be tied to the tracker key it ' +
      'serves rather than left unattributed.',
  }),
  Object.freeze({
    permission: 'metadata',
    access: 'read',
    because:
      'Mandatory for every GitHub App, and how Compass reads which branch is the default one. Without ' +
      'a default branch there is no "merged to main" to compute.',
  }),
  Object.freeze({
    permission: 'members',
    access: 'read',
    because:
      'Reads the organization roster so a git address can be offered for identity matching. Unclaimed ' +
      'addresses wait in a queue; Compass never guesses who somebody is.',
  }),
]);

/**
 * Permissions Compass must never request, asserted rather than merely omitted.
 *
 * An omission is not a guarantee — the next person to touch the install URL has no way to know that
 * `contents: write` was left out on purpose. This list is what
 * `tests/scopes.test.ts` holds the requested set against, so adding any of them fails the build.
 */
export const FORBIDDEN_GITHUB_PERMISSIONS: readonly string[] = Object.freeze([
  'administration',
  'workflows',
  'actions',
  'secrets',
  'environments',
  'packages',
  'pages',
  'repository_hooks',
  'organization_hooks',
  'team_discussions',
  'members_write',
]);

/** The `permissions` query value a GitHub App install URL carries, built from the list above. */
export const githubPermissionQuery = (scopes: readonly GithubScope[] = GITHUB_SCOPES): string =>
  scopes.map((scope) => `${scope.permission}:${scope.access}`).join(',');

/**
 * The install URL a manager is sent to.
 *
 * `state` is the caller's CSRF token; this function does not invent one, because a token generated
 * where it cannot be stored is a token nobody can verify on the way back.
 */
export function githubInstallUrl(input: {
  readonly appSlug: string;
  readonly state: string;
  readonly scopes?: readonly GithubScope[];
}): string {
  const query = new URLSearchParams({
    state: input.state,
    permissions: githubPermissionQuery(input.scopes ?? GITHUB_SCOPES),
  });
  return `https://github.com/apps/${encodeURIComponent(input.appSlug)}/installations/new?${query.toString()}`;
}
