import { ROLE_MATRIX } from '@compass/auth';
import { POLICY_DOCUMENTS } from '@compass/trust';
import { describe, expect, it, vi } from 'vitest';

import { INDEXABLE_ROUTES, crawlDisallow, indexablePaths } from '../lib/crawlable';

import { allRoutesOnDisk, pageRoutesOnDisk } from './helpers/routes';

/**
 * robots.txt and sitemap.xml, and the one property that has to hold between them.
 *
 * The editorial half — *which* pages Compass wants found — is a judgement call and is not
 * asserted here; a test that restated `INDEXABLE_ROUTES` would fail whenever somebody
 * changed their mind and would prove nothing. What is asserted is everything that would be
 * a defect at any editorial position:
 *
 *  - nothing advertised to a crawler requires a seat,
 *  - nothing advertised is also forbidden in the same file,
 *  - every route that exists is one or the other, never neither,
 *  - the two documents name the same set.
 */

/** The matrix rule for a route, or undefined — every route on disk has one, by another gate. */
const ruleFor = (route: string) => ROLE_MATRIX.find((entry) => entry.route === route);

describe('the index list only names pages a stranger can actually open', () => {
  it.each(INDEXABLE_ROUTES)('%s is served to the public principal', (route) => {
    const rule = ruleFor(route);
    expect(rule, `${route} is offered to crawlers but has no matrix entry`).toBeDefined();
    expect(
      (rule?.allow.GET ?? []).includes('public'),
      `${route} is in the sitemap but requires a seat — a search result nobody can open`,
    ).toBe(true);
  });

  it.each(INDEXABLE_ROUTES)('%s is a page on disk, not an endpoint', (route) => {
    // A sitemap entry pointing at a route handler would advertise a JSON body, or a
    // redirect, as a document to index.
    expect(pageRoutesOnDisk(), `${route} is advertised but is not a page`).toContain(route);
  });

  /**
   * `/` is the one entry that is `demoOnlyPublic`, and it is deliberate.
   *
   * On the seeded demonstration tenant it is a complete public report and the product's
   * shop window; on a real deployment the same URL asks for a seat. Listing a site's own
   * front door is not something to withhold on the grounds that it is sometimes gated —
   * every authenticated product does exactly this — but it *is* the only such entry, and
   * that fact is worth a failing test rather than a comment, because the next
   * `demoOnlyPublic` route added to this list would be an organization's own work.
   */
  it('advertises exactly one route whose public access is demo-only, and it is the front door', () => {
    const demoOnly = INDEXABLE_ROUTES.filter((route) => ruleFor(route)?.demoOnlyPublic === true);
    expect(demoOnly).toEqual(['/']);
  });
});

describe('robots.txt cannot contradict itself', () => {
  const disallow = crawlDisallow();

  it('forbids nothing it also advertises', () => {
    // Longest-match resolves this in a crawler's favour anyway; a file that needs the
    // tie-break to be read correctly is one a human will read incorrectly.
    for (const path of indexablePaths()) {
      const swallowed = disallow.filter(
        (rule) => path.startsWith(rule) && (rule.endsWith('/') || path[rule.length] === '/' || path === rule),
      );
      expect(swallowed, `${path} is advertised and forbidden by ${swallowed.join(', ')}`).toEqual([]);
    }
  });

  it('states no rule that a shorter rule already covers', () => {
    for (const rule of disallow) {
      const parents = disallow.filter(
        (other) => other !== rule && rule.startsWith(other) && (other.endsWith('/') || rule[other.length] === '/'),
      );
      expect(parents, `${rule} is already covered by ${parents.join(', ')}`).toEqual([]);
    }
  });

  /**
   * The pruning must not lean on robots.txt's raw-prefix matching.
   *
   * `Disallow: /me` really does forbid `/merged`, so a prune written with bare `startsWith`
   * would drop `/merged` and leave a file that is correct and unreadable. Both routes exist,
   * so this is a live case rather than a hypothetical.
   */
  it('keeps a route whose path merely begins with another rule', () => {
    expect(disallow).toContain('/me');
    expect(disallow).toContain('/merged');
  });
});

describe('every route on disk is decided, never left out', () => {
  it('covers each one with an index entry or a disallow rule', () => {
    const disallow = crawlDisallow();
    const undecided = allRoutesOnDisk().filter((route) => {
      if (INDEXABLE_ROUTES.includes(route)) return false;
      if (route.startsWith('/api')) return false;
      return !disallow.some((rule) => route.startsWith(rule.endsWith('/') ? rule : `${rule}/`) || route === rule);
    });

    expect(undecided, 'these routes are neither advertised nor hidden').toEqual([]);
  });

  it('hides the tenant data that is public only on the demonstration org', () => {
    // The archive and the artifacts are the reason this file exists: readable without a
    // session on the seeded org, and never something to put in a search index.
    const disallow = crawlDisallow();
    for (const path of ['/archive', '/artifact/', '/weekly', '/merged']) {
      expect(disallow, `${path} is not hidden from crawlers`).toContain(path);
    }
  });
});

describe('the sitemap', () => {
  /** Both metadata routes read the origin through `next/headers`, which needs a request. */
  const withHost = (host: string | null) => {
    vi.doMock('next/headers', () => ({
      headers: async () => new Map(host === null ? [] : [['host', host]]),
    }));
  };

  it('expands every published policy, and only those', async () => {
    const legal = indexablePaths().filter((path) => path.startsWith('/legal/'));
    expect(legal.sort()).toEqual(POLICY_DOCUMENTS.map((document) => `/legal/${document.slug}`).sort());
  });

  it('emits absolute URLs against the configured origin', async () => {
    vi.resetModules();
    vi.stubEnv('COMPASS_BASE_URL', 'https://compass.example.com');
    withHost('attacker.example');

    const { default: sitemap } = await import('../app/sitemap');
    const entries = await sitemap();

    expect(entries.length).toBe(indexablePaths().length);
    for (const entry of entries) {
      expect(entry.url.startsWith('https://compass.example.com/'), `${entry.url} is not absolute`).toBe(true);
    }
    // The Host header is not a source. A sitemap that named the attacker's domain as
    // canonical for Compass's own pages is the reason `siteOrigin` refuses to read one.
    expect(entries.some((entry) => entry.url.includes('attacker.example'))).toBe(false);

    vi.unstubAllEnvs();
    vi.doUnmock('next/headers');
  });

  /**
   * The zero-config path, and the check that keeps the two tests below honest.
   *
   * Both of those assert an *empty* result, which is also what an unapplied `next/headers`
   * mock would produce — `headers()` outside a request throws, `siteOrigin` catches, the
   * sitemap is empty, and the test passes having proved nothing. This one asserts a
   * non-empty result from the same mock, so if the mock ever stops taking effect it fails
   * here rather than silently hollowing out the two after it.
   */
  it('falls back to a loopback Host, which is what makes `docker compose up` work unconfigured', async () => {
    vi.resetModules();
    vi.stubEnv('COMPASS_BASE_URL', '');
    withHost('localhost:3000');

    const { default: sitemap } = await import('../app/sitemap');
    const entries = await sitemap();

    expect(entries.length).toBe(indexablePaths().length);
    expect(entries[0]?.url).toBe('http://localhost:3000/');

    vi.unstubAllEnvs();
    vi.doUnmock('next/headers');
  });

  it('is empty rather than relative when the origin cannot be resolved', async () => {
    vi.resetModules();
    vi.stubEnv('COMPASS_BASE_URL', '');
    withHost('compass.example.com');

    const { default: sitemap } = await import('../app/sitemap');
    expect(await sitemap()).toEqual([]);

    vi.unstubAllEnvs();
    vi.doUnmock('next/headers');
  });

  /**
   * A typo'd origin and an unconfigured one are the same empty sitemap, and must not be the
   * same silence.
   *
   * `COMPASS_BASE_URL=htps://…` is a deployment that believes it is configured. Without a log
   * line the only symptom is a sitemap that lists nothing, on a route nobody opens, and the
   * variable that caused it is never mentioned anywhere — which is close to undiagnosable. An
   * unset variable warns nothing, because that is a choice rather than a fault.
   */
  it('says which environment variable is at fault when one is set and unreadable', async () => {
    vi.resetModules();
    vi.stubEnv('COMPASS_BASE_URL', 'htps://compass.example.com');
    withHost('compass.example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { default: sitemap } = await import('../app/sitemap');
    expect(await sitemap(), 'a malformed origin must not produce URLs').toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0]?.[0] ?? '');
    expect(said, 'the warning does not name the variable to fix').toContain('COMPASS_BASE_URL');
    expect(said, 'the warning does not quote the offending value').toContain('htps://compass.example.com');

    warn.mockRestore();
    vi.unstubAllEnvs();
    vi.doUnmock('next/headers');
  });

  it('stays silent when the variable is simply unset, because that is a choice not a fault', async () => {
    vi.resetModules();
    vi.stubEnv('COMPASS_BASE_URL', '');
    withHost('compass.example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { default: sitemap } = await import('../app/sitemap');
    expect(await sitemap()).toEqual([]);
    expect(warn, 'an unconfigured deployment is being warned at on every request').not.toHaveBeenCalled();

    warn.mockRestore();
    vi.unstubAllEnvs();
    vi.doUnmock('next/headers');
  });

  it('omits the Sitemap pointer from robots.txt in that same condition', async () => {
    vi.resetModules();
    vi.stubEnv('COMPASS_BASE_URL', '');
    withHost('compass.example.com');

    const { default: robots } = await import('../app/robots');
    const document = await robots();

    expect(document.sitemap).toBeUndefined();
    // The rules still stand: an unconfigured origin is a reason to say less, not to invite
    // a crawler into the archive.
    expect(document.rules).not.toEqual([]);

    vi.unstubAllEnvs();
    vi.doUnmock('next/headers');
  });
});
