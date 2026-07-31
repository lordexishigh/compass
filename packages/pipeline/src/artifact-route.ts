/**
 * The in-app artifact route.
 *
 * Every computed claim in a report carries an evidence marker, and every marker
 * resolves to a page inside Compass showing the underlying artifact — the commit
 * SHA, the pull request number, the tracker key. That link has to be built in two
 * places: by the web view rendering the marker, and by whatever writes the
 * `artifact_kind` / `artifact_id` columns the page then looks up. One definition
 * here means a link cannot be built that the page cannot resolve.
 *
 * The id is the source's own natural key, percent-encoded. It is not a label:
 * `#42` is ambiguous across repositories, and a URL is not a place to be
 * ambiguous about which pull request a manager is being shown.
 */
export const ARTIFACT_ROUTE_KINDS = [
  'commit',
  'pull_request',
  'issue',
  'branch',
  'release',
  'sprint',
  'message',
  'memo',
] as const;

export type ArtifactRouteKind = (typeof ARTIFACT_ROUTE_KINDS)[number];

export function isArtifactRouteKind(value: string): value is ArtifactRouteKind {
  return (ARTIFACT_ROUTE_KINDS as readonly string[]).includes(value);
}

/**
 * `/artifact/pull_request/checkout-web%3Apr-9201`.
 *
 * A kind Compass does not have a page for still produces a link rather than
 * silently rendering unlinked text: the page states that the artifact kind is not
 * one it can show, which a reader can act on. Dropping the link would leave a
 * claim looking unevidenced when the evidence exists.
 */
export function artifactHref(kind: string, artifactId: string): string {
  return `/artifact/${encodeURIComponent(kind)}/${encodeURIComponent(artifactId)}`;
}
