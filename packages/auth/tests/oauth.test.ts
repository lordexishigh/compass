import {
  SSO_PROVIDER_DEFINITIONS,
  SSO_PROVIDERS,
  SSO_STATE_SECRET_ENV_VAR,
  SSO_STATE_TTL_MILLIS,
  configuredSsoProviders,
  fetchSsoProfile,
  generateSsoNonce,
  isSsoProvider,
  issueSsoState,
  ssoAuthorizeUrl,
  ssoCredentials,
  verifySsoState,
  type SsoHttpClient,
  type SsoHttpRequest,
  type SsoHttpResponse,
} from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

/**
 * Google and GitHub sign-in: the scopes, the signed state, and the profile read.
 *
 * The two claims worth stating up front, because they are the acceptance criteria:
 *
 *  - **The requested scopes are exactly the documented read-only set.** Asserted as an exact array
 *    equality rather than a `toContain`, so *widening* the request fails this file. A `toContain` check
 *    would pass happily after somebody added `repo` to the GitHub list.
 *  - **An unverified provider email never auto-links.** That decision lives in `federated-sign-in.ts`
 *    and is asserted there against a database; what this file proves is the half that feeds it — that
 *    `emailVerified` reflects what the provider actually said, including for GitHub, where the answer
 *    comes from a second endpoint and `/user` alone cannot supply it.
 */

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-05T09:00:00Z');

const ENVIRONMENT = {
  [SSO_STATE_SECRET_ENV_VAR]: 'a-state-secret-for-tests-only-not-a-credential',
  COMPASS_GOOGLE_CLIENT_ID: 'google-client-id.apps.googleusercontent.com',
  COMPASS_GOOGLE_CLIENT_SECRET: 'google-client-secret-fixture',
  COMPASS_GITHUB_SSO_CLIENT_ID: 'github-client-id-fixture',
  COMPASS_GITHUB_SSO_CLIENT_SECRET: 'github-client-secret-fixture',
} as const;

const ORGANIZATION_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c61';

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

describe('the requested scopes are exactly the documented read-only set', () => {
  it('asks Google for identity only — no Drive, no Calendar, no directory', () => {
    // Exact equality, not `toContain`: widening the request must fail this test.
    expect(SSO_PROVIDER_DEFINITIONS.google.scopes).toEqual(['openid', 'email', 'profile']);
  });

  it('asks GitHub for read:user and user:email, and nothing that touches a repository', () => {
    expect(SSO_PROVIDER_DEFINITIONS.github.scopes).toEqual(['read:user', 'user:email']);
  });

  it('requests no write, admin or repository scope on either provider', () => {
    // A property rather than a list, so a scope nobody thought to enumerate is still caught.
    for (const provider of SSO_PROVIDERS) {
      for (const scope of SSO_PROVIDER_DEFINITIONS[provider].scopes) {
        expect(scope, `${provider} asks for ${scope}`).not.toMatch(
          /write|admin|delete|repo\b|workflow|gist|org:|Drive|calendar/i,
        );
      }
    }
  });

  it('puts the one scope declaration into the authorization URL, so the two cannot drift', () => {
    for (const provider of SSO_PROVIDERS) {
      const url = ssoAuthorizeUrl({
        provider,
        redirectUri: 'https://compass.example/api/auth/sso/callback',
        state: 'state-value',
        environment: ENVIRONMENT,
      });

      expect(url).not.toBeNull();
      expect(new URL(url!).searchParams.get('scope')).toBe(
        SSO_PROVIDER_DEFINITIONS[provider].scopes.join(' '),
      );
    }
  });

  it('states what each provider will read, for the consent screen to render verbatim', () => {
    for (const provider of SSO_PROVIDERS) {
      expect(SSO_PROVIDER_DEFINITIONS[provider].reads.length).toBeGreaterThan(30);
    }
  });
});

describe('the authorization URL', () => {
  it('carries the client id, the redirect, the state and an authorization-code response type', () => {
    const url = new URL(
      ssoAuthorizeUrl({
        provider: 'google',
        redirectUri: 'https://compass.example/api/auth/sso/google/callback',
        state: 'signed-state',
        environment: ENVIRONMENT,
      })!,
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(ENVIRONMENT.COMPASS_GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://compass.example/api/auth/sso/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('signed-state');
  });

  it('asks Google to let the reader choose an account, so a shared machine does not sign in silently', () => {
    const url = new URL(
      ssoAuthorizeUrl({
        provider: 'google',
        redirectUri: 'https://compass.example/cb',
        state: 's',
        environment: ENVIRONMENT,
      })!,
    );

    expect(url.searchParams.get('prompt')).toBe('select_account');
  });

  it('is null when the deployment has no client credentials, rather than a URL that cannot work', () => {
    expect(
      ssoAuthorizeUrl({
        provider: 'github',
        redirectUri: 'https://compass.example/cb',
        state: 's',
        environment: { [SSO_STATE_SECRET_ENV_VAR]: 'secret' },
      }),
    ).toBeNull();
  });
});

describe('which providers a deployment offers', () => {
  it('offers only the ones with both a client id and a secret', () => {
    expect(configuredSsoProviders(ENVIRONMENT)).toEqual(['google', 'github']);
    expect(
      configuredSsoProviders({
        [SSO_STATE_SECRET_ENV_VAR]: 'secret',
        COMPASS_GOOGLE_CLIENT_ID: 'id',
        COMPASS_GOOGLE_CLIENT_SECRET: 'secret',
      }),
    ).toEqual(['google']);
  });

  it('offers none at all without a state secret, because the callback would be unverifiable', () => {
    const { [SSO_STATE_SECRET_ENV_VAR]: _omitted, ...withoutSecret } = ENVIRONMENT;

    expect(configuredSsoProviders(withoutSecret)).toEqual([]);
  });

  it('treats whitespace as absent, so a blank line in an env file does not enable a provider', () => {
    expect(
      ssoCredentials('google', {
        COMPASS_GOOGLE_CLIENT_ID: '   ',
        COMPASS_GOOGLE_CLIENT_SECRET: 'secret',
      }),
    ).toBeNull();
  });

  it('recognises exactly two providers', () => {
    expect(isSsoProvider('google')).toBe(true);
    expect(isSsoProvider('github')).toBe(true);
    expect(isSsoProvider('saml')).toBe(false);
    expect(isSsoProvider('okta')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The signed state
// ---------------------------------------------------------------------------

describe('the signed state', () => {
  const nonce = 'a-fixed-nonce-value';

  const issue = (overrides: Partial<Parameters<typeof issueSsoState>[0]> = {}) =>
    issueSsoState({
      provider: 'google',
      organizationId: ORGANIZATION_ID,
      nonce,
      now: NOW,
      environment: ENVIRONMENT,
      ...overrides,
    });

  it('round-trips the provider, the organization and the link target', () => {
    const verdict = verifySsoState({
      state: issue({ linkUserId: 'user-1' })!,
      nonce,
      now: NOW,
      environment: ENVIRONMENT,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.state).toEqual({
      provider: 'google',
      organizationId: ORGANIZATION_ID,
      nonce,
      linkUserId: 'user-1',
    });
  });

  it('distinguishes a sign-in from a link by the absence of a user id', () => {
    const verdict = verifySsoState({ state: issue()!, nonce, now: NOW, environment: ENVIRONMENT });

    expect(verdict.ok && verdict.state.linkUserId).toBeNull();
  });

  it('refuses a tampered organization, which is the whole reason it is signed', () => {
    /**
     * The attack this stops: rewriting the organization in the URL so a provider identity is attached
     * to a seat in somebody else's tenant.
     */
    const state = issue()!;
    const forged = state.replace(ORGANIZATION_ID, '11111111-1111-4111-8111-111111111111');

    expect(verifySsoState({ state: forged, nonce, now: NOW, environment: ENVIRONMENT })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a tampered link target, so a callback cannot be redirected onto another account', () => {
    const state = issue({ linkUserId: 'user-1' })!;
    const forged = state.replace('user-1', 'user-2');

    expect(verifySsoState({ state: forged, nonce, now: NOW, environment: ENVIRONMENT })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a state signed with a different secret', () => {
    const state = issueSsoState({
      provider: 'google',
      organizationId: ORGANIZATION_ID,
      nonce,
      now: NOW,
      environment: { [SSO_STATE_SECRET_ENV_VAR]: 'a-different-secret' },
    })!;

    expect(verifySsoState({ state, nonce, now: NOW, environment: ENVIRONMENT }).ok).toBe(false);
  });

  it('expires after ten minutes, and is refused a millisecond past it', () => {
    const state = issue()!;
    const justInside = at('2026-08-05T09:09:59Z');
    const justOutside = instantFromIso(
      new Date(Date.parse('2026-08-05T09:00:00Z') + SSO_STATE_TTL_MILLIS + 1).toISOString(),
    );

    expect(verifySsoState({ state, nonce, now: justInside, environment: ENVIRONMENT }).ok).toBe(true);
    expect(verifySsoState({ state, nonce, now: justOutside, environment: ENVIRONMENT })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a state from the future, which is a replayed or forged issue time', () => {
    const state = issue()!;

    expect(
      verifySsoState({ state, nonce, now: at('2026-08-05T08:00:00Z'), environment: ENVIRONMENT }).ok,
    ).toBe(false);
  });

  /**
   * The nonce, which is the login-CSRF defence.
   *
   * Without it a signed state is unforgeable but not *bound to a browser*: an attacker starts a flow
   * with their own provider account, captures the callback URL, and feeds it to a victim — who is
   * silently signed in as the attacker and may then type something into the attacker's account.
   */
  it('refuses a callback presented in a browser that did not start the flow', () => {
    const state = issue()!;

    expect(
      verifySsoState({ state, nonce: 'a-different-browsers-nonce', now: NOW, environment: ENVIRONMENT }),
    ).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it('refuses a callback with no nonce cookie at all', () => {
    expect(verifySsoState({ state: issue()!, nonce: null, now: NOW, environment: ENVIRONMENT })).toEqual({
      ok: false,
      reason: 'nonce_mismatch',
    });
  });

  it('checks the nonce after the signature, so a forgery is not diagnosed as a nonce problem', () => {
    const forged = issue()!.replace(ORGANIZATION_ID, '11111111-1111-4111-8111-111111111111');

    expect(
      verifySsoState({ state: forged, nonce: 'wrong-too', now: NOW, environment: ENVIRONMENT }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('fails closed with no secret configured, rather than accepting an unsigned state', () => {
    expect(issueSsoState({ provider: 'google', organizationId: ORGANIZATION_ID, nonce, now: NOW, environment: {} })).toBeNull();
    expect(verifySsoState({ state: 'anything', nonce, now: NOW, environment: {} })).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it('refuses a malformed state without throwing', () => {
    for (const state of ['', 'a.b.c', 'a.b.c.d.e.f.g', 'not-a-state']) {
      expect(verifySsoState({ state, nonce, now: NOW, environment: ENVIRONMENT }).ok).toBe(false);
    }
  });

  it('generates a nonce with enough entropy to be unguessable, and a fresh one each time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateSsoNonce()));

    expect(nonces.size).toBe(50);
    for (const value of nonces) expect(value.length).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// The token exchange and the profile
// ---------------------------------------------------------------------------

/** A transport that answers from a script and records every request, so calls can be asserted. */
function scriptedHttp(
  answers: readonly { readonly match: string; readonly status?: number; readonly body: unknown }[],
): SsoHttpClient & { readonly requests: SsoHttpRequest[] } {
  const requests: SsoHttpRequest[] = [];

  return {
    requests,
    // The return type is annotated rather than inferred: without it the two branches widen into a
    // union whose header maps are not both `Record<string, string>`, which `tsc -p tsconfig.tests.json`
    // rejects even though vitest runs it happily.
    async send(request: SsoHttpRequest): Promise<SsoHttpResponse> {
      requests.push(request);
      const answer = answers.find((entry) => request.url.includes(entry.match));

      if (answer === undefined) return { status: 404, headers: {}, body: '{}' };
      return {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
        body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
      };
    },
  };
}

describe('reading a Google profile', () => {
  const exchange = { match: 'oauth2.googleapis.com/token', body: { access_token: 'google-access-token' } };

  it('takes the subject from `sub` and the verification state from `email_verified`', async () => {
    const http = scriptedHttp([
      exchange,
      {
        match: 'openidconnect.googleapis.com/v1/userinfo',
        body: { sub: '1029384756', email: 'Priya@Example.com', email_verified: true, name: 'Priya Raman' },
      },
    ]);

    const result = await fetchSsoProfile({
      provider: 'google',
      code: 'auth-code',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.profile).toEqual({
      provider: 'google',
      // The immutable subject, never the address.
      subject: '1029384756',
      // Normalised, so a match against a stored address cannot fail on capitalisation.
      email: 'priya@example.com',
      emailVerified: true,
      displayName: 'Priya Raman',
    });
  });

  it('reports an unverified address as unverified rather than dropping it', async () => {
    const http = scriptedHttp([
      exchange,
      {
        match: 'userinfo',
        body: { sub: '1029384756', email: 'priya@example.com', email_verified: false, name: 'Priya' },
      },
    ]);

    const result = await fetchSsoProfile({
      provider: 'google',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    // Carried forward, not refused here: one module decides what unverified *means*.
    expect(result.ok && result.profile.emailVerified).toBe(false);
  });

  it('treats the string "true" as unverified, because only a boolean is an assertion', async () => {
    const http = scriptedHttp([
      exchange,
      { match: 'userinfo', body: { sub: 's', email: 'a@b.com', email_verified: 'true' } },
    ]);

    const result = await fetchSsoProfile({
      provider: 'google',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    /**
     * Strict `=== true`, and this test is why.
     *
     * A truthy check would read the *string* `"false"` as verified, which is the shape of bug that turns
     * a careful linking rule into no rule at all.
     */
    expect(result.ok && result.profile.emailVerified).toBe(false);
  });

  it('refuses when the token exchange fails', async () => {
    const http = scriptedHttp([{ match: 'token', status: 400, body: { error: 'invalid_grant' } }]);

    expect(
      await fetchSsoProfile({
        provider: 'google',
        code: 'spent-code',
        redirectUri: 'https://compass.example/cb',
        http,
        environment: ENVIRONMENT,
      }),
    ).toEqual({ ok: false, reason: 'exchange_failed' });
  });

  it('refuses a 200 with no access token, which is how GitHub reports a spent code', async () => {
    const http = scriptedHttp([{ match: 'token', body: { error: 'bad_verification_code' } }]);

    expect(
      (
        await fetchSsoProfile({
          provider: 'github',
          code: 'spent',
          redirectUri: 'https://compass.example/cb',
          http,
          environment: ENVIRONMENT,
        })
      ).ok,
    ).toBe(false);
  });

  it('refuses when the provider releases no address', async () => {
    const http = scriptedHttp([exchange, { match: 'userinfo', body: { sub: 's', email_verified: true } }]);

    expect(
      await fetchSsoProfile({
        provider: 'google',
        code: 'c',
        redirectUri: 'https://compass.example/cb',
        http,
        environment: ENVIRONMENT,
      }),
    ).toEqual({ ok: false, reason: 'no_email' });
  });

  it('refuses without client credentials, before any request is made', async () => {
    const http = scriptedHttp([]);

    expect(
      await fetchSsoProfile({
        provider: 'google',
        code: 'c',
        redirectUri: 'https://compass.example/cb',
        http,
        environment: {},
      }),
    ).toEqual({ ok: false, reason: 'unconfigured' });
    expect(http.requests).toHaveLength(0);
  });
});

describe('reading a GitHub profile', () => {
  const exchange = {
    match: 'github.com/login/oauth/access_token',
    body: { access_token: 'github-access-token' },
  };

  it('takes the subject from the numeric id, never from the renameable login', async () => {
    const http = scriptedHttp([
      exchange,
      { match: 'api.github.com/user/emails', body: [{ email: 'marcus@example.com', primary: true, verified: true }] },
      { match: 'api.github.com/user', body: { id: 5551234, login: 'marcus-h', name: 'Marcus Hale' } },
    ]);

    const result = await fetchSsoProfile({
      provider: 'github',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    expect(result.ok).toBe(true);
    // The numeric id as a string. A `login` can be renamed; the id cannot.
    expect(result.ok && result.profile.subject).toBe('5551234');
    expect(result.ok && result.profile.displayName).toBe('Marcus Hale');
  });

  /**
   * The reason `user:email` is in the scope list.
   *
   * `/user` returns a *public profile* address with no verification state at all. If the address came
   * from there, every GitHub sign-in would arrive unverifiable and would be refused — so the narrower
   * scope list is the one that does not work.
   */
  it('reads the address from /user/emails, not from /user', async () => {
    const http = scriptedHttp([
      exchange,
      {
        match: 'api.github.com/user/emails',
        body: [
          { email: 'personal@example.com', primary: false, verified: true },
          { email: 'work@example.com', primary: true, verified: true },
        ],
      },
      // A *different* address on the public profile, which must be ignored.
      { match: 'api.github.com/user', body: { id: 7, login: 'l', name: 'N', email: 'public@example.com' } },
    ]);

    const result = await fetchSsoProfile({
      provider: 'github',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    expect(result.ok && result.profile.email).toBe('work@example.com');
    expect(http.requests.some((request) => request.url.endsWith('/user/emails'))).toBe(true);
  });

  it('reports an unverified primary address as unverified', async () => {
    const http = scriptedHttp([
      exchange,
      { match: 'api.github.com/user/emails', body: [{ email: 'unconfirmed@example.com', primary: true, verified: false }] },
      { match: 'api.github.com/user', body: { id: 7, login: 'l' } },
    ]);

    const result = await fetchSsoProfile({
      provider: 'github',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    expect(result.ok && result.profile.emailVerified).toBe(false);
  });

  it('falls back to a verified address when none is flagged primary', async () => {
    const http = scriptedHttp([
      exchange,
      {
        match: 'api.github.com/user/emails',
        body: [
          { email: 'unverified@example.com', primary: false, verified: false },
          { email: 'verified@example.com', primary: false, verified: true },
        ],
      },
      { match: 'api.github.com/user', body: { id: 7, login: 'l' } },
    ]);

    const result = await fetchSsoProfile({
      provider: 'github',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    expect(result.ok && result.profile.email).toBe('verified@example.com');
    expect(result.ok && result.profile.emailVerified).toBe(true);
  });

  it('uses the login as a display name when the account has no name set', async () => {
    const http = scriptedHttp([
      exchange,
      { match: 'api.github.com/user/emails', body: [{ email: 'a@b.com', primary: true, verified: true }] },
      { match: 'api.github.com/user', body: { id: 7, login: 'octo-dev', name: null } },
    ]);

    const result = await fetchSsoProfile({
      provider: 'github',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    expect(result.ok && result.profile.displayName).toBe('octo-dev');
  });

  it('sends a user agent, which GitHub requires, and a bearer token', async () => {
    const http = scriptedHttp([
      exchange,
      { match: 'api.github.com/user/emails', body: [{ email: 'a@b.com', primary: true, verified: true }] },
      { match: 'api.github.com/user', body: { id: 7, login: 'l' } },
    ]);

    await fetchSsoProfile({
      provider: 'github',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    const profileRequest = http.requests.find((request) => request.url === 'https://api.github.com/user');
    expect(profileRequest?.headers?.['user-agent']).toBe('compass');
    expect(profileRequest?.headers?.['authorization']).toBe('Bearer github-access-token');
  });

  it('never stores the access token — it is used for the profile read and discarded', async () => {
    const http = scriptedHttp([
      exchange,
      { match: 'api.github.com/user/emails', body: [{ email: 'a@b.com', primary: true, verified: true }] },
      { match: 'api.github.com/user', body: { id: 7, login: 'l' } },
    ]);

    const result = await fetchSsoProfile({
      provider: 'github',
      code: 'c',
      redirectUri: 'https://compass.example/cb',
      http,
      environment: ENVIRONMENT,
    });

    /**
     * The returned profile carries no credential.
     *
     * Asserted structurally rather than by reading a field, so a token added to the shape later fails
     * here: a sign-in has no reason to keep a third-party access token, and one kept for convenience is
     * one in a database dump.
     */
    expect(result.ok && Object.keys(result.profile).sort()).toEqual([
      'displayName',
      'email',
      'emailVerified',
      'provider',
      'subject',
    ]);
  });
});
