import { toEpochMillis, type Instant } from '@compass/clock';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sign-in with Google and with GitHub, behind one shape.
 *
 * ## The rule this module exists to enforce
 *
 * **A provider's assertion about an email address is only trusted when the provider says it verified
 * it.** Everything else here follows from that one sentence. An OAuth provider will happily hand over
 * an address its user typed in and never confirmed; treating that as proof of mailbox control turns
 * "sign in with Google" into "type any colleague's address and become them". So `emailVerified`
 * travels with every profile, `resolveSsoSignIn` refuses to auto-link when it is false, and the
 * refusal is a distinct outcome rather than a generic failure so the screen can explain the way back.
 *
 * ## Why the identity is keyed on `subject` and not on the address
 *
 * An email address is mutable and reassignable — somebody changes their surname, or leaves and their
 * address is handed to a new joiner. The provider's own immutable id (`sub` at Google, the numeric
 * `id` at GitHub) is the identity; the address is what the *first* match is made on, and after that it
 * is a stored fact, never the key. `packages/db/src/schema/federated-identity.ts` says the same thing
 * in the unique index.
 *
 * ## No account is ever created by signing in
 *
 * `resolveSsoSignIn` will link to an existing seat and will activate a *pending* one, and it will not
 * create a user. Compass seats are invited; a flow that minted one on first Google login would mean
 * anybody on the internet with a Google account could take a seat in somebody else's organization,
 * which is the same hole as an open registration form with extra steps.
 *
 * ## No clock read, and no `fetch`
 *
 * `now` is a parameter, as everywhere in this package and as `compass/no-system-clock` enforces. The
 * transport is an injected `SsoHttpClient` for the reason the connectors take one: "which requests
 * left the process" is only assertable if there is one seam a test can watch, and a module that called
 * global `fetch` could not be tested without a network.
 */

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * One outbound request. Structurally identical to `@compass/connector-port`'s `HttpClient`.
 *
 * Declared here rather than imported, deliberately. `@compass/auth` depends on `@compass/clock` and
 * `@compass/db` and nothing else, and it sits beside the connector layer rather than above it — a
 * dependency on the connector port to borrow one interface would be a layer edge bought for three
 * lines of types. The shapes match, so the composition root can pass `fetchHttpClient()` to both.
 */
export interface SsoHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | null;
}

export interface SsoHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SsoHttpClient {
  send(request: SsoHttpRequest): Promise<SsoHttpResponse>;
}

// ---------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------

export const SSO_PROVIDERS = ['google', 'github'] as const;

export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export const isSsoProvider = (value: unknown): value is SsoProvider =>
  typeof value === 'string' && (SSO_PROVIDERS as readonly string[]).includes(value);

/**
 * What Compass asks each provider for, and nothing more.
 *
 * Both lists are read-only and are the minimum that answers "who is this, and did you verify their
 * address". This is the one declaration; the consent screen renders *this array* rather than a
 * hand-written copy, for the reason `apps/web/lib/connect-source.ts` gives at length — two copies of a
 * scope list is the shape where the screen keeps promising read-only after somebody widens the
 * request, and the drift is invisible in review because both halves look right alone.
 */
export interface SsoProviderDefinition {
  readonly provider: SsoProvider;
  readonly name: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** Scopes requested, verbatim. Displayed before consent. */
  readonly scopes: readonly string[];
  /** One sentence for the connect screen, saying what Compass will read. */
  readonly reads: string;
  readonly clientIdEnvVar: string;
  readonly clientSecretEnvVar: string;
}

export const SSO_PROVIDER_DEFINITIONS: Readonly<Record<SsoProvider, SsoProviderDefinition>> =
  Object.freeze({
    google: Object.freeze({
      provider: 'google' as const,
      name: 'Google',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      /**
       * `openid` and `email` are what identify the person; `profile` supplies the display name.
       *
       * Deliberately not `https://www.googleapis.com/auth/userinfo.profile` or anything Workspace
       * Admin — Compass reads an identity, never a directory, and never a document.
       */
      scopes: Object.freeze(['openid', 'email', 'profile']),
      reads: 'your name, your email address, and whether Google has verified it. Nothing else — no ' +
        'Drive, no Calendar, no directory.',
      clientIdEnvVar: 'COMPASS_GOOGLE_CLIENT_ID',
      clientSecretEnvVar: 'COMPASS_GOOGLE_CLIENT_SECRET',
    }),
    github: Object.freeze({
      provider: 'github' as const,
      name: 'GitHub',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      /**
       * `read:user` and `user:email`, and the second one is not optional padding.
       *
       * GitHub's `/user` endpoint returns a *public profile* email, which may be null and carries no
       * verification state at all. The only way to learn whether an address is confirmed is
       * `/user/emails`, which needs `user:email`. Without it every GitHub sign-in would arrive
       * unverified and be refused — so the narrower-looking scope list is the one that does not work.
       *
       * Neither scope grants repository access: this is sign-in, and the code connector is a separate
       * GitHub App with its own read-only permissions.
       */
      scopes: Object.freeze(['read:user', 'user:email']),
      reads: 'your name, your GitHub username, and your verified email addresses. No repository ' +
        'access — connecting code is a separate step with its own permissions.',
      clientIdEnvVar: 'COMPASS_GITHUB_SSO_CLIENT_ID',
      clientSecretEnvVar: 'COMPASS_GITHUB_SSO_CLIENT_SECRET',
    }),
  });

/** Every environment variable SSO reads, for `.env.example` and the docs gate. */
export const SSO_ENV_VARS: readonly string[] = Object.freeze(
  SSO_PROVIDERS.flatMap((provider) => [
    SSO_PROVIDER_DEFINITIONS[provider].clientIdEnvVar,
    SSO_PROVIDER_DEFINITIONS[provider].clientSecretEnvVar,
  ]),
);

export const SSO_STATE_SECRET_ENV_VAR = 'COMPASS_SSO_STATE_SECRET';

export type SsoEnvironment = Readonly<Record<string, string | undefined>>;

export interface SsoClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

const trimmed = (value: string | undefined): string => (value ?? '').trim();

/**
 * The client credentials for one provider, or null when this deployment has none.
 *
 * Null is a supported state, not a misconfiguration — the same posture `resolveBillingConfig` takes.
 * A Compass with no Google client signs people in with a password and does not show a Google button;
 * it does not fail to boot, and it does not show a button that 503s.
 */
export function ssoCredentials(
  provider: SsoProvider,
  environment: SsoEnvironment = process.env,
): SsoClientCredentials | null {
  const definition = SSO_PROVIDER_DEFINITIONS[provider];
  const clientId = trimmed(environment[definition.clientIdEnvVar]);
  const clientSecret = trimmed(environment[definition.clientSecretEnvVar]);

  if (clientId.length === 0 || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

/** Which providers this deployment can actually offer. Drives what the sign-in panel renders. */
export function configuredSsoProviders(environment: SsoEnvironment = process.env): readonly SsoProvider[] {
  // A state secret is as required as the client credentials: see `issueSsoState`.
  if (ssoStateSecret(environment) === null) return [];
  return SSO_PROVIDERS.filter((provider) => ssoCredentials(provider, environment) !== null);
}

// ---------------------------------------------------------------------------
// The signed `state`
// ---------------------------------------------------------------------------

/**
 * How long an authorization round-trip may take.
 *
 * Ten minutes, the same window `apps/web/lib/connect-source.ts` uses and for the same reason: it is
 * how long a person actually spends on a consent screen, and short enough that a URL left in a
 * browser history is not a standing key.
 */
export const SSO_STATE_TTL_MILLIS = 10 * 60 * 1000;

const ssoStateSecret = (environment: SsoEnvironment): string | null => {
  const value = trimmed(environment[SSO_STATE_SECRET_ENV_VAR]);
  return value.length === 0 ? null : value;
};

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

const signaturesMatch = (left: string, right: string): boolean =>
  left.length === right.length && timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

export interface SsoState {
  readonly provider: SsoProvider;
  readonly organizationId: string;
  /**
   * A random value echoed back, so a `state` cannot be replayed from one round-trip into another.
   *
   * The signature alone makes the value unforgeable but not unique: without a nonce, a captured state
   * for the right organization stays valid for its whole ten minutes and could be pasted into a
   * second, attacker-initiated flow. The nonce is set in a cookie by the route that mints the state
   * and compared on return, which is what binds the callback to the browser that started it.
   */
  readonly nonce: string;
  /**
   * The signed-in user this flow is *linking* an identity to, or null for a sign-in.
   *
   * Carrying it in the signed state rather than reading the session at the callback is what makes
   * "link" and "sign in" two different acts rather than one act with an ambient mood. A callback that
   * decided from whatever cookie happened to be present would link the identity to whoever was
   * signed in when the redirect landed — which is not necessarily who started it.
   */
  readonly linkUserId: string | null;
}

export type SsoStateVerdict =
  | { readonly ok: true; readonly state: SsoState }
  | {
      readonly ok: false;
      readonly reason: 'unconfigured' | 'malformed' | 'bad_signature' | 'expired' | 'nonce_mismatch';
    };

/** A fresh nonce for one round-trip. 128 bits, base64url, so it is safe in a cookie and a URL. */
export const generateSsoNonce = (): string => randomBytes(16).toString('base64url');

/**
 * The `state` an authorization round-trip carries.
 *
 * Signed rather than stored, exactly as the connector install state and the second-factor challenge
 * are, and the module headers on both explain the trade at length: a callback arrives with no
 * *usable* session, the organization it belongs to therefore has to travel in the URL, and anything
 * that travels in a URL an attacker can also write — so the value is HMAC'd and compared in constant
 * time inside a short window.
 *
 * **There is no fallback secret.** An HMAC under a key committed to the repository is not a
 * signature, so an unset `COMPASS_SSO_STATE_SECRET` disables SSO rather than defaulting to a known
 * key — which is why `configuredSsoProviders` returns nothing without one.
 */
export function issueSsoState(input: {
  readonly provider: SsoProvider;
  readonly organizationId: string;
  readonly nonce: string;
  readonly linkUserId?: string | null;
  readonly now: Instant;
  readonly environment?: SsoEnvironment;
}): string | null {
  const secret = ssoStateSecret(input.environment ?? process.env);
  if (secret === null) return null;

  // `linkUserId` is written as `-` when absent so the field count is fixed and a uuid containing a
  // separator could not shift the meaning of the parts around it.
  const payload = [
    input.provider,
    input.organizationId,
    input.nonce,
    input.linkUserId ?? '-',
    String(toEpochMillis(input.now)),
  ].join('.');

  return `${payload}.${sign(secret, payload)}`;
}

export function verifySsoState(input: {
  readonly state: string | null;
  /** The nonce this browser was given when the flow started, from its cookie. */
  readonly nonce: string | null;
  readonly now: Instant;
  readonly environment?: SsoEnvironment;
}): SsoStateVerdict {
  const secret = ssoStateSecret(input.environment ?? process.env);
  // Fails closed. A callback accepted without a verifiable state is one anybody can forge.
  if (secret === null) return { ok: false, reason: 'unconfigured' };
  if (input.state === null || input.state.length === 0) return { ok: false, reason: 'malformed' };

  const parts = input.state.split('.');
  if (parts.length !== 6) return { ok: false, reason: 'malformed' };

  const [provider, organizationId, nonce, linkUserIdRaw, issuedAtRaw, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (!signaturesMatch(signature, sign(secret, parts.slice(0, 5).join('.')))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Everything below runs only on a value this deployment signed, so a malformed field here is a bug
  // rather than an attack — but it is still refused rather than coerced.
  if (!isSsoProvider(provider) || organizationId.length === 0 || nonce.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: 'malformed' };

  const age = toEpochMillis(input.now) - issuedAt;
  if (age < 0 || age > SSO_STATE_TTL_MILLIS) return { ok: false, reason: 'expired' };

  /**
   * The nonce, checked last and in constant time.
   *
   * Last because a mismatch here is the most specific diagnosis — the state was genuine, unexpired,
   * and still did not belong to this browser — and it is the check that catches a login-CSRF where an
   * attacker feeds a victim a callback URL from a flow the attacker started.
   */
  if (input.nonce === null || !signaturesMatch(nonce, input.nonce)) {
    return { ok: false, reason: 'nonce_mismatch' };
  }

  return {
    ok: true,
    state: {
      provider,
      organizationId,
      nonce,
      linkUserId: linkUserIdRaw === '-' ? null : linkUserIdRaw,
    },
  };
}

/** What to tell somebody whose round-trip was refused. Never says which check failed. */
export const describeSsoStateRejection = (
  reason: Exclude<SsoStateVerdict, { ok: true }>['reason'],
): string =>
  reason === 'unconfigured'
    ? 'Single sign-on is not configured on this deployment. An administrator has to set ' +
      `${SSO_STATE_SECRET_ENV_VAR} and the provider's client credentials before it can be used.`
    : 'That sign-in attempt could not be completed — it may have expired, or it was started in a ' +
      'different browser. Start again from the sign-in screen.';

// ---------------------------------------------------------------------------
// The authorization URL
// ---------------------------------------------------------------------------

/**
 * Where to send somebody to consent, or null when this deployment cannot ask.
 *
 * `redirectUri` is passed in rather than derived from a request header, for the reason
 * `apps/web/lib/auth/guard.ts` gives about `baseUrlFor`: a caller who chose the redirect target would
 * choose where somebody else's authorization code was delivered.
 */
export function ssoAuthorizeUrl(input: {
  readonly provider: SsoProvider;
  readonly redirectUri: string;
  readonly state: string;
  readonly environment?: SsoEnvironment;
}): string | null {
  const environment = input.environment ?? process.env;
  const credentials = ssoCredentials(input.provider, environment);
  if (credentials === null) return null;

  const definition = SSO_PROVIDER_DEFINITIONS[input.provider];
  const url = new URL(definition.authorizeUrl);

  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  // Built from the one scope declaration, so the URL and the consent screen cannot disagree.
  url.searchParams.set('scope', definition.scopes.join(' '));
  url.searchParams.set('state', input.state);

  if (input.provider === 'google') {
    /**
     * `prompt=select_account` rather than the default.
     *
     * Without it, somebody already signed into one Google account is silently authenticated as that
     * account — which on a shared machine signs them in as the previous person, and gives no
     * indication that a choice was made on their behalf.
     */
    url.searchParams.set('prompt', 'select_account');
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// The token exchange and the profile
// ---------------------------------------------------------------------------

/** A provider's answer about who just consented. Normalised across providers. */
export interface SsoProfile {
  readonly provider: SsoProvider;
  /** The provider's immutable id. The identity — never the address. */
  readonly subject: string;
  readonly email: string;
  /** As the provider asserted it. False forbids auto-linking. */
  readonly emailVerified: boolean;
  readonly displayName: string;
}

export type SsoProfileResult =
  | { readonly ok: true; readonly profile: SsoProfile }
  | {
      readonly ok: false;
      readonly reason: 'unconfigured' | 'exchange_failed' | 'profile_failed' | 'no_email';
    };

const jsonObject = (body: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Exchanges the authorization code for a token, then reads the profile.
 *
 * The access token is used for exactly one read and is never stored. That is worth stating because
 * the temptation is real — a stored Google token would let Compass re-read a display name later —
 * and it is refused: this is a sign-in, the token grants access to a person's identity at a third
 * party, and a credential kept for a convenience is a credential in a database dump. The connector
 * path stores tokens because it has to poll; this one does not.
 */
export async function fetchSsoProfile(input: {
  readonly provider: SsoProvider;
  readonly code: string;
  readonly redirectUri: string;
  readonly http: SsoHttpClient;
  readonly environment?: SsoEnvironment;
}): Promise<SsoProfileResult> {
  const environment = input.environment ?? process.env;
  const credentials = ssoCredentials(input.provider, environment);
  if (credentials === null) return { ok: false, reason: 'unconfigured' };

  const definition = SSO_PROVIDER_DEFINITIONS[input.provider];

  const form = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });

  const exchange = await input.http.send({
    method: 'POST',
    url: definition.tokenUrl,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // GitHub answers form-encoded unless asked otherwise; Google always answers JSON. Asking both
      // means one parse path rather than two.
      accept: 'application/json',
    },
    body: form.toString(),
  });

  if (exchange.status < 200 || exchange.status >= 300) return { ok: false, reason: 'exchange_failed' };

  const exchanged = jsonObject(exchange.body);
  const accessToken = exchanged === null ? '' : asString(exchanged['access_token']);
  // An `error` field with a 200 is GitHub's way of refusing a spent or mismatched code.
  if (accessToken.length === 0) return { ok: false, reason: 'exchange_failed' };

  return input.provider === 'google'
    ? googleProfile({ accessToken, http: input.http })
    : githubProfile({ accessToken, http: input.http });
}

const bearer = (accessToken: string): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${accessToken}`,
  accept: 'application/json',
  // GitHub rejects requests with no user agent; Google ignores it.
  'user-agent': 'compass',
});

async function googleProfile(input: {
  readonly accessToken: string;
  readonly http: SsoHttpClient;
}): Promise<SsoProfileResult> {
  /**
   * The OIDC userinfo endpoint, rather than decoding the `id_token`.
   *
   * Verifying an `id_token` locally means fetching and caching Google's JWKS and checking an RS256
   * signature, and getting *any* part of that wrong (a skipped `aud` check, an unchecked `alg`) is a
   * full authentication bypass. Reading userinfo over TLS with the token just obtained gives the same
   * claims with the transport doing the authentication, and there is no signature to get wrong.
   */
  const response = await input.http.send({
    method: 'GET',
    url: 'https://openidconnect.googleapis.com/v1/userinfo',
    headers: bearer(input.accessToken),
  });

  if (response.status < 200 || response.status >= 300) return { ok: false, reason: 'profile_failed' };

  const body = jsonObject(response.body);
  if (body === null) return { ok: false, reason: 'profile_failed' };

  const subject = asString(body['sub']);
  const email = asString(body['email']).toLowerCase();
  if (subject.length === 0) return { ok: false, reason: 'profile_failed' };
  if (email.length === 0) return { ok: false, reason: 'no_email' };

  return {
    ok: true,
    profile: {
      provider: 'google',
      subject,
      email,
      // Strictly `=== true`. Google sends a boolean; some OIDC providers send the string "true", and
      // a truthy check would read the string "false" as verified.
      emailVerified: body['email_verified'] === true,
      displayName: asString(body['name']).length > 0 ? asString(body['name']) : email,
    },
  };
}

async function githubProfile(input: {
  readonly accessToken: string;
  readonly http: SsoHttpClient;
}): Promise<SsoProfileResult> {
  const user = await input.http.send({
    method: 'GET',
    url: 'https://api.github.com/user',
    headers: bearer(input.accessToken),
  });

  if (user.status < 200 || user.status >= 300) return { ok: false, reason: 'profile_failed' };

  const body = jsonObject(user.body);
  if (body === null) return { ok: false, reason: 'profile_failed' };

  // GitHub's `id` is a number and is the immutable identity; `login` is a *renameable* handle, so it
  // is used for the display name and never as the subject.
  const rawId = body['id'];
  const subject = typeof rawId === 'number' ? String(rawId) : asString(rawId);
  if (subject.length === 0) return { ok: false, reason: 'profile_failed' };

  const login = asString(body['login']);
  const name = asString(body['name']);

  /**
   * The address comes from `/user/emails`, never from `/user`.
   *
   * `/user`'s `email` is the *public profile* address: it is often null, and it carries no
   * verification state whatsoever. Only this endpoint says which address is primary and which is
   * confirmed, and both facts are needed — the primary one is the person's own choice of identity,
   * and `verified` is the whole basis on which Compass is willing to link it to an existing seat.
   */
  const emails = await input.http.send({
    method: 'GET',
    url: 'https://api.github.com/user/emails',
    headers: bearer(input.accessToken),
  });

  if (emails.status < 200 || emails.status >= 300) return { ok: false, reason: 'profile_failed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(emails.body);
  } catch {
    return { ok: false, reason: 'profile_failed' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'profile_failed' };

  const entries = parsed
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      email: asString(entry['email']).toLowerCase(),
      primary: entry['primary'] === true,
      verified: entry['verified'] === true,
    }))
    .filter((entry) => entry.email.length > 0);

  /**
   * The primary address if there is one, otherwise the first verified one.
   *
   * The fallback matters: a GitHub account can have no address flagged primary, and refusing that
   * person outright would be a dead end they cannot diagnose. An *unverified* address is still
   * carried forward rather than dropped — `resolveSsoSignIn` is the single place that decides what
   * unverified means, and a profile that silently omitted it would make that decision here instead.
   */
  const chosen = entries.find((entry) => entry.primary) ?? entries.find((entry) => entry.verified) ?? entries[0];
  if (chosen === undefined) return { ok: false, reason: 'no_email' };

  return {
    ok: true,
    profile: {
      provider: 'github',
      subject,
      email: chosen.email,
      emailVerified: chosen.verified,
      displayName: name.length > 0 ? name : login.length > 0 ? login : chosen.email,
    },
  };
}
