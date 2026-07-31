import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS, SESSION_ABSOLUTE_TTL_MILLIS, findRouteRule, type Action } from '@compass/auth';
import { NextResponse } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  hasSessionCookie,
  readSessionCookie,
  requestIsSecure,
  sessionCookieOptions,
  setSessionCookie,
} from '../lib/auth/cookies';
import { baseUrlFor } from '../lib/auth/guard';
import { LinkOriginUnavailableError } from '../lib/auth/http';

/**
 * The HTTP half: the session cookie's attributes, and the guard on every route.
 *
 * The cookie assertions run the *real* helper against a real `NextResponse` and read the
 * `Set-Cookie` header back out, because the criterion is about the header a browser
 * receives and not about an options object somebody wrote down.
 *
 * The guard assertions are a source scan, and that is the honest tool for the claim: "every
 * route enforces the matrix" is a property of every handler in the tree, and the only way
 * to check all of them is to read all of them.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), 'utf8');

/** The `Set-Cookie` header a response carries for the session cookie. */
function setCookieHeader(response: NextResponse): string {
  const headers = response.headers.getSetCookie();
  const found = headers.find((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (found === undefined) {
    throw new Error(`No ${SESSION_COOKIE_NAME} cookie in [${headers.join(' | ')}]`);
  }
  return found;
}

const httpsRequest = () => new Request('https://compass.example.com/api/auth/login', { method: 'POST' });
const httpRequest = () => new Request('http://localhost:3000/api/auth/login', { method: 'POST' });

describe('the session cookie a successful sign-in sets', () => {
  it('is httpOnly, Secure, SameSite=Lax and scoped to the whole app', () => {
    const header = setCookieHeader(setSessionCookie(NextResponse.json({ ok: true }), httpsRequest(), 'a-secret'));

    // Each attribute is asserted by name, because each one is a separate criterion and a
    // single regex over the whole header would pass with one of them missing.
    expect(header, 'script must not be able to read a bearer credential').toContain('HttpOnly');
    expect(header, 'the cookie must never travel over plain HTTP').toContain('Secure');
    expect(header, 'SameSite=Lax is the CSRF cover for every mutating route').toMatch(/SameSite=Lax/i);
    expect(header).toContain('Path=/');
    expect(header).toContain('a-secret');
  });

  it('expires with the session’s own absolute deadline rather than at some other number', () => {
    const header = setCookieHeader(setSessionCookie(NextResponse.json({ ok: true }), httpsRequest(), 'a-secret'));

    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(SESSION_ABSOLUTE_TTL_MILLIS / 1000);
    expect(header).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
  });

  it('sets Secure from the request rather than from NODE_ENV', () => {
    // A production deployment behind a plain-HTTP sidecar would otherwise set a cookie the
    // browser silently drops, and the symptom is "sign-in appears to work and nothing
    // happens".
    expect(requestIsSecure(httpsRequest())).toBe(true);
    expect(requestIsSecure(httpRequest())).toBe(false);

    const forwarded = new Request('http://internal:3000/api/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    expect(requestIsSecure(forwarded), 'the first hop is what the browser saw').toBe(true);
  });

  it('keeps the same attributes when it clears the cookie', () => {
    // A `Secure` cookie at `/` is not cleared by a non-secure deletion at the default
    // path: the name, path and domain all have to match, or the browser keeps the old one
    // and the sign-out silently does nothing.
    const header = setCookieHeader(clearSessionCookie(NextResponse.json({ ok: true }), httpsRequest()));

    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=0');
  });

  it('never puts a session secret in the response body', async () => {
    // The route answers with the seat's role and the deadline, never with the credential:
    // a body containing it would be readable by script, which is the whole thing
    // `httpOnly` exists to prevent.
    const response = setSessionCookie(
      NextResponse.json({ signedIn: true, role: 'manager' }),
      httpsRequest(),
      'the-secret-value',
    );

    expect(await response.clone().text()).not.toContain('the-secret-value');
  });

  it('puts it only in the cookie machinery, and in no other header', () => {
    const response = setSessionCookie(NextResponse.json({ signedIn: true }), httpsRequest(), 'the-secret-value');

    // `x-middleware-set-cookie` is Next's own internal mirror of the Set-Cookie it will
    // emit; it is consumed and stripped before the response leaves. Everything else must
    // be clean — a secret echoed into, say, a `location` header would end up in access
    // logs and in the browser's history.
    const internal = new Set(['set-cookie', 'x-middleware-set-cookie']);

    for (const [name, value] of response.headers.entries()) {
      if (internal.has(name.toLowerCase())) continue;
      expect(value, `${name} carries the session secret`).not.toContain('the-secret-value');
    }
  });

  it('states the options it will use, so the login route cannot pass its own', () => {
    const options = sessionCookieOptions(httpsRequest());

    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
  });
});

describe('reading the cookie back off a request', () => {
  it('finds it among others, and ignores a cookie that merely starts the same way', () => {
    const request = new Request('https://compass.example.com/', {
      headers: {
        cookie: `theme=dark; ${SESSION_COOKIE_NAME}_other=decoy; ${SESSION_COOKIE_NAME}=the-real-one; locale=en`,
      },
    });

    expect(readSessionCookie(request)).toBe('the-real-one');
  });

  it('answers null when there is no cookie header at all, and for an empty value', () => {
    expect(readSessionCookie(new Request('https://compass.example.com/'))).toBeNull();
    expect(
      readSessionCookie(
        new Request('https://compass.example.com/', { headers: { cookie: `${SESSION_COOKIE_NAME}=` } }),
      ),
    ).toBeNull();
  });

  it('answers null for a value that is not valid percent-encoding, rather than throwing', () => {
    // `decodeURIComponent('%zz')` raises URIError. This function is called from inside
    // `guard()`, before any handler's try/catch, so an unguarded decode turned one
    // malformed cookie into a 500 on every route at once — and it threw *before* the
    // branch that clears a cookie which has stopped working, so the browser kept
    // presenting the bad value with no way for the person holding it to recover.
    for (const bad of ['%zz', '%', '%E0%A4%A', 'ok%', '%C0%80%']) {
      const request = new Request('https://compass.example.com/', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${bad}` },
      });

      expect(() => readSessionCookie(request), `\`${bad}\` threw`).not.toThrow();
      expect(readSessionCookie(request), `\`${bad}\` was treated as a session`).toBeNull();
    }
  });

  it('still reports that a malformed cookie is present, so the guard can clear it', () => {
    // The two questions are different, and both matter: the value is not a session, and
    // there is nevertheless a cookie on the browser that needs overwriting.
    const request = new Request('https://compass.example.com/', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=%zz` },
    });

    expect(readSessionCookie(request)).toBeNull();
    expect(hasSessionCookie(request)).toBe(true);
  });

  it('reports no cookie when there genuinely is none', () => {
    expect(hasSessionCookie(new Request('https://compass.example.com/'))).toBe(false);
    expect(
      hasSessionCookie(new Request('https://compass.example.com/', { headers: { cookie: 'theme=dark' } })),
    ).toBe(false);
  });

  it('round-trips a value the cookie encoder would have escaped', () => {
    // Session secrets are base64url and need no escaping, but the reader must not corrupt a
    // value that did — a half-decoded secret would be an unexplained sign-out.
    const response = setSessionCookie(NextResponse.json({}), httpsRequest(), 'a+b/c=d');
    const header = setCookieHeader(response);
    const value = header.slice(`${SESSION_COOKIE_NAME}=`.length, header.indexOf(';'));

    expect(readSessionCookie(new Request('https://x.test/', { headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` } }))).toBe(
      'a+b/c=d',
    );
  });
});

// ---------------------------------------------------------------------------
// Where a mailed link may point
// ---------------------------------------------------------------------------

/**
 * `POST /api/auth/password-reset` is public and answers identically for an address that
 * has a seat and one that does not — deliberately, so the form is not a membership
 * oracle. Which means an unauthenticated caller can make Compass mail a **valid
 * single-use token** to somebody else.
 *
 * If the origin of that link came from a request header, that same caller would also
 * choose where the victim's token pointed. These tests pin the rule that it cannot.
 */
describe('the origin of a mailed link', () => {
  const ORIGINAL = process.env['COMPASS_BASE_URL'];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['COMPASS_BASE_URL'];
    else process.env['COMPASS_BASE_URL'] = ORIGINAL;
  });

  const requestFrom = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { method: 'POST', headers });

  it('ignores x-forwarded-host entirely', () => {
    delete process.env['COMPASS_BASE_URL'];

    // The attack: a public reset request carrying a host the caller chose.
    expect(() =>
      baseUrlFor(requestFrom('https://compass.example.com/api/auth/password-reset', {
        'x-forwarded-host': 'evil.example',
      })),
    ).toThrow(LinkOriginUnavailableError);
  });

  it('ignores a Host header that is not this machine', () => {
    delete process.env['COMPASS_BASE_URL'];

    // `request.url` in a route handler is built from the Host header, so it is attacker
    // controlled in the same way and gets the same treatment.
    expect(() => baseUrlFor(requestFrom('https://evil.example/api/auth/password-reset'))).toThrow(
      LinkOriginUnavailableError,
    );
  });

  it('names the variable to set when it refuses', () => {
    delete process.env['COMPASS_BASE_URL'];

    try {
      baseUrlFor(requestFrom('https://evil.example/api/auth/password-reset'));
      throw new Error('baseUrlFor accepted an unverified host.');
    } catch (error) {
      expect(error).toBeInstanceOf(LinkOriginUnavailableError);
      expect((error as Error).message).toContain('COMPASS_BASE_URL');
      // And it says *why*, because a bare "not configured" reads as a bug rather than a
      // deliberate refusal somebody has to make a decision about.
      expect((error as Error).message).toContain('called by anyone');
    }
  });

  it('uses the configured origin, whatever the request claims', () => {
    process.env['COMPASS_BASE_URL'] = 'https://compass.acme.example/';

    const origin = baseUrlFor(
      requestFrom('https://evil.example/api/auth/password-reset', { 'x-forwarded-host': 'also-evil.example' }),
    );

    expect(origin).toBe('https://compass.acme.example');
  });

  it('accepts a loopback Host with nothing configured, which is the zero-config path', () => {
    delete process.env['COMPASS_BASE_URL'];

    // `docker compose up` then a browser on localhost. A link to the reader's own machine
    // is harmless whoever asked for it, so this is the one host that needs no allowlist.
    expect(baseUrlFor(requestFrom('http://localhost:3000/api/auth/magic-link'))).toBe('http://localhost:3000');
    expect(baseUrlFor(requestFrom('http://127.0.0.1:3000/api/auth/magic-link'))).toBe('http://127.0.0.1:3000');
  });

  it('refuses a configured value that is not an absolute http(s) URL', () => {
    // Better to refuse than to mail a link nobody can open.
    for (const bad of ['compass.acme.example', 'ftp://compass.acme.example', 'not a url']) {
      process.env['COMPASS_BASE_URL'] = bad;
      expect(
        () => baseUrlFor(requestFrom('http://localhost:3000/api/auth/magic-link')),
        `\`${bad}\` was accepted`,
      ).toThrow(LinkOriginUnavailableError);
    }
  });

  it('drops a path and a trailing slash, so the link is not built with a double one', () => {
    process.env['COMPASS_BASE_URL'] = 'https://compass.acme.example/compass/';

    expect(baseUrlFor(requestFrom('http://localhost:3000/api/auth/magic-link'))).toBe(
      'https://compass.acme.example',
    );
  });
});

// ---------------------------------------------------------------------------
// Every route enforces the matrix
// ---------------------------------------------------------------------------

interface RouteFile {
  readonly route: string;
  readonly file: string;
  readonly source: string;
  readonly verbs: readonly Action[];
}

function routeFiles(): readonly RouteFile[] {
  const found: RouteFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== 'route.ts') continue;

      const source = readFileSync(full, 'utf8');
      const segments = relative(join(WEB_ROOT, 'app'), dirname(full)).split(sep);
      found.push({
        route: `/${segments.join('/')}`,
        file: relative(WEB_ROOT, full),
        source,
        verbs: ACTIONS.filter((action) => new RegExp(`export async function ${action}\\s*\\(`).test(source)),
      });
    }
  };

  walk(join(WEB_ROOT, 'app', 'api'));
  return found.sort((left, right) => (left.route < right.route ? -1 : 1));
}

const ROUTE_FILES = routeFiles();

describe('the matrix is enforced server-side on every route', () => {
  it('found the route files, so an empty walk cannot pass this file', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(10);
    expect(ROUTE_FILES.every((entry) => entry.verbs.length > 0)).toBe(true);
  });

  it.each(ROUTE_FILES.map((entry) => [entry.route, entry] as const))(
    '%s calls guard() before doing anything',
    (_route, entry) => {
      expect(entry.source, `${entry.file} does not import the shared guard`).toMatch(
        /import \{[^}]*\bguard\b[^}]*\} from '[^']*lib\/auth\/guard'/,
      );

      // One `guard({ ... route: … })` call per verb the file serves. A handler that
      // forgot one would be a handler nothing decided about.
      const guardCalls = [...entry.source.matchAll(/guard\(\{/g)].length;
      expect(
        guardCalls,
        `${entry.file} serves ${entry.verbs.join(', ')} but calls guard() ${guardCalls} time(s)`,
      ).toBeGreaterThanOrEqual(entry.verbs.length);
    },
  );

  it.each(ROUTE_FILES.map((entry) => [entry.route, entry] as const))(
    '%s names itself to the matrix with the route the filesystem gives it',
    (route, entry) => {
      // The guard is keyed by the route string, so a typo would silently authorise
      // against a *different* row of the matrix — or none, which denies. Either way the
      // route the file is at has to be the route it declares.
      expect(entry.source, `${entry.file} must pass route: '${route}'`).toContain(`'${route}'`);
      expect(findRouteRule(route), `${route} has no matrix entry`).not.toBeNull();
    },
  );

  it.each(ROUTE_FILES.map((entry) => [entry.route, entry] as const))(
    '%s pins the Node runtime, because Argon2id is a native addon',
    (_route, entry) => {
      // A handler that ended up on the Edge runtime would fail to load the binding. Pinned
      // on every route rather than only the hashing ones, so the guard — which reaches the
      // database — is never the one that gets moved.
      expect(entry.source, `${entry.file} must declare runtime = 'nodejs'`).toMatch(
        /export const runtime = 'nodejs'/,
      );
    },
  );

  it('declares a matrix action for every verb each route actually serves', () => {
    const missing: string[] = [];

    for (const entry of ROUTE_FILES) {
      const rule = findRouteRule(entry.route);
      for (const verb of entry.verbs) {
        if ((rule?.allow[verb]?.length ?? 0) === 0) missing.push(`${entry.route} ${verb}`);
      }
    }

    expect(missing, 'these verbs are served but permitted to nobody, so they would always 405').toEqual([]);
  });

  it('declares no matrix action that no route serves', () => {
    const served = new Map(ROUTE_FILES.map((entry) => [entry.route, entry.verbs]));
    const phantom: string[] = [];

    for (const route of served.keys()) {
      const rule = findRouteRule(route);
      if (rule === null) continue;
      for (const action of ACTIONS) {
        if ((rule.allow[action]?.length ?? 0) === 0) continue;
        if (!(served.get(route) ?? []).includes(action)) phantom.push(`${route} ${action}`);
      }
    }

    expect(phantom, 'the matrix permits these, but no handler serves them').toEqual([]);
  });
});

describe('the report route still passes no gate', () => {
  it('never calls the guard, reads a cookie, or redirects', () => {
    // `/` is the zero-config promise. The matrix carries the public entry for it — see
    // `authz-matrix.test.ts` — and the page itself has nothing in it that could gate.
    const page = read('app', 'page.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    for (const forbidden of ['guard(', 'pageAccess(', 'cookies(', 'redirect(', 'headers(']) {
      expect(page, `\`${forbidden}\` on / would gate the first request`).not.toContain(forbidden);
    }
  });

  it('has an /account route rather than a /login one, so no directory reads as a gate', () => {
    const directories = readdirSync(join(WEB_ROOT, 'app'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories).toContain('account');
    for (const gate of ['login', 'signin', 'sign-in', 'setup', 'onboarding', 'connect', 'welcome']) {
      expect(directories, `app/${gate} would read as a gate on the way to the report`).not.toContain(gate);
    }
  });

  it('reaches the account screen from the report rather than the other way round', () => {
    expect(read('components', 'report-document.tsx')).toContain('href="/account"');
  });
});
