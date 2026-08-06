import type { MetadataRoute } from 'next';

import { nowAtEdge } from '../lib/auth/guard';
import { indexablePaths } from '../lib/crawlable';
import { siteOrigin } from '../lib/site-origin';

/**
 * `/sitemap.xml` — the seven pages Compass asks to be found by.
 *
 * ## What is deliberately not in it
 *
 * No report, no archive entry, no artifact. A sitemap is a claim that a URL is worth
 * indexing and stable enough to come back to, and an organization's daily report is
 * neither: it is that tenant's own work, it is behind a seat on every deployment that is
 * not the seeded demonstration, and its whole design is that it never repeats unchanged.
 * The front door is listed; what is behind it is not.
 *
 * `indexablePaths()` is shared with `robots.ts` so the two documents cannot disagree — a
 * sitemap advertising a URL the same host's robots.txt forbids is the commonest way this
 * pair goes wrong, and it makes a crawler distrust both.
 *
 * ## `lastModified`
 *
 * Set to the request instant rather than to a per-document date, and that is a statement
 * about what Compass knows rather than laziness. These pages are rendered from modules in
 * the running build — `POLICY_DOCUMENTS` for the five policies, components for the rest —
 * and nothing in the running process records when any of them last changed. A hard-coded
 * date would go stale the first time a policy was edited and would then be a false claim
 * a crawler acts on; a per-request instant claims only "as of now", which is true.
 *
 * ## Empty rather than wrong
 *
 * With no resolvable origin there is nothing honest to emit: sitemap URLs must be
 * absolute, and a relative one is not a lesser sitemap but an invalid document. So the
 * list is empty and `robots.txt` omits the pointer to it in the same condition.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  if (origin === null) return [];

  const lastModified = new Date(nowAtEdge());

  return indexablePaths().map((path) => ({
    // `path` always begins with `/` and `origin` never ends with one, so this is correct for
    // the root (`https://host/`) and for a document alike, with no special case.
    url: `${origin}${path}`,
    lastModified,
    // The front door above the documents it leads to. Relative weights only — they order
    // Compass's own pages against each other and mean nothing across sites.
    priority: path === '/' ? 1 : 0.6,
    changeFrequency: 'monthly' as const,
  }));
}
