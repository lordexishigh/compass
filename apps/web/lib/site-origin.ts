import { headers } from 'next/headers';

import { baseUrlFor } from './auth/guard';

/**
 * This deployment's own origin, for the two documents that have to state it absolutely.
 *
 * ## Why not just read the Host header
 *
 * `sitemap.xml` and `robots.txt` are the two files a crawler reads *before* it trusts
 * anything else, and both must carry absolute URLs — a sitemap of relative paths is
 * invalid, and `Sitemap:` in robots.txt is defined as an absolute reference. The obvious
 * source is the request's own host, and it is the wrong one: these are unauthenticated,
 * cacheable, world-readable documents, so a request carrying `x-forwarded-host:
 * evil.example` would have Compass publish a sitemap advertising somebody else's domain
 * as canonical for its own pages.
 *
 * ## One policy, not two
 *
 * `baseUrlFor` already decides this question for mailed links, and its reasoning — a
 * caller who chooses the host chooses where a token points — reaches the same answer:
 * configuration, or a loopback Host, or nothing. Rather than restate that policy here
 * where it could drift, this calls it. The only thing a metadata route lacks is a
 * `Request` to hand it, and the only field `baseUrlFor` reads off one is the hostname, so
 * a request synthesised from the incoming `Host` header is the same input by a different
 * route. When `COMPASS_BASE_URL` is set — every real deployment — the synthesised request
 * is ignored entirely.
 *
 * ## Null rather than a guess
 *
 * An unconfigured deployment behind a non-loopback host gets null, and the callers say
 * nothing rather than something wrong: the sitemap lists no URLs and robots.txt omits its
 * `Sitemap:` line. That is the honest degradation the brief asks for. A sitemap naming
 * `http://undefined/pricing` would be worse than an empty one, because a crawler would
 * act on it.
 */
export async function siteOrigin(): Promise<string | null> {
  const host = (await headers()).get('host');

  try {
    // `http` is a placeholder that only survives the loopback branch, where it is also
    // correct — nothing serves these documents over https on localhost. A configured
    // `COMPASS_BASE_URL` carries its own scheme and wins before this is looked at.
    return baseUrlFor(new Request(`http://${host ?? 'unset.invalid'}/`));
  } catch (error) {
    // `baseUrlFor` throws `LinkOriginUnavailableError` when it has neither configuration
    // nor a loopback host. For a mailed link that is a 503; for a crawler document it is
    // a document with less in it.
    //
    // Two very different situations reach this line, and only one of them is somebody's
    // mistake. A deployment that never set `COMPASS_BASE_URL` is unconfigured, which is a
    // choice; a deployment that set it to `htps://compass.example.com` believes it is
    // configured and is silently serving an empty sitemap. Both produced the same silence
    // until this branch told them apart, and a typo in an environment variable is the
    // hardest kind of fault to find when nothing anywhere mentions it.
    //
    // Warned rather than thrown: a malformed variable must not take down `/robots.txt`,
    // which still has real rules to serve and is the more important of the two documents.
    // Once per request for these two routes only, so it cannot become log noise.
    const configured = process.env['COMPASS_BASE_URL'];
    if (configured !== undefined && configured.length > 0) {
      console.warn(
        `COMPASS_BASE_URL is set to \`${configured}\` and Compass could not read an origin from it, so ` +
          `/sitemap.xml is empty and /robots.txt names no sitemap. It must be an absolute http or https ` +
          `URL, like \`https://compass.your-company.com\`. ${error instanceof Error ? error.message : ''}`,
      );
    }
    return null;
  }
}
