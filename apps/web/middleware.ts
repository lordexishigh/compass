import { NextResponse, type NextRequest } from 'next/server';

import { CSP_HEADER, NONCE_HEADER, applySecurityHeaders, generateNonce } from './lib/security-headers';

/**
 * The security headers, and nothing else.
 *
 * ## This middleware cannot gate a request, and that is enforced
 *
 * `lib/auth/guard.ts` explains at length why authorization is **not** here: it runs before `/`,
 * so it would need an exception for the zero-config report — an exception in the one layer no
 * test can see the inside of — and Argon2id is a native addon that cannot load on the Edge
 * runtime. Both of those are still true. What changed is that a per-response CSP nonce has no
 * other home: `next.config.ts`'s `headers()` is evaluated once at build time and cannot vary per
 * response, and a `<meta>` CSP is ignored for `frame-ancestors`.
 *
 * So this file exists and is deliberately incapable of gating anything. It has no database, no
 * session lookup, no `redirect`, no `rewrite` and no conditional on the path: every request gets
 * `NextResponse.next()` with headers on it. `tests/cold-start.test.tsx` asserts those absences
 * against this source — the assertion that used to say "no middleware file exists" now says "the
 * middleware cannot gate the first request", which is the property that was ever actually wanted.
 *
 * ## Why the nonce goes on the *request* headers too
 *
 * Two readers need it. The root layout reads `NONCE_HEADER` to stamp `nonce` on any script it
 * renders. Next.js itself reads the `Content-Security-Policy` request header, finds the
 * `nonce-…` in it, and stamps that same nonce onto the framework's own inline bootstrap and
 * chunk-loading scripts — which is the mechanism that makes a CSP with no `unsafe-inline`
 * survive hydration. Setting only the response header would produce a policy that blocks the
 * page it is protecting.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = generateNonce();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  // Read by Next to nonce its own scripts. Must be the same policy string as the response's.
  requestHeaders.set(CSP_HEADER, csp(nonce));

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response.headers, nonce);
  return response;
}

/** Kept out of line so the response and the request provably carry the identical policy. */
const csp = (nonce: string): string => {
  const headers = new Headers();
  applySecurityHeaders(headers, nonce);
  return headers.get(CSP_HEADER) ?? '';
};

/**
 * Every path except the ones that are bytes on disk.
 *
 * `_next/static` and `_next/image` are immutable build output and `favicon.ico` is a file; a CSP
 * on a JavaScript chunk protects nothing and a nonce generated for one is thrown away. Excluding
 * them keeps the Edge invocation off the hot path for every asset on every page load.
 *
 * Everything else is included, which specifically means `/` is included. That is safe *because*
 * this middleware cannot gate — the matcher and the public-route entry in `ROLE_MATRIX` do not
 * have to be kept in agreement, since there is no decision here to agree with.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
