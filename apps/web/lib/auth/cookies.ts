import { SESSION_ABSOLUTE_TTL_MILLIS } from '@compass/auth';
import type { NextResponse } from 'next/server';

/**
 * The session cookie, and the four attributes that make it one.
 *
 * | attribute | value | why |
 * | --------- | ----- | --- |
 * | `httpOnly` | true | Script cannot read it, so an XSS that gets a foothold still cannot exfiltrate the session. |
 * | `secure` | see below | Never sent over plain HTTP in production. |
 * | `sameSite` | `lax` | Not sent on cross-site POSTs, which is CSRF cover for every mutating route; still sent on a top-level GET, which is what makes the magic-link redirect land signed in. `strict` would break that link, and `none` would hand the cookie to any site that framed a form. |
 * | `path` | `/` | One session for the whole app. |
 *
 * `maxAge` matches the session's absolute deadline, so a browser drops the cookie at
 * roughly the moment the server would refuse it. The server is still the authority —
 * a cookie that outlived its row is rejected on arrival — but a browser that has
 * already forgotten it saves a pointless round trip on every request for a month.
 *
 * ## `secure` and localhost
 *
 * `Secure` on `http://localhost` is honoured by modern browsers (localhost is a
 * secure context), but not by every HTTP client a developer might point at a dev
 * server, and `docker compose up` serves plain HTTP on a LAN address where it is
 * genuinely wrong. So it is set whenever the request arrived over HTTPS or the
 * deployment says it is behind TLS, and the decision is made from the request rather
 * than from `NODE_ENV` — a production deployment behind a plain-HTTP sidecar would
 * otherwise set a cookie the browser silently drops, and the symptom would be "login
 * appears to succeed and nothing happens".
 */
export const SESSION_COOKIE_NAME = 'compass_session';

export const SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(SESSION_ABSOLUTE_TTL_MILLIS / 1000);

/** Whether this request reached us over TLS, directly or through a proxy that says so. */
export function requestIsSecure(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return true;

  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto !== null && forwardedProto.split(',')[0]?.trim() === 'https') return true;

  // An explicit deployment statement, for a proxy that strips the header.
  return process.env['COMPASS_ASSUME_HTTPS'] === 'true';
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAge: number;
}

export const sessionCookieOptions = (request: Request): SessionCookieOptions => ({
  httpOnly: true,
  secure: requestIsSecure(request),
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
});

/**
 * Reads the session secret a request presented, or null.
 *
 * Total by construction: **every** unusable value answers `null` rather than throwing,
 * including one that is not valid percent-encoding. `decodeURIComponent('%zz')` raises a
 * `URIError`, and this function is called from inside `guard()` before any handler's
 * try/catch — so an unguarded decode turned one malformed cookie into a 500 on every
 * route at once. Worse, it threw *before* the branch that clears a cookie which has
 * stopped working, so the browser kept presenting the bad value and there was no way,
 * from inside the product, to be rid of it.
 *
 * A value Compass cannot decode is not a session Compass issued. Treating it as absent is
 * both true and the only answer that lets the caller recover: `guard()` sees a cookie
 * present and no identity, and clears it.
 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;

    const value = part.slice(separator + 1).trim();
    if (value.length === 0) return null;

    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whether a request presented *something* under the session cookie's name.
 *
 * Distinct from `readSessionCookie` returning a value, and the distinction is the whole
 * point: a malformed cookie reads as no session but is still on the browser, so
 * `guard()` needs to know it is there in order to clear it.
 */
export function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get('cookie');
  if (header === null) return false;

  return header.split(';').some((part) => {
    const separator = part.indexOf('=');
    return separator !== -1 && part.slice(0, separator).trim() === SESSION_COOKIE_NAME;
  });
}

/** Attaches a freshly-issued session to a response. */
export function setSessionCookie(response: NextResponse, request: Request, secret: string): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, secret, sessionCookieOptions(request));
  return response;
}

// ---------------------------------------------------------------------------
// The single-sign-on nonce
// ---------------------------------------------------------------------------

/**
 * Where the SSO round-trip's nonce lives while the person is at the provider.
 *
 * ## Why a second cookie rather than reusing the session one
 *
 * Because there is usually no session. An SSO sign-in starts with a signed-out browser, so the value
 * that binds the callback to *this* browser cannot live in a session — there is none to put it in.
 *
 * ## Why `SameSite=Lax` and not `Strict`
 *
 * The callback is a top-level navigation from accounts.google.com or github.com, and `Strict` would
 * withhold the cookie on exactly that request — so the nonce would always appear absent and every
 * sign-in would be refused. `Lax` sends it on a top-level GET, which is precisely this case and
 * nothing wider.
 *
 * ## What it is for
 *
 * Login CSRF. The signed `state` is unforgeable but not *bound* to a browser: without a nonce, an
 * attacker can start a flow with their own provider account, capture the resulting callback URL, and
 * feed it to a victim — who would then be silently signed in as the attacker, in the attacker's
 * account, and might go on to type something into it. Comparing the nonce makes a callback usable only
 * in the browser that began the flow.
 */
export const SSO_NONCE_COOKIE_NAME = 'compass_sso_nonce';

/** Ten minutes, matching `SSO_STATE_TTL_MILLIS` — the state expires with it either way. */
export const SSO_NONCE_MAX_AGE_SECONDS = 10 * 60;

export function setSsoNonceCookie(response: NextResponse, request: Request, nonce: string): NextResponse {
  response.cookies.set(SSO_NONCE_COOKIE_NAME, nonce, {
    httpOnly: true,
    secure: requestIsSecure(request),
    sameSite: 'lax',
    path: '/',
    maxAge: SSO_NONCE_MAX_AGE_SECONDS,
  });
  return response;
}

export function readSsoNonceCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SSO_NONCE_COOKIE_NAME) continue;

    const value = part.slice(separator + 1).trim();
    if (value.length === 0) return null;

    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Clears the nonce, which the callback does whatever the outcome.
 *
 * Single-use by construction: a nonce left on the browser after a completed round-trip is one that
 * could be paired with a captured `state` a second time, which is the replay the nonce exists to stop.
 */
export function clearSsoNonceCookie(response: NextResponse, request: Request): NextResponse {
  response.cookies.set(SSO_NONCE_COOKIE_NAME, '', {
    httpOnly: true,
    secure: requestIsSecure(request),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}

/**
 * Clears the cookie.
 *
 * An empty value with `maxAge: 0` rather than `cookies.delete`, because the two
 * differ in one way that matters: `delete` omits the attributes, and a browser only
 * overwrites a cookie whose name, path and domain all match. A `Secure` cookie set at
 * `/` is not cleared by a non-secure deletion at the default path, and the symptom is
 * a sign-out that appears to work until the next request.
 */
export function clearSessionCookie(response: NextResponse, request: Request): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    ...sessionCookieOptions(request),
    maxAge: 0,
  });
  return response;
}
