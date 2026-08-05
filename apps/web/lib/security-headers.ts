/**
 * The six response headers every Compass response carries, in one place.
 *
 * ## One owner, because two owners is a duplicate header
 *
 * These used to be split: three static ones in `next.config.ts`'s `headers()` and nothing
 * else. A per-response nonce cannot be emitted from `next.config.ts` — it is evaluated once at
 * build time — so the CSP has to come from middleware, and a CSP declared in *both* places
 * emits the header twice. Browsers then intersect the two policies, which is the strictest
 * possible reading of a mistake nobody made on purpose, and any test asserting "exactly the
 * documented value" would fail on a joined string. So middleware owns all six and
 * `next.config.ts` sets none, and `tests/security-headers.test.ts` asserts that `next.config.ts`
 * has no `headers()` at all rather than trusting the comment there.
 *
 * ## Documented values
 *
 * `docs/ENGINEERING.md` quotes every value below verbatim and
 * `tools/quality-gates/tests/security-posture.test.ts` diffs the prose against this module, so
 * "asserted with the documented values" means the documentation is part of the build.
 */

/**
 * `frame-ancestors 'none'` lives in the CSP and cannot live anywhere else.
 *
 * A `<meta http-equiv>` CSP is ignored for `frame-ancestors` by every browser — the directive is
 * about who may embed the document, which has to be answered before the document is parsed. So it
 * is a real response header, and the test that verifies it reads the header rather than the
 * markup. `X-Frame-Options: DENY` is set as well, for the same reason both halves of the
 * append-only guarantee exist: it is the older mechanism, some corporate proxies still act on it,
 * and neither is trusted to be the only one.
 */
export const FRAME_ANCESTORS = "frame-ancestors 'none'";

/** Which bundle this process is serving. The only thing the policy varies on. */
export type BuildMode = 'development' | 'production';

/**
 * `process.env.NODE_ENV` is read as a *static* member expression, deliberately.
 *
 * The middleware runs in the Edge runtime, where the bundler substitutes exactly this expression
 * with a string literal at build time. Reading it dynamically — indexing a `process.env` passed in
 * as a parameter — would not be substituted, would depend on the Edge shim happening to carry the
 * variable, and would fail by silently returning `production` in development: the strict policy
 * again, and the same dead client bundle this function exists to prevent.
 *
 * Anything that is not literally `development` — a production build, `next start`, a test run, an
 * unset variable — gets the strict policy. The relaxation is unreachable by accident.
 */
export function currentBuildMode(): BuildMode {
  return process.env.NODE_ENV === 'development' ? 'development' : 'production';
}

/**
 * The Content-Security-Policy, given this response's nonce.
 *
 * ## `'unsafe-eval'` under `next dev`, and only there
 *
 * This is the one directive that differs between the two bundles, and it differs because the
 * *bundler* differs. `next dev` compiles with webpack's `eval-source-map` devtool: every module
 * arrives wrapped in an `eval("…")` call — the chunk's own header says so — and React Refresh's
 * runtime is the first of them to run. Under a policy without `'unsafe-eval'` that first module
 * throws `EvalError` before hydration begins, which takes the whole client bundle with it: the
 * server-rendered prose is still on screen, so the page *looks* fine, while the Six Spine's active
 * tick, every interactive control and Fast Refresh are all dead, and the console holds one error
 * naming a directive nobody meant to violate.
 *
 * Relaxing it in development is not a weakening of the deployed posture, which is what makes this
 * the right shape rather than a compromise: `next build` emits no `eval` and no `new Function` at
 * all — verified across all 93 chunks of a production build — so the served policy is byte for byte
 * the strict one, and `tests/security-headers.test.ts` asserts both branches rather than whichever
 * one the test process happens to be in.
 *
 * The alternative was to make the dev bundle eval-free by overriding `webpack.devtool` in
 * `next.config.ts`. It is rejected because it trades a real thing for a cosmetic one: dev source
 * maps and Fast Refresh are how this codebase is debugged, and a `next.config.ts` that fights its
 * own dev server is a maintenance burden pointed at a policy that never ships.
 *
 * ## No `unsafe-inline`, and what that cost
 *
 * The deployed `script-src` is `'self' 'nonce-…' 'strict-dynamic'`. The nonce is what lets Next's own
 * hydration bootstrap run: Next reads the CSP off the *request* header the middleware sets and
 * stamps the same nonce onto every script tag it emits, so the framework's inline bootstrap is
 * allowed and an injected one is not. `'strict-dynamic'` extends that trust to scripts those
 * scripts create, which is how Next loads its chunks — without it, `script-src 'self'` would
 * block the very chunks it appears to permit.
 *
 * `style-src` keeps `'unsafe-inline'`, and that is a real limitation stated rather than hidden.
 * React sets `style` attributes for its own layout work and Next inlines a critical-CSS block
 * with no nonce; a nonce-only `style-src` breaks the page. The exposure is meaningfully smaller
 * than for scripts — an injected style can restyle and, with care, exfiltrate via a background
 * URL, which is why `img-src` and `connect-src` below are closed to `'self'`.
 *
 * `object-src 'none'` and `base-uri 'self'` are the two directives that are pure downside to
 * omit: the first kills plugin-based script execution, the second stops an injected `<base>` from
 * repointing every relative URL on the page.
 */
export function contentSecurityPolicy(nonce: string, mode: BuildMode = currentBuildMode()): string {
  // Appended rather than interpolated conditionally, so the production string is unchanged down to
  // its whitespace and a diff of the two policies is one token long.
  const scriptSrc = [`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`];
  if (mode === 'development') scriptSrc.push("'unsafe-eval'");

  return [
    "default-src 'self'",
    scriptSrc.join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Compass talks to its own origin and nothing else. The Anthropic API is called from the
    // worker and from route handlers, never from the browser, so there is no third-party host to
    // allow — `tests/no-third-party-keys.test.tsx` asserts the other half of that.
    "connect-src 'self'",
    "form-action 'self'",
    FRAME_ANCESTORS,
    "object-src 'none'",
    "base-uri 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * The five headers that do not depend on the response.
 *
 *  - **`Strict-Transport-Security`** — two years, subdomains included, `preload`. `preload` is
 *    the half that matters and the half that is a commitment: it asks browser vendors to ship
 *    the domain in a list, so the *first* request to Compass is HTTPS rather than an HTTP
 *    redirect an attacker on the network could intercept. It also means the domain cannot serve
 *    plain HTTP again without waiting out the list, which is stated in `docs/ENGINEERING.md`
 *    beside the value.
 *  - **`X-Content-Type-Options: nosniff`** — a JSON error body must never be sniffed as HTML.
 *    Every route here answers `application/json`, and a browser that guessed otherwise on a body
 *    containing a manager's prose would be executing it.
 *  - **`Referrer-Policy: strict-origin-when-cross-origin`** — report URLs carry team keys, report
 *    ids and share tokens in the path. A full referrer would hand those to every link a manager
 *    clicks out to; the origin alone is enough for anybody who legitimately needs to know where
 *    the traffic came from.
 *  - **`Permissions-Policy`** — camera, microphone and geolocation denied outright. Compass has
 *    no use for any of them, so the honest value is an empty allowlist rather than an absent
 *    header: absent means "whatever the browser defaults to", which is not a decision.
 *  - **`X-Frame-Options: DENY`** — the older sibling of `frame-ancestors`. See above.
 */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-frame-options': 'DENY',
});

/** The header the CSP itself is sent under. */
export const CSP_HEADER = 'content-security-policy';

/** The request header the middleware puts the nonce on, for the root layout to read. */
export const NONCE_HEADER = 'x-compass-nonce';

/**
 * Every header name a response must carry, for the test that samples each route class.
 *
 * Derived from the two constants above rather than listed, so adding a header without extending
 * the assertion is not possible.
 */
export const REQUIRED_SECURITY_HEADERS: readonly string[] = Object.freeze([
  CSP_HEADER,
  ...Object.keys(STATIC_SECURITY_HEADERS),
]);

/**
 * A nonce for one response: 16 bytes, base64.
 *
 * `crypto.getRandomValues` rather than `node:crypto`, because this runs in middleware. Middleware
 * is the Edge runtime by default and `node:crypto` is not available there — and switching the
 * middleware to the Node runtime to get `randomBytes` would be paying a real cost (a heavier
 * runtime on every single request, including `/`) for an identical CSPRNG.
 *
 * 16 bytes is the CSP specification's floor of 128 bits of entropy. A guessable nonce is a CSP
 * with `unsafe-inline` and a longer configuration file.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Applies every security header to a response, and returns it.
 *
 * One function so middleware has one call and the test has one thing to assert against. It sets
 * rather than appends: a `Headers` that already carried a CSP from somewhere else would end up
 * with two, which is the failure the module note above is about.
 */
export function applySecurityHeaders(headers: Headers, nonce: string): Headers {
  headers.set(CSP_HEADER, contentSecurityPolicy(nonce));
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}
