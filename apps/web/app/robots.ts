import type { MetadataRoute } from 'next';

import { crawlDisallow, indexablePaths } from '../lib/crawlable';
import { siteOrigin } from '../lib/site-origin';

/**
 * `/robots.txt` — what a crawler may read.
 *
 * ## Why this exists at all
 *
 * Without it every crawler gets a 404 and falls back to "everything is fair game", and
 * Compass serves a lot that should not be in a search index: an organization's archive of
 * past reports, the evidence artifacts behind every claim, the seat list, the privacy
 * console. None of it is *reachable* without a session — the matrix sees to that, and
 * robots.txt is a request rather than a control — but a crawler that has to be refused
 * forty thousand times to learn the shape of the app is one that has learned the shape of
 * the app. Saying so up front is cheaper for everybody.
 *
 * ## Allow and Disallow, both stated
 *
 * The allow list is emitted explicitly rather than relied upon by omission. Crawlers
 * resolve conflicts by longest match, so an explicit `Allow: /legal/terms` survives even
 * if some future route collapses to a `Disallow: /legal/` prefix above it — the failure
 * this guards against is a policy page quietly dropping out of search because a sibling
 * route was added, which nobody would notice for months.
 *
 * `Sitemap:` is omitted rather than guessed when the origin is unknown; see `siteOrigin`.
 */
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();

  return {
    rules: [
      {
        userAgent: '*',
        allow: [...indexablePaths()],
        disallow: [...crawlDisallow()],
      },
    ],
    ...(origin === null ? {} : { sitemap: `${origin}/sitemap.xml`, host: origin }),
  };
}
