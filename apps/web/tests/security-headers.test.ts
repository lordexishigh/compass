import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { middleware, config as middlewareConfig } from '../middleware';
import {
  CSP_HEADER,
  FRAME_ANCESTORS,
  NONCE_HEADER,
  REQUIRED_SECURITY_HEADERS,
  STATIC_SECURITY_HEADERS,
  contentSecurityPolicy,
  currentBuildMode,
  generateNonce,
} from '../lib/security-headers';

/**
 * The six headers, on a sample of every route class, with the documented values.
 *
 * The middleware is invoked directly rather than through a booted server. That is not a weaker
 * test: `NextResponse.next()` returns the real response object with the real headers on it, and the
 * matcher — the other half of "on every response" — is a declared constant that is asserted
 * separately below. A booted-server test would additionally cover Next's own routing, which is not
 * what this file is about and is covered by the container smoke test.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One path per route class, chosen so that no class is represented only by another's neighbour.
 *
 * `/` is first and matters most: it is the zero-config report, the one path a blanket middleware
 * would be most likely to break, and the one whose session-less rendering the cold-start suite
 * asserts from the other side.
 */
const ROUTE_CLASSES = [
  ['the zero-config report', '/'],
  ['a rendered screen', '/account'],
  ['a dynamic rendered screen', '/archive/abc-123'],
  ['the goal hierarchy', '/goals'],
  ['the merged view', '/merged'],
  ['the weekly digest', '/weekly'],
  ['a public API route', '/api/health'],
  ['an authenticating API route', '/api/auth/login'],
  ['a seated API route', '/api/seats'],
  ['a dynamic API route', '/api/reports/platform'],
  ['a token-authorised route', '/api/share/abc123'],
  ['a webhook route', '/api/webhooks/github'],
  ['the audit log', '/api/audit'],
  ['a path that matches no route at all', '/not-a-route'],
] as const;

const respond = (path: string) => middleware(new NextRequest(`https://compass.example.com${path}`));

// One test stubs `NODE_ENV` to check the build-mode branch. Restored here so nothing after it reads
// a policy chosen by a leftover stub.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('every route class carries all six headers', () => {
  it.each(ROUTE_CLASSES)('%s (%s)', (_label, path) => {
    const response = respond(path);

    for (const header of REQUIRED_SECURITY_HEADERS) {
      const value = response.headers.get(header);
      expect(value, `${path} is missing ${header}`).not.toBeNull();
      expect(value?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it.each(ROUTE_CLASSES)('%s carries the documented static values verbatim', (_label, path) => {
    const response = respond(path);

    for (const [header, expected] of Object.entries(STATIC_SECURITY_HEADERS)) {
      expect(response.headers.get(header), `${path}: ${header}`).toBe(expected);
    }
  });

  it('names six headers and no fewer, so the list cannot quietly shrink', () => {
    expect([...REQUIRED_SECURITY_HEADERS].sort()).toEqual([
      'content-security-policy',
      'permissions-policy',
      'referrer-policy',
      'strict-transport-security',
      'x-content-type-options',
      'x-frame-options',
    ]);
  });

  it('sets each header exactly once, so nothing is intersected or concatenated', () => {
    /**
     * Two owners of one header emit it twice. `Headers.get` then returns them comma-joined,
     * browsers intersect the two policies, and any assertion of a documented value fails against a
     * string nobody wrote.
     *
     * Asserted by counting the header's own entries rather than by splitting on commas —
     * `permissions-policy` legitimately contains commas — so this holds whatever the value is.
     */
    const response = respond('/');
    const counts = new Map<string, number>();
    response.headers.forEach((_value, name) => {
      counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
    });

    for (const header of REQUIRED_SECURITY_HEADERS) {
      expect(counts.get(header), `${header} must be set exactly once`).toBe(1);
      // A value that is literally itself twice is what a duplicate looks like after joining.
      const value = response.headers.get(header) ?? '';
      expect(value).not.toMatch(/^(.+), ?\1$/);
    }
  });
});

describe('the documented values, one by one', () => {
  it('sets HSTS for two years, including subdomains, with preload', () => {
    expect(STATIC_SECURITY_HEADERS['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');
    // `preload` is the half that makes the *first* request HTTPS. Without it, an attacker on the
    // network still gets one plaintext round trip to work with.
    expect(STATIC_SECURITY_HEADERS['strict-transport-security']).toContain('preload');
  });

  it('sets nosniff, so a JSON error body is never guessed to be HTML', () => {
    expect(STATIC_SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
  });

  it('sets strict-origin-when-cross-origin, because report URLs carry ids and tokens', () => {
    expect(STATIC_SECURITY_HEADERS['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('denies camera, microphone and geolocation outright', () => {
    const policy = STATIC_SECURITY_HEADERS['permissions-policy'] ?? '';

    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(policy, `${feature} must be denied`).toContain(`${feature}=()`);
    }
    // An empty allowlist, not a self allowlist: Compass has no use for any of the three.
    expect(policy).not.toContain('self');
    expect(policy).not.toContain('*');
  });
});

describe('the Content-Security-Policy', () => {
  const nonce = 'dGVzdC1ub25jZS0xMjM0';
  /**
   * The **deployed** policy, asserted by naming the mode rather than by inheriting the test
   * process's own `NODE_ENV`.
   *
   * That distinction is the whole point of the parameter. `next dev` needs `'unsafe-eval'` because
   * its bundle is `eval`-wrapped, and a suite that only ever evaluated the default would pass
   * identically whether the relaxation were confined to development or applied to every deployment
   * — the one thing here worth being sure about.
   */
  const policy = contentSecurityPolicy(nonce, 'production');

  it('carries no `unsafe-inline` in script-src, and no `unsafe-eval` anywhere', () => {
    const scriptSrc = policy.split('; ').find((directive) => directive.startsWith('script-src')) ?? '';

    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('carries the response’s nonce on script-src', () => {
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toContain("script-src 'self' 'nonce-");
  });

  it("sets frame-ancestors 'none', verified on the header and not in the markup", () => {
    // `frame-ancestors` is ignored in a `<meta>` CSP by every browser, so the only place it can be
    // stated is a real response header — which is what is read here.
    expect(FRAME_ANCESTORS).toBe("frame-ancestors 'none'");
    expect(policy).toContain("frame-ancestors 'none'");

    for (const [, path] of ROUTE_CLASSES) {
      const header = respond(path).headers.get(CSP_HEADER) ?? '';
      expect(header, `${path} must refuse to be framed`).toContain("frame-ancestors 'none'");
    }
  });

  it('closes object-src and base-uri, the two directives that are pure downside to omit', () => {
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
  });

  it('confines every fetch to this origin, because Compass talks to no third party from a browser', () => {
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("form-action 'self'");
  });

  /**
   * The development bundle is `eval`-wrapped, so the development policy has to allow it.
   *
   * This is the regression that produced the bug: the policy was unconditional while the bundler
   * output was not, so `next dev` served a page whose every module threw `EvalError` from React
   * Refresh's runtime before hydration started. The prose still painted — which is why it survived
   * review — but the client bundle was dead and the console carried the violation.
   */
  describe('under `next dev`', () => {
    const development = contentSecurityPolicy(nonce, 'development');

    it('allows `unsafe-eval`, because webpack’s dev devtool wraps every module in one', () => {
      const scriptSrc = development.split('; ').find((directive) => directive.startsWith('script-src')) ?? '';

      expect(scriptSrc).toContain("'unsafe-eval'");
      // The nonce and `strict-dynamic` are unchanged: this adds one token, it does not open the
      // policy up. An injected inline script is still refused in development.
      expect(scriptSrc).toContain(`'nonce-${nonce}'`);
      expect(scriptSrc).toContain("'strict-dynamic'");
      expect(scriptSrc).not.toContain('unsafe-inline');
    });

    it('differs from the deployed policy by exactly that one token', () => {
      // Everything else — every other directive, and the whitespace — is identical, so "development
      // relaxes one thing" is a claim about the string rather than about the intent.
      expect(development.replace(" 'unsafe-eval'", '')).toBe(policy);
    });

    it('is chosen by NODE_ENV, and by nothing else being trusted to mean production', () => {
      vi.stubEnv('NODE_ENV', 'development');
      expect(currentBuildMode()).toBe('development');

      // Anything that is not literally `development` gets the strict policy, so a misspelled or
      // absent variable fails closed rather than shipping `unsafe-eval`.
      for (const value of ['production', 'test', 'Development', 'dev', '']) {
        vi.stubEnv('NODE_ENV', value);
        expect(currentBuildMode(), `NODE_ENV=${value}`).toBe('production');
      }

      vi.unstubAllEnvs();
    });
  });

  it('states the one relaxation it keeps, rather than hiding it', () => {
    // React sets style attributes and Next inlines a critical-CSS block with no nonce. The
    // exposure is real, smaller than for scripts, and documented in `lib/security-headers.ts`.
    const styleSrc = policy.split('; ').find((directive) => directive.startsWith('style-src')) ?? '';
    expect(styleSrc).toContain('unsafe-inline');

    const source = readFileSync(join(WEB_ROOT, 'lib', 'security-headers.ts'), 'utf8');
    expect(source, 'the style-src relaxation must be explained where it is set').toContain('style-src');
  });
});

describe('the nonce', () => {
  it('is different on every response', () => {
    const nonces = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const csp = respond('/').headers.get(CSP_HEADER) ?? '';
      const match = /'nonce-([^']+)'/.exec(csp);
      expect(match, 'every response must carry a nonce').not.toBeNull();
      nonces.add(match![1]!);
    }

    expect(nonces.size, 'a reused nonce is a CSP with unsafe-inline and extra steps').toBe(50);
  });

  it('is at least 128 bits, the specification’s floor', () => {
    for (let index = 0; index < 10; index += 1) {
      const nonce = generateNonce();
      expect(Buffer.from(nonce, 'base64').length).toBeGreaterThanOrEqual(16);
      // Base64 rather than raw bytes, so it is safe inside an HTML attribute.
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
  });

  it('is put on the request as well, which is how Next nonces its own scripts', () => {
    // Next reads the `Content-Security-Policy` *request* header, finds the nonce, and stamps it
    // onto the framework's inline bootstrap and chunk loaders. Setting only the response header
    // would produce a policy that blocks the page it is protecting.
    const response = respond('/');
    const forwarded = response.headers.get('x-middleware-override-headers') ?? '';

    expect(forwarded.toLowerCase(), 'the nonce must reach the request').toContain(NONCE_HEADER);
    expect(forwarded.toLowerCase(), 'Next reads the CSP off the request').toContain(CSP_HEADER);
  });

  it('sends the identical policy on the request and the response', () => {
    const response = respond('/');
    const onResponse = response.headers.get(CSP_HEADER);
    const onRequest = response.headers.get(`x-middleware-request-${CSP_HEADER}`);

    expect(onRequest, 'the request CSP must be set for Next to read').not.toBeNull();
    expect(onRequest, 'two different policies would nonce the scripts against the wrong one').toBe(onResponse);
  });
});

describe('there is exactly one owner of these headers', () => {
  it('declares no `headers()` in next.config.ts', () => {
    // Static config and middleware both apply. A CSP declared in both is emitted twice.
    const source = readFileSync(join(WEB_ROOT, 'next.config.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    expect(code).not.toContain('headers()');
    expect(code).not.toContain('async headers');
    expect(code).not.toContain('X-Frame-Options');
    expect(code).not.toContain('Content-Security-Policy');
  });

  it('sets them from the one constant, so the test and the middleware read one source', () => {
    const source = readFileSync(join(WEB_ROOT, 'middleware.ts'), 'utf8');

    expect(source).toContain('applySecurityHeaders');
    // No header literals in the middleware itself: they belong to `lib/security-headers.ts`.
    expect(source).not.toContain('max-age=');
    expect(source).not.toContain('nosniff');
  });
});

describe('the matcher covers every path that renders or answers', () => {
  it('is declared, and excludes only immutable build output', () => {
    expect(middlewareConfig.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)']);
  });

  it('matches every route class, including `/`', () => {
    const pattern = new RegExp(`^${middlewareConfig.matcher[0]!}$`);

    for (const [label, path] of ROUTE_CLASSES) {
      expect(pattern.test(path), `${label} (${path}) would receive no security headers`).toBe(true);
    }
  });

  it('skips the asset paths, where a nonce would be generated and thrown away', () => {
    const pattern = new RegExp(`^${middlewareConfig.matcher[0]!}$`);

    for (const asset of ['/_next/static/chunks/main.js', '/_next/image', '/favicon.ico']) {
      expect(pattern.test(asset), `${asset} does not need a per-response nonce`).toBe(false);
    }
  });
});
