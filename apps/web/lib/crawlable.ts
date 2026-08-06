import { ROLE_MATRIX } from '@compass/auth';
import { POLICY_DOCUMENTS } from '@compass/trust';

/**
 * What a crawler may index, and what it may not.
 *
 * ## Why this is two lists and not one derivation
 *
 * It is tempting to compute both from `ROLE_MATRIX`: index what `public` may GET, hide
 * the rest. That is wrong in both directions, and the wrongness is instructive.
 *
 * `/` is `demoOnlyPublic` — world-readable on the seeded demonstration tenant and behind a
 * seat everywhere else — so a derivation keyed on "not demo-only" would drop the site's own
 * front door. Meanwhile `/account/invite` and `/account/reset` *are* unconditionally public,
 * because a person accepting an invitation has no session yet; they are also useless in a
 * search result, since each one is a landing page for a single-use token in a query string.
 *
 * So which pages Compass *wants* found is an editorial decision, not an access-control
 * consequence, and it is written down here as one. What the matrix is used for is the
 * safety property underneath it — see `crawlDisallow` — plus the assertion in
 * `tests/crawlable.test.ts` that nothing on the index list requires a seat. Advertising a
 * page to a crawler that a reader then cannot open is the failure worth a build gate; the
 * reverse, declining to advertise a public page, is a preference.
 */

/**
 * The pages Compass asks to be found by, spelled as the App Router spells them.
 *
 * Six documents and the front door: the report itself, the price, the five policies, and
 * the subprocessor list. Every one is something a stranger evaluating Compass has a reason
 * to read before they have an account, and nothing here is an organization's own work.
 */
export const INDEXABLE_ROUTES: readonly string[] = [
  '/',
  '/pricing',
  '/legal',
  '/legal/[slug]',
  '/trust/subprocessors',
];

/**
 * The same list with `[slug]` expanded, as paths a crawler can actually fetch.
 *
 * The slugs come from `POLICY_DOCUMENTS`, which is the closed list `/legal/[slug]` renders
 * from and 404s outside of — so a policy added there is offered to search engines by the
 * same edit that publishes it, and a sitemap can never name a document that does not exist.
 */
export function indexablePaths(): readonly string[] {
  return INDEXABLE_ROUTES.flatMap((route) =>
    route === '/legal/[slug]' ? POLICY_DOCUMENTS.map((document) => `/legal/${document.slug}`) : [route],
  );
}

/**
 * The static prefix a route matches under robots.txt's rules.
 *
 * robots.txt paths are prefix matches, so a route is covered by everything up to its first
 * dynamic segment: `/archive/[reportId]` is covered by `/archive/`, and `/artifact/[kind]/
 * [artifactId]` by `/artifact/`. Emitting the bracketed spelling instead would produce a
 * rule matching a literal `[` — a directive that looks precise and forbids nothing.
 */
function staticPrefix(route: string): string {
  const segments = route.split('/').filter((segment) => segment.length > 0);
  const dynamic = segments.findIndex((segment) => segment.startsWith('['));
  if (dynamic === -1) return route;
  return `/${segments.slice(0, dynamic).join('/')}/`;
}

/**
 * Everything else, from the matrix — so a new route is hidden by default.
 *
 * This is the half that must not be hand-maintained. A hand-written disallow list is
 * correct on the day it is written and silently stale the first time somebody adds a screen
 * that reads organization data; the mistake never announces itself, because a crawled page
 * that should not have been crawled looks exactly like one that should. Deriving it from
 * `ROLE_MATRIX` — which the route-coverage test already forces to name every route on disk —
 * means the default for anything new is "not indexed", and opting in is an edit to
 * `INDEXABLE_ROUTES` above where a reader will see it.
 *
 * `/api` is collapsed to one entry rather than listed endpoint by endpoint: forty rules
 * saying the same thing are forty chances for one to be missed, and no endpoint under it is
 * ever a page.
 */
export function crawlDisallow(): readonly string[] {
  const prefixes = new Set<string>(['/api/']);

  for (const rule of ROLE_MATRIX) {
    if (INDEXABLE_ROUTES.includes(rule.route)) continue;
    if (rule.route.startsWith('/api/') || rule.route === '/api') continue;
    prefixes.add(staticPrefix(rule.route));
  }

  const all = [...prefixes];
  // `/archive` already forbids `/archive/diff`; emitting both says the same thing twice, and
  // a file with four ways to state one rule is one somebody edits half of.
  return all.filter((path) => !all.some((other) => other !== path && coversAtSegment(other, path))).sort();
}

/**
 * Whether `shorter` forbids `longer` by robots.txt's own prefix rule, at a segment boundary.
 *
 * The boundary is the load-bearing part. robots.txt matches on raw string prefix, not on
 * path segments, so `Disallow: /me` genuinely does forbid `/merged` — and pruning on bare
 * `startsWith` would therefore drop `/merged` from the emitted file on the grounds that
 * `/me` covers it. It does cover it, and the file would still be correct, and it would have
 * become impossible to read: a maintainer looking for the rule that hides the merged report
 * would find nothing and add one. So only a genuine parent — `/archive` over `/archive/diff`
 * — is allowed to absorb its child, and coincidental prefixes are left alone.
 */
function coversAtSegment(shorter: string, longer: string): boolean {
  if (!longer.startsWith(shorter)) return false;
  return shorter.endsWith('/') || longer[shorter.length] === '/';
}
